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
// SQL CONTROLLER — the sidebar mount serves the tool protocol (R1, R2, R6)
// =============================================================================
//
// The dev tool's sidebar mount is its CONTROLLER: it owns the tool's one
// engine connection, as an engine core (sqlCore.ts), and serves every frame
// op from it:
//
//   OPS    sql.*            answered from the core, through the dev-tool
//                           library's attachController: each op is checked
//                           against its `deadlineAt` (a call held while no
//                           controller was mounted, delivered after its frame
//                           gave up, never runs), and answers a Reply.
//   STATE  'connections'   { status, list }: the saved-connection list the
//                           core read for the signed-in identity, republished
//                           on every change (never over the retained-state
//                           size cap).
//   STATE  'identity'      { fingerprint }: who the core vouches for (R9).
//   EVENT  'active'        heard: a frame's active endpoint key.
//   EVENT  'openError'     heard: a connection a frame could not open.
//
// The controller's OWN checks, whatever a frame sent:
//
//   - a statement is classified again with the node's dialect
//     (sql/gate.ts): transaction control is refused, and only a read is ever
//     repeated (T10);
//   - a saved-connection record must be a usable record naming a database
//     node (sqlCore.ts checkSavedConnection);
//   - a mutation (save, delete) is refused unless the calling frame belongs
//     to the identity signed in now (`owner`), so a call from before a change
//     of account can never write into the next account's list.
//
// LIFETIME (R6, R7). `attachSqlController` runs inside the sidebar's
// `useEffect` and its `dispose` is the cleanup: exactly one op server per
// mount, created after the channel, never in a render. At mount it publishes
// retained state only: no event, no call, no `documents.open`; the core waits
// for activation before its first discovery. Documents open only on a user
// action in the sidebar.
// =============================================================================

import type { DevToolProps, ToolChannel } from 'shell';
import { ExplorerToolError } from 'shared/explorer/errors';
import { attachController } from 'shared/explorer/devtool/controller';
import type { ControllerHandlers } from 'shared/explorer/devtool/controller';
import type { DeadlineError } from 'shared/explorer/devtool/deadline';
import { publishIdentityState } from 'shared/explorer/devtool/frameIdentity';
import type { JsonValue } from 'shared/explorer/devtool/reply';
import { guardRetainedState } from 'shared/explorer/devtool/state';
import type { IStoreClock } from 'shared/explorer/connect/store';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import type { IFocusTarget } from 'shared/explorer/devtool/watch';
import { SQL_APP_ID } from './appId';
import { getSavedConnections, getSavedConnectionsStatus, subscribeSavedConnections } from './connect';
import { connectionEditorDocKey } from './docs';
import type { ConnectionsState, SqlOps } from './ops';
import type { SqlSidebarBridge } from './sidebarBridge';
import { gateStatement } from './sql/gate';
import { createSqlCore } from './sqlCore';
import type { SqlCore, SqlCoreBus } from './sqlCore';
import { sqlChannel } from './sqlFrame';
import type { SqlToolProtocol } from './sqlFrame';

/** What {@link attachSqlController} needs (DevToolProps plus the injected realm and factories). */
export interface SqlControllerOptions {
	/** The sidebar mount's peer. */
	peer: DevToolPeer;
	/** The host's channel, when it gave one. */
	channel?: ToolChannel;
	/** The host's documents API (opened only on user actions). */
	documents?: DevToolProps['documents'];
	/** The sidebar's activeDocKey at mount. */
	activeDocKey?: string | null;
	/** The realm's ConnectionManager. */
	cm: SqlCoreBus;
	/** The protocol factories. */
	protocol: SqlToolProtocol;
	/** The deadline guard's clock (tests). */
	now?: () => number;
	/** Where focus comes from (default: the window; null: none). */
	focusTarget?: IFocusTarget | null;
	/** The endpoint store's clock (tests). */
	clock?: IStoreClock;
	/** Told about every call the deadline guard refused (tests, diagnostics). */
	onRefused?: (error: DeadlineError) => void;
}

/** A mounted controller. */
export interface SqlControllerMount {
	/** The bridge the sidebar renders against. */
	readonly bridge: SqlSidebarBridge;
	/** The controller's engine core. */
	readonly core: SqlCore;
	/** The channel the controller serves on. */
	readonly channel: ToolChannel;
	/** Feed every new activeDocKey prop value (activation, R7). */
	noteActiveDocKey(key: string | null | undefined): void;
	/** Tear everything down (the effect's cleanup; idempotent). */
	dispose(): void;
}

/**
 * The saved-connection list as the controller publishes it.
 *
 * @returns The snapshot.
 */
function connectionsState(): ConnectionsState {
	const status = getSavedConnectionsStatus();
	return { status, list: status === 'ready' ? getSavedConnections() : [] };
}

/**
 * Mount the controller.
 *
 * @param opts - See {@link SqlControllerOptions}.
 * @returns The mount.
 */
