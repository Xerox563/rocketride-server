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
// SQL DEV TOOL — the controller and its frames over the REAL shell modules
// =============================================================================
//
// The controller (sqlController.ts) and a frame (sqlFrame.ts + the REMOTE
// SqlEnv) wired exactly as the hosts wire them, over the shell's real
// busPeer, toolOps, toolChannel and retained registry (the dev-tool
// library's harness), with the JSON wire ON: every payload crosses as its
// JSON image, as VS Code's postMessage carries it. The engine behind the
// controller is a scripted fake realm (realm.ts).
//
// T1 descriptor and manifest; T2 frames hold no client; T3 every op
// round-trips; T4 timeouts on both lanes; T5 lifecycle; T6 quiet sidebar;
// T9 docKey routing; T10 the controller's own write checks; T11 retained
// state stays small; T13 deadlines. T7/T8 (identity, host connection) are in
// devtool.identity.test.ts.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import { assertJsonSafe, assertSidebarSubscribers, createDevToolHarness, findToolFactoryImports, manualNow, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import { BUS_TOOL_MARGIN_MS, FRAME_OP_MARGIN_MS, GET_TASKS_TIMEOUT_MS, MAX_TIMER_MS, SDK_TIMEOUT_SLACK_MS, UNBOUNDED_TOOL_TIMEOUT_MS } from 'shared/explorer/devtool/timeouts';
import { DEFAULT_RETRY_WINDOW_MS } from 'shared/explorer/connect/session';
import { MAX_RETAINED_STATE_BYTES, MAX_RETAINED_TOTAL_BYTES, jsonByteLength } from 'shared/explorer/devtool/state';
import { CONTROLLER_STATE_TOPIC, RESERVED_STATE_PREFIX } from 'shared/explorer/devtool/realm';
import { SQL_APP_ID } from '../src/appId';
import { applyReplicaConnections, deleteSavedConnection, endpointForConnection, endpointKeyForConnection, getSavedConnections, getSavedConnectionsPartial, getSavedConnectionsStatus, ownSavedConnections, resetSavedConnections } from '../src/connect';
import type { PipelineBoundConnection, SavedSqlConnection } from '../src/connect';
import { lookupConnection } from '../src/connectionRecord';
import { MAX_WATCHED_HISTORY_KEYS, attachSqlController, checkExecuteInput, checkSchemaInput } from '../src/sqlController';
import type { ConnectionsState, HistoryState } from '../src/ops';
import { connectionDocState, directReleaseKey, routeDocKey, sqlChannel } from '../src/sqlFrame';
import { RESOLVE_BUDGET_MS, SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { DIALECT_WAIT_MS, GET_SCHEMA_WAIT_MS, REFRESH_SCHEMA_WAIT_MS } from '../src/connect/tools';
import { SAVED_PATH, USER, engineScript, scriptedClientRealm, until } from './realm';
import { taskRow } from './support';
import { DIRECT, PIPELINE, postgres, rig, toolRequests } from './devtoolRig';

const SRC = path.resolve(__dirname, '..', 'src');

/**
 * Many saved connections, each bound to its own pipeline (about 230 bytes of
 * JSON each, so a few hundred exceed the 64 KiB retained-state cap).
 *
 * @param n - How many.
 * @returns The records.
 */
function many(n: number): PipelineBoundConnection[] {
	return Array.from({ length: n }, (_, i) => ({ id: `c-${i}`, mode: 'pipeline' as const, name: `Warehouse connection ${i}`, projectId: `p-${i}-0f8fad5b-d9cb-469f-a165-70867728950e`, pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' }));
}

/**
 * The last snapshot the controller retained on each topic.
 *
 * @param posts - The sidebar peer's posts.
 * @returns Snapshot by topic.
 */
function retained(posts: unknown[]): Map<string, unknown> {
	const last = new Map<string, unknown>();
	for (const post of posts) {
		const p = post as { __rrtool?: string; topic?: string; snapshot?: unknown };
		if (p.__rrtool === 'state' && typeof p.topic === 'string') last.set(p.topic, p.snapshot);
	}
	return last;
}

/**
 * Read a source file of the app.
 *
 * @param rel - Path under src/.
 * @returns Its text.
 */
function source(rel: string): string {
	return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/**
 * Every source file reachable from one file through relative imports.
 *
 * @param entry - Path under src/.
 * @returns The reachable files (paths under src/).
 */
function importGraph(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (rel: string): void => {
		if (seen.has(rel)) return;
		seen.add(rel);
		const text = source(rel);
		for (const match of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
			const target = path.normalize(path.join(path.dirname(rel), match[1] as string));
			const candidates = [`${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts')];
			const found = candidates.find((candidate) => fs.existsSync(path.join(SRC, candidate)));
			if (found) visit(found);
		}
	};
	visit(entry);
	return [...seen].sort();
}

// =============================================================================
// T1 — DESCRIPTOR AND MANIFEST
// =============================================================================

describe('T1 — the descriptor exports both dev-tool mounts; the manifest is a dev tool; the id is unchanged', () => {
	it('AppDescriptor names SqlDevTool as devToolFrame and SqlDevToolSidebar as devToolSidebar, under the manifest id', () => {
		const descriptor = source('AppDescriptor.ts');
		assert.match(descriptor, /devToolFrame: SqlDevTool,/);
		assert.match(descriptor, /devToolSidebar: SqlDevToolSidebar,/);
		assert.match(descriptor, /id: SQL_APP_ID,/);
		assert.match(source('SqlDevTool.tsx'), /export const SqlDevTool: React\.FC<DevToolProps>/);
		assert.match(source('SqlSidebar.tsx'), /export const SqlDevToolSidebar: React\.FC<DevToolProps>/);
		const manifest = JSON.parse(fs.readFileSync(path.resolve(SRC, '..', 'package.json'), 'utf8')).appManifest as { id: string; categories: string[] };
		assert.equal(manifest.id, 'rocketride.sql');
		assert.equal(SQL_APP_ID, manifest.id);
		assert.ok(manifest.categories.includes('devTool'));
	});
});

// =============================================================================
// T2 — FRAMES HOLD NO CLIENT
// =============================================================================

describe('T2 — frame modules never import or use a client', () => {
	it('nothing reachable from the frame mount imports the engine core, the bus client, or a ConnectionManager / shell connection', () => {
		const files = importGraph('SqlDevTool.tsx');
		assert.ok(files.includes('sqlFrame.ts') && files.includes('sqlEnv.ts') && files.includes('views/QueryView.tsx'), 'the walk reaches the frame wiring and the views');
		for (const forbidden of ['sqlCore.ts', 'localEnv.ts', 'sqlController.ts', 'SqlApp.tsx', 'SqlSidebar.tsx']) {
			assert.equal(files.includes(forbidden), false, `the frame reaches ${forbidden}`);
		}
		for (const file of files) {
			const text = source(file);
			assert.doesNotMatch(text, /shared\/explorer\/devtool\/busClient/, `${file} imports the bus client`);
			assert.doesNotMatch(text, /\bConnectionManager\b/, `${file} names ConnectionManager`);
			assert.doesNotMatch(text, /\buseShellConnection\b/, `${file} reads the shell connection`);
			assert.doesNotMatch(text, /\.request\(\s*'client\./, `${file} sends a client op`);
		}
	});

	it('the protocol factories are imported in ONE wiring module (sqlBridge.ts), so no view can build a stray subscriber', () => {
		const all = fs.readdirSync(SRC, { recursive: true }).filter((file): file is string => typeof file === 'string' && /\.tsx?$/.test(file));
		const files = all.map((file) => ({ path: file.split(path.sep).join('/'), text: source(file) }));
		assert.deepEqual(findToolFactoryImports(files), ['sqlBridge.ts']);
	});

	it('a frame works with no client at all: its only way out is its peer', async () => {
		const r = await rig();
		try {
			// attachSqlFrame takes no ConnectionManager and no client; everything below rides the peer.
			assert.deepEqual(await r.env.resolveEndpoint(PIPELINE), { key: 'p1:s1:db_1', connId: 'c-pipe', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', nodeName: 'Orders', provider: 'db_postgres', running: true });
			assert.ok(r.frameCalls.some((call) => call.op === 'sql.resolveEndpoint'));
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T3 — EVERY OP ROUND-TRIPS
// =============================================================================

describe('T3 — every op round-trips JSON-safe; failures come back as equal ExplorerToolErrors', () => {
	it('each op answers through the JSON wire, args and results JSON-safe, nothing JSON would change on the wire', async () => {
		const r = await rig();
		r.engine.script['client.getService'] = () => ({ title: 'MySQL', Pipe: { schema: {} } });
		r.engine.script['client.validate'] = () => ({ errors: [], warnings: [] });
		r.engine.script['client.getEnvironmentKeys'] = () => ['ROCKETRIDE_DB_PASSWORD'];
		r.engine.script['client.use'] = () => ({});
		r.engine.script['client.getTaskToken'] = () => 'tk_sentinel_direct';
		r.engine.script['client.terminate'] = () => ({});
		try {
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			const session = r.env.getSession(endpoint);
			const results: Record<string, unknown> = {
				execute: await session.execute('SELECT * FROM orders', { params: ['x', 1, null], idempotent: true }),
				getSchema: await session.getSchema(),
				refreshSchema: await session.refreshSchema(),
				dialect: await session.dialect(),
				discover: await r.env.discoverEndpoints(),
				service: await r.env.getService('db_mysql'),
				validate: await r.env.validate({ version: 1, component: { id: 'db_mysql_1', provider: 'db_mysql', config: {} } }),
				envKeys: await r.env.getEnvironmentKeys(),
				connection: await r.env.getConnection('c-pipe'),
				noConnection: await r.env.getConnection('c-none'),
			};
			assert.deepEqual(results.connection, PIPELINE);
			assert.equal(results.noConnection, null);
			const owner = r.frame.owner();
			const entry = { id: 'h1', sql: 'SELECT 1', at: 1, ms: 2, outcome: 'rows' as const, rows: 1, kind: 'read' as const };
			await r.frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
			await r.frame.caller.callReply('sql.historyEdit', { connId: 'c-pipe', edit: { action: 'pin', id: 'h1' }, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyEdit'] });
			results.history = await r.frame.caller.callReply('sql.history', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			assert.deepEqual(results.history, [{ ...entry, pinned: true }]);
			await r.env.saveConnection({ ...PIPELINE, id: 'c-new', name: 'New' });
			await r.env.deleteConnection({ ...PIPELINE, id: 'c-new', name: 'New' });
			// The direct document's release carries the key it opened, and the
			// controller sees it.
			const released: Array<[string, string | undefined]> = [];
			const release = r.mount.core.release.bind(r.mount.core);
			r.mount.core.release = (connId, key) => {
				released.push([connId, key]);
				return release(connId, key);
			};
			const directKey = endpointForConnection(DIRECT).key;
			r.env.releaseEndpoint('c-direct', directKey);
			await until(() => r.engine.ops().includes('client.terminate'), 'the release');
			assert.deepEqual(released, [['c-direct', directKey]]);
			assert.deepEqual(results.execute, { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 });
			assert.equal(results.dialect, 'postgres');
			assert.deepEqual(results.discover, [{ key: 'p1:s1:db_1', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', nodeName: 'Orders DB', provider: 'db_postgres', running: true }]);
			assert.deepEqual(results.envKeys, ['ROCKETRIDE_DB_PASSWORD']);
			for (const [name, value] of Object.entries(results)) assertJsonSafe(value, name);
			const ops = new Set(r.frameCalls.map((call) => call.op));
			for (const op of Object.keys(SQL_OP_TIMEOUT_MS)) assert.ok(ops.has(op), `${op} was called`);
			for (const [i, entry] of r.h.wire.entries()) assertJsonSafe(entry.value, `wire #${i} ${entry.topic}`);
			assert.deepEqual(r.h.violations, [], 'nothing JSON would change crossed the wire');
			// No task token and no owner-aware key ever reached the wire.
			const wire = JSON.stringify(r.h.wire);
			assert.equal(wire.includes('tk_sentinel'), false);
			assert.equal(wire.includes('k1|'), false);
		} finally {
			r.dispose();
		}
	});

	it('a node failure reaches the frame as an ExplorerToolError equal to the controller\'s, kind and code intact', async () => {
		const r = await rig({ tool: (params) => {
			if (params.tool === 'execute') throw Object.assign(new Error('Task is gone\nIt finished'), { code: 'TASK_COMPLETED' });
			return postgres(params);
		} });
		try {
			const endpoint = await r.env.resolveEndpoint(PIPELINE);
			await assert.rejects(r.env.getSession(endpoint).execute('SELECT 1'), (error: unknown) => {
				assert.ok(error instanceof ExplorerToolError);
				assert.equal(error.kind, 'raised');
				assert.equal(error.code, 'TASK_COMPLETED');
				assert.equal(error.tool, 'execute');
				assert.equal(error.headline, 'Task is gone');
				assert.equal(error.detail, 'It finished');
				return true;
			});
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('an unresolvable connection is Reply data (`unavailable`), not a thrown protocol error', async () => {
		const r = await rig({ rows: [] });
		try {
			await assert.rejects(r.env.resolveEndpoint(PIPELINE), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && /not running/.test(error.message));
			// A resolution failure inside an op names that op's tool (reviewer F6).
			const fails = (op: 'sql.execute' | 'sql.getSchema' | 'sql.refreshSchema' | 'sql.dialect', tool: string, params: Record<string, unknown> = {}) => assert.rejects(
				r.frame.caller.callReply(op, { connId: 'c-pipe', ...params } as never, { timeoutMs: SQL_OP_TIMEOUT_MS[op] }),
				(error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable' && error.tool === tool,
			);
			await fails('sql.execute', 'execute', { sql: 'SELECT 1' });
			await fails('sql.getSchema', 'get_schema');
			await fails('sql.refreshSchema', 'refresh_schema');
			await fails('sql.dialect', 'dialect');
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T4 — TIMEOUTS ON BOTH LANES
// =============================================================================

describe('T4 — the frame\'s timeouts and the controller\'s bus timeouts match R5', () => {
	it('the controller names dialect 15 s, get_schema 60 s, refresh_schema 135 s (each + SDK slack + bus margin), and a statement on a node with no published deadline the 24 h cap', async () => {
		const r = await rig();
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			await session.dialect();
			await session.getSchema();
			await session.refreshSchema();
			await session.execute('SELECT 1');
			const bus = (tool: string): number | undefined => toolRequests(r.engine, tool).at(-1)?.timeoutMs;
			assert.equal(bus('dialect'), DIALECT_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('get_schema'), GET_SCHEMA_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('refresh_schema'), REFRESH_SCHEMA_WAIT_MS + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS);
			assert.equal(bus('execute'), UNBOUNDED_TOOL_TIMEOUT_MS);
			assert.equal(DIALECT_WAIT_MS, 15_000);
			assert.equal(GET_SCHEMA_WAIT_MS, 60_000);
			assert.equal(REFRESH_SCHEMA_WAIT_MS, 135_000);
			assert.deepEqual(r.engine.requests.filter((request) => typeof request.timeoutMs !== 'number').map((request) => request.op), [], 'every bus request names its timeout');
		} finally {
			r.dispose();
		}
	});

	it('the frame waits longer than the controller can take for every op, and never relies on the 120 s default', async () => {
		// A clock that stands still: the frame sends what is left of a call's
		// timeout after the readiness wait, which a running clock can shave by 1 ms.
		const clock = manualNow(Date.now());
		const r = await rig({ now: clock.now });
		try {
			const session = r.env.getSession(await r.env.resolveEndpoint(PIPELINE));
			await session.dialect();
			await session.getSchema();
			await session.refreshSchema();
			await session.execute('SELECT 1');
			for (const call of r.frameCalls) {
				assert.equal(call.timeoutMs, SQL_OP_TIMEOUT_MS[call.op as keyof typeof SQL_OP_TIMEOUT_MS], `${call.op} frame timeout`);
			}
			const at = (op: keyof typeof SQL_OP_TIMEOUT_MS): number => SQL_OP_TIMEOUT_MS[op];
			const busOf = (wait: number): number => wait + SDK_TIMEOUT_SLACK_MS + BUS_TOOL_MARGIN_MS;
			assert.equal(at('sql.dialect'), RESOLVE_BUDGET_MS + busOf(DIALECT_WAIT_MS) + FRAME_OP_MARGIN_MS);
			assert.equal(at('sql.getSchema'), RESOLVE_BUDGET_MS + busOf(GET_SCHEMA_WAIT_MS) + FRAME_OP_MARGIN_MS);
			assert.equal(at('sql.refreshSchema'), RESOLVE_BUDGET_MS + busOf(REFRESH_SCHEMA_WAIT_MS) + busOf(GET_SCHEMA_WAIT_MS) + FRAME_OP_MARGIN_MS);
			// The controller's longest path for a statement, from its parts: resolve;
			// the gate's one dialect call; the statement's first send (refused
			// TASK_STOPPED at the latest when its bus wait ends); the session's
			// rebind (its retry window plus one discovery request in flight); the
			// second, unbounded send. The frame waits longer (R5), as a real timer.
			const controllerLongest = RESOLVE_BUDGET_MS + busOf(DIALECT_WAIT_MS)
				+ UNBOUNDED_TOOL_TIMEOUT_MS
				+ DEFAULT_RETRY_WINDOW_MS + GET_TASKS_TIMEOUT_MS
				+ UNBOUNDED_TOOL_TIMEOUT_MS;
			assert.ok(at('sql.execute') > controllerLongest, `frame ${at('sql.execute')} > controller ${controllerLongest}`);
			assert.equal(at('sql.execute'), controllerLongest + FRAME_OP_MARGIN_MS);
			assert.ok(at('sql.execute') <= MAX_TIMER_MS);
			for (const op of Object.keys(SQL_OP_TIMEOUT_MS) as Array<keyof typeof SQL_OP_TIMEOUT_MS>) assert.notEqual(at(op), 120_000, op);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T5 — LIFECYCLE
// =============================================================================

describe('T5 — mount -> dispose -> mount leaves one live op server; ops answered, events delivered, replays execute nothing', () => {
	it('StrictMode\'s double mount leaves exactly one op server and two sidebar subscribers, and the remounted controller still answers', async () => {
		const r = await rig();
		try {
			assertSidebarSubscribers(r.spy, 'sql controller');
			// StrictMode: cleanup, then setup again.
			r.mount.dispose();
			r.remount();
			assert.equal(r.servers.created - r.servers.disposed, 1, 'exactly one live op server');
			assertSidebarSubscribers(r.spy, 'sql controller after remount');
			r.engine.realm.login(USER);
			await settle();

			const actives: Array<string | null> = [];
			r.mount.bridge.subscribeActive((key) => actives.push(key));
			await r.env.resolveEndpoint(PIPELINE);
			const executes = (): number => toolRequests(r.engine, 'execute').length;
			await r.env.getSession(await r.env.resolveEndpoint(PIPELINE)).execute('SELECT 1');
			assert.equal(executes(), 1);

			// A frame event reaches the controller once (live subscriber + retained slot do not double it).
			sqlChannel(r.frame.channel).sendEvent('active', 'p1:s1:db_1');
			await settle();
			assert.deepEqual(actives.filter((key) => key === 'p1:s1:db_1'), ['p1:s1:db_1']);

			// Remount: the retained last frame payload replays into the new controller and runs nothing.
			r.mount.dispose();
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			assert.equal(r.servers.created - r.servers.disposed, 1);
			assert.equal(executes(), 1, 'no statement re-executed by a replay');
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('event names and op names are disjoint (busPeer quirk 7), and saveConnection is an op, never an event', () => {
		const ops = source('ops.ts');
		const opNames = [...ops.matchAll(/'(sql\.[a-zA-Z]+)': ToolOpSpec/g)].map((m) => m[1]);
		const eventBlock = ops.slice(ops.indexOf('export interface SqlEventMap'));
		const events = [...eventBlock.matchAll(/^\t([a-zA-Z]+): /gm)].map((m) => m[1]);
		assert.deepEqual(events.sort(), ['active', 'openError']);
		for (const event of events) assert.equal(opNames.includes(event), false);
		assert.ok(opNames.includes('sql.saveConnection') && opNames.includes('sql.deleteConnection'));
		assert.doesNotMatch(source('sqlFrame.ts') + source('sqlController.ts') + source('SqlDevTool.tsx'), /sendEvent\('saveConnection'/);
	});
});

// =============================================================================
// T6 — QUIET SIDEBAR
// =============================================================================

describe('T6 — the sidebar mount posts nothing but retained state, opens no document, and discovers only once activated', () => {
	it('zero events or calls and zero documents.open at mount, and no engine request at all until activation; then the first op opens it', async () => {
		const r = await rig({ docKey: '', activate: false });
		try {
			await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
			const posted = r.spy.posts.map((post) => (post as { __rrtool?: string }).__rrtool);
			assert.ok(posted.length > 0, 'retained state was published');
			assert.deepEqual(posted.filter((kind) => kind !== 'state'), [], 'only state publishes at mount');
			assert.deepEqual(r.docs.opened, []);
			assert.deepEqual(r.engine.ops(), [], 'no engine request before activation: no discovery, no saved list, no history file');
			// The first op from a frame activates the controller.
			await r.env.discoverEndpoints();
			assert.equal(r.mount.core.activation.reason(), 'op');
			assert.ok(r.engine.ops().includes('client.getTasks'));
			await until(() => r.engine.ops().includes('client.fsReadJson') && r.engine.ops().includes('client.fsStat'), 'the saved list and the history file, once active');
		} finally {
			r.dispose();
		}
	});

	it('a boot with the account already known (rocket-ui mounts every pinned sidebar) makes no engine request until the tool is activated (DA CE-6)', async () => {
		resetSavedConnections({ force: true });
		const h = createDevToolHarness(SQL_APP_ID, { json: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], postgres, {}));
		engine.realm.login(USER);
		h.setHostConnection(true);
		const spy = spyPeer(h.sidebarPeer);
		const mount = attachSqlController({ peer: spy.peer, channel: shellProtocol.createToolChannel(spy.peer), cm: engine.cm, protocol: shellProtocol, focusTarget: null });
		try {
			await settle();
			await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
			assert.deepEqual(engine.ops(), [], 'nothing before activation');
			engine.realm.activate(SQL_APP_ID);
			await until(() => getSavedConnectionsStatus() === 'ready', 'the saved list once activated');
			await until(() => engine.ops().includes('client.fsStat') && engine.ops().includes('client.getTasks'), 'the history file and the first discovery');
		} finally {
			mount.dispose();
		}
	});

	it('documents open on user actions only, and each one activates', async () => {
		const r = await rig({ docKey: '', activate: false });
		try {
			r.mount.bridge.openConnection(PIPELINE);
			assert.deepEqual(r.docs.opened, [['c-pipe', 'Orders']]);
			assert.equal(r.mount.core.activation.reason(), 'user');
			r.mount.bridge.openConnectionEditor(null);
			assert.deepEqual(r.docs.opened[1], ['edit:*new*', 'New Connection']);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T9 — DOCKEYS
// =============================================================================

describe('T9 — docKey routing for every family', () => {
	it('undefined and \'\' are the landing; edit:<id|*new*> the editor; anything else a saved connection id', () => {
		assert.deepEqual(routeDocKey(undefined), { kind: 'landing' });
		assert.deepEqual(routeDocKey(''), { kind: 'landing' });
		assert.deepEqual(routeDocKey(null), { kind: 'landing' });
		assert.deepEqual(routeDocKey('edit:*new*'), { kind: 'editor', connId: null });
		assert.deepEqual(routeDocKey('edit:c-pipe'), { kind: 'editor', connId: 'c-pipe' });
		assert.deepEqual(routeDocKey('c-pipe'), { kind: 'connection', connId: 'c-pipe' });
	});

	it('an unknown id is "not found" once the list is read, "loading" before', () => {
		const base = { ready: true, failed: false, opened: false, found: false };
		assert.equal(connectionDocState({ ...base, listStatus: 'ready' }), 'not-found');
		assert.equal(connectionDocState({ ...base, listStatus: 'loading' }), 'loading');
		assert.equal(connectionDocState({ ...base, listStatus: 'idle' }), 'loading');
		assert.equal(connectionDocState({ ...base, ready: false, listStatus: 'ready' }), 'not-connected');
		assert.equal(connectionDocState({ ...base, found: true, listStatus: 'ready' }), 'opening');
		assert.equal(connectionDocState({ ...base, found: true, opened: true, listStatus: 'ready' }), 'open');
		assert.equal(connectionDocState({ ...base, found: true, failed: true, listStatus: 'ready' }), 'failed');
	});

	it('a realm without a controller takes the snapshot as a read-only replica; a realm that owns the list never takes one', () => {
		resetSavedConnections({ force: true });
		applyReplicaConnections({ status: 'ready', list: [PIPELINE] });
		assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe']);
		// A replica holds no writer: a mutation attempted in a frame realm is refused.
		deleteSavedConnection('c-pipe');
		assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe']);
		// A list the controller has not read shows as loading.
		applyReplicaConnections({ status: 'loading', list: [] });
		assert.deepEqual(getSavedConnections(), []);
		assert.equal(getSavedConnectionsStatus(), 'idle');
		// In a realm that hosts the controller too, the owner's list stands.
		const release = ownSavedConnections();
		try {
			applyReplicaConnections({ status: 'ready', list: [DIRECT] });
			assert.deepEqual(getSavedConnections(), []);
		} finally {
			release();
		}
	});

	it('the frame replicates the controller\'s list, so a connection document finds its record by id', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnections().length === 2, 'the replica');
			assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe', 'c-direct']);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T10 — THE CONTROLLER'S OWN WRITE CHECKS
// =============================================================================

describe('T10 — write gates hold in the controller even when a frame calls the op directly', () => {
	it('a write sent as `idempotent` is still sent at most once; transaction control is refused before anything is sent', async () => {
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [], affected_rows: 1 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const call = (sql: string) => r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql, idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] });
			await assert.rejects(call("INSERT INTO orders (id) VALUES ('x')"), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 1, 'the INSERT was not re-sent');
			attempt = 0;
			await assert.rejects(call('SELECT 1; DELETE FROM orders'), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 2, 'a text holding a write is not re-sent');
			for (const tx of ['BEGIN', 'COMMIT', 'SELECT 1; ROLLBACK']) {
				await assert.rejects(call(tx), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			}
			assert.equal(toolRequests(r.engine, 'execute').length, 2, 'no transaction statement reached the node');
		} finally {
			r.dispose();
		}
	});

	it('the gate asks the node for its dialect when no probe has it: a MySQL-only batch the first probe missed is sent once', async () => {
		// DA CE-2: the first probe fails (the node is restarting), so the store
		// has no dialect; the text is two statements on MySQL (`--1` is
		// arithmetic there), the second a DELETE.
		let probes = 0;
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'dialect') {
				probes += 1;
				if (probes === 1) throw new Error('connection refused');
				return { dialect: 'mysql' };
			}
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [{ ok: 1 }], affected_rows: 0 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const probe = Object.values(r.mount.core.endpoints.getState().probes)[0];
			assert.equal(probe?.ok, false, 'the store has no dialect');
			await assert.rejects(r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql: 'SELECT 1--1; DELETE FROM orders', idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] }), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 1, 'a text that holds a write on MySQL is sent at most once');
			assert.ok(probes >= 2, 'the node was asked for its dialect before the statement');
		} finally {
			r.dispose();
		}
	});

	it('with no dialect at all the gate fails closed: a marked read is sent once, and valid PL/pgSQL is not refused', async () => {
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'dialect') throw new Error('connection refused');
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [], affected_rows: 0 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const call = (sql: string) => r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql, idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] });
			await assert.rejects(call('SELECT 1'), /Task was stopped/);
			assert.equal(toolRequests(r.engine, 'execute').length, 1, 'never repeated without a dialect');
			const fn = 'CREATE FUNCTION bump() RETURNS void AS $$\nDECLARE x int;\nBEGIN\n  PERFORM 1;\nEND;\n$$ LANGUAGE plpgsql';
			assert.deepEqual(await call(fn), { rows: [], affected_rows: 0 }, 'sent, and the node decides');
			assert.equal(toolRequests(r.engine, 'execute').length, 2);
		} finally {
			r.dispose();
		}
	});

	it('malformed input is `invalid` Reply data, before anything is resolved, gated or sent (R3)', async () => {
		const r = await rig();
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const before = r.engine.requests.length;
			type Checked = 'sql.execute' | 'sql.getSchema' | 'sql.getService' | 'sql.validate' | 'sql.releaseEndpoint';
			const call = (op: Checked, params: Record<string, unknown>) => r.frame.caller.callReply(op, { connId: 'c-pipe', ...params } as never, { timeoutMs: SQL_OP_TIMEOUT_MS[op] });
			const bad: Array<[Checked, Record<string, unknown>]> = [
				['sql.releaseEndpoint', { key: 42 }],
				['sql.getService', { provider: 42 }],
				['sql.getService', { provider: '' }],
				['sql.validate', { pipeline: 'x' }],
				['sql.validate', { pipeline: [1] }],
				['sql.validate', { pipeline: null }],
				['sql.execute', { sql: 42 }],
				['sql.execute', { sql: null }],
				['sql.execute', { sql: ['SELECT 1'] }],
				['sql.execute', { sql: 'SELECT ?', params: 'x' }],
				['sql.execute', { sql: 'SELECT ?', params: { 0: 1 } }],
				['sql.execute', { sql: 'SELECT 1', idempotent: 'yes' }],
				['sql.getSchema', { table: 7 }],
			];
			for (const [op, params] of bad) {
				await assert.rejects(call(op, params), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid', JSON.stringify(params));
			}
			assert.deepEqual(r.engine.requests.slice(before).map((q) => q.op), [], 'nothing reached the engine');
			assert.deepEqual(await call('sql.execute', { sql: 'SELECT ?', params: [null, 1, 'a', true, { k: [1] }] }), { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 }, 'control');
			// What only a same-realm frame (no JSON wire) could send.
			for (const params of [[Number.NaN], [() => 1], [new Date(0)], [Infinity]]) {
				assert.throws(() => checkExecuteInput({ sql: 'SELECT ?', params }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			}
			assert.throws(() => checkSchemaInput({ table: ['t'] }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
		} finally {
			r.dispose();
		}
	});

	it('deleting an id the list does not hold changes nothing and writes nothing', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnectionsStatus() === 'ready', 'the list');
			await r.frame.caller.callReply('sql.deleteConnection', { connId: 'c-none', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.deleteConnection'] });
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(r.engine.requests.some((q) => q.op === 'client.fsWriteJson' && (q.params as { path: string }).path === SAVED_PATH), false);
			assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe', 'c-direct']);
		} finally {
			r.dispose();
		}
	});

	it('a read the frame did not mark idempotent is not repeated either; a marked read is, once', async () => {
		let attempt = 0;
		const r = await rig({ tool: (params) => {
			if (params.tool === 'execute') {
				attempt += 1;
				if (attempt === 1) throw Object.assign(new Error('Task was stopped'), { code: 'TASK_STOPPED' });
				return { rows: [{ ok: 1 }], affected_rows: 0 };
			}
			return postgres(params);
		} });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const result = await r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql: 'SELECT 1', idempotent: true }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.execute'] });
			assert.deepEqual(result, { rows: [{ ok: 1 }], affected_rows: 0 });
			assert.equal(toolRequests(r.engine, 'execute').length, 2);
		} finally {
			r.dispose();
		}
	});

	it('a saved-connection record from a frame must be usable and name a database node; a frame of another identity cannot write', async () => {
		const r = await rig();
		try {
			await until(() => getSavedConnections().length === 2, 'the list');
			const save = (connection: unknown, owner: string | null) => r.frame.caller.callReply('sql.saveConnection', { connection: connection as SavedSqlConnection, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] });
			const owner = r.frame.owner();
			assert.ok(owner !== null);
			await assert.rejects(save({ ...DIRECT, id: 'x', provider: 'llm_openai' }, owner), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(save({ id: 'x', mode: 'direct', name: 'n', provider: 'db_mysql' }, owner), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(save({ ...PIPELINE, id: 'y' }, 'someone-else'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			await assert.rejects(r.frame.caller.callReply('sql.deleteConnection', { connId: 'c-pipe', owner: 'someone-else' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.deleteConnection'] }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			assert.deepEqual(getSavedConnections().map((c) => c.id), ['c-pipe', 'c-direct'], 'nothing was written');
			assert.equal(r.engine.ops().includes('client.fsWriteJson'), false);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T11 — RETAINED STATE STAYS SMALL
// =============================================================================

describe('T11 — no bulk result is retained state; each topic stays within 64 KiB and all within 128 KiB, honestly', () => {
	it('the controller retains its fixed topics (and the library\'s readiness), never one under the reserved prefix; statement rows travel as op results', async () => {
		const r = await rig();
		try {
			await r.env.getSession(await r.env.resolveEndpoint(PIPELINE)).execute('SELECT * FROM orders');
			const states = r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state').map((post) => (post as { topic: string }).topic);
			assert.deepEqual([...new Set(states)].sort(), ['connections', CONTROLLER_STATE_TOPIC, 'history', 'identity'].sort());
			assert.deepEqual([...new Set(states)].filter((topic) => topic.startsWith(RESERVED_STATE_PREFIX) && topic !== CONTROLLER_STATE_TOPIC), []);
			assert.equal(JSON.stringify(r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state')).includes('"rows"'), false);
			assert.doesNotMatch(source('sqlController.ts'), /publishState\(\s*['`"]devtool:/);
		} finally {
			r.dispose();
		}
	});

	it('at scale (400 saved connections, 200 histories read) every topic stays within 64 KiB and the map within 128 KiB; nothing is withheld or marked truncated', async () => {
		const saved = many(400);
		assert.ok(jsonByteLength({ status: 'ready', list: saved, partial: null }) > MAX_RETAINED_STATE_BYTES, 'the whole list does not fit');
		const r = await rig({ saved });
		try {
			await until(() => getSavedConnections().length === 400, 'the list');
			for (const conn of saved.slice(0, 200)) await r.frame.caller.callReply('sql.history', { connId: conn.id, owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			await settle();
			const last = retained(r.spy.posts);
			let total = 0;
			for (const [topic, snapshot] of last) {
				const bytes = jsonByteLength(snapshot);
				assert.ok(bytes <= MAX_RETAINED_STATE_BYTES, `${topic}: ${bytes} bytes`);
				assert.equal(JSON.stringify(snapshot).includes('"truncated"'), false, `${topic} carries no generic truncated marker`);
				total += bytes;
			}
			assert.ok(total <= MAX_RETAINED_TOTAL_BYTES, `the whole map: ${total} bytes`);
			// The list is published in part, and says so.
			const connections = last.get('connections') as ConnectionsState;
			assert.equal(connections.status, 'ready');
			assert.ok(connections.partial !== null && connections.partial.total === 400 && connections.partial.kept === connections.list.length && connections.list.length > 0 && connections.list.length < 400);
			assert.deepEqual(connections.list, saved.slice(0, connections.list.length));
			// History follows the connections read most recently.
			const history = last.get('history') as HistoryState;
			assert.deepEqual(Object.keys(history.keys), saved.slice(200 - MAX_WATCHED_HISTORY_KEYS, 200).map((conn) => endpointKeyForConnection(conn)));
		} finally {
			r.dispose();
		}
	});

	it('a record the partial list left out is asked for, never reported gone; a whole list that lacks it means it is gone', async () => {
		const saved = many(400);
		const r = await rig({ saved });
		try {
			await until(() => getSavedConnections().length === 400, 'the list');
			assert.deepEqual(await r.env.getConnection('c-399'), saved[399]);
			assert.equal(await r.env.getConnection('c-none'), null);
		} finally {
			r.dispose();
		}
		// A realm that does not own the list (a VS Code frame) holds the replica.
		resetSavedConnections({ force: true });
		try {
			applyReplicaConnections({ status: 'ready', list: saved.slice(0, 10), partial: { kept: 10, total: 400 } });
			assert.deepEqual(getSavedConnectionsPartial(), { kept: 10, total: 400 });
			const view = { list: getSavedConnections(), status: getSavedConnectionsStatus(), partial: getSavedConnectionsPartial() };
			assert.deepEqual(lookupConnection('c-5', view), { kind: 'found', record: saved[5] });
			assert.deepEqual(lookupConnection('c-399', view), { kind: 'ask' });
			assert.deepEqual(lookupConnection('c-399', { ...view, partial: null }), { kind: 'missing' });
			assert.deepEqual(lookupConnection('c-399', { ...view, status: 'loading' }), { kind: 'loading' });
			// A whole list replaces the note.
			applyReplicaConnections({ status: 'ready', list: saved.slice(0, 10), partial: null });
			assert.equal(getSavedConnectionsPartial(), null);
		} finally {
			resetSavedConnections({ force: true });
		}
	});

	it('a frame whose history the controller stopped following reads it again, which follows it again', async () => {
		const saved = many(MAX_WATCHED_HISTORY_KEYS + 2);
		const r = await rig({ saved });
		const snapshots: HistoryState[] = [];
		const off = r.frame.channel.onState('history', (snapshot) => { snapshots.push(snapshot as HistoryState); });
		try {
			await until(() => getSavedConnections().length === saved.length, 'the list');
			const mine = endpointForConnection(saved[0]!);
			r.history.watch(mine);
			await until(() => snapshots.at(-1)?.keys[mine.key] !== undefined, 'the frame\'s key to be followed');
			// Other documents read as many other connections as the controller follows.
			for (const conn of saved.slice(1, MAX_WATCHED_HISTORY_KEYS + 1)) await r.frame.caller.callReply('sql.history', { connId: conn.id, owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			assert.ok(snapshots.some((snapshot) => snapshot.keys[mine.key] === undefined), 'it was dropped');
			await until(() => snapshots.at(-1)?.keys[mine.key] !== undefined, 'the frame to read it again');
			assert.ok(Object.keys(snapshots.at(-1)!.keys).length <= MAX_WATCHED_HISTORY_KEYS);
		} finally {
			off();
			r.dispose();
		}
	});

	it('more history views than the controller follows settle: each re-reads at most once, and reads again only when opened again (DA CE-5)', async () => {
		const saved = many(MAX_WATCHED_HISTORY_KEYS + 2);
		const r = await rig({ saved });
		try {
			await until(() => getSavedConnections().length === saved.length, 'the list');
			for (const conn of saved) r.history.watch(endpointForConnection(conn));
			const count = (): number => r.frameCalls.filter((call) => call.op === 'sql.history').length;
			await new Promise((resolve) => setTimeout(resolve, 300));
			const a = count();
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(count(), a, 'the reads settled');
			// Per view at most: the first read, one re-read, and one more when the
			// re-followed key's revision appears (the re-read began before it did).
			assert.ok(a <= 3 * saved.length, `${a} reads for ${saved.length} views`);
			// A dropped view opened again reads (and is followed) again.
			const snapshots: HistoryState[] = [];
			const off = r.frame.channel.onState('history', (snapshot) => { snapshots.push(snapshot as HistoryState); });
			try {
				await settle();
				const dropped = saved.map((conn) => endpointForConnection(conn)).find((endpoint) => snapshots.at(-1)?.keys[endpoint.key] === undefined);
				assert.ok(dropped, 'some view is not followed');
				const before = count();
				r.history.watch(dropped);
				await until(() => snapshots.at(-1)?.keys[dropped.key] !== undefined, 'the reopened view to be followed');
				assert.ok(count() > before);
			} finally {
				off();
			}
		} finally {
			r.dispose();
		}
	});

	it('the shrink is the lane\'s (a partial list, the newest keys), and every op has a handler', () => {
		const controller = source('sqlController.ts');
		assert.match(controller, /shrink: shrinkSqlState,/);
		assert.match(controller, /const handlers: RequiredControllerHandlers<SqlOps> = \{/);
		assert.match(controller, /publishIdentityState\(guarded, core\.identity\)/, 'identity counts toward the total budget');
	});
});

describe('a direct connection\'s temp pipeline is released when its document goes away, and only then (reviewer F2)', () => {
	it('the release is keyed on the endpoint key: a re-resolve (a list republish, a controller remount) keeps it', async () => {
		const first = endpointForConnection(DIRECT);
		const again = endpointForConnection({ ...DIRECT });
		assert.notEqual(first, again, 'a re-resolve makes a new endpoint object');
		assert.equal(directReleaseKey(first), directReleaseKey(again));
		assert.equal(directReleaseKey(first), 'sqlconn-c-direct:tools_1:db_mysql_1');
		assert.equal(directReleaseKey(endpointForConnection(PIPELINE)), null, 'a pipeline connection releases nothing');
		assert.equal(directReleaseKey(null), null);
	});

	it('the document\'s release effect depends on that key and the connection id only, never on env or the endpoint object', () => {
		const devTool = source('SqlDevTool.tsx');
		const doc = devTool.slice(devTool.indexOf('const SqlConnectionDocument'), devTool.indexOf('/** A document that cannot open yet'));
		assert.match(doc, /const releaseKey = directReleaseKey\(endpoint\);\s*useEffect\(\(\) => \{\s*if \(releaseKey === null\) return undefined;\s*return \(\) => \{ envRef\.current\.releaseEndpoint\(connId, releaseKey\); \};\s*\}, \[releaseKey, connId\]\);/);
		assert.equal((doc.match(/releaseEndpoint\(/g) ?? []).length, 1, 'one release site');
		assert.doesNotMatch(doc, /\}, \[endpoint, env, connId\]\);/);
	});

	it('a controller remount and a list republish send no release and no terminate of their own', async () => {
		const r = await rig();
		try {
			await r.env.resolveEndpoint(PIPELINE);
			const owner = r.frame.owner();
			await r.frame.caller.callReply('sql.saveConnection', { connection: { ...PIPELINE, id: 'c-other', name: 'Other' }, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] });
			r.mount.dispose();
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			await r.env.resolveEndpoint(PIPELINE);
			assert.equal(r.frameCalls.some((call) => call.op === 'sql.releaseEndpoint'), false);
			assert.equal(r.engine.ops().some((op) => op === 'client.terminate' || op === 'client.getTaskToken'), false);
		} finally {
			r.dispose();
		}
	});
});

// =============================================================================
// T13 — DEADLINES
// =============================================================================

describe('T13 — a call held while no controller is subscribed and delivered after its deadline is not executed', () => {
	it('the frame has already rejected it, and the remounted controller refuses it (control: an on-time held call runs)', async () => {
		const clock = manualNow(Date.now());
		const r = await rig({ now: clock.now });
		try {
			await r.env.resolveEndpoint(PIPELINE);
			// The controller unmounts (a VS Code disconnect); the frame calls into the void.
			r.mount.dispose();
			await settle();
			const late = r.frame.caller.callReply('sql.execute', { connId: 'c-pipe', sql: 'DELETE FROM orders' }, { timeoutMs: 40 });
			await assert.rejects(late, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'timeout');
			clock.advance(5 * 60_000);
			r.remount();
			r.engine.realm.login(USER);
			await settle();
			assert.equal(toolRequests(r.engine, 'execute').length, 0, 'the expired DELETE never ran');

			// Control: a held call still inside its deadline runs on remount.
			r.mount.dispose();
			await settle();
			const onTime = r.frame.caller.callReply('sql.dialect', { connId: 'c-pipe' }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.dialect'] });
			await settle();
			r.remount();
			r.engine.realm.login(USER);
			assert.equal(await onTime, 'postgres');
		} finally {
			r.dispose();
		}
	});
});
