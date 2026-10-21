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
// GRAPH-UI - DEV-TOOL CONTROLLER (the sidebar mount: the tool's one engine connection)
// =============================================================================
//
// A plain function over injected parts (the realm's ConnectionManager as a
// structural type, the peer, the host's channel and the shell's protocol
// factories), so it runs under node:test against the real shell modules. The
// React mount (GraphDevToolSidebar.tsx) calls it in an effect and disposes it
// in the cleanup (R6).
//
// What it owns (R1): its OWN endpoint store, schema store, data versions,
// history and preview request; the bus-backed client; the identity tracker,
// the activation gate and the discovery watch; and every op handler.
//
//   QUIET (R7)  At mount it publishes retained state only: no event, no call,
//               no document, no engine request. Discovery waits for identity
//               AND activation (devtool/watch.ts); history is read only once
//               the tool is activated and an identity is known.
//   GATES (T10) graph.execute re-checks the write gate (canWrite on the
//               node's own dialect answer, and a ready endpoint) HERE, whatever
//               the frame believed, and counts the write (countWrite) here too,
//               so `dataVersions` moves for every frame of the connection.
//   IDENTITY    A different identity (or none) resets the endpoint store (the
//               watch), and here clears the schema snapshots and the pending
//               preview and re-binds history to the new owner's bag; frames
//               close themselves on the published fingerprint (R9).
//   SIZES (T11) Rows and history lists are op results. Retained snapshots are
//               capped (protocol.ts) and refused over 64 KiB; a result over
//               maxResultBytes is refused rather than sent.
// =============================================================================

import type { DevToolProps, IToolOpServer, ToolChannel } from 'shell';
import { ExplorerToolError, createActiveKeyStore } from 'shared/explorer';
import type { IExplorerClient, IExplorerEndpoint, IHistoryEntry } from 'shared/explorer';
import { createActivationGate } from 'shared/explorer/devtool/activation';
import type { IActivationBus, IActivationGate } from 'shared/explorer/devtool/activation';
import { getBusExplorerClient } from 'shared/explorer/devtool/busClient';
import type { IExplorerBus } from 'shared/explorer/devtool/busClient';
import { attachController } from 'shared/explorer/devtool/controller';
import type { ControllerHandlers } from 'shared/explorer/devtool/controller';
import { publishIdentityState } from 'shared/explorer/devtool/frameIdentity';
import { createIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IIdentityBus, IIdentityTracker } from 'shared/explorer/devtool/identity';
import { attachWhenLoaded, createFsPrefs, historyPrefsPath } from 'shared/explorer/devtool/prefs';
import type { IFsPrefs } from 'shared/explorer/devtool/prefs';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { replyOk } from 'shared/explorer/devtool/reply';
import { guardRetainedState, jsonByteLength } from 'shared/explorer/devtool/state';
import { createDevToolDiscovery } from 'shared/explorer/devtool/watch';
import type { IDevToolDiscovery, IDiscoveryBus, IFocusTarget } from 'shared/explorer/devtool/watch';
import { loadConnectionSchema } from '../adapters/actions';
import { TOOL, makeGraphEndpointStore, makeGraphHistory } from '../adapters/explorer';
import { DEVTOOL_HISTORY_PRIVACY_NOTE, memoryPrefs } from '../env';
import type { DocTarget, IGraphEnv, IReadable } from '../env';
import { endpointKeyFromUri } from '../graph/addresses';
import { countWrite, createDataVersions } from '../graph/dataVersion';
import { canWrite, parseDialect } from '../graph/dialect';
import { createPreviewStore } from '../graph/previews';
import { createSchemaStore } from '../graph/schemaStore';
import type { ReadQueryResult } from '../graph/types';
import { createLocalGraphEnv } from '../localEnv';
import type { IGraphStores } from '../localEnv';
import { EVENT, GRAPH_APP_ID, OP, STATE, docKeyFor, endpointsSnapshot, field, schemasSnapshot, toWire } from './protocol';
import type { GraphOps, HistoryEdit, IGraphHistoryView } from './protocol';

/** What the controller needs from its realm's ConnectionManager (structural; tests pass the base's fake realms). */
export type IGraphRealm = IIdentityBus & IActivationBus & IDiscoveryBus & IExplorerBus;

