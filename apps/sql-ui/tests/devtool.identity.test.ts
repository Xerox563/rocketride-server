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
import { getSavedConnections, resetSavedConnections } from '../src/connect';
import { refreshSchema, schemaSnapshot } from '../src/schema/schemaStore';
import { attachSqlController } from '../src/sqlController';
import type { SqlControllerMount } from '../src/sqlController';
import { attachSqlFrame, sqlChannel } from '../src/sqlFrame';
import { createRemoteSqlEnv } from '../src/sqlEnv';
import { createRemoteHistory } from '../src/history/remoteHistory';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { taskRow } from './support';
import { engineScript, scriptedSocketlessRealm, until } from './realm';
import { PIPELINE, postgres } from './devtoolRig';

const SRC = path.resolve(__dirname, '..', 'src');
const USER_A = account('uA', 'org-1', 'team-1');
const USER_B = account('uB', 'org-1', 'team-1');

/**
 * A VS Code-style controller and one connection frame.
 *
 * @param tool - The engine's tool answers.
 * @returns The rig.
 */
async function vscodeRig(tool: (params: { tool: string }) => unknown = postgres) {
	resetSavedConnections({ force: true });
	const h = createDevToolHarness(SQL_APP_ID, { json: true });
	const engine = scriptedSocketlessRealm(engineScript([PIPELINE], [taskRow('p1', { ownerId: 'uA' }), taskRow('p1', { ownerId: 'uB', token: 'tk_sentinel_b' })], tool));
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
		assert.match(devTool, /createRemoteSqlEnv\(mount\.frame\.caller, engineReady,/);
		const query = fs.readFileSync(path.join(SRC, 'views', 'QueryView.tsx'), 'utf8');
		assert.match(query, /const canRun = env\.ready && /);
		const design = fs.readFileSync(path.join(SRC, 'views', 'TableDesignView.tsx'), 'utf8');
		assert.match(design, /disabled=\{pendingCount === 0 \|\| applying \|\| !env\.ready\}/);
		const sidebar = fs.readFileSync(path.join(SRC, 'SqlSidebar.tsx'), 'utf8');
		assert.match(sidebar, /const \{ isConnected \} = useShellConnection\(\);/);
		assert.doesNotMatch(sidebar, /useConnectionReady/);
	});
});
