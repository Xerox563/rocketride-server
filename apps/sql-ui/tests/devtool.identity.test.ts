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
// SQL DEV TOOL — IDENTITY (T7) AND THE HOST CONNECTION (T8)
// =============================================================================
//
// A VS Code-style realm: the controller's ConnectionManager has no client and
// follows the extension host's retained `shell:account` topic (the dev-tool
// library's fake socketless realm). The controller vouches for a fingerprint
// on the retained `identity` topic; each frame remembers the first one it saw
// and closes its document (and clears its caches) when another arrives. The
// controller of a VS Code webview unmounts on a disconnect and mounts again,
// so the frames compare fingerprints, never counters.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import { account, createDevToolHarness, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { FrameResetReason } from 'shared/explorer/devtool/frameIdentity';
import { SQL_APP_ID } from '../src/appId';
import { PREFS_FILE_VERSION } from 'shared/explorer/devtool/prefs';
import { getSavedConnections, getSavedConnectionsStatus, resetSavedConnections } from '../src/connect';
import type { HistoryEntry } from '../src/history/types';
import { refreshSchema, schemaSnapshot } from '../src/schema/schemaStore';
import { attachSqlController } from '../src/sqlController';
import type { SqlControllerMount } from '../src/sqlController';
import { SIDEBAR_CLOSED_TEXT, attachSqlFrame, connectionDocState, followControllerReady, followVouched, plainFrameError, sqlChannel } from '../src/sqlFrame';
import { createRemoteSqlEnv } from '../src/sqlEnv';
import { createRemoteHistory } from '../src/history/remoteHistory';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { taskRow } from './support';
import { SAVED_PATH, engineScript, scriptedSocketlessRealm, until } from './realm';
import { PIPELINE, postgres } from './devtoolRig';

const SRC = path.resolve(__dirname, '..', 'src');
const USER_A = account('uA', 'org-1', 'team-1');
const USER_B = account('uB', 'org-1', 'team-1');
const FP_A = 'uA|org-1|team-1';
const FP_B = 'uB|org-1|team-1';
const HISTORY_PATH = '@/User/.workspace/rocketride.sql.history.json';
const KEY = 'p1:s1:db_1';

/** A finished statement. */
const entry = (id: string, sql: string, at: number): HistoryEntry => ({ id, sql, at, ms: 3, outcome: 'rows', rows: 1, kind: 'read' });

/**
 * A history file holding one statement for each account.
 *
 * @returns The file, in the dev-tool library's format.
 */
function historyOfBoth(): unknown {
	const owner = (id: string, sql: string, at: number): unknown => ({ at: 1, prefs: { 'sql.history': { [KEY]: [entry(id, sql, at)] }, 'sql.historyRecording': {} } });
	return { version: PREFS_FILE_VERSION, owners: { [FP_A]: owner('a1', 'SELECT salary FROM a_only', 10), [FP_B]: owner('b1', 'SELECT 1', 20) } };
}

/**
 * Hold the engine's answers to some requests until released.
 *
 * @param r - The rig's scripted engine.
 * @param ops - The ops to hold.
 * @param when - Which requests of those ops to hold.
 * @returns Release everything held so far (and stop holding).
 */
function hold(r: { engine: { script: Record<string, (params: unknown) => unknown> } }, ops: string[], when: (params: unknown) => boolean = () => true): { held: () => number; release: () => void } {
	const waiting: Array<() => void> = [];
	let holding = true;
	for (const op of ops) {
		const answer = r.engine.script[op]!;
		r.engine.script[op] = (params) => (holding && when(params)
			? new Promise((resolve, reject) => { waiting.push(() => { try { resolve(answer(params)); } catch (error) { reject(error); } }); })
			: answer(params));
	}
	return {
		held: () => waiting.length,
		release() {
			holding = false;
			waiting.splice(0).forEach((go) => go());
		},
	};
}

/** Whether a request is for the history file. */
const historyFileRequest = (params: unknown): boolean => (params as { path?: string } | null)?.path === HISTORY_PATH;

/**
 * A VS Code-style controller and one connection frame.
 *
 * @param tool - The engine's tool answers.
 * @param files - Other files in the user's store.
 * @returns The rig.
 */
