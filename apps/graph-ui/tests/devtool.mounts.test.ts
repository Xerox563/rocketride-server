// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL MOUNTS: the descriptor, frames without a client, docKey routing,
// the full app on the LOCAL env, the one wiring module, and what degrades
// (T1, T2, T9, T12, R6, R7, R11)
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fakeWorld } from 'shared/explorer/connect/testing';
import { findToolFactoryImports } from 'shared/explorer/devtool/testing';
import { makeGraphEndpointStore, makeGraphHistory } from '../src/adapters/explorer';
import type { IGraphFrameOptions } from '../src/devtool/frame';
import { docKeyFor, routeDocKey } from '../src/devtool/protocol';
import { APP_HISTORY_PRIVACY_NOTE, DEVTOOL_HISTORY_PRIVACY_NOTE, memoryPrefs } from '../src/env';
import type { DocTarget } from '../src/env';
import { createDataVersions } from '../src/graph/dataVersion';
import { createPreviewStore } from '../src/graph/previews';
import { createSchemaStore } from '../src/graph/schemaStore';
import { COPY_BLOCKED_NOTE, GRID_NOTICE } from '../src/graph/wording';
import { chooseWorkerStrategy } from '../src/layout/workerStrategy';
import { ExplorerToolError } from 'shared/explorer';
import { CONTROLLER_NOT_READY_TEXT, frameFailureText, missingConnectionText } from '../src/devtool/frameText';
import { createRegionClaims } from '../src/realmRegion';
import { createLocalGraphEnv } from '../src/localEnv';
import { graphRow, mountController, mountFrame, readOnlyNode, signInVsCode, until, vscodeRealm } from './support/devtool';

const APP = path.resolve(__dirname, '..');
const SRC = path.join(APP, 'src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Source without comments. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');

/**
 * Every source file reachable from an entry through relative imports (the module graph of one mount).
 *
 * @param entry - The entry, relative to src.
 * @returns The files, relative to src.
 */
function reachable(entry: string): string[] {
	const seen = new Set<string>();
	const visit = (rel: string): void => {
		if (seen.has(rel)) return;
		seen.add(rel);
		const text = read(rel);
		for (const match of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(\.[^']+)'/gm)) {
			const base = path.join(path.dirname(rel), match[1]);
			const file = ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).find((candidate) => fs.existsSync(path.join(SRC, candidate)));
			if (file) visit(file);
		}
	};
	visit(entry);
	return [...seen].sort();
}

/**
 * Every .ts/.tsx file under src.
 *
 * @returns Their paths (relative to src) and text.
 */
