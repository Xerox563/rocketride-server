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
// SQL — ENGINE CORE (what lies beneath SqlEnv where the engine connection is)
// =============================================================================
//
// One core per owner of the engine connection: the full app's mount (`app:`),
// or the dev tool's CONTROLLER (the sidebar mount). Frames never hold one
// (R1); they reach it through ops (sqlBridge.ts). It is built on the shared
// Explorer library:
//
//   client      the library's IExplorerClient over the shell bus
//               (shared/explorer/devtool/busClient), every request with an
//               explicit timeout;
//   identity    the dev-tool identity tracker: it fails closed, and NOTHING is
//               discovered while it cannot vouch for anyone;
//   activation  the full app opens it at once; a dev-tool controller waits
//               for the tool to be activated (rocket-ui mounts every pinned
//               controller at boot), the first op from a frame, or a user
//               action in the sidebar;
//   endpoints   SQL Explorer's endpoint store (connect/endpoints.ts): owner-
//               aware discovery, one probe per endpoint, the task-token vault,
//               the sessions (tokens come ONLY from that vault);
//   the saved-connection list, read from the user's store once the identity
//               is known, read again for each new identity, forgotten when
//               it becomes unknown.
//
// RESOLUTION (a saved connection -> the running endpoint it names). A saved
// connection is named by its id, never by an endpoint or a key from outside:
//
//   pipeline   the discovered endpoint whose `legacyKey` equals
//              `endpointKeyForConnection(record)`. The store sets a
//              legacyKey only on the caller's OWN development run, so that is
//              the run a saved `projectId:source:nodeId` opens; a team
//              deployment or another owner's run never matches. Discovery is
//              identity-filtered (another organization's runs are dropped).
//   direct     `client.use` starts or reattaches the connection's temporary
//              tool pipeline (explicit timeout), then discovery finds it by
//              its legacyKey `sqlconn-<id>:tools_1:<provider>_1`. A direct
//              pipeline that idled out (its endpoint shows `stopped` or is
//              gone) is started again before the next call.
//
// A connection that resolves to nothing fails with an ExplorerToolError of
// kind `unavailable` (the controller answers it as Reply data). Every wait
// here is bounded (see the constants), so a frame's timeout can be derived
// from them (sqlTimeouts in ops.ts).
// =============================================================================

import { ExplorerToolError } from 'shared/explorer/errors';
import type { IEndpointStore, IStoreClock } from 'shared/explorer/connect/store';
import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer/types';
import { busRequest, getBusExplorerClient } from 'shared/explorer/devtool/busClient';
import type { IExplorerBus } from 'shared/explorer/devtool/busClient';
import { createIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IIdentityBus, IIdentitySnapshot, IIdentityTracker } from 'shared/explorer/devtool/identity';
import { createActivationGate } from 'shared/explorer/devtool/activation';
import type { IActivationBus, IActivationGate } from 'shared/explorer/devtool/activation';
import { createDevToolDiscovery } from 'shared/explorer/devtool/watch';
import type { IDevToolDiscovery, IDiscoveryBus, IFocusTarget } from 'shared/explorer/devtool/watch';
import {
	createSqlEndpoints,
	createSqlSession,
	directProjectId,
	directUseOptions,
	endpointForConnection,
	endpointKeyForConnection,
	getSavedConnection,
	getSavedConnectionsStatus,
	loadSavedConnections,
	resetSavedConnections,
	subscribeSavedConnections,
	TOOLS_SOURCE_ID,
} from './connect';
import type { SavedConnectionsFs, SavedSqlConnection, SqlEndpoint, SqlSession } from './connect';

// =============================================================================
// WAITS (every one explicit; see ops.ts for how a frame derives its own)
// =============================================================================

/** Bus timeout of each user-store request (the saved-connection file). */
export const FS_TIMEOUT_MS = 15_000;

/** How long a call waits for the saved-connection list to finish loading (mkdir + read). */
export const LIST_WAIT_MS = 2 * FS_TIMEOUT_MS;

/** Bus timeout of `client.use` (starting or reattaching a direct connection's pipeline). */
export const USE_TIMEOUT_MS = 60_000;

/**
 * How long resolution waits for a discovery it asked for: the store's own
 * discovery bound (30 s) plus one probe (15 s). Discovery merges endpoints
 * before it probes them, so an endpoint is usually found well before this.
 */
