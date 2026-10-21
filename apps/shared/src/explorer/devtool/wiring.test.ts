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
// EXPLORER DEV TOOL — WIRING OVER THE REAL SHELL MODULES (T3, T5, T13)
// =============================================================================
//
// Everything here runs over the shell's REAL busPeer, toolOps and toolChannel
// on the shell's REAL retained registry (see testing.ts). The lanes reuse these
// shapes for their own op maps.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IToolOpServer, ToolOpMap, ToolOpSpec } from 'shell';
import { ExplorerToolError } from '../errors';
import { attachController } from './controller';
import type { IDeadline } from './deadline';
import { createFrameCaller } from './frame';
import type { DevToolPeer } from './realm';
import { toReply } from './reply';
import type { Reply } from './reply';
import { assertJsonSafe, createDevToolHarness, manualNow, settle, shellProtocol } from './testing';

interface WireOps extends ToolOpMap {
	'w.read': ToolOpSpec<IDeadline & { key: string; text: string }, Reply<{ columns: string[]; rows: unknown[][] }>>;
	'w.write': ToolOpSpec<IDeadline & { key: string; text: string }, Reply<{ affected: number }>>;
}

/** Counts op servers over the real factory. */
function countingServers() {
	const counts = { created: 0, disposed: 0 };
	const factory = (peer: DevToolPeer): IToolOpServer<WireOps> => {
		counts.created += 1;
		const server = shellProtocol.createToolOpServer<WireOps>(peer);
		return { serve: (op, handler) => server.serve(op, handler), dispose: () => { counts.disposed += 1; server.dispose(); } };
	};
	return { counts, factory };
}

describe('T3 — every op round-trips JSON-safe; failures come back as equal ExplorerToolErrors', () => {
	it('args, results and Reply errors all survive a JSON round trip, on the wire and at both ends', async () => {
		const h = createDevToolHarness();
		h.setHostConnection(true);
		const handled: unknown[] = [];
		const failure = new ExplorerToolError({ kind: 'raised', tool: 'execute', code: 'TASK_STOPPED', message: 'Task stopped\nIt was restarted' });
		const attached = attachController<WireOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: {
				'w.read': (params) => toReply(() => { handled.push(params); return { columns: ['id', 'name'], rows: [[1, 'a'], [2, null]] }; }),
				'w.write': (params) => toReply(() => { handled.push(params); throw failure; }),
			},
		});
		const caller = createFrameCaller<WireOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel });
		await settle();

		const value = await caller.callReply('w.read', { key: 'k1|dev|user|u1|t|p|tools=tools_1|db_1', text: 'select 1' }, { timeoutMs: 5_000 });
		assert.deepEqual(value, { columns: ['id', 'name'], rows: [[1, 'a'], [2, null]] });
		assertJsonSafe(value, 'result');

		await assert.rejects(caller.callReply('w.write', { key: 'k1', text: 'delete' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.deepEqual(error, failure);
			assert.equal(error.code, 'TASK_STOPPED');
			return true;
		});

		for (const [i, params] of handled.entries()) assertJsonSafe(params, `args #${i}`);
		assert.ok(h.wire.length > 0);
		for (const [i, entry] of h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
		const replies = h.wire.filter((entry) => (entry.value as { __rrtool?: string })?.__rrtool === 'reply');
		assert.equal(replies.length, 2);
		const errorReply = (replies[1].value as { result: Reply<unknown> }).result;
		assert.deepEqual(errorReply, { ok: false, error: { kind: 'raised', code: 'TASK_STOPPED', tool: 'execute', message: 'Task stopped\nIt was restarted', detail: 'It was restarted' } });

		caller.dispose();
		attached.dispose();
	});

	it('a bus timeout inside the controller comes back to the frame as kind timeout', async () => {
		const h = createDevToolHarness();
		const attached = attachController<WireOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			handlers: { 'w.read': () => toReply(() => { throw new Error("Op 'client.tool' timed out after 66000ms (bridged)"); }, { tool: 'get_data' }) },
		});
		const caller = createFrameCaller<WireOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel });
		await settle();
		await assert.rejects(caller.callReply('w.read', { key: 'k', text: 'x' }, { timeoutMs: 5_000 }), (error: unknown) => {
			assert.ok(error instanceof ExplorerToolError);
			assert.equal(error.kind, 'timeout');
			assert.equal(error.tool, 'get_data');
			return true;
		});
		caller.dispose();
		attached.dispose();
	});
});