function allSources(): Array<{ path: string; text: string }> {
	const out: Array<{ path: string; text: string }> = [];
	const walk = (dir: string): void => {
		for (const name of fs.readdirSync(dir)) {
			const full = path.join(dir, name);
			if (fs.statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|tsx)$/.test(name)) out.push({ path: path.relative(SRC, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
		}
	};
	walk(SRC);
	return out;
}

describe('T1 - the descriptor declares both dev-tool mounts; the manifest says devTool; the id is unchanged', () => {
	it('AppDescriptor exports devToolFrame and devToolSidebar beside app, under rocketride.graph', () => {
		const descriptor = code(read('AppDescriptor.ts'));
		assert.match(descriptor, /id: 'rocketride\.graph',/);
		assert.match(descriptor, /app: GraphApp,/);
		assert.match(descriptor, /devToolFrame: GraphDevTool,/);
		assert.match(descriptor, /devToolSidebar: GraphDevToolSidebar,/);
		assert.match(descriptor, /import \{ GraphDevTool \} from '\.\/GraphDevToolFrame';/);
		assert.match(descriptor, /import \{ GraphDevToolSidebar \} from '\.\/GraphDevToolSidebar';/);
		const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
		assert.equal(pkg.appManifest.id, 'rocketride.graph');
		assert.ok(pkg.appManifest.categories.includes('devTool'), 'the manifest category the hosts list dev tools by');
		assert.ok(pkg.appManifest.categories.includes('tools'));
		const config = fs.readFileSync(path.join(APP, 'rsbuild.config.mts'), 'utf8');
		assert.match(config, /'\.\/AppDescriptor': '\.\/src\/AppDescriptor\.ts'/, 'the module federation expose is still ./AppDescriptor');
	});

	it('the two mount components are real exports (the frame imported with a stand-in Worker: Monaco\'s environment extends it at load)', async () => {
		const g = globalThis as { Worker?: unknown };
		const had = 'Worker' in g;
		if (!had) g.Worker = class {};
		try {
			const frame = await import('../src/GraphDevToolFrame');
			const sidebar = await import('../src/GraphDevToolSidebar');
			assert.equal(typeof frame.GraphDevTool, 'function');
			assert.equal(typeof sidebar.GraphDevToolSidebar, 'function');
		} finally {
			if (!had) delete g.Worker;
		}
	});
});

describe('T2 - frames hold no client', () => {
	const FRAME_ENTRY = 'GraphDevToolFrame.tsx';

	it('no module a frame loads reaches for a client, the ConnectionManager, the workspace prefs or the app\'s singleton stores', () => {
		const files = reachable(FRAME_ENTRY);
		assert.ok(files.includes('devtool/frame.ts') && files.includes('components/RunSurface.tsx') && files.includes('views/WorkbenchView.tsx'), 'the premise: the walk reaches the frame code and its views');
		for (const forbidden of ['devtool/controller.ts', 'localEnv.ts', 'adapters/actions.ts', 'adapters/react.ts', 'GraphApp.tsx', 'GraphSidebar.tsx', 'docs.ts']) {
			assert.ok(!files.includes(forbidden), `a frame loads ${forbidden}`);
		}
		for (const file of files) {
			const text = code(read(file));
			assert.doesNotMatch(text, /useShellConnection|ConnectionManager|getClient\(|getBusExplorerClient|RocketRideClient|usePrefs|shared\/explorer\/react/, `${file} reaches for a client or the workspace prefs`);
			if (file === 'adapters/explorer.ts') continue;
			assert.doesNotMatch(text, /import\s*\{[^}]*\b(graphEndpoints|graphHistory|dataVersions|schemas|appPreviews|activeConnection)\b[^}]*\}\s*from\s*'[./]*adapters\/explorer'/, `${file} imports one of the app's own stores`);
		}
	});

	it('a frame is built without a client: its options have none, and it works with no client anywhere in its realm', async () => {
		// @ts-expect-error a frame takes no ConnectionManager
		const typed: IGraphFrameOptions = { cm: {} };
		void typed;
		const engine = vscodeRealm();
		signInVsCode(engine.realm);
		const mounted = mountController(engine.cm);
		mounted.h.setHostConnection(true);
		const { frame } = mountFrame(mounted.h, undefined);
		await until(() => Object.keys(frame.env(true).endpoints.get().probes).length === 1, 'the probe');
		const endpoint = frame.env(true).endpoints.get().endpoints[0];
		const before = engine.requests.length;
		await frame.env(true).session(endpoint)?.invoke('read_query', { cypher: 'MATCH (n) RETURN n', params: {}, limit: 5 });
		const engineCalls = engine.requests.slice(before).filter((r) => r.op === 'client.tool');
		assert.equal(engineCalls.length, 1, 'the engine call was made by the CONTROLLER\'s realm, over its bus');
		frame.dispose();
		mounted.controller.dispose();
	});
});

describe('T9 - docKey routing for every family', () => {
	it('undefined (VS Code) and \'\' (rocket-ui) are the landing; workbench: and write: route by key; anything else is not found', () => {
		const key = 'k1|dev|user|u1|team-1|proj-1|tools=tools_1|graph_1';
		assert.deepEqual(routeDocKey(undefined), { kind: 'landing' });
		assert.deepEqual(routeDocKey(''), { kind: 'landing' });
		assert.deepEqual(routeDocKey(null), { kind: 'landing' });
		assert.deepEqual(routeDocKey(`workbench:${key}`), { kind: 'workbench', key });
		assert.deepEqual(routeDocKey(`write:${key}`), { kind: 'write', key });
		for (const unknown of ['workbench:', 'write:', 'connections', 'edit:*new*', key, 'console:x']) assert.deepEqual(routeDocKey(unknown), { kind: 'unknown', docKey: unknown });
		assert.equal(docKeyFor('workbench', key), `workbench:${key}`);
		assert.equal(docKeyFor('write', key), `write:${key}`);
	});

	it('the frame renders each route: the landing, a connection document, or the not-found empty state', () => {
		const frame = code(read('GraphDevToolFrame.tsx'));
		assert.match(frame, /if \(route\.kind === 'landing'\) return <ConnectionsView \/>;/);
		assert.match(frame, /if \(route\.kind === 'unknown'\) \{[\s\S]*?title=\{UNKNOWN_DOCUMENT_TITLE\}/);
		assert.match(frame, /return <FrameConnectionDocument kind=\{route\.kind\} endpointKey=\{route\.key\} controllerReady=\{controllerReady\} \/>;/);
		assert.match(frame, /<FrameBody route=\{frame\.route\} controllerReady=\{controllerReady\} \/>/);
	});
});

describe('T12 - the full app (app:) runs on the LOCAL env', () => {
	it('GraphApp provides the LOCAL env over its own stores and the realm\'s bus client, to its tree AND to the sidebar the shell renders apart', () => {
		const app = code(read('GraphApp.tsx'));
		assert.match(app, /const APP_STORES: IGraphStores = \{ endpoints: graphEndpoints, schemas, dataVersions, history: graphHistory, previews: appPreviews \};/);
		assert.match(app, /getBusExplorerClient\(ConnectionManager\.getInstance\(\)\)/);
		assert.match(app, /createLocalGraphEnv\(\{ mount: 'app', ready: isConnected, client, stores: APP_STORES,/);
		assert.match(app, /<GraphEnvProvider value=\{env\}><GraphSidebar \/><\/GraphEnvProvider>/);
		assert.match(app, /historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE/);
	});

	it('the LOCAL env does what the full app did: discovery, a counted write, history, previews taken once, documents', async () => {
		const world = fakeWorld([graphRow()], readOnlyNode);
		const stores = { endpoints: makeGraphEndpointStore({ debounceMs: 0 }), schemas: createSchemaStore(), dataVersions: createDataVersions(), history: makeGraphHistory(0), previews: createPreviewStore() };
		const memory = memoryPrefs();
		stores.history.attachPrefs(memory, 'owner');
		const opened: DocTarget[] = [];
		const env = createLocalGraphEnv({ mount: 'app', ready: true, client: world.client, stores, activeConnection: { get: () => null, subscribe: () => () => undefined }, openDocument: (t) => opened.push(t), prefs: memoryPrefs(), historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE });
		await env.refresh();
		const endpoint = env.endpoints.get().endpoints[0];
		assert.ok(endpoint, 'discovered');
		assert.equal(env.endpoints.get().omitted, 0);
		assert.equal(env.endpoints.get(), env.endpoints.get(), 'a stable snapshot between changes');
		await env.countWrite(endpoint.key, async () => 'sent');
		assert.equal(env.dataVersions.get(endpoint.key), 1, 'the write is counted in the call');
		env.markAbandonedWrite(endpoint.key);
		assert.equal(env.dataVersions.get(endpoint.key), 2);
		env.history.record(endpoint.key, { id: 'a', at: 1, kind: 'read', cypher: 'RETURN 1', ms: 1, outcome: 'rows', rows: 1 } as never);
		assert.equal(env.history.view(endpoint.key).get().entries.length, 1);
		assert.equal(env.history.view(endpoint.key).get(), env.history.view(endpoint.key).get(), 'a stable view');
		env.previews.request({ endpointKey: endpoint.key, action: 'label-preview', name: 'Person' });
		const pending = env.previews.pending.get();
		assert.ok(pending);
		assert.equal(env.previews.consume(pending.nonce), true);
		assert.equal(env.previews.consume(pending.nonce), false);
		assert.equal(env.previews.pending.get(), null, 'a workbench that mounts later finds nothing');
		await env.loadSchema(endpoint.key);
		assert.ok(env.schemaLabels.get(endpoint.key).length > 0);
		assert.equal(env.schemaLabels.get(endpoint.key), env.schemaLabels.get(endpoint.key), 'stable labels');
		env.openDocument({ kind: 'connections' });
		assert.deepEqual(opened, [{ kind: 'connections' }]);
		assert.equal(env.session(endpoint)?.endpoint.key, endpoint.key);
		const offline = createLocalGraphEnv({ mount: 'app', ready: false, client: null, stores, activeConnection: { get: () => null, subscribe: () => () => undefined }, openDocument: () => undefined, prefs: memoryPrefs(), historyPrivacyNote: APP_HISTORY_PRIVACY_NOTE });
		assert.equal(offline.session(endpoint), null, 'no session while not connected');
	});

	it('every view reaches the engine through the env: the six useShellConnection call sites are gone from the views', () => {
		for (const file of ['GraphSidebar.tsx', 'components/AskBar.tsx', 'components/RunSurface.tsx', 'views/ConnectionsView.tsx', 'views/WorkbenchView.tsx', 'views/WriteConsoleView.tsx', 'components/HistoryPanel.tsx']) {
			const text = code(read(file));
			assert.doesNotMatch(text, /useShellConnection|usePrefs|getDocs\(|graphEndpoints|graphHistory|workbenchRequests/, `${file} still reaches past the env`);
			assert.match(text, /useGraphEnv\(\)|useGraphEndpoints\(\)/, `${file} reads the env`);
		}
		const users = allSources().filter((f) => /\buseShellConnection\(\)/.test(code(f.text))).map((f) => f.path).sort();
		assert.deepEqual(users, ['GraphApp.tsx', 'GraphDevToolSidebar.tsx'], 'only the two LOCAL mount roots read the shell connection');
		const prefs = allSources().filter((f) => /\busePrefs\(\)/.test(code(f.text))).map((f) => f.path);
		assert.deepEqual(prefs, ['GraphApp.tsx'], 'only the full app reads the workspace prefs (a dev-tool mount would write into the host\'s bag)');
	});
});

describe('R6 - one wiring module; mounts built in effects', () => {
	it('createToolChannel, createToolOpServer and createToolController are imported from shell in ONE module', () => {
		assert.deepEqual(findToolFactoryImports(allSources()), ['devtool/wiring.ts']);
	});

	it('the sidebar builds its controller, and the frame its caller, in an effect with a disposing cleanup, never in a memo', () => {
		const sidebar = code(read('GraphDevToolSidebar.tsx'));
		assert.match(sidebar, /useEffect\(\(\) => \{[\s\S]*?const created = createGraphController\(\{[\s\S]*?return \(\) => \{\s*created\.dispose\(\);/);
		assert.doesNotMatch(sidebar, /useMemo\(\(\) => createGraphController|peer\.subscribe/);
		const frame = code(read('GraphDevToolFrame.tsx'));
		assert.match(frame, /useEffect\(\(\) => \{[\s\S]*?const created: IGraphFrame = createGraphFrame\(\{[\s\S]*?return \(\) => \{\s*created\.dispose\(\);/);
		assert.doesNotMatch(frame, /useMemo\(\(\) => createGraphFrame|peer\.subscribe/);
	});
});

describe('R7 - the sidebar opens documents only on a click', () => {
	it('GraphSidebar calls openDocument and previews.request from its click handlers only, never from an effect', () => {
		const sidebar = code(read('GraphSidebar.tsx'));
		const effects = [...sidebar.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[/g)].map((m) => m[1]);
		assert.ok(effects.length > 0, 'the premise: the sidebar has effects');
		for (const effect of effects) assert.doesNotMatch(effect, /openDocument|previews\.request/);
		const select = sidebar.slice(sidebar.indexOf('const select = '), sidebar.indexOf('const open = '));
		assert.match(select, /env\.openDocument\(/);
	});
});

describe('one live region per realm (rocket-ui runs several Graph documents in one realm)', () => {
	it('the first mounted region is the one that speaks; when it unmounts the next takes over; none is left after the last', () => {
		const claims = createRegionClaims();
		const a = {};
		const b = {};
		const c = {};
		claims.claim(a);
		claims.claim(b);
		claims.claim(c);
		assert.equal(claims.owner(), a, 'exactly one region speaks');
		let changes = 0;
		const off = claims.subscribe(() => { changes += 1; });
		claims.release(a);
		assert.equal(claims.owner(), b, 'the next one takes over');
		claims.release(c);
		assert.equal(claims.owner(), b);
		claims.release(b);
		assert.equal(claims.owner(), null);
		claims.claim(a);
		claims.claim(a);
		claims.release(a);
		assert.equal(claims.owner(), null, 'a claim is per token, not counted twice');
		assert.ok(changes > 0);
		off();
	});

	it('every mount renders the realm\'s region, portalled to the page so a hidden tab cannot silence it', () => {
		for (const file of ['GraphDevToolFrame.tsx', 'GraphApp.tsx']) {
			const text = code(read(file));
			assert.match(text, /<RealmLiveRegion \/>/, `${file} renders the realm's region`);
			assert.doesNotMatch(text, /<LiveRegion \/>/, `${file} renders no region of its own`);
		}
		const region = code(read('components/RealmLiveRegion.tsx'));
		assert.match(region, /createPortal\(<LiveRegion \/>, document\.body\)/);
	});
});

describe('what a frame says when it cannot reach the controller', () => {
	it('a call that was never sent because no controller is up says to open the sidebar, not the op\'s name; a dropped call says nothing', () => {
		const notSent = new ExplorerToolError({ kind: 'timeout', tool: 'graph.refreshEndpoints', message: "'graph.refreshEndpoints' was not sent: the tool's controller did not become ready within 15s." });
		assert.equal(frameFailureText(notSent, false), CONTROLLER_NOT_READY_TEXT);
		assert.doesNotMatch(CONTROLLER_NOT_READY_TEXT, /graph\./);
		assert.equal(frameFailureText(new ExplorerToolError({ kind: 'stale', tool: 'x', message: 'dropped' }), true), null);
		assert.equal(frameFailureText(new ExplorerToolError({ kind: 'unavailable', tool: 'x', message: 'Not signed in.' }), true), 'Not signed in.');
	});

	it('a connection a document cannot find says why: no sidebar yet, still looking, left out of a capped list, or not listed', () => {
		assert.equal(missingConnectionText('idle', 0, false).description, CONTROLLER_NOT_READY_TEXT);
		assert.match(missingConnectionText('loading', 0, true).title, /Looking/);
		assert.match(missingConnectionText('ready', 12, true).description, /too many connections/);
		assert.match(missingConnectionText('ready', 0, true).description, /not running, or it belongs to another account/);
	});
});

describe('R11 - what cannot work in a dev-tool mount degrades visibly', () => {
	it('the history note says where each mount keeps history', () => {
		assert.match(APP_HISTORY_PRIVACY_NOTE, /workspace file on the server/);
		assert.match(DEVTOOL_HISTORY_PRIVACY_NOTE, /rocketride\.graph\.history\.json/);
		assert.match(DEVTOOL_HISTORY_PRIVACY_NOTE, /session only/);
		assert.match(code(read('components/HistoryPanel.tsx')), /\{env\.historyPrivacyNote\}/);
	});

	it('a layout worker the window cannot start (a VS Code webview loading the remote from the engine) falls back to the grid, with a note', () => {
		const strategy = chooseWorkerStrategy({ workerUrl: 'http://127.0.0.1:5565/apps/rocketride.graph/v3/static/js/async/graph-layout.js', pageHref: 'vscode-webview://abc123/index.html', production: true, hasWorker: true });
		assert.equal(strategy.kind, 'unavailable');
		assert.match(code(read('components/GraphView.tsx')), /layoutStatus\.state === 'fallback' && \([\s\S]*?\$\{GRID_NOTICE\} \(\$\{layoutStatus\.detail\}\)/);
		assert.match(GRID_NOTICE, /grid/);
	});

	it('a blocked clipboard leaves the text on screen to copy by hand (Raw view and inspector)', () => {
		assert.match(COPY_BLOCKED_NOTE, /select it/);
		const raw = code(read('components/ResultViews.tsx'));
		assert.match(raw, /\{blocked !== null && <CopyBlocked text=\{blocked\} \/>\}/);
		assert.match(raw, /<textarea readOnly value=\{text\}/);
		assert.match(code(read('components/InspectorPanel.tsx')), /\{blocked !== null && blocked === m\.json && <CopyBlocked text=\{blocked\} \/>\}/);
	});
});