async function vscodeRig(tool: (params: { tool: string }) => unknown = postgres, files: Record<string, unknown> = {}) {
	resetSavedConnections({ force: true });
	const h = createDevToolHarness(SQL_APP_ID, { json: true });
	const engine = scriptedSocketlessRealm(engineScript([PIPELINE], [taskRow('p1', { ownerId: 'uA' }), taskRow('p1', { ownerId: 'uB', token: 'tk_sentinel_b' })], tool, files));
	const sidebar = spyPeer(h.sidebarPeer);
	const hostChannel = shellProtocol.createToolChannel(sidebar.peer);
	const mountController = (): SqlControllerMount => attachSqlController({ peer: sidebar.peer, channel: hostChannel, cm: engine.cm, protocol: shellProtocol, focusTarget: null });
	let controller = mountController();
	const closed: string[] = [];
	const resets: FrameResetReason[] = [];
	const framePeer = spyPeer(h.newFramePeer());
	let history: ReturnType<typeof createRemoteHistory> | null = null;
	const frame = attachSqlFrame({
		peer: framePeer.peer,
		docKey: 'c-pipe',
		documents: { open: () => undefined, close: (key) => { closed.push(key); } },
		protocol: shellProtocol,
		onReset: (reason) => {
			resets.push(reason);
			history?.reset();
		},
	});
	history = createRemoteHistory({ caller: frame.caller, channel: sqlChannel(frame.channel), owner: frame.owner });
	const env = createRemoteSqlEnv(frame.caller, true, frame.owner, history);
	await settle();
	return {
		h, engine, frame, framePeer, env, closed, resets,
		get controller() { return controller; },
		remount() { controller = mountController(); return controller; },
		dispose() {
			history?.dispose();
			frame.dispose();
			controller.dispose();
		},
	};
}

describe('T7 — identity fails closed, and a frame of another account closes itself', () => {
	it('a null account means no discovery call: nothing is discovered or read for nobody', async () => {
		const r = await vscodeRig();
		try {
			r.engine.realm.root.connect(null);
			r.h.setHostConnection(true);
			await settle();
			await assert.rejects(r.env.resolveEndpoint(PIPELINE), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
			await settle();
			assert.equal(r.engine.ops().includes('client.getTasks'), false);
			assert.equal(r.engine.ops().includes('client.fsReadJson'), false);
			assert.equal(r.frame.owner(), null);
		} finally {
			r.dispose();
		}
	});

	it('VS Code sequence: account A, disconnect, reconnect, account B after shell:connected: the frame closes its document and clears its caches', async () => {
		const r = await vscodeRig();
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() !== null, 'the frame to see account A');
			const fingerprintA = r.frame.owner();
			await until(() => getSavedConnections().length === 1, 'A\'s saved list');
			// Some state the frame holds for A: a schema snapshot.
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			await refreshSchema(r.env.getSession(endpoint));
			assert.equal(schemaSnapshot(endpoint.key).status, 'ready');

			// The connection drops: the extension host publishes the status, then a
			// null account; the host marks the connection down; the webview's
			// controller unmounts.
			r.engine.realm.root.disconnect();
			r.h.setHostConnection(false);
			r.controller.dispose();
			await settle();
			assert.ok(r.resets.includes('disconnected'), 'host:connection false resets the frame');
			assert.deepEqual(r.closed, [], 'a drop alone closes nothing');
			assert.equal(schemaSnapshot(endpoint.key).status, 'idle', 'caches cleared on the drop');

			// Reconnect: the controller mounts again (its counters restart), the
			// status arrives first, then account B.
			r.remount();
			r.engine.realm.root.connect(USER_B);
			r.h.setHostConnection(true);
			await until(() => r.closed.length > 0, 'the frame to close itself');
			assert.deepEqual(r.closed, ['c-pipe']);
			assert.ok(r.resets.includes('identity'));
			assert.notEqual(r.frame.owner(), fingerprintA);
			assert.equal(schemaSnapshot(endpoint.key).status, 'idle');
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('the same account coming back after a drop closes nothing', async () => {
		const r = await vscodeRig();
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() !== null, 'account A');
			r.engine.realm.root.disconnect();
			r.h.setHostConnection(false);
			r.controller.dispose();
			await settle();
			r.remount();
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await settle();
			assert.deepEqual(r.closed, []);
		} finally {
			r.dispose();
		}
	});

	it('a write from a frame that belongs to account A is refused once B is signed in', async () => {
		const r = await vscodeRig();
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() !== null, 'account A');
			const ownerA = r.frame.owner();
			r.engine.realm.root.accountChanged(USER_B);
			await until(() => r.closed.length > 0, 'the frame to close itself');
			await assert.rejects(
				r.frame.caller.callReply('sql.saveConnection', { connection: { ...PIPELINE, id: 'c-a' }, owner: ownerA }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] }),
				(error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale',
			);
		} finally {
			r.dispose();
		}
	});
});