export function attachSqlController(opts: SqlControllerOptions): SqlControllerMount {
	const core = createSqlCore({
		cm: opts.cm,
		appId: SQL_APP_ID,
		mode: 'devtool',
		activeDocKey: opts.activeDocKey ?? null,
		...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}),
		...(opts.clock ? { clock: opts.clock } : {}),
	});

	/**
	 * Refuse a mutation from a frame that does not belong to who is signed in now.
	 *
	 * @param owner - The calling frame's fingerprint.
	 * @param tool - The op.
	 */
	const requireOwner = (owner: string | null | undefined, tool: string): void => {
		const now = core.identity.get().fingerprint;
		if (now === null) throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'Not signed in to a RocketRide server, so nothing was changed.' });
		if (owner !== now) throw new ExplorerToolError({ kind: 'stale', tool, message: 'The signed-in account changed since this document opened, so nothing was changed.' });
	};

	const handlers: ControllerHandlers<SqlOps> = {
		'sql.resolveEndpoint': ({ connId }) => core.resolve(connId),
		'sql.releaseEndpoint': async ({ connId }) => { await core.release(connId); },
		'sql.discoverEndpoints': () => core.pickable(),
		'sql.execute': ({ connId, sql, params, idempotent }) => core.withSession(connId, (session, ctx) => {
			const gate = gateStatement(sql, ctx.dialect, idempotent === true);
			if (gate.refusal !== null) throw new ExplorerToolError({ kind: 'invalid', tool: 'execute', message: gate.refusal });
			return session.execute(sql, { ...(params && params.length > 0 ? { params } : {}), idempotent: gate.idempotent });
		}),
		'sql.getSchema': ({ connId, table }) => core.withSession(connId, (session) => session.getSchema(table)),
		'sql.refreshSchema': ({ connId }) => core.withSession(connId, (session) => session.refreshSchema()),
		'sql.dialect': ({ connId }) => core.withSession(connId, (session) => session.dialect()),
		'sql.getService': async ({ provider }) => (await core.getService(provider)) as JsonValue,
		'sql.validate': async ({ pipeline }) => (await core.validate(pipeline)) as JsonValue,
		'sql.envKeys': () => core.envKeys(),
		'sql.saveConnection': async ({ connection, owner }) => {
			requireOwner(owner, 'saveConnection');
			await core.saveConnection(connection);
		},
		'sql.deleteConnection': async ({ connId, owner }) => {
			requireOwner(owner, 'deleteConnection');
			await core.deleteConnection(connId);
		},
	};

	// The channel first (the host's, or one per peer), then exactly one op
	// server, inside the caller's effect (R6).
	const attached = attachController<SqlOps>({
		peer: opts.peer,
		...(opts.channel ? { channel: opts.channel } : {}),
		createToolChannel: opts.protocol.createToolChannel,
		createToolOpServer: opts.protocol.createToolOpServer,
		handlers,
		...(opts.now ? { now: opts.now } : {}),
		...(opts.onRefused ? { onRefused: opts.onRefused } : {}),
		// The first op from a frame is an activation (R7).
		onFirstOp: () => core.activation.open('op'),
	});

	// Retained state, size-capped: a snapshot over the cap is never published.
	const state = sqlChannel(guardRetainedState(attached.channel, {
		onOversize: (error) => console.log('[sql-ui] a state snapshot was not published:', error.message),
	}));
	const publishConnections = (): void => state.publishState('connections', connectionsState());
	publishConnections();
	const offConnections = subscribeSavedConnections(publishConnections);
	const offIdentity = publishIdentityState(attached.channel, core.identity);

	// ── Frame -> sidebar feeds (idempotent hints) ───────────────────────────

	const activeSubs = new Set<(key: string | null) => void>();
	const errorSubs = new Set<(message: string) => void>();
	let activeKey: string | null = null;
	const offActive = state.onEvent('active', (payload) => {
		activeKey = typeof payload === 'string' ? payload : null;
		activeSubs.forEach((fn) => fn(activeKey));
	});
	const offError = state.onEvent('openError', (payload) => {
		errorSubs.forEach((fn) => fn(String(payload)));
	});

	// ── The sidebar's actions (each one a user action: it activates) ────────

	const bridge: SqlSidebarBridge = {
		// Hosts open the connection's OWN top-level tab through documents.
		openConnection: (conn) => {
			core.activation.open('user');
			opts.documents?.open(conn.id, conn.name);
		},
		openConnectionEditor: (editing) => {
			core.activation.open('user');
			opts.documents?.open(connectionEditorDocKey(editing?.id ?? null), editing ? `Edit ${editing.name}` : 'New Connection');
		},
		deleteConnection: (conn) => {
			core.activation.open('user');
			void core.deleteConnection(conn.id).catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				errorSubs.forEach((fn) => fn(message));
			});
		},
		subscribeActive(cb) {
			cb(activeKey);
			activeSubs.add(cb);
			return () => { activeSubs.delete(cb); };
		},
		subscribeError(cb) {
			errorSubs.add(cb);
			return () => { errorSubs.delete(cb); };
		},
	};

	let disposed = false;
	return {
		bridge,
		core,
		channel: attached.channel,
		noteActiveDocKey: (key) => core.activation.noteActiveDocKey(key),
		dispose() {
			if (disposed) return;
			disposed = true;
			attached.dispose();
			offConnections();
			offIdentity();
			offActive();
			offError();
			activeSubs.clear();
			errorSubs.clear();
			core.dispose();
		},
	};
}
