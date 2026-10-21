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
// EXPLORER DEV TOOL — FRAME CALLER (explicit timeouts, deadlines, host:connection)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ToolChannel, ToolControllerFn, ToolOpMap, ToolOpSpec } from 'shell';
import { ExplorerToolError } from '../errors';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import { createFrameCaller, HOST_CONNECTION_TOPIC } from './frame';
import type { DevToolPeer } from './realm';
import { replyOk, toReply } from './reply';
import type { Reply } from './reply';
import { MAX_TIMER_MS } from './timeouts';
import { createDevToolHarness, manualNow, settle, shellProtocol, spyPeer } from './testing';

interface FrameOps extends ToolOpMap {
	'f.echo': ToolOpSpec<IDeadline & { x: number }, number>;
	'f.read': ToolOpSpec<IDeadline & { q: string }, Reply<{ rows: number[] }>>;
	'f.hang': ToolOpSpec<IDeadline, never>;
}

/**
 * A controller serving FrameOps over the harness's sidebar peer.
 *
 * @param h - The harness.
 * @param seen - Receives every params object the controller handled.
 * @param now - The controller clock (default: real).
 * @returns Dispose.
 */
function serve(h: ReturnType<typeof createDevToolHarness>, seen: unknown[] = [], now?: () => number): () => void {
	const attached = attachController<FrameOps>({
		peer: h.sidebarPeer,
		...(now ? { now } : {}),
		createToolChannel: shellProtocol.createToolChannel,
		createToolOpServer: shellProtocol.createToolOpServer,
		handlers: {
			'f.echo': (params) => { seen.push(params); return params.x; },
			'f.read': (params) => toReply(() => {
				seen.push(params);
				if (params.q === 'bad') throw new ExplorerToolError({ kind: 'invalid', tool: 'get_data', code: 'BAD_SQL', message: 'Syntax error\nnear "selec"' });
				return { rows: [1, 2] };
			}),
			'f.hang': () => new Promise<never>(() => undefined),
		},
	});
	return () => attached.dispose();
}

/** Real primitives, counted. */
function counted() {
	const counts = { controllers: 0, channels: 0 };
	return {
		counts,
		createToolController: <O extends ToolOpMap>(peer: DevToolPeer): ToolControllerFn<O> => { counts.controllers += 1; return shellProtocol.createToolController<O>(peer); },
		createToolChannel: (peer: DevToolPeer): ToolChannel => { counts.channels += 1; return shellProtocol.createToolChannel(peer); },
	};
}

describe('createFrameCaller — calls', () => {
	it('stamps deadlineAt = now + timeoutMs on the args the controller receives', async () => {
		const h = createDevToolHarness();
		const seen: unknown[] = [];
		const clock = manualNow(50_000);
		const stop = serve(h, seen, clock.now);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted(), now: clock.now });
		await settle();
		assert.equal(await caller.call('f.echo', { x: 7 }, { timeoutMs: 30_000 }), 7);
		assert.deepEqual(seen, [{ x: 7, deadlineAt: 80_000 }]);
		caller.dispose();
		stop();
	});

	it('requires an explicit, valid timeoutMs', () => {
		const h = createDevToolHarness();
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		for (const bad of [undefined, 0, -1, Number.NaN, MAX_TIMER_MS + 1]) {
			assert.throws(() => caller.call('f.echo', { x: 1 }, { timeoutMs: bad as unknown as number }), RangeError, String(bad));
		}
		assert.throws(() => caller.call('f.echo', { x: 1 }, undefined as unknown as { timeoutMs: number }), RangeError);
		caller.dispose();
	});

	it('callReply unwraps a Reply, and a failure comes back as an equal ExplorerToolError', async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		await settle();
		assert.deepEqual(await caller.callReply('f.read', { q: 'ok' }, { timeoutMs: 5_000 }), { rows: [1, 2] });
		const original = new ExplorerToolError({ kind: 'invalid', tool: 'get_data', code: 'BAD_SQL', message: 'Syntax error\nnear "selec"' });
		await assert.rejects(caller.callReply('f.read', { q: 'bad' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.deepEqual(error, original);
			return true;
		});
		caller.dispose();
		stop();
	});

	it("maps the op lane's timeout to an ExplorerToolError of kind timeout naming the op", async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		await settle();
		await assert.rejects(caller.call('f.hang', {}, { timeoutMs: 30 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'timeout');
			assert.equal(error.tool, 'f.hang');
			assert.match(error.message, /did not answer within/);
			return true;
		});
		assert.equal(caller.pending(), 0);
		caller.dispose();
		stop();
	});

	it('a protocol failure stays a plain Error (an op no controller serves)', async () => {
		const h = createDevToolHarness();
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps & { 'f.unknown': ToolOpSpec<IDeadline, void> }>({ peer: h.newFramePeer(), ...counted() });
		await settle();
		await assert.rejects(caller.call('f.unknown', {}, { timeoutMs: 5_000 }), (error: unknown) => error instanceof Error && !(error instanceof ExplorerToolError) && /No handler serves/.test(error.message));
		caller.dispose();
		stop();
	});
});