export const DISCOVERY_WAIT_MS = 45_000;

/** The longest a resolution can take: the list, a direct pipeline's start, and a discovery. */
export const RESOLVE_BUDGET_MS = LIST_WAIT_MS + USE_TIMEOUT_MS + DISCOVERY_WAIT_MS;

/** Bus timeout of `client.getTaskToken` and `client.terminate` (releasing a direct pipeline). */
export const RELEASE_STEP_TIMEOUT_MS = 15_000;

/** Bus timeout of `client.getService` (one service definition). */
export const SERVICE_TIMEOUT_MS = 30_000;

/** Bus timeout of `client.validate` (one component). */
export const VALIDATE_TIMEOUT_MS = 30_000;

/** Bus timeout of `client.getEnvironmentKeys`. */
export const ENV_KEYS_TIMEOUT_MS = 15_000;

// =============================================================================
// TYPES
// =============================================================================

/** What the core needs from a realm's ConnectionManager (structural). */
export type SqlCoreBus = IExplorerBus & IIdentityBus & IActivationBus & IDiscoveryBus;

/** What {@link createSqlCore} needs. */
export interface SqlCoreOptions {
	/** The realm's ConnectionManager. */
	cm: SqlCoreBus;
	/** This tool's app id (the activation gate listens for it). */
	appId: string;
	/**
	 * `app`: the full app, which owns the window and discovers at once;
	 * `devtool`: a dev-tool controller, which waits to be activated (R7).
	 */
	mode: 'app' | 'devtool';
	/** The sidebar's `activeDocKey` at mount (devtool). */
	activeDocKey?: string | null;
	/** Where focus comes from (default: the window; null: none). */
	focusTarget?: IFocusTarget | null;
	/** The endpoint store's clock (tests). */
	clock?: IStoreClock;
}

/** The engine core. */
export interface SqlCore {
	/** The bus client (one per realm). */
	readonly client: IExplorerClient;
	/** The identity tracker. */
	readonly identity: IIdentityTracker;
	/** The activation gate. */
	readonly activation: IActivationGate;
	/** The discovery gate and watch. */
	readonly discovery: IDevToolDiscovery;
	/** SQL Explorer's endpoint store (owner of every task token). */
	readonly endpoints: IEndpointStore;
	/**
	 * Resolve a saved connection to its running endpoint (direct mode starts
	 * or reattaches its temp pipeline).
	 *
	 * @returns The token-free description, carrying `connId`.
	 * @throws ExplorerToolError `invalid` (no such connection) or `unavailable` (not signed in, not running).
	 */
	resolve(connId: string): Promise<SqlEndpoint>;
	/** A session whose every call resolves its connection first (`endpoint.connId` is required). */
	sessionFor(endpoint: SqlEndpoint): SqlSession;
	/** Run calls on a connection's session (resolving it first). */
	withSession<T>(connId: string, fn: (session: SqlSession) => Promise<T>): Promise<T>;
	/** Stop a direct connection's temp pipeline, best effort (a no-op for a pipeline connection). */
	release(connId: string): Promise<void>;
	/** The New Connection picker's list: discovered endpoints a pipeline connection can be saved for. */
	pickable(): Promise<SqlEndpoint[]>;
	/** One service definition (the direct path's config schema). */
	getService(provider: string): Promise<unknown>;
	/** Server-side validation of a single-component pipeline payload. */
	validate(pipeline: Record<string, unknown>): Promise<unknown>;
	/** Environment-variable names (the config form's `${}` autocomplete). */
	envKeys(): Promise<string[]>;
	/** Stop everything the core follows (idempotent). */
	dispose(): void;
}

// =============================================================================
// HELPERS
// =============================================================================

/** How preferable an endpoint state is when two runs share a legacyKey. */
const STATE_RANK: Record<IExplorerEndpoint['state'], number> = { ready: 0, probing: 1, unreachable: 2, inaccessible: 3, stopped: 4 };

/**
 * The token-free description the app and its frames use for a discovered endpoint.
 *
 * @param endpoint - A discovered endpoint with a legacyKey.
 * @returns The description (key = legacyKey).
 */
function pickerEntry(endpoint: IExplorerEndpoint): SqlEndpoint {
	return {
		key: endpoint.legacyKey as string,
		projectId: endpoint.projectId,
		pipelineName: endpoint.pipelineName,
		source: endpoint.source,
		nodeId: endpoint.nodeId,
		nodeName: endpoint.nodeName,
		provider: endpoint.provider,
		running: endpoint.running,
	};
}

