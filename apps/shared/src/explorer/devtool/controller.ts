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
// EXPLORER DEV TOOL — CONTROLLER WIRING (the sidebar mount's op server, R6)
// =============================================================================
//
// The sidebar peer keeps ONE live subscriber: each `peer.subscribe` replaces
// the last, and calls reach only whoever subscribed last (busPeer.ts). Both
// the channel and the op server subscribe it, so the ORDER decides who gets
// the calls:
//
//   1. the channel first: the host's `DevToolProps.channel` when given, else
//      ONE channel per peer (realm.ts channelFor, never disposed);
//   2. exactly ONE op server last, created here and disposed by `dispose`.
//
// Frame events still reach the channel after the op server took the live
// slot: every subscriber also follows the retained last-payload lane.
//
// Nothing here calls `peer.subscribe` itself, and nothing posts at mount (a
// quiet sidebar, R7). The React shell calls `attachController` inside a
// `useEffect` and returns `dispose` as the cleanup; under StrictMode that is
// mount -> dispose -> mount, which leaves one live op server.
//
// HELD CALLS. While no controller is subscribed the peer holds frame calls
// (up to 64) and hands them over SYNCHRONOUSLY inside the next subscribe,
// that is inside `createToolOpServer`, before any handler could be served:
// the real op server would answer them all "No handler serves". So the op
// server subscribes through a thin shim that queues that synchronous burst
// and releases it once every handler is registered. Each released call then
// meets the deadline guard (deadline.ts): on time, it runs; its frame gave up,
// it does not.
// =============================================================================

import type { IToolOpServer, ToolChannel, ToolOpMap, ToolOpParams, ToolOpResult } from 'shell';
import { guardDeadline } from './deadline';
import type { DeadlineError } from './deadline';
import { channelFor } from './realm';
import type { DevToolPeer } from './realm';

/** The handlers a controller serves, by op wire name. */
export type ControllerHandlers<O extends ToolOpMap> = {
	[K in keyof O & string]?: (params: ToolOpParams<O, K>) => ToolOpResult<O, K> | Promise<ToolOpResult<O, K>>;
};

/** What {@link attachController} wires. */
export interface IAttachControllerOptions<O extends ToolOpMap> {
	/** The sidebar mount's peer (DevToolProps.peer). */
	peer: DevToolPeer;
	/** The host's channel (DevToolProps.channel), when it gave one. */
	channel?: ToolChannel;
	/** The shell's `createToolChannel` (injected: no value import from 'shell'). */
	createToolChannel: (peer: DevToolPeer) => ToolChannel;
	/** The shell's `createToolOpServer`. */
	createToolOpServer: (peer: DevToolPeer) => IToolOpServer<O>;
	/** The op handlers; each is served through the deadline guard. */
	handlers: ControllerHandlers<O>;
	/** The clock the deadline guard reads (default `Date.now`). */
	now?: () => number;
	/** Told once, about the first call the guard accepts (the activation gate's "first op from a frame"). */
	onFirstOp?: (op: string) => void;
	/** Told about every call the guard refused (it did not run). */
	onRefused?: (error: DeadlineError) => void;
}

/** A mounted controller. */
export interface IAttachedController {
	/** The channel the controller publishes state on and hears frame events from. */
	readonly channel: ToolChannel;
	/** Dispose the op server (idempotent). The channel stays: it cannot be disposed. */
	dispose(): void;
}

/** The live attachment per sidebar peer (exactly one op server per peer). */
const live = new WeakMap<DevToolPeer, IAttachedController>();

/**
 * Wire a controller mount: the channel first, then ONE op server serving
 * every handler through the deadline guard.
 *
 * @param opts - See {@link IAttachControllerOptions}.
 * @returns The channel and `dispose` (the effect's cleanup).
 */
export function attachController<O extends ToolOpMap>(opts: IAttachControllerOptions<O>): IAttachedController {
	const { peer } = opts;

	// 1. The channel, BEFORE the op server takes the live slot.
	const channel = opts.channel ?? channelFor(peer, opts.createToolChannel);

	// A mount that was never cleaned up must not keep a second op server.
	live.get(peer)?.dispose();

	// 2. The op server, LAST, through a shim that holds the synchronous burst
	//    of held calls until every handler is served.
	let released = false;
	const early: unknown[] = [];
	let deliver: ((message: unknown) => void) | null = null;
	const shim: DevToolPeer = {
		post: (message) => peer.post(message),
		subscribe: (cb) => {
			deliver = cb;
			return peer.subscribe((message) => {
				if (released) cb(message);
				else early.push(message);
			});
		},
	};
	const server = opts.createToolOpServer(shim);

	let first = true;
	const onAccepted = (op: string): void => {
		if (!first) return;
		first = false;
		opts.onFirstOp?.(op);
	};
	for (const op of Object.keys(opts.handlers) as Array<keyof O & string>) {
		const handler = opts.handlers[op];
		if (handler === undefined) continue;
		server.serve(op, guardDeadline(op, handler, { now: opts.now, onAccepted, onRefused: opts.onRefused }));
	}

	released = true;
	const flush = deliver as ((message: unknown) => void) | null;
	if (flush !== null) for (const message of early.splice(0)) flush(message);

	let disposed = false;
	const attachment: IAttachedController = {
		channel,
		dispose() {
			if (disposed) return;
			disposed = true;
			server.dispose();
			if (live.get(peer) === attachment) live.delete(peer);
		},
	};
	live.set(peer, attachment);
	return attachment;
}
