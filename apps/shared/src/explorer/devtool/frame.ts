// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// EXPLORER DEV TOOL — FRAME CALLER (how a document frame calls its controller)
// =============================================================================
//
// Frames hold no client (R1): every engine-facing step is an op on the
// controller. This is the frame's runtime for those ops:
//
//   - ONE controller function and ONE channel per frame peer. Both
//     `createToolController` and `createToolChannel` subscribe the peer at
//     construction and can never be disposed (toolOps.ts, toolChannel.ts); on
//     a frame peer each subscription also announces a HELLO. They are cached
//     per peer, so a StrictMode double mount adds nothing.
//   - Every call names an explicit `timeoutMs` (timeouts.ts) and is stamped
//     with `deadlineAt` (deadline.ts), which the controller enforces.
//   - The moment `host:connection` turns false, every pending call is
//     rejected: the caller stops waiting, and since nothing can be cancelled
//     the error says the call may still have run (kind `timeout`).
//   - FAIL FAST: a call made while `host:connection` is already false is
//     rejected at once, before anything is posted, as kind `unavailable`
//     (it was not sent, so it cannot have run). Before the host has published
//     the topic at all (`connected()` is null) calls pass through.
//   - The op lane's own timeout text, and the controller's refusal of a call
//     that arrived after its deadline, become an ExplorerToolError of kind
//     `timeout`; Reply ops are unwrapped by `callReply` (reply.ts), which
//     rebuilds the controller's ExplorerToolError. Anything else (an op no
//     controller serves, a missing deadline, a programming error in a
//     handler) is a protocol error and stays a plain Error.
//   - A missing or unusable `timeoutMs` is a programming error: `call` and
//     `callReply` THROW it synchronously (a RangeError), so it never reaches
//     a `.catch` on the returned promise.
//   - `dispose` (the effect cleanup) stops following host:connection and
//     rejects what is still pending as `stale`, which callers ignore.
// =============================================================================

import type { ToolChannel, ToolControllerFn, ToolOpMap, ToolOpParams, ToolOpResult } from 'shell';
import { ExplorerToolError, readErrorMessage } from '../errors';
import { isDeadlineExpiredText, stampDeadline } from './deadline';
import { channelFor } from './realm';
import type { DevToolPeer } from './realm';
import { fromReply, isLaneTimeoutText } from './reply';
import type { Reply, ReplyValue } from './reply';
import { assertTimeoutMs } from './timeouts';

/** The host-published connection topic (the shell's HOST_CONNECTION_TOPIC, toolRelay.ts; a test pins the two). */
export const HOST_CONNECTION_TOPIC = 'host:connection';

/** The params a frame passes: the op's params without the deadline it stamps. */
export type FrameParams<O, K extends keyof O> = Omit<ToolOpParams<O, K>, 'deadlineAt'>;

/** Per-call options: the timeout is REQUIRED. */
export interface IFrameCallOptions {
	/** How long the frame waits (see timeouts.ts `frameOpTimeoutMs`). */
	timeoutMs: number;
}

/** What {@link createFrameCaller} needs. */
export interface IFrameCallerOptions {
	/** The frame mount's peer (DevToolProps.peer). */
	peer: DevToolPeer;
	/** The host's channel for this mount (DevToolProps.channel), when it gave one. */
	channel?: ToolChannel;
	/** The shell's `createToolController` (injected: no value import from 'shell'). */
	createToolController: <O extends ToolOpMap>(peer: DevToolPeer) => ToolControllerFn<O>;
	/** The shell's `createToolChannel`. */
	createToolChannel: (peer: DevToolPeer) => ToolChannel;
	/** The clock deadlines are stamped from (default `Date.now`). */
	now?: () => number;
}

/** A frame's way to call its controller. */
export interface IFrameCaller<O extends ToolOpMap> {
	/**
	 * Call an op and return its raw result (a Reply, for every op a controller
	 * wired with attachController serves).
	 *
	 * @throws RangeError (synchronously) when `timeoutMs` is missing or unusable.
	 */
	call<K extends keyof O & string>(op: K, params: FrameParams<O, K>, opts: IFrameCallOptions): Promise<ToolOpResult<O, K>>;
	/**
	 * Call a Reply op and return its value, or reject with the controller's ExplorerToolError.
	 *
	 * @throws RangeError (synchronously) when `timeoutMs` is missing or unusable.
	 */
	callReply<K extends keyof O & string>(op: K, params: FrameParams<O, K>, opts: IFrameCallOptions): Promise<ReplyValue<ToolOpResult<O, K>>>;
	/** Calls still waiting. */
	pending(): number;
	/** The last `host:connection` snapshot: true / false, or null before the host published one. */
	connected(): boolean | null;
	/** Stop following host:connection and reject what is pending as `stale` (idempotent). */
	dispose(): void;
}