describe('T7 — an account change in a mounted controller: nothing of the previous account is served, kept or written', () => {
	it('while the next account\'s history file is read, the previous account\'s statements are never served from memory', async () => {
		const r = await vscodeRig(postgres, { [HISTORY_PATH]: historyOfBoth() });
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			const read = async (): Promise<string[]> => (await r.frame.caller.callReply('sql.history', { connId: 'c-pipe' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] })).map((e) => e.id);
			await until(() => r.controller.history.getHistory(KEY).length > 0, 'A\'s history file');
			assert.deepEqual(await read(), ['a1']);

			// B's history file is slow to answer (the library retries for seconds).
			const slow = hold(r, ['client.fsStat', 'client.fsReadJson'], historyFileRequest);
			r.engine.realm.root.accountChanged(USER_B);
			await until(() => r.frame.owner() === FP_B, 'account B');
			await until(() => slow.held() > 0, 'B\'s history file to be asked for');
			assert.deepEqual(r.controller.history.getHistory(KEY), [], 'nothing of A\'s is left in memory');
			assert.deepEqual(await read(), [], 'B is not served A\'s statements');
			assert.equal(getSavedConnectionsStatus(), 'ready', 'B\'s saved list was read: the read above really ran');

			// B's own file arrives: B's statements, and only those.
			slow.release();
			await until(() => r.controller.history.getHistory(KEY).length > 0, 'B\'s history file');
			assert.deepEqual(await read(), ['b1']);
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('an account change clears the controller\'s own caches at once: endpoints, probes, the saved list and history', async () => {
		const r = await vscodeRig(postgres, { [HISTORY_PATH]: historyOfBoth() });
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			await r.env.resolveEndpoint(PIPELINE);
			const core = r.controller.core;
			await until(() => core.endpoints.getState().endpoints.length > 0 && Object.keys(core.endpoints.getState().probes).length > 0, 'A\'s endpoints and probes');
			await until(() => r.controller.history.getHistory(KEY).length > 0, 'A\'s history');
			assert.equal(getSavedConnections().length, 1);

			// Nothing B asks for answers yet: what is left is what was not cleared.
			const slow = hold(r, ['client.getTasks', 'client.fsStat', 'client.fsReadJson']);
			r.engine.realm.root.accountChanged(USER_B);
			await settle();
			assert.deepEqual(core.endpoints.getState().endpoints, [], 'endpoints');
			assert.deepEqual(core.endpoints.getState().probes, {}, 'probes');
			assert.deepEqual(getSavedConnections(), [], 'the saved list');
			assert.deepEqual(r.controller.history.getHistory(KEY), [], 'history');
			slow.release();
		} finally {
			r.dispose();
		}
	});

	it('a sign-out forgets the account\'s history at once (not at the next sign-in)', async () => {
		const r = await vscodeRig(postgres, { [HISTORY_PATH]: historyOfBoth() });
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.controller.history.getHistory(KEY).length > 0, 'A\'s history');
			r.engine.realm.root.accountChanged(null);
			await settle();
			assert.deepEqual(r.controller.history.getHistory(KEY), []);
			assert.deepEqual(getSavedConnections(), []);
			assert.deepEqual(r.controller.core.endpoints.getState().endpoints, []);
		} finally {
			r.dispose();
		}
	});

	it('a change account A asked for, still waiting for the saved list, is refused once B is signed in and never reaches B\'s list', async () => {
		const r = await vscodeRig();
		try {
			// A's saved list is slow to read: the save waits for it.
			const slowList = hold(r, ['client.fsReadJson'], (params) => (params as { path?: string }).path === SAVED_PATH);
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			const call = (op: 'sql.saveConnection' | 'sql.deleteConnection', params: Record<string, unknown>): Promise<unknown> => r.frame.caller.callReply(op, { ...params, owner: FP_A } as never, { timeoutMs: SQL_OP_TIMEOUT_MS[op] });
			const saving = call('sql.saveConnection', { connection: { ...PIPELINE, id: 'c-from-a', name: 'From A' } });
			const deleting = call('sql.deleteConnection', { connId: 'c-pipe' });
			await until(() => slowList.held() > 0, 'A\'s list read');

			// B signs in; B's list reads at once (A's read never answers).
			const heldForA = slowList.held();
			r.engine.script['client.fsReadJson'] = engineScript([PIPELINE], [])['client.fsReadJson']!;
			r.engine.realm.root.accountChanged(USER_B);
			await assert.rejects(saving, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			await assert.rejects(deleting, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			assert.equal(heldForA, 1);
			assert.equal(getSavedConnectionsStatus(), 'ready');
			assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe'], 'B\'s list is untouched');
			assert.equal(r.engine.requests.some((q) => q.op === 'client.fsWriteJson' && (q.params as { path: string }).path === SAVED_PATH), false, 'nothing was written');
		} finally {
			r.dispose();
		}
	});
});