describe('T5 — mount -> dispose -> mount leaves one live op server; replays execute nothing', () => {
	for (const withHostChannel of [true, false]) {
		it(`ops are answered and channel events delivered (${withHostChannel ? 'host channel, rocket-ui style' : 'no host channel'})`, async () => {
			const h = createDevToolHarness();
			const hostChannel = withHostChannel ? shellProtocol.createToolChannel(h.sidebarPeer) : undefined;
			const servers = countingServers();
			const runs: string[] = [];
			const mount = () => attachController<WireOps>({
				peer: h.sidebarPeer,
				...(hostChannel ? { channel: hostChannel } : {}),
				createToolChannel: shellProtocol.createToolChannel,
				createToolOpServer: servers.factory,
				handlers: {
					'w.read': (params) => toReply(() => { runs.push(`read:${params.text}`); return { columns: [], rows: [] }; }),
					'w.write': (params) => toReply(() => { runs.push(`write:${params.text}`); return { affected: 1 }; }),
				},
			});

			// StrictMode: mount, cleanup, mount.
			const first = mount();
			first.dispose();
			const second = mount();
			assert.equal(servers.counts.created - servers.counts.disposed, 1, 'exactly one live op server');

			const actives: unknown[] = [];
			second.channel.onEvent('active', (payload) => actives.push(payload));

			const framePeer = h.newFramePeer();
			const frameChannel = shellProtocol.createToolChannel(framePeer);
			const caller = createFrameCaller<WireOps>({ peer: framePeer, channel: frameChannel, createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel });
			await settle();

			// Ops are answered, once each.
			await caller.callReply('w.write', { key: 'k', text: 'one' }, { timeoutMs: 5_000 });
			assert.deepEqual(runs, ['write:one']);

			// Channel events reach the controller's channel exactly once (the op server is the live
			// subscriber; the channel hears frame events on the retained last-payload lane).
			frameChannel.sendEvent('active', 'workbench:k');
			await settle();
			assert.deepEqual(actives, ['workbench:k']);

			// An event named like an op (a protocol bug) is delivered twice to the op server (live +
			// retained slot) and executes nothing: it carries no deadline.
			frameChannel.sendEvent('w.write', { key: 'k', text: 'event' });
			await settle();
			assert.deepEqual(runs, ['write:one']);

			// Remount: the retained last frame payload replays into the new op server and executes nothing.
			second.dispose();
			const third = mount();
			await settle();
			assert.equal(servers.counts.created - servers.counts.disposed, 1);
			assert.deepEqual(runs, ['write:one']);
			assert.deepEqual(actives, ['workbench:k'], 'no second delivery of the last event to the controller channel');

			// And the remounted controller still answers.
			await caller.callReply('w.read', { key: 'k', text: 'two' }, { timeoutMs: 5_000 });
			assert.deepEqual(runs, ['write:one', 'read:two']);

			caller.dispose();
			third.dispose();
		});
	}
});

describe('T13 — a call held while no controller is subscribed and delivered after its deadline is not executed', () => {
	it('the frame has already rejected; the remounted controller refuses it (control: an on-time held call runs)', async () => {
		const h = createDevToolHarness();
		const clock = manualNow(1_000_000);
		const runs: string[] = [];
		const mount = () => attachController<WireOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			now: clock.now,
			handlers: { 'w.write': (params) => toReply(() => { runs.push(params.text); return { affected: 1 }; }) },
		});
		const caller = createFrameCaller<WireOps>({ peer: h.newFramePeer(), createToolController: shellProtocol.createToolController, createToolChannel: shellProtocol.createToolChannel, now: clock.now });

		// The controller mounted once (as at boot), then unmounted (a VS Code disconnect).
		mount().dispose();
		await settle();

		// The frame calls while no controller is subscribed: the REAL busPeer holds the call.
		const late = caller.callReply('w.write', { key: 'k', text: 'late' }, { timeoutMs: 40 });
		await assert.rejects(late, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
		assert.equal(caller.pending(), 0, 'the frame gave up');

		// Minutes pass, then the controller remounts and receives the held call.
		clock.advance(5 * 60_000);
		const refused: string[] = [];
		const again = attachController<WireOps>({
			peer: h.sidebarPeer,
			createToolChannel: shellProtocol.createToolChannel,
			createToolOpServer: shellProtocol.createToolOpServer,
			now: clock.now,
			onRefused: (error) => refused.push(`${error.op}:${error.reason}`),
			handlers: { 'w.write': (params) => toReply(() => { runs.push(params.text); return { affected: 1 }; }) },
		});
		await settle();
		assert.deepEqual(runs, [], 'the expired write never ran');
		assert.deepEqual(refused, ['w.write:expired'], 'the held call DID reach the controller, which refused it');
		again.dispose();

		// Control: a held call still inside its deadline is executed on remount.
		const onTime = caller.callReply('w.write', { key: 'k', text: 'on-time' }, { timeoutMs: 5_000 });
		await settle();
		const third = mount();
		assert.deepEqual(await onTime, { affected: 1 });
		assert.deepEqual(runs, ['on-time']);
		third.dispose();
		caller.dispose();
	});
});