/** The largest result the controller sends to a frame (well above the node's own bounds; see T11). */
export const MAX_GRAPH_RESULT_BYTES = 32 * 1024 * 1024;

/** Said when a frame asks for a write the connection does not allow (nothing was sent). */
export const WRITE_REFUSED_TEXT = 'This connection does not allow writes: its node has direct execution off, does not support the graph result shape, or has not answered its check. Nothing was sent.';

/** What {@link createGraphController} needs. */
export interface IGraphControllerOptions {
	/** The realm's ConnectionManager. */
	cm: IGraphRealm;
	/** The sidebar mount's peer. */
	peer: DevToolPeer;
	/** The host's channel (both hosts pass one). */
	channel?: ToolChannel;
	/** The host's documents API (opened only on a user action). */
	documents?: DevToolProps['documents'];
	/** The sidebar's activeDocKey prop at mount. */
	activeDocKey?: string | null;
	/** The shell's createToolChannel (injected). */
	createToolChannel: (peer: DevToolPeer) => ToolChannel;
	/** The shell's createToolOpServer (injected). */
	createToolOpServer: (peer: DevToolPeer) => IToolOpServer<GraphOps>;
	/** The tool's app id (default rocketride.graph). */
	appId?: string;
	/** The clock (deadlines, previews). */
	now?: () => number;
	/** Where focus comes from (null in tests). */
	focusTarget?: IFocusTarget | null;
	/** The largest result sent to a frame (default MAX_GRAPH_RESULT_BYTES). */
	maxResultBytes?: number;
	/** Replace a store (tests). */
	stores?: Partial<IGraphStores>;
	/** Told about refused calls, oversize state and history file failures. */
	onError?: (error: unknown, where: string) => void;
}

/** A mounted controller. */
export interface IGraphController {
	readonly channel: ToolChannel;
	readonly stores: IGraphStores;
	readonly client: IExplorerClient;
	readonly identity: IIdentityTracker;
	readonly activation: IActivationGate;
	readonly discovery: IDevToolDiscovery;
	/** The connection the fronted document belongs to. */
	readonly activeConnection: IReadable<string | null>;
	/** Feed every new activeDocKey prop value. */
	noteActiveDocKey(key: string | null | undefined): void;
	/** The LOCAL env the sidebar's views use (rebuild it when the realm's connection flag changes). */
	env(ready: boolean): IGraphEnv;
	/** Dispose everything (idempotent). History still pending is written first. */
	dispose(): void;
}

/**
 * Mount the Graph Explorer controller.
 *
 * @param opts - See {@link IGraphControllerOptions}.
 * @returns The controller; dispose it in the mount's cleanup.
 */