/** The controller function built for each frame peer. */
const controllers = new WeakMap<DevToolPeer, ToolControllerFn<ToolOpMap>>();

/**
 * The one controller function for a frame peer.
 *
 * @param peer - The frame's peer.
 * @param create - The shell's `createToolController`.
 * @returns The function (untyped; the caller types it).
 */
function controllerFor(peer: DevToolPeer, create: IFrameCallerOptions['createToolController']): ToolControllerFn<ToolOpMap> {
	let fn = controllers.get(peer);
	if (fn === undefined) {
		fn = create<ToolOpMap>(peer);
		controllers.set(peer, fn);
	}
	return fn;
}

/**
 * Build a frame's caller.
 *
 * @param opts - See {@link IFrameCallerOptions}.
 * @returns The caller; dispose it in the mount's cleanup.
 */
export function createFrameCaller<O extends ToolOpMap>(opts: IFrameCallerOptions): IFrameCaller<O> {
	const now = opts.now ?? Date.now;
	const send = controllerFor(opts.peer, opts.createToolController) as unknown as (op: string, params: unknown, options: { timeoutMs: number }) => Promise<unknown>;
	const channel = opts.channel ?? channelFor(opts.peer, opts.createToolChannel);

	/** One pending call: its op and how to reject it. */
	interface IPending {
		op: string;
		reject: (error: unknown) => void;
	}
	const pending = new Set<IPending>();
	let connected: boolean | null = null;
	let disposed = false;

	/**
	 * Reject every pending call.
	 *
	 * @param make - Builds the error for one op.
	 */
	const rejectAll = (make: (op: string) => ExplorerToolError): void => {
		for (const entry of [...pending]) {
			pending.delete(entry);
			entry.reject(make(entry.op));
		}
	};

	const offConnection = channel.onState(HOST_CONNECTION_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { connected?: unknown }).connected : undefined;
		if (typeof value !== 'boolean') return;
		connected = value;
		if (!value) {
			rejectAll((op) => new ExplorerToolError({
				kind: 'timeout',
				tool: op,
				message: `Lost the connection while '${op}' was running. It may still have run; there is no way to cancel it from here.`,
			}));
		}
	});

	/**
	 * What a failed call rejects with.
	 *
	 * @param op - The op.
	 * @param error - What the op lane rejected with.
	 * @returns An ExplorerToolError for the lane's timeout; anything else unchanged.
	 */
	const mapFailure = (op: string, error: unknown): unknown => {
		const message = readErrorMessage(error);
		return isLaneTimeoutText(message) || isDeadlineExpiredText(message) ? new ExplorerToolError({ kind: 'timeout', tool: op, message }) : error;
	};

	const stale = (op: string): ExplorerToolError => new ExplorerToolError({ kind: 'stale', tool: op, message: `'${op}' was dropped: its frame closed.` });

	const call = (op: string, params: unknown, options: IFrameCallOptions): Promise<unknown> => {
		const timeoutMs = assertTimeoutMs(options?.timeoutMs, `'${op}' timeoutMs`);
		if (disposed) return Promise.reject(stale(op));
		if (connected === false) {
			return Promise.reject(new ExplorerToolError({ kind: 'unavailable', tool: op, message: `Not connected to a server, so '${op}' was not sent.` }));
		}
		const args = stampDeadline(params as object | undefined, timeoutMs, now);
		return new Promise<unknown>((resolve, reject) => {
			const entry: IPending = { op, reject };
			pending.add(entry);
			send(op, args, { timeoutMs }).then(
				(value) => { if (pending.delete(entry)) resolve(value); },
				(error: unknown) => { if (pending.delete(entry)) reject(mapFailure(op, error)); },
			);
		});
	};

	return {
		call: (op, params, options) => call(op, params, options) as Promise<ToolOpResult<O, typeof op>>,
		callReply: (op, params, options) => call(op, params, options).then((reply) => fromReply(reply as Reply<unknown>, { tool: op })) as Promise<ReplyValue<ToolOpResult<O, typeof op>>>,
		pending: () => pending.size,
		connected: () => connected,
		dispose() {
			if (disposed) return;
			disposed = true;
			offConnection();
			rejectAll(stale);
		},
	};
}
