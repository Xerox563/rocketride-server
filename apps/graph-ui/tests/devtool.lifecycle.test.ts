// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL LIFECYCLE: one op server, a quiet sidebar, identity, host:connection
// and the first click (T5, T6, T7, T8, R8) over the REAL shell modules
// =============================================================================

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { assertSidebarSubscribers } from 'shared/explorer/devtool/testing';
import { OP } from '../src/devtool/protocol';
import { PREVIEW_MAX_AGE_MS, previewFor } from '../src/graph/previews';
import { account, graphRow, mountController, mountFrame, readOnlyNode, rocketRealm, settle, signInVsCode, until, vscodeRealm } from './support/devtool';

const APP = 'rocketride.graph';

/**
 * The posts a sidebar made that are not retained state (events and calls).
 *
 * @param posts - Everything the spied sidebar peer posted.
 * @returns The non-state posts.
 */
function nonStatePosts(posts: unknown[]): unknown[] {
	return posts.filter((post) => (post as { __rrtool?: string })?.__rrtool !== 'state');
}

describe('T5 - mount -> dispose -> mount leaves one live op server; ops answered, events delivered, replays run nothing', () => {
	it('the remounted controller has exactly two live subscriptions, serves ops, follows the frame\'s active event, and the replayed event executes nothing', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const first = mountController(engine.cm);
		assertSidebarSubscribers(first.spy, 'first graph controller');
		// StrictMode: mount, cleanup, mount (the host's channel lives on).
		first.controller.dispose();
		const second = mountController(engine.cm, {}, first.h, first);
		assertSidebarSubscribers(second.spy, 'remounted graph controller');

		first.h.setHostConnection(true);
		const { frame } = mountFrame(first.h, 'workbench:k1|some|key');
		await until(() => second.controller.activeConnection.get() === 'k1|some|key', 'the frame\'s active event (activeDocKey is undefined in VS Code)');
		assert.deepEqual(await frame.caller.callReply(OP.historyList, { key: 'k1|some|key' }, { timeoutMs: 5_000 }), { entries: [], recording: true }, 'an op is answered');

		await until(() => engine.world.calls.length > 0, 'the first discovery and probe');
		await settle();
		const calls = engine.world.calls.length;
		second.controller.dispose();
		const third = mountController(engine.cm, {}, first.h, first);
		assertSidebarSubscribers(third.spy, 'third graph controller');
		await settle();
		const afterReplay = engine.world.calls.filter((c, i) => i >= calls && c.tool !== 'dialect');
		assert.deepEqual(afterReplay, [], 'nothing the frame sent before ran again (only discovery probes)');
		// The replay reaches the op server (which drops events), not the channel; the frame says again which
		// document it is when the host connection comes back, as it does around a VS Code controller remount.
		first.h.setHostConnection(false);
		first.h.setHostConnection(true);
		await until(() => third.controller.activeConnection.get() === 'k1|some|key', 'the frame to announce itself again');
		assert.deepEqual(first.h.violations, []);
		frame.dispose();
		third.controller.dispose();
	});
});