export function createGraphController(opts: IGraphControllerOptions): IGraphController {
	const { cm, peer } = opts;
	const appId = opts.appId ?? GRAPH_APP_ID;
	const now = opts.now ?? Date.now;
	const maxResultBytes = opts.maxResultBytes ?? MAX_GRAPH_RESULT_BYTES;
	const report = (error: unknown, where: string): void => opts.onError?.(error, where);
	const client = getBusExplorerClient(cm);
	const stores: IGraphStores = {
		endpoints: opts.stores?.endpoints ?? makeGraphEndpointStore(),
		schemas: opts.stores?.schemas ?? createSchemaStore(),
		dataVersions: opts.stores?.dataVersions ?? createDataVersions(),
		history: opts.stores?.history ?? makeGraphHistory(),
		previews: opts.stores?.previews ?? createPreviewStore({ now }),
	};
	const identity = createIdentityTracker({ cm });
	const activation = createActivationGate({ appId, cm, ...(opts.activeDocKey !== undefined ? { activeDocKey: opts.activeDocKey } : {}) });
	const discovery = createDevToolDiscovery({ cm, client, identity, activation, ...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}) });
	const offs: Array<() => void> = [];
	let disposed = false;

	// ── The fronted document: the host's activeDocKey, else the frames' `active` event (R8) ─────
	let hostActive: string | null | undefined = opts.activeDocKey;
	let eventActive: string | null = null;
	const active = createActiveKeyStore();
	const syncActive = (): void => {
		const docKey = typeof hostActive === 'string' ? hostActive : hostActive === null ? null : eventActive;
		active.set(docKey ? endpointKeyFromUri(docKey) : null);
	};
	syncActive();

	// ── Op handlers: each answers a Reply (attachController wraps escaping failures) ────────────
	const keyOf = (params: unknown, op: string): string => {
		const key = field(params, 'key');
		if (typeof key !== 'string' || key === '') throw new ExplorerToolError({ kind: 'invalid', tool: op, message: `${op} needs a connection key.` });
		return key;
	};
	const textOf = (params: unknown, name: string, op: string): string => {
		const value = field(params, name);
		if (typeof value !== 'string') throw new ExplorerToolError({ kind: 'invalid', tool: op, message: `${op} needs ${name} as text.` });
		return value;
	};
	const endpointOf = (key: string, tool: string): IExplorerEndpoint => {
		const endpoint = stores.endpoints.getState().endpoints.find((candidate) => candidate.key === key);
		if (!endpoint) throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'This connection is not listed any more. Refresh the connections.' });
		return endpoint;
	};
	const sized = <T>(result: T, tool: string): T => {
		const bytes = jsonByteLength(result);
		if (bytes > maxResultBytes) {
			const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
			throw new ExplorerToolError({ kind: 'malformed', tool, message: `The result is ${mb(bytes)} MB, too large to send to this window (the limit is ${mb(maxResultBytes)} MB). Lower the row limit, or return fewer or smaller properties.` });
		}
		return result;
	};
	const applyEdit = (key: string, edit: HistoryEdit): void => {
		const history = stores.history;
		switch (edit.action) {
			case 'record': {
				const entry = edit.entry as unknown;
				if (typeof field(entry, 'id') !== 'string' || typeof field(entry, 'cypher') !== 'string' || typeof field(entry, 'at') !== 'number') {
					throw new ExplorerToolError({ kind: 'invalid', tool: OP.historyEdit, message: 'A history entry needs an id, a statement and a time.' });
				}
				history.runs.emitRun(key, entry as IHistoryEntry<'cypher'>);
				return;
			}
			case 'remove':
				history.removeEntry(key, edit.id);
				return;
			case 'pin':
				history.togglePin(key, edit.id);
				return;
			case 'note':
				history.setNote(key, edit.id, edit.note);
				return;
			case 'clear':
				history.clearForKey(key);
				return;
			case 'recording':
				history.setRecording(key, edit.on === true);
				return;
			default:
				throw new ExplorerToolError({ kind: 'invalid', tool: OP.historyEdit, message: 'Unknown history change.' });
		}
	};
	const editOf = (params: unknown): HistoryEdit => {
		const edit = field(params, 'edit');
		const action = field(edit, 'action');
		const id = field(edit, 'id');
		const needsId = action === 'remove' || action === 'pin' || action === 'note';
		if (typeof action !== 'string' || (needsId && typeof id !== 'string') || (action === 'note' && typeof field(edit, 'note') !== 'string')) {
			throw new ExplorerToolError({ kind: 'invalid', tool: OP.historyEdit, message: 'Unknown history change.' });
		}
		return edit as HistoryEdit;
	};

	const handlers: ControllerHandlers<GraphOps> = {
		[OP.refreshEndpoints]: (params) => {
			if (!discovery.allowed()) throw new ExplorerToolError({ kind: 'unavailable', tool: OP.refreshEndpoints, message: 'Not signed in to a server yet, so nothing was discovered.' });
			void stores.endpoints.refresh(client, { reprobe: field(params, 'reprobe') === true });
			return replyOk(null);
		},
		[OP.probe]: async (params) => replyOk(await stores.endpoints.probe(client, keyOf(params, OP.probe))),
		[OP.loadSchema]: (params) => {
			const endpoint = endpointOf(keyOf(params, OP.loadSchema), TOOL.getSchema);
			void loadConnectionSchema(client, endpoint, { fresh: field(params, 'fresh') === true }, { endpoints: stores.endpoints, schemas: stores.schemas });
			return replyOk(null);
		},
		[OP.readQuery]: async (params) => {
			const endpoint = endpointOf(keyOf(params, OP.readQuery), TOOL.readQuery);
			const cypher = textOf(params, 'cypher', OP.readQuery);
			const input = field(params, 'params');
			const limit = field(params, 'limit');
			if (typeof limit !== 'number' || !(input !== null && typeof input === 'object' && !Array.isArray(input))) {
				throw new ExplorerToolError({ kind: 'invalid', tool: TOOL.readQuery, message: 'read_query needs its params and a row limit.' });
			}
			const result = await stores.endpoints.session(client, endpoint).invoke<ReadQueryResult>(TOOL.readQuery, { cypher, params: input as Record<string, unknown>, limit });
			return replyOk(sized(result, TOOL.readQuery));
		},
		[OP.execute]: async (params) => {
			const key = keyOf(params, OP.execute);
			const endpoint = endpointOf(key, TOOL.execute);
			const query = textOf(params, 'query', OP.execute);
			// T10: the gate is the CONTROLLER's, whatever the frame believed.
			const probe = stores.endpoints.getState().probes[key];
			const dialect = probe?.ok ? parseDialect(probe.info) : null;
			if (endpoint.state !== 'ready' || !canWrite(dialect)) throw new ExplorerToolError({ kind: 'unavailable', tool: TOOL.execute, message: WRITE_REFUSED_TEXT });
			const session = stores.endpoints.session(client, endpoint);
			const result = await countWrite(stores.dataVersions, key, () => session.invoke<ReadQueryResult>(TOOL.execute, { query, shape: 'graph' }));
			return replyOk(sized(result, TOOL.execute));
		},
		[OP.ask]: async (params) => {
			const endpoint = endpointOf(keyOf(params, OP.ask), TOOL.getQuery);
			const question = textOf(params, 'question', OP.ask);
			return replyOk(await stores.endpoints.session(client, endpoint).invoke<unknown>(TOOL.getQuery, { question }));
		},
		[OP.historyList]: (params) => {
			const key = keyOf(params, OP.historyList);
			const view: IGraphHistoryView = { entries: stores.history.getHistory(key), recording: stores.history.getRecording(key) };
			return replyOk(toWire(view));
		},
		[OP.historyEdit]: (params) => {
			applyEdit(keyOf(params, OP.historyEdit), editOf(params));
			return replyOk(null);
		},
		[OP.writeAbandoned]: (params) => {
			stores.dataVersions.bump(keyOf(params, OP.writeAbandoned));
			return replyOk(null);
		},
	};

	// ── The channel first, then the ONE op server (attachController, R6) ────────────────────────
	const attached = attachController<GraphOps>({
		peer,
		...(opts.channel ? { channel: opts.channel } : {}),
		createToolChannel: opts.createToolChannel,
		createToolOpServer: opts.createToolOpServer,
		handlers,
		now,
		onFirstOp: () => activation.open('op'),
		onRefused: (error) => report(error, 'refused'),
	});
	let refused = false;
	const channel = guardRetainedState(attached.channel, {
		onOversize: (error) => {
			refused = true;
			report(error, 'state');
		},
	});

	// ── Retained state: published at mount (allowed, R7) and on every change ────────────────────
	const published = new Map<string, string>();
	const publish = (topic: string, snapshot: unknown): void => {
		if (disposed) return;
		const text = JSON.stringify(snapshot);
		if (published.get(topic) === text) return;
		refused = false;
		channel.publishState(topic, snapshot);
		if (!refused) published.set(topic, text);
	};
	const publishEndpoints = (): void => publish(STATE.endpoints, endpointsSnapshot(stores.endpoints.getState()));
	const publishSchemas = (): void => publish(STATE.schemas, schemasSnapshot(stores.schemas.keys().map((key) => [key, stores.schemas.get(key)] as const)));
	const publishVersions = (): void => publish(STATE.dataVersions, stores.dataVersions.snapshot());
	let historyRev = 0;
	const publishHistory = (): void => publish(STATE.history, { rev: historyRev });
	const publishPreviews = (): void => publish(STATE.previews, { pending: stores.previews.get() });
	offs.push(stores.endpoints.subscribe(publishEndpoints));
	offs.push(stores.schemas.subscribe(publishSchemas));
	offs.push(stores.dataVersions.subscribe(publishVersions));
	offs.push(stores.history.subscribe(() => {
		historyRev += 1;
		publishHistory();
	}));
	offs.push(stores.previews.subscribe(publishPreviews));
	publishEndpoints();
	publishSchemas();
	publishVersions();
	publishHistory();
	publishPreviews();
	offs.push(publishIdentityState(channel, identity));

	// ── Frame events: `active` (the fallback for the fronted document, and a taken preview) ─────
	offs.push(attached.channel.onEvent(EVENT.active, (payload) => {
		const docKey = field(payload, 'docKey');
		const consumed = field(payload, 'consumed');
		if (typeof consumed === 'string') stores.previews.consume(consumed);
		if (typeof docKey === 'string') {
			eventActive = docKey;
			syncActive();
		}
	}));

	// ── Discovery: the store follows identity, activation, task events and focus ────────────────
	offs.push(stores.endpoints.attach(client, identity.get().identity, discovery.watch));

	// ── Identity: what belonged to the previous one goes ────────────────────────────────────────
	let fingerprint = identity.get().known ? identity.get().fingerprint : null;
	offs.push(identity.subscribe((snapshot) => {
		const next = snapshot.known ? snapshot.fingerprint : null;
		if (next === fingerprint) return;
		fingerprint = next;
		stores.schemas.clear();
		stores.previews.clear();
		syncHistory();
	}));

	// ── History: an fs-backed bag per identity, loaded before it is attached (§3.5) ─────────────
	let prefs: IFsPrefs | null = null;
	let detachHistory: (() => void) | null = null;
	let historyOwner: string | null = null;
	function syncHistory(): void {
		const owner = activation.isOpen() && identity.get().known ? identity.get().fingerprint : null;
		if (owner === historyOwner) return;
		detachHistory?.();
		detachHistory = null;
		prefs?.dispose();
		prefs = null;
		historyOwner = owner;
		if (owner === null || disposed) return;
		prefs = createFsPrefs({
			cm,
			path: historyPrefsPath('graph'),
			owner,
			ownerNow: () => (identity.get().known ? identity.get().fingerprint : null),
			onError: (error, phase) => report(error, `history ${phase}`),
		});
		detachHistory = attachWhenLoaded(prefs, (api, who) => stores.history.attachPrefs(api, who));
	}
	offs.push(activation.subscribe(() => syncHistory()));

	// ── The sidebar's own env (LOCAL, over these stores) ─────────────────────────────────────────
	const openDocument = (target: DocTarget): void => {
		activation.open('user');
		const documents = opts.documents;
		if (!documents) return;
		if (target.kind === 'connections') documents.open('', 'Graph Explorer');
		else documents.open(docKeyFor(target.kind, target.endpoint.key), target.kind === 'write' ? `${target.endpoint.nodeName || 'Graph'} (write)` : target.endpoint.nodeName || 'Graph');
	};
	const sidebarPrefs = memoryPrefs();
	const activeConnection: IReadable<string | null> = { get: active.get, subscribe: active.subscribe };
	let lastEnv: { ready: boolean; env: IGraphEnv } | null = null;

	return {
		channel: attached.channel,
		stores,
		client,
		identity,
		activation,
		discovery,
		activeConnection,
		noteActiveDocKey(key) {
			hostActive = key;
			activation.noteActiveDocKey(key);
			syncActive();
		},
		env(ready) {
			if (lastEnv && lastEnv.ready === ready) return lastEnv.env;
			const local = createLocalGraphEnv({
				mount: 'controller',
				ready,
				client: ready ? client : null,
				stores,
				activeConnection,
				openDocument,
				prefs: sidebarPrefs,
				historyPrivacyNote: DEVTOOL_HISTORY_PRIVACY_NOTE,
				refresh: (o) => {
					activation.open('user');
					return discovery.allowed() ? stores.endpoints.refresh(client, o) : Promise.resolve();
				},
			});
			const env: IGraphEnv = {
				...local,
				loadSchema: (key, o) => {
					activation.open('user');
					return local.loadSchema(key, o);
				},
				previews: {
					...local.previews,
					request: (input) => {
						activation.open('user');
						local.previews.request(input);
					},
				},
			};
			lastEnv = { ready, env };
			return env;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			detachHistory?.();
			detachHistory = null;
			const closing = prefs;
			prefs = null;
			if (closing) void closing.close();
			discovery.dispose();
			activation.dispose();
			identity.dispose();
			attached.dispose();
		},
	};
}