describe('T7 — a frame calls nothing on its own until the controller vouches for an account', () => {
	it('follows the controller\'s retained identity: unknown, then signed in, then signed out', async () => {
		const r = await vscodeRig();
		const seen: boolean[] = [];
		const off = followVouched(r.frame.channel, (vouched) => { seen.push(vouched); });
		try {
			r.h.setHostConnection(true);
			await settle();
			assert.equal(seen.at(-1) ?? false, false, 'nobody yet');
			r.engine.realm.root.connect(USER_A);
			await until(() => seen.at(-1) === true, 'account A');
			r.engine.realm.root.accountChanged(null);
			await until(() => seen.at(-1) === false, 'the sign-out');
		} finally {
			off();
			r.dispose();
		}
	});

	it('a frame is ready (opening its connection, the first schema read, run and apply) only with the host connection, a ready controller AND a vouched account', () => {
		const devTool = fs.readFileSync(path.join(SRC, 'SqlDevTool.tsx'), 'utf8');
		assert.match(devTool, /const vouched = useVouched\(toolChannel\);/);
		assert.match(devTool, /const controllerReady = useControllerReady\(toolChannel\);/);
		assert.match(devTool, /const ready = engineReady && controllerReady && vouched;/);
		assert.match(devTool, /createRemoteSqlEnv\(mount\.frame\.caller, ready,/);
		// The automatic calls are the ones gated on env.ready.
		const doc = devTool.slice(devTool.indexOf('const SqlConnectionDocument'));
		assert.match(doc, /if \(!env\.ready \|\| !conn\) return;/);
		const view = fs.readFileSync(path.join(SRC, 'views', 'ConnectionView.tsx'), 'utf8');
		assert.match(view, /if \(env\.ready && snapshot\.status === 'idle'\)/);
		const diagram = fs.readFileSync(path.join(SRC, 'views', 'DiagramView.tsx'), 'utf8');
		assert.match(diagram, /if \(!env\.ready \|\| engineeredRef\.current\) return;/);
	});
});

describe('a frame restored before its sidebar was opened says to open it, and never speaks an op\'s wire name', () => {
	it('follows the controller\'s readiness: ready while mounted, not after it unmounts, ready again on a remount', async () => {
		const r = await vscodeRig();
		const seen: boolean[] = [];
		const off = followControllerReady(r.frame.channel, (ready) => { seen.push(ready); });
		try {
			await settle();
			assert.equal(seen.at(-1), true);
			r.controller.dispose();
			await settle();
			assert.equal(seen.at(-1), false);
			r.remount();
			await settle();
			assert.equal(seen.at(-1), true);
		} finally {
			off();
			r.dispose();
		}
	});

	it('a call made while no controller is ready times out unsent with the open-the-sidebar text, not the op\'s name', async () => {
		const r = await vscodeRig();
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() !== null, 'account A');
			r.controller.dispose();
			await settle();
			assert.equal(r.frame.caller.controllerReady(), false);
			await assert.rejects(r.frame.caller.callReply('sql.dialect', { connId: 'c-pipe' }, { timeoutMs: 40 }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && error.message === SIDEBAR_CLOSED_TEXT && error.headline === SIDEBAR_CLOSED_TEXT);
			assert.equal(r.engine.requests.some((q) => q.op === 'client.tool'), false, 'nothing was sent');
		} finally {
			r.dispose();
		}
	});

	it('the library\'s own texts read "the request" instead of the wire name; kind, tool and code are kept; other errors pass through', () => {
		const lost = new ExplorerToolError({ kind: 'timeout', tool: 'sql.execute', message: 'Lost the connection while \'sql.execute\' was running. It may still have run; there is no way to cancel it from here.' });
		const plain = plainFrameError(lost) as ExplorerToolError;
		assert.equal(plain.message, 'Lost the connection while the request was running. It may still have run; there is no way to cancel it from here.');
		assert.equal(plain.kind, 'timeout');
		assert.equal(plain.tool, 'sql.execute');
		const dropped = plainFrameError(new ExplorerToolError({ kind: 'stale', tool: 'sql.history', message: '\'sql.history\' was dropped: its frame closed.' })) as ExplorerToolError;
		assert.equal(dropped.message, 'The request was dropped: its frame closed.');
		const coded = plainFrameError(new ExplorerToolError({ kind: 'unavailable', tool: 'sql.dialect', code: 'X', message: 'Not connected to a server, so \'sql.dialect\' was not sent.' })) as ExplorerToolError;
		assert.equal(coded.message, 'Not connected to a server, so the request was not sent.');
		assert.equal(coded.code, 'X');
		const own = new ExplorerToolError({ kind: 'raised', tool: 'execute', message: 'relation "orders" does not exist' });
		assert.equal(plainFrameError(own), own);
		const other = new Error('boom');
		assert.equal(plainFrameError(other), other);
	});

	it('a document that has not opened says to open the sidebar; one already open stays open', () => {
		const base = { ready: false, listStatus: 'ready' as const, found: true, failed: false, opened: false };
		assert.equal(connectionDocState({ ...base, sidebarClosed: true }), 'no-sidebar');
		assert.equal(connectionDocState({ ...base, sidebarClosed: true, opened: true }), 'open');
		assert.equal(connectionDocState({ ...base, sidebarClosed: true, opened: true, failed: true }), 'no-sidebar');
		assert.equal(connectionDocState({ ...base, sidebarClosed: false }), 'not-connected');
		const devTool = fs.readFileSync(path.join(SRC, 'SqlDevTool.tsx'), 'utf8');
		assert.match(devTool, /const sidebarClosed = engineReady && !controllerReady;/);
		assert.match(devTool, /case 'no-sidebar':\s*body = <SidebarClosed \/>;/);
		assert.match(devTool, /title="Open the SQL Explorer sidebar to connect"/);
		const editor = fs.readFileSync(path.join(SRC, 'components', 'ConnectionEditorBody.tsx'), 'utf8');
		assert.match(editor, /if \(sidebarClosed\) return /);
	});
});