describe('T6 - a quiet sidebar: no event, call or document at mount; the first discovery waits for activation', () => {
	it('rocket-ui (every pinned sidebar mounts at boot): state publishes only, no engine request until the tool is activated', async () => {
		const engine = rocketRealm();
		engine.realm.login(account('u1'));
		const mounted = mountController(engine.cm);
		await settle();
		assert.deepEqual(nonStatePosts(mounted.spy.posts), [], 'no event or call posts at mount');
		assert.ok(mounted.spy.posts.length > 0, 'the premise: retained state was published');
		assert.deepEqual(mounted.docs.opened, [], 'no documents.open at mount');
		assert.deepEqual(mounted.h.emitted, [], 'nothing summoned a frame');
		assert.deepEqual(engine.requests, [], 'no engine request: no discovery, no monitor, no history read');

		engine.realm.activate(APP);
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'the first discovery after activation');
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'history read once activated');
		assert.deepEqual(nonStatePosts(mounted.spy.posts), [], 'still no event or call posts');
		mounted.controller.dispose();
	});

	it('rocket-ui: signing in after the sidebar booted still reads nothing (no history file) until the tool is activated', async () => {
		const engine = rocketRealm();
		const mounted = mountController(engine.cm);
		engine.realm.login(account('u1'));
		await settle();
		assert.equal(mounted.controller.identity.get().known, true, 'the premise: the identity is known');
		assert.deepEqual(engine.requests, [], 'no history read, no discovery, before activation');
		engine.realm.activate(APP);
		await until(() => engine.requests.some((r) => r.op === 'client.fsStat'), 'history read once activated');
		mounted.controller.dispose();
	});

	it('a user action in the sidebar activates it too, and opens the document it names', async () => {
		const engine = rocketRealm();
		engine.realm.login(account('u1'));
		const mounted = mountController(engine.cm);
		const env = mounted.controller.env(true);
		env.openDocument({ kind: 'connections' });
		assert.deepEqual(mounted.docs.opened, [{ key: '', title: 'Graph Explorer' }]);
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'discovery after the click');
		mounted.controller.dispose();
	});

	it('VS Code (the sidebar mounts lazily: the mount is the activation) still waits for a known identity', async () => {
		const engine = vscodeRealm();
		const mounted = mountController(engine.cm);
		await settle();
		assert.equal(mounted.controller.activation.isOpen(), false, 'not connected yet: the realm cannot be classified');
		assert.deepEqual(engine.requests, []);
		signInVsCode(engine.realm);
		await until(() => engine.requests.some((r) => r.op === 'client.getTasks'), 'discovery once signed in');
		assert.equal(mounted.controller.activation.reason(), 'lazyMount');
		assert.deepEqual(nonStatePosts(mounted.spy.posts), []);
		mounted.controller.dispose();
	});
});