/**
 * Settle with `work`, or after `ms` (whichever comes first).
 *
 * @param work - The promise.
 * @param ms - The bound.
 * @returns When either happened (never rejects).
 */
function bounded(work: Promise<unknown>, ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		work.then(
			() => { clearTimeout(timer); resolve(); },
			() => { clearTimeout(timer); resolve(); },
		);
	});
}

/**
 * An `unavailable` failure (nothing was sent to a node).
 *
 * @param tool - What was being done.
 * @param message - The sentence.
 * @returns The error.
 */
function unavailable(tool: string, message: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'unavailable', tool, message });
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create the engine core for one owner.
 *
 * @param opts - See {@link SqlCoreOptions}.
 * @returns The core; dispose it with its owner.
 */
export function createSqlCore(opts: SqlCoreOptions): SqlCore {
	const { cm, appId } = opts;
	const client = getBusExplorerClient(cm);
	const identity = createIdentityTracker({ cm });
	const activation = createActivationGate({ appId, cm, activeDocKey: opts.activeDocKey ?? null });
	if (opts.mode === 'app') activation.open('user');
	const discovery = createDevToolDiscovery({
		cm,
		client,
		identity,
		activation,
		...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}),
	});
	const endpoints = createSqlEndpoints(opts.clock ? { clock: opts.clock } : {});
	const detachStore = endpoints.attach(client, identity.get().identity, discovery.watch);
	let disposed = false;

	// ── The saved-connection list, per identity ──────────────────────────────

	const fs: SavedConnectionsFs = {
		fsMkdir: (path) => busRequest(cm, 'client.fsMkdir', { path }, FS_TIMEOUT_MS),
		fsReadJson: (path) => busRequest(cm, 'client.fsReadJson', { path }, FS_TIMEOUT_MS),
		fsWriteJson: (path, value) => busRequest(cm, 'client.fsWriteJson', { path, value }, FS_TIMEOUT_MS),
	};
	let listOwner: string | null = null;
	const followIdentity = (snapshot: IIdentitySnapshot): void => {
		const owner = snapshot.known ? snapshot.fingerprint : null;
		if (owner === listOwner) return;
		listOwner = owner;
		// The list is per user: a new identity (or none) must not see the last one's.
		resetSavedConnections({ force: true });
		if (owner !== null) void loadSavedConnections(fs);
	};
	followIdentity(identity.get());
	const offIdentity = identity.subscribe(followIdentity);

	// ── Resolution ───────────────────────────────────────────────────────────

	const requireIdentity = (tool: string): void => {
		if (!identity.get().known) throw unavailable(tool, 'Not signed in to a RocketRide server, so nothing was sent.');
	};

	/**
	 * The saved connection, once the list has been read.
	 *
	 * @param connId - The connection id.
	 * @param tool - What is being done (named in errors).
	 * @returns The record.
	 */
	const recordOf = async (connId: string, tool: string): Promise<SavedSqlConnection> => {
		requireIdentity(tool);
		if (getSavedConnectionsStatus() !== 'ready') {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, LIST_WAIT_MS);
				const off = subscribeSavedConnections(() => { if (getSavedConnectionsStatus() === 'ready') done(); });
				function done(): void {
					clearTimeout(timer);
					off();
					resolve();
				}
			});
		}
		if (getSavedConnectionsStatus() !== 'ready') throw unavailable(tool, 'Your saved connections could not be read from the server yet. Try again.');
		const record = getSavedConnection(connId);
		if (!record) throw new ExplorerToolError({ kind: 'invalid', tool, message: `There is no saved connection '${connId}'.` });
		return record;
	};

	/**
	 * The discovered endpoint a saved connection names, best state first.
	 *
	 * @param legacyKey - `endpointKeyForConnection(record)`.
	 * @returns The endpoint, or undefined.
	 */
	const match = (legacyKey: string): IExplorerEndpoint | undefined => endpoints.getState().endpoints
		.filter((endpoint) => endpoint.legacyKey === legacyKey)
		.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state])[0];

	/** Run a discovery now (only while it is allowed), bounded. */
	const rediscover = async (tool: string): Promise<void> => {
		requireIdentity(tool);
		// A call is an explicit request: it opens the gate (the controller already
		// did so for the op itself).
		activation.open('op');
		await bounded(endpoints.refresh(client), DISCOVERY_WAIT_MS);
	};

	/**
	 * Find the running endpoint of a saved connection, starting a direct
	 * connection's pipeline when it is not running.
	 *
	 * @param record - The saved connection.
	 * @param tool - What is being done.
	 * @returns The endpoint.
	 */
	const locate = async (record: SavedSqlConnection, tool: string): Promise<IExplorerEndpoint> => {
		const legacyKey = endpointKeyForConnection(record);
		let found = match(legacyKey);
		const running = (endpoint: IExplorerEndpoint | undefined): boolean => endpoint !== undefined && endpoint.state !== 'stopped';
		if (!running(found)) {
			if (record.mode === 'direct') {
				requireIdentity(tool);
				await busRequest(cm, 'client.use', directUseOptions(record), USE_TIMEOUT_MS);
			}
			await rediscover(tool);
			found = match(legacyKey);
		}
		if (found === undefined) {
			throw unavailable(tool, record.mode === 'direct'
				? `The connection '${record.name}' started, but its pipeline was not found running. Try again.`
				: `The pipeline '${record.pipelineName}' is not running in your workspace. Start it and try again.`);
		}
		if (found.state === 'stopped') {
			throw unavailable(tool, found.stateDetail ?? `The pipeline '${found.pipelineName}' is not running. Start it and try again.`);
		}
		return found;
	};

	const withSession = async <T,>(connId: string, fn: (session: SqlSession) => Promise<T>, tool = 'connection'): Promise<T> => {
		const record = await recordOf(connId, tool);
		const endpoint = await locate(record, tool);
		return fn(createSqlSession(endpoints.session(client, endpoint), endpointForConnection(record)));
	};

	const sessionFor = (endpoint: SqlEndpoint): SqlSession => {
		const connId = endpoint.connId;
		if (typeof connId !== 'string' || connId === '') {
			throw new TypeError(`sessionFor: the endpoint '${endpoint.key}' carries no connection id.`);
		}
		return {
			endpoint,
			execute: (sql, options) => withSession(connId, (session) => session.execute(sql, options), 'execute'),
			getSchema: (table) => withSession(connId, (session) => session.getSchema(table), 'get_schema'),
			refreshSchema: () => withSession(connId, (session) => session.refreshSchema(), 'refresh_schema'),
			dialect: () => withSession(connId, (session) => session.dialect(), 'dialect'),
		};
	};

	return {
		client,
		identity,
		activation,
		discovery,
		endpoints,
		async resolve(connId) {
			const record = await recordOf(connId, 'resolve');
			await locate(record, 'resolve');
			return endpointForConnection(record);
		},
		sessionFor,
		withSession: (connId, fn) => withSession(connId, fn),
		async release(connId) {
			// Read before the first await: a delete that follows a release in the
			// same turn must not hide the record from it.
			const record = getSavedConnection(connId);
			if (record?.mode !== 'direct' || !identity.get().known) return;
			const projectId = directProjectId(record);
			try {
				const token = await busRequest(cm, 'client.getTaskToken', { projectId, source: TOOLS_SOURCE_ID }, RELEASE_STEP_TIMEOUT_MS);
				if (typeof token === 'string' && token !== '') await busRequest(cm, 'client.terminate', { token }, RELEASE_STEP_TIMEOUT_MS);
			} catch {
				// Best effort: the 15-minute idle TTL reaps whatever this leaves behind.
			}
		},
		async pickable() {
			await rediscover('discover');
			return endpoints.getState().endpoints
				.filter((endpoint) => endpoint.legacyKey !== null && endpoint.state !== 'stopped')
				.map(pickerEntry);
		},
		getService: (provider) => busRequest(cm, 'client.getService', { service: provider }, SERVICE_TIMEOUT_MS),
		validate: (pipeline) => busRequest(cm, 'client.validate', { pipeline }, VALIDATE_TIMEOUT_MS),
		async envKeys() {
			const keys = await busRequest(cm, 'client.getEnvironmentKeys', {}, ENV_KEYS_TIMEOUT_MS);
			return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			offIdentity();
			detachStore();
			discovery.dispose();
			activation.dispose();
			identity.dispose();
		},
	};
}
