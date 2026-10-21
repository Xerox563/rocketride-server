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
import type { IToolOpServer, ToolControllerFn, ToolOpMap } from 'shell';
import { ExplorerToolError } from 'shared/explorer/errors';
import { assertJsonSafe, assertSidebarSubscribers, createDevToolHarness, findToolFactoryImports, manualNow, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness, IPeerSpy } from 'shared/explorer/devtool/testing';
import { BUS_TOOL_MARGIN_MS, FRAME_OP_MARGIN_MS, SDK_TIMEOUT_SLACK_MS, UNBOUNDED_TOOL_TIMEOUT_MS } from 'shared/explorer/devtool/timeouts';
import { MAX_RETAINED_STATE_BYTES } from 'shared/explorer/devtool/state';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { SQL_APP_ID } from '../src/appId';
import { applyReplicaConnections, deleteSavedConnection, getSavedConnections, getSavedConnectionsStatus, ownSavedConnections, resetSavedConnections } from '../src/connect';
import type { SavedSqlConnection } from '../src/connect';
import { attachSqlController } from '../src/sqlController';
import type { SqlControllerMount } from '../src/sqlController';
import { attachSqlFrame, connectionDocState, routeDocKey, sqlChannel } from '../src/sqlFrame';
import type { SqlFrameMount, SqlToolProtocol } from '../src/sqlFrame';
import { createRemoteSqlEnv } from '../src/sqlEnv';
import type { SqlEnv } from '../src/sqlEnv';
import { RESOLVE_BUDGET_MS, SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { DIALECT_WAIT_MS, GET_SCHEMA_WAIT_MS, REFRESH_SCHEMA_WAIT_MS } from '../src/connect/tools';
import { taskRow } from './support';
import type { IFakeTaskRow } from './support';
import { USER, engineScript, scriptedClientRealm, until } from './realm';
import type { IScriptedRealm } from './realm';
import type { IFakeClientRealm } from 'shared/explorer/devtool/testing';

// =============================================================================
// FIXTURES
// =============================================================================

const SRC = path.resolve(__dirname, '..', 'src');
const PIPELINE: SavedSqlConnection = { id: 'c-pipe', mode: 'pipeline', name: 'Orders', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' };
const DIRECT: SavedSqlConnection = { id: 'c-direct', mode: 'direct', name: 'Scratch', provider: 'db_mysql', config: { host: 'db.internal' } };

/**
 * A tool answer for each tool, like a postgres node.
 *
 * @param params - The client.tool params.
 * @returns The answer.
 */
function postgres(params: { tool: string }): unknown {
	switch (params.tool) {
		case 'execute': return { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 };
		case 'get_schema': return { database: 'shop', tables: { orders: { columns: [{ column: 'id', type: 'INT' }] } } };
		case 'refresh_schema': return { database: 'shop', tables: {} };
		default: return { dialect: 'postgres' };
	}
}

/** A controller, a frame on it, and everything recorded. */
interface IRig {
	h: IDevToolHarness;
	engine: IScriptedRealm<IFakeClientRealm>;
	spy: IPeerSpy;
	protocol: SqlToolProtocol;
	mount: SqlControllerMount;
	frame: SqlFrameMount;
	env: SqlEnv;
	docs: { opened: Array<[string, string]>; closed: string[] };
	frameCalls: Array<{ op: string; timeoutMs: number | undefined }>;
	servers: { created: number; disposed: number };
	/** Remount the controller (the old one must be disposed first). */
	remount(): SqlControllerMount;
	dispose(): void;
}

/**
 * Mount a controller (as the hosts do: a host channel on the sidebar peer,
 * then the controller in an effect) and one frame on a connection document.
 *
 * @param opts - The engine's saved list, tasks and tool answers; whether to sign in.
 * @returns The rig.
 */
async function rig(opts: { saved?: SavedSqlConnection[]; rows?: IFakeTaskRow[]; tool?: (params: { tool: string; input?: Record<string, unknown> }) => unknown; login?: boolean; now?: () => number; docKey?: string } = {}): Promise<IRig> {
	resetSavedConnections({ force: true });
	const h = createDevToolHarness(SQL_APP_ID, { json: true });
	const engine = scriptedClientRealm(engineScript(opts.saved ?? [PIPELINE, DIRECT], opts.rows ?? [taskRow('p1')], opts.tool ?? postgres));
	const spy = spyPeer(h.sidebarPeer);
	const hostChannel = shellProtocol.createToolChannel(spy.peer);
	const docs = { opened: [] as Array<[string, string]>, closed: [] as string[] };
	const documents = { open: (key: string, title: string) => { docs.opened.push([key, title]); }, close: (key: string) => { docs.closed.push(key); } };
	const frameCalls: Array<{ op: string; timeoutMs: number | undefined }> = [];
	const servers = { created: 0, disposed: 0 };
	const protocol: SqlToolProtocol = {
		createToolChannel: shellProtocol.createToolChannel,
		createToolController: <O extends ToolOpMap>(peer: DevToolPeer): ToolControllerFn<O> => {
			const fn = shellProtocol.createToolController<O>(peer);
			return ((op: keyof O & string, params: never, callOpts?: { timeoutMs?: number }) => {
				frameCalls.push({ op, timeoutMs: callOpts?.timeoutMs });
				return fn(op, params, callOpts);
			}) as ToolControllerFn<O>;
		},
		createToolOpServer: <O extends ToolOpMap>(peer: DevToolPeer): IToolOpServer<O> => {
			servers.created += 1;
			const server = shellProtocol.createToolOpServer<O>(peer);
			return { serve: (op, handler) => server.serve(op, handler), dispose: () => { servers.disposed += 1; server.dispose(); } };
		},
	};
	const controllerOpts = { peer: spy.peer, channel: hostChannel, documents, cm: engine.cm, protocol, focusTarget: null, ...(opts.now ? { now: opts.now } : {}) };
	let mount = attachSqlController(controllerOpts);
	if (opts.login !== false) engine.realm.login(USER);
	h.setHostConnection(true);
	const frame = attachSqlFrame({ peer: h.newFramePeer(), docKey: opts.docKey ?? 'c-pipe', documents, protocol, ...(opts.now ? { now: opts.now } : {}) });
	const env = createRemoteSqlEnv(frame.caller, true, frame.owner);
	await settle();
	const rigged: IRig = {
		h, engine, spy, protocol, mount, frame, env, docs, frameCalls, servers,
		remount: () => {
			mount = attachSqlController(controllerOpts);
			rigged.mount = mount;
			return mount;
		},
		dispose: () => {
			frame.dispose();
			mount.dispose();
		},
	};
	return rigged;
}

/**
 * The ops the controller's engine received for one tool.
 *
 * @param engine - The scripted realm.
 * @param tool - The tool name.
 * @returns Those `client.tool` requests.
 */
function toolRequests(engine: IScriptedRealm<IFakeClientRealm>, tool: string) {
	return engine.requests.filter((request) => request.op === 'client.tool' && (request.params as { tool: string }).tool === tool);
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
			};
			await r.env.saveConnection({ ...PIPELINE, id: 'c-new', name: 'New' });
			await r.env.deleteConnection({ ...PIPELINE, id: 'c-new', name: 'New' });
			r.env.releaseEndpoint('c-direct');
			await until(() => r.engine.ops().includes('client.terminate'), 'the release');
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
		const r = await rig();
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
			assert.equal(at('sql.execute'), RESOLVE_BUDGET_MS + UNBOUNDED_TOOL_TIMEOUT_MS + FRAME_OP_MARGIN_MS);
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
	it('zero events or calls and zero documents.open at mount; the first discovery waits for activation, then the first op opens it', async () => {
		const r = await rig({ docKey: '' });
		try {
			await until(() => r.engine.ops().includes('client.fsReadJson'), 'the saved list');
			await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
			const posted = r.spy.posts.map((post) => (post as { __rrtool?: string }).__rrtool);
			assert.ok(posted.length > 0, 'retained state was published');
			assert.deepEqual(posted.filter((kind) => kind !== 'state'), [], 'only state publishes at mount');
			assert.deepEqual(r.docs.opened, []);
			assert.equal(r.engine.ops().includes('client.getTasks'), false, 'no discovery before activation');
			// The first op from a frame activates the controller.
			await r.env.discoverEndpoints();
			assert.equal(r.mount.core.activation.reason(), 'op');
			assert.ok(r.engine.ops().includes('client.getTasks'));
		} finally {
			r.dispose();
		}
	});

	it('documents open on user actions only, and each one activates', async () => {
		const r = await rig({ docKey: '' });
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

describe('T11 — no bulk result is retained state, and a size guard exists', () => {
	it('the controller retains only its fixed topics; statement rows travel as op results', async () => {
		const r = await rig();
		try {
			await r.env.getSession(await r.env.resolveEndpoint(PIPELINE)).execute('SELECT * FROM orders');
			const states = r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state').map((post) => (post as { topic: string }).topic);
			assert.deepEqual([...new Set(states)].sort(), ['connections', 'identity']);
			assert.equal(JSON.stringify(r.spy.posts.filter((post) => (post as { __rrtool?: string }).__rrtool === 'state')).includes('"rows"'), false);
		} finally {
			r.dispose();
		}
	});

	it('a connection list over the 64 KiB cap is never published (the last good snapshot stands)', async () => {
		const big: SavedSqlConnection = { ...DIRECT, id: 'c-big', config: { blob: 'x'.repeat(MAX_RETAINED_STATE_BYTES) } };
		const r = await rig({ saved: [PIPELINE] });
		try {
			await until(() => getSavedConnections().length === 1, 'the list');
			const before = r.spy.posts.length;
			const owner = r.frame.owner();
			await r.frame.caller.callReply('sql.saveConnection', { connection: big, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.saveConnection'] });
			const published = r.spy.posts.slice(before).filter((post) => (post as { __rrtool?: string; topic?: string }).__rrtool === 'state' && (post as { topic?: string }).topic === 'connections');
			assert.deepEqual(published, [], 'the oversize snapshot was refused');
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
