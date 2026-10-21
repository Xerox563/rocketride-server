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
// EXPLORER DEV TOOL — CONTROLLER WIRING (R6 order, one op server, R2 guard)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IToolOpServer, ToolChannel, ToolOpMap, ToolOpSpec } from 'shell';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import type { DevToolPeer } from './realm';
import type { Reply } from './reply';
import { createDevToolHarness, manualNow, settle, shellProtocol, spyPeer } from './testing';

interface TestOps extends ToolOpMap {
	't.echo': ToolOpSpec<IDeadline & { x: number }, Reply<number>>;
	't.other': ToolOpSpec<IDeadline, Reply<string>>;
}

/** Counts op servers the controller creates and disposes, over the real factory. */
function countingServers(order: string[] = []) {
	const counts = { created: 0, disposed: 0 };
	const factory = (peer: DevToolPeer): IToolOpServer<TestOps> => {
		order.push('opServer');
		counts.created += 1;
		const server = shellProtocol.createToolOpServer<TestOps>(peer);
		return { serve: (op, handler) => server.serve(op, handler), dispose: () => { counts.disposed += 1; server.dispose(); } };
	};
	return { counts, factory };
}

/** Counts channels built over the real factory. */
function countingChannels(order: string[] = []) {
	const counts = { created: 0 };
	const factory = (peer: DevToolPeer): ToolChannel => {
		order.push('channel');
		counts.created += 1;
		return shellProtocol.createToolChannel(peer);
	};
	return { counts, factory };
}

describe('attachController — subscription order and lifetime (R6)', () => {
	it('with no host channel: ONE channel per peer, created BEFORE the op server, which is created last', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.sidebarPeer);
		const order: string[] = [];
		const channels = countingChannels(order);
		const servers = countingServers(order);
		const first = attachController<TestOps>({ peer: spy.peer, createToolChannel: channels.factory, createToolOpServer: servers.factory, handlers: {} });
		assert.deepEqual(order, ['channel', 'opServer']);
		assert.equal(spy.subscribes, 2, 'the channel and the op server — the controller itself never subscribes');
		first.dispose();
		const second = attachController<TestOps>({ peer: spy.peer, createToolChannel: channels.factory, createToolOpServer: servers.factory, handlers: {} });
		assert.equal(channels.counts.created, 1, 'the channel is cached per peer: a remount adds no channel subscription');
		assert.equal(second.channel, first.channel);
		assert.equal(spy.subscribes, 3);
		second.dispose();
	});

	it('uses the host channel when given and never builds one', () => {
		const h = createDevToolHarness();
		const host = shellProtocol.createToolChannel(h.sidebarPeer);
		const channels = countingChannels();
		const servers = countingServers();
		const attached = attachController<TestOps>({ peer: h.sidebarPeer, channel: host, createToolChannel: channels.factory, createToolOpServer: servers.factory, handlers: {} });
		assert.equal(attached.channel, host);
		assert.equal(channels.counts.created, 0);
		attached.dispose();
	});

	it('leaves exactly one live op server per peer, even if a previous mount was never disposed', () => {
		const h = createDevToolHarness();
		const servers = countingServers();
		const a = attachController<TestOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: servers.factory, handlers: {} });
		attachController<TestOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: servers.factory, handlers: {} });
		assert.equal(servers.counts.created - servers.counts.disposed, 1);
		a.dispose();
		assert.equal(servers.counts.created - servers.counts.disposed, 1, 'disposing a superseded mount twice is a no-op');
	});

	it('posts nothing on the peer while mounting (a quiet sidebar, R7)', () => {
		const h = createDevToolHarness();
		const spy = spyPeer(h.sidebarPeer);
		const attached = attachController<TestOps>({
			peer: spy.peer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => x },
		});
		assert.deepEqual(spy.posts, []);
		assert.deepEqual(h.emitted, [], 'and summons nothing');
		attached.dispose();
	});
});

describe('attachController — every op answers a Reply (R3)', () => {
	it('refuses, at compile time, an op map whose results are not Replies', () => {
		interface PlainOps extends ToolOpMap {
			'p.count': ToolOpSpec<IDeadline, number>;
		}
		const h = createDevToolHarness();
		// @ts-expect-error -- every controller op answers a Reply; a plain result type is refused
		const attached = attachController<PlainOps>({ peer: h.sidebarPeer, createToolChannel: shellProtocol.createToolChannel, createToolOpServer: shellProtocol.createToolOpServer, handlers: {} });
		attached.dispose();
	});
});

describe('attachController — every handler is served through the deadline guard (R2)', () => {
	it('answers an on-time call, refuses a late one and one without a deadline, and opens activation on the first accepted op', async () => {
		const h = createDevToolHarness();
		const clock = manualNow(1_000);
		const ran: number[] = [];
		const firstOps: string[] = [];
		const attached = attachController<TestOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.echo': ({ x }) => { ran.push(x); return x * 10; } },
			now: clock.now,
			onFirstOp: (op) => firstOps.push(op),
		});
		const frame = h.newFramePeer();
		const call = shellProtocol.createToolController<TestOps>(frame);
		await settle();

		await assert.rejects(call('t.echo', { x: 1 } as TestOps['t.echo']['params'], { timeoutMs: 1_000 }), /deadlineAt/);
		await assert.rejects(call('t.echo', { x: 2, deadlineAt: 999 }, { timeoutMs: 1_000 }), /deadline/);
		assert.deepEqual(await call('t.echo', { x: 3, deadlineAt: 5_000 }, { timeoutMs: 1_000 }), { ok: true, value: 30 });
		assert.deepEqual(await call('t.echo', { x: 4, deadlineAt: 5_000 }, { timeoutMs: 1_000 }), { ok: true, value: 40 });
		assert.deepEqual(ran, [3, 4]);
		assert.deepEqual(firstOps, ['t.echo'], 'once, on the first op that was accepted');
		attached.dispose();
	});

	it('dispose stops serving: a later call is not executed', async () => {
		const h = createDevToolHarness();
		let ran = 0;
		const attached = attachController<TestOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 't.other': () => { ran += 1; return 'x'; } },
		});
		attached.dispose();
		attached.dispose();
		const call = shellProtocol.createToolController<TestOps>(h.newFramePeer());
		await settle();
		await assert.rejects(call('t.other', { deadlineAt: Date.now() + 60_000 }, { timeoutMs: 50 }), /did not answer/);
		assert.equal(ran, 0);
	});
});