describe('createFrameCaller — host:connection', () => {
	it('rejects every pending call as soon as host:connection turns false, as "may still have run"', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(true);
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		await settle();
		assert.equal(caller.connected(), true);
		const a = caller.call('f.hang', {}, { timeoutMs: 60_000 });
		const b = caller.call('f.hang', {}, { timeoutMs: 60_000 });
		await settle();
		assert.equal(caller.pending(), 2);
		h.setHostConnection(false);
		for (const pending of [a, b]) {
			await assert.rejects(pending, (error: unknown) => {
				assert.ok(error instanceof ExplorerToolError);
				assert.equal(error.kind, 'timeout');
				assert.equal(error.tool, 'f.hang');
				return true;
			});
		}
		assert.equal(caller.pending(), 0);
		assert.equal(caller.connected(), false);
		caller.dispose();
		stop();
	});

	it('uses the host channel when the mount has one, and the constant matches the shell', async () => {
		assert.equal(HOST_CONNECTION_TOPIC, shellProtocol.HOST_CONNECTION_TOPIC);
		const h = createDevToolHarness();
		const frame = h.newFramePeer();
		const host = shellProtocol.createToolChannel(frame);
		const prims = counted();
		const caller = createFrameCaller<FrameOps>({ peer: frame, channel: host, ...prims });
		assert.equal(prims.counts.channels, 0);
		h.setHostConnection(false);
		await settle();
		assert.equal(caller.connected(), false);
		caller.dispose();
	});
});

describe('createFrameCaller — one subscription set per peer', () => {
	it('a StrictMode double mount builds ONE controller and ONE channel for the peer', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.newFramePeer());
		const prims = counted();
		const first = createFrameCaller<FrameOps>({ peer: spy.peer, ...prims });
		first.dispose();
		const second = createFrameCaller<FrameOps>({ peer: spy.peer, ...prims });
		assert.deepEqual(prims.counts, { controllers: 1, channels: 1 });
		assert.equal(spy.subscribes, 2, 'one for the controller function, one for the channel');
		second.dispose();
	});

	it('dispose rejects what is pending as stale, refuses later calls and stops listening', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(true);
		const stop = serve(h);
		const caller = createFrameCaller<FrameOps>({ peer: h.newFramePeer(), ...counted() });
		await settle();
		const pending = caller.call('f.hang', {}, { timeoutMs: 60_000 });
		caller.dispose();
		await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		await assert.rejects(caller.call('f.echo', { x: 1 }, { timeoutMs: 1_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		h.setHostConnection(false);
		await settle();
		assert.equal(caller.connected(), true, 'a disposed caller no longer follows host:connection');
		stop();
	});

	it('replyOk is what a Reply op resolves with on the wire', () => {
		assert.deepEqual(replyOk(1), { ok: true, value: 1 });
	});
});
