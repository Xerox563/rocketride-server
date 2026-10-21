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
// SQL ENV — where the views' engine calls actually go
// =============================================================================
//
// Every view and dialog reaches the engine through this ONE seam instead of
// holding a RocketRide client. Two implementations:
//
//   LOCAL  (createLocalSqlEnv)  — over the realm's engine core (sqlCore.ts:
//          the shared endpoint store, sessions, identity). Used by the full
//          app (SqlApp), where the realm legitimately owns a connection; the
//          sidebar CONTROLLER serves the ops from its own core.
//   REMOTE (createRemoteSqlEnv) — routes every call over `controller(...)`
//          to the tool's sidebar controller (see ops.ts / sqlBridge.ts).
//          Used by every dev-tool document frame: frames hold NO client.
//
// The provider decides which one a subtree gets; views only ever call
// useSqlEnv(). `ready` replaces the old `client && isConnected` enablement —
// remotely it reflects the CONTROLLER's connection (`host:connection`).
// =============================================================================

import { createContext, useContext } from 'react';
import type { ToolControllerFn } from 'shell';
import type { SqlOps } from './ops';
import type { SqlEndpoint, SqlExecuteResult, SqlSchemaResponse, SqlSession, SavedSqlConnection, SqlDialect } from './connect';
import type { SqlCore } from './sqlCore';

// =============================================================================
// THE SEAM
// =============================================================================

/** The engine surface a sql-ui view may use. */
export interface SqlEnv {
	/** Whether the engine is reachable (drives run/apply enablement). */
	ready: boolean;
	/** The session for an endpoint (cached; all statement traffic). */
	getSession(endpoint: SqlEndpoint): SqlSession;
	/** Resolve a saved connection to a live endpoint (direct mode starts
	 *  or reattaches its temp pipeline). */
	resolveEndpoint(conn: SavedSqlConnection): Promise<SqlEndpoint>;
	/** Stop a direct connection's temp pipeline, fire-and-forget (best
	 *  effort — the idle TTL is the backstop). A no-op for a pipeline
	 *  connection. Named by the saved connection's id. */
	releaseEndpoint(connId: string): void;
	/** Discover database endpoints in the server's running pipelines. */
	discoverEndpoints(): Promise<SqlEndpoint[]>;
	/** One service definition (the direct path's config schema). */
	getService(provider: string): Promise<unknown>;
	/** Server-side single-component pipeline validation. */
	validate(pipeline: Record<string, unknown>): Promise<unknown>;
	/** Environment-variable names for the config form's autocomplete.
	 *  Never rejects — failures come back as an empty list. */
	getEnvironmentKeys(): Promise<string[]>;
}

const SqlEnvContext = createContext<SqlEnv | null>(null);

/** The provider component both mount roots wrap their subtree in. */
export const SqlEnvProvider = SqlEnvContext.Provider;

/**
 * The subtree's engine surface. Throws when no provider is mounted — every
 * sql-ui mount root (SqlApp, SqlDevTool) must install one.
 *
 * @returns The environment.
 */
export function useSqlEnv(): SqlEnv {
	const env = useContext(SqlEnvContext);
	if (!env) throw new Error('useSqlEnv: no SqlEnvProvider above this component.');
	return env;
}

// =============================================================================
// LOCAL — over the realm's engine core
// =============================================================================

/**
 * The core-backed environment (the full app).
 *
 * @param core - The realm's engine core (sqlCore.ts).
 * @param isConnected - The shell's connection flag.
 * @returns The environment (rebuild on core/connection change).
 */
export function createLocalSqlEnv(core: SqlCore, isConnected: boolean): SqlEnv {
	return {
		ready: isConnected,
		getSession: (endpoint) => core.sessionFor(endpoint),
		resolveEndpoint: (conn) => core.resolve(conn.id),
		releaseEndpoint: (connId) => {
			void core.release(connId).catch(() => undefined);
		},
		discoverEndpoints: () => core.pickable(),
		getService: (provider) => core.getService(provider),
		validate: (pipeline) => core.validate(pipeline),
		getEnvironmentKeys: async () => {
			try {
				return await core.envKeys();
			} catch {
				return [];
			}
		},
	};
}

// =============================================================================
// REMOTE — over controller(...) ops
// =============================================================================

/**
 * An SqlSession whose four tools are controller ops. Stateless — the
 * token cache and retry policy live in the CONTROLLER's real session.
 *
 * @param call - The frame's controller function.
 * @param endpoint - The endpoint to bind.
 * @returns The proxy session.
 */
function remoteSession(call: ToolControllerFn<SqlOps>, endpoint: SqlEndpoint): SqlSession {
	return {
		endpoint,
		execute: (sql: string, opts?: { params?: unknown[]; idempotent?: boolean }): Promise<SqlExecuteResult> =>
			call('sql.execute', { endpoint, sql, ...(opts?.params ? { params: opts.params } : {}), ...(opts?.idempotent !== undefined ? { idempotent: opts.idempotent } : {}) }),
		getSchema: (table?: string): Promise<SqlSchemaResponse> =>
			call('sql.getSchema', { endpoint, ...(table ? { table } : {}) }),
		refreshSchema: (): Promise<SqlSchemaResponse> => call('sql.refreshSchema', { endpoint }),
		dialect: (): Promise<SqlDialect> => call('sql.dialect', { endpoint }),
	};
}

/**
 * The controller-backed environment (dev-tool document frames). The frame
 * holds no client: every call crosses the tool channel and executes on the
 * controller's single engine connection.
 *
 * @param call - The frame's controller function (createToolController(peer)).
 * @param ready - The controller realm's server reachability (`host:connection`).
 * @returns The environment (rebuild when `ready` changes).
 */
export function createRemoteSqlEnv(call: ToolControllerFn<SqlOps>, ready: boolean): SqlEnv {
	return {
		ready,
		getSession: (endpoint) => remoteSession(call, endpoint),
		resolveEndpoint: (conn) => call('sql.resolveEndpoint', { connId: conn.id }),
		releaseEndpoint: (connId) => {
			// Fire-and-forget: a late or lost reply is fine — the TTL reaps.
			void call('sql.releaseEndpoint', { connId }).catch(() => undefined);
		},
		discoverEndpoints: () => call('sql.discoverEndpoints', {}),
		getService: (provider) => call('sql.getService', { provider }),
		validate: (pipeline) => call('sql.validate', { pipeline }),
		getEnvironmentKeys: () => call('sql.envKeys', {}).catch(() => []),
	};
}