describe('T7 - identity fails closed', () => {
	it('a connected realm with no account discovers nothing, and a frame\'s refresh is refused as data', async () => {
		const engine = vscodeRealm();
		engine.realm.root.connect(null);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await settle();
		await assert.rejects(frame.caller.callReply(OP.refreshEndpoints, {}, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		await settle();
		assert.ok(!engine.requests.some((r) => r.op === 'client.getTasks'), 'no discovery call without an identity');
		frame.dispose();
		mounted.controller.dispose();
	});

	it('VS Code: account A -> disconnect -> reconnect -> account B closes every connection document and clears the frames\' caches', async () => {
		const engine = vscodeRealm([graphRow(), graphRow({ ownerId: 'u2', token: 'tk_b' })]);
		signInVsCode(engine.realm, 'u1');
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const doc = mountFrame(mounted.h, 'workbench:k1|a');
		const landing = mountFrame(mounted.h, undefined);
		await until(() => doc.frame.guard.first() !== null && landing.frame.guard.first() !== null, 'the frames to learn account A');
		const fingerprintA = doc.frame.guard.first();

		engine.realm.root.disconnect();
		mounted.h.setHostConnection(false);
		await settle();
		assert.deepEqual(doc.docs.closed, [], 'a drop alone closes nothing');
		mounted.h.setHostConnection(true);
		engine.realm.root.connect(account('u2'));
		await until(() => doc.docs.closed.length > 0, 'the document to close for account B');
		assert.deepEqual(doc.docs.closed, ['workbench:k1|a']);
		assert.equal(doc.frame.lastReset(), 'identity');
		assert.deepEqual(landing.docs.closed, [], 'the landing is never closed');
		assert.notEqual(landing.frame.guard.first(), fingerprintA, 'the landing adopted account B');
		assert.equal(landing.frame.lastReset(), 'identity', 'and cleared its caches');
		doc.frame.dispose();
		landing.frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T8 - host:connection false: frames stop running and drop what they wait for; the sidebar follows isConnected', () => {
	it('pending calls reject, new calls are refused before sending, the frame env is not ready and has no session', async () => {
		let release: (() => void) | null = null;
		const engine = vscodeRealm(undefined, (call) => (call.tool === 'read_query' ? new Promise((resolve) => { release = () => resolve(readOnlyNode(call)); }) : readOnlyNode(call)));
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const endpoint = frame.env(true).endpoints.get().endpoints[0];
		assert.equal(frame.connected.get(), true);
		const session = frame.env(true).session(endpoint);
		assert.ok(session);
		const running = session.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 25 });
		await until(() => release !== null, 'the read to reach the node');

		mounted.h.setHostConnection(false);
		await assert.rejects(running, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /may still have run/.test(error.message));
		await settle();
		assert.equal(frame.connected.get(), false);
		const env = frame.env(frame.connected.get());
		assert.equal(env.ready, false, 'run and apply are disabled');
		assert.equal(env.session(endpoint), null, 'and there is no session to send through');
		assert.equal(frame.lastReset(), 'disconnected', 'the frame cleared its caches');
		const posted = mounted.h.wire.length;
		await assert.rejects(frame.caller.callReply(OP.probe, { key: endpoint.key }, { timeoutMs: 5_000 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
		assert.equal(mounted.h.wire.length, posted, 'refused before anything was posted');
		(release as unknown as () => void)();

		// The sidebar (controller) env follows the realm's own isConnected.
		assert.equal(mounted.controller.env(false).ready, false);
		assert.equal(mounted.controller.env(false).session(endpoint), null);
		assert.equal(mounted.controller.env(true).ready, true);
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('R8 - the schema click that summons a cold frame is not lost, and runs once', () => {
	it('a preview requested before the workbench frame exists is taken by it, once; a later frame finds nothing', async () => {
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		await until(() => mounted.controller.stores.endpoints.getState().endpoints.length === 1, 'discovery');
		const endpoint = mounted.controller.stores.endpoints.getState().endpoints[0];
		const sidebar = mounted.controller.env(true);

		// The click: open the workbench (a cold webview in VS Code) and leave the request.
		sidebar.openDocument({ kind: 'workbench', endpoint });
		sidebar.previews.request({ endpointKey: endpoint.key, action: 'label-preview', name: 'Person' });
		assert.deepEqual(mounted.docs.opened, [{ key: `workbench:${endpoint.key}`, title: endpoint.nodeName }]);

		// Seconds later the frame boots.
		await settle();
		const cold = mountFrame(mounted.h, `workbench:${endpoint.key}`);
		await until(() => cold.frame.env(true).previews.pending.get() !== null, 'the retained request in the cold frame');
		const request = cold.frame.env(true).previews.pending.get();
		assert.ok(request && previewFor(request, endpoint.key, new Set(), Date.now()), 'it is this connection\'s, and fresh');
		assert.equal(cold.frame.env(true).previews.consume(request.nonce), true, 'taken once');
		assert.equal(cold.frame.env(true).previews.consume(request.nonce), false, 'never twice');
		assert.equal(cold.frame.env(true).previews.pending.get(), null);
		await until(() => mounted.controller.stores.previews.get() === null, 'the controller to clear it');

		const later = mountFrame(mounted.h, `workbench:${endpoint.key}`);
		await settle();
		assert.equal(later.frame.env(true).previews.pending.get(), null, 'a workbench opened later replays nothing');
		cold.frame.dispose();
		later.frame.dispose();
		mounted.controller.dispose();
	});

	it('the age limit is a backstop only: a request nobody took within a minute is not run', () => {
		const request = { nonce: 'n1', endpointKey: 'k', action: 'label-preview' as const, name: 'P', at: 1_000 };
		assert.ok(previewFor(request, 'k', new Set(), 1_000 + 30_000), 'a request from a cold summon seconds ago runs');
		assert.equal(previewFor(request, 'k', new Set(), 1_000 + PREVIEW_MAX_AGE_MS + 1), null);
		assert.equal(previewFor(request, 'other', new Set(), 1_000), null, 'another connection\'s request');
		assert.equal(previewFor(request, 'k', new Set(['n1']), 1_000), null, 'a request this realm already took');
	});
});