describe('T8 — with host:connection false, frames disable run/apply and reject pending calls; the sidebar uses isConnected', () => {
	it('a pending call is rejected the moment the host connection drops (it may still have run), and a new one is not sent', async () => {
		let release: () => void = () => undefined;
		const r = await vscodeRig((params) => {
			if (params.tool === 'execute') return new Promise((resolve) => { release = () => resolve({ rows: [], affected_rows: 0 }); });
			return postgres(params);
		});
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() !== null, 'account A');
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			const pending = session.execute('SELECT pg_sleep(60)');
			await until(() => r.engine.requests.some((q) => q.op === 'client.tool' && (q.params as { tool: string }).tool === 'execute'), 'the statement to reach the node');
			r.h.setHostConnection(false);
			await assert.rejects(pending, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout' && /may still have run/.test(error.message));
			const posts = r.framePeer.posts.length;
			await assert.rejects(session.dialect(), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
			assert.equal(r.framePeer.posts.length, posts, 'nothing was posted while the host connection is down');
			release();
		} finally {
			r.dispose();
		}
	});

	it('run and apply follow the host connection in frames, and the sidebar follows the shell\'s isConnected', () => {
		const devTool = fs.readFileSync(path.join(SRC, 'SqlDevTool.tsx'), 'utf8');
		assert.match(devTool, /const engineReady = useConnectionReady\(toolChannel\);/);
		assert.match(devTool, /const ready = engineReady && controllerReady && vouched;/);
		assert.match(devTool, /createRemoteSqlEnv\(mount\.frame\.caller, ready,/);
		const query = fs.readFileSync(path.join(SRC, 'views', 'QueryView.tsx'), 'utf8');
		assert.match(query, /const canRun = env\.ready && /);
		const design = fs.readFileSync(path.join(SRC, 'views', 'TableDesignView.tsx'), 'utf8');
		assert.match(design, /disabled=\{pendingCount === 0 \|\| applying \|\| !env\.ready\}/);
		const sidebar = fs.readFileSync(path.join(SRC, 'SqlSidebar.tsx'), 'utf8');
		assert.match(sidebar, /const \{ isConnected \} = useShellConnection\(\);/);
		assert.doesNotMatch(sidebar, /useConnectionReady/);
	});
});
