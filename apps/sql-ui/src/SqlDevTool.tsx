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
// SQL-UI — DEV-TOOL FRAME (one host document per connection, no inner tabs)
// =============================================================================
//
// The `devToolFrame` mount. Its docKey routes it (R8, sqlFrame.ts routeDocKey):
//
//   undefined / ''        the generic frame: a landing state, plus the
//                         sidebar-requested dialogs;
//   edit:<id> / edit:*new*  the connection editor;
//   <saved connection id> that connection's workbench ("not found" once the
//                         list is read and has no such id).
//
// FRAMES HOLD NO ROCKETRIDE CLIENT, and this module imports nothing that
// does (a test pins the import graph). Every engine call is an op on the
// controller (sqlFrame.ts, sqlEnv.ts REMOTE); run/apply enablement is the
// host's `host:connection` snapshot. The frame's identity guard closes the
// document when the controller's signed-in identity changes.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { DevToolProps, ToolChannel } from 'shell';
import { EmptyState, useConnectionReady } from 'shell';
import { isDirectEndpointKey } from './connect';
import { useConnectionRecord } from './connectionRecord';
import type { SqlEndpoint } from './connect';
import { setActiveConnection } from './navigation';
import { SQL_TOOL_PROTOCOL, frameChannel } from './sqlBridge';
import { attachSqlFrame, connectionDocState, followVouched, routeDocKey, sqlChannel } from './sqlFrame';
import type { SqlFrameMount } from './sqlFrame';
import { createRemoteHistory } from './history/remoteHistory';
import type { RemoteHistory } from './history/remoteHistory';
import { SqlEnvProvider, createRemoteSqlEnv, useSqlEnv } from './sqlEnv';
import ConnectionView from './views/ConnectionView';
import ConnectionOverlays from './components/ConnectionOverlays';
import ConnectionEditorBody from './components/ConnectionEditorBody';
import LiveRegion from './components/LiveRegion';
import { DatabaseIcon } from './icons';

const styles = {
	// Centred empty state.
	welcome: {
		display: 'flex',
		flex: 1,
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
};

// Overlay-host claim: sidebar-requested dialogs (add/edit/delete connection)
// must render in exactly ONE frame per realm. In VS Code each frame is its
// own document (always one host). In-shell, several connection frames share
// the realm — the first alive mount holds the claim and it transfers when
// that mount closes.
const overlayHosts: Array<() => void> = [];

/** Whether THIS mount currently owns the overlay-host claim. */
function useOverlayHostClaim(): boolean {
	const [, force] = useState(0);
	const tickRef = useRef<(() => void) | null>(null);
	if (!tickRef.current) tickRef.current = () => force((n) => n + 1);
	useEffect(() => {
		const tick = tickRef.current!;
		overlayHosts.push(tick);
		overlayHosts.forEach((fn) => fn());
		return () => {
			const at = overlayHosts.indexOf(tick);
			if (at >= 0) overlayHosts.splice(at, 1);
			overlayHosts.forEach((fn) => fn());
		};
	}, []);
	return overlayHosts[0] === tickRef.current;
}

/** The sidebar-requested dialogs, rendered by the claim-holding mount only. */
const OverlayHost: React.FC = () => {
	const owns = useOverlayHostClaim();
	return owns ? <ConnectionOverlays /> : null;
};

/**
 * One connection's workbench as a host document: resolves the saved
 * connection named by the doc key (direct mode materialises its temp tool
 * pipeline), then renders the paged ConnectionView — Overview / Insights /
 * Diagram, plus Query / Data / Design as they are used. No inner documents.
 *
 * @param props.connId - The saved connection's id (the host document key).
 * @param props.onOpenError - Tell the sidebar this connection could not be opened.
 */
const SqlConnectionDocument: React.FC<{ connId: string; onOpenError: (message: string) => void }> = ({ connId, onOpenError }) => {
	const env = useSqlEnv();
	const { record: conn, status } = useConnectionRecord(connId);
	const [endpoint, setEndpoint] = useState<SqlEndpoint | null>(null);
	const [resolveError, setResolveError] = useState<string | null>(null);

	// Resolve the endpoint whenever the record (or the connection) changes.
	// In a dev-tool frame this is a controller op — the temp pipeline (and
	// its revival) lives in the CONTROLLER realm, never here.
	useEffect(() => {
		if (!env.ready || !conn) return;
		let alive = true;
		setResolveError(null);
		env.resolveEndpoint(conn)
			.then((ep) => { if (alive) setEndpoint(ep); })
			.catch((err: unknown) => {
				if (!alive) return;
				const message = err instanceof Error ? err.message : String(err);
				setResolveError(message);
				// The sidebar's row shows "opening…" until the connection comes to
				// front or this arrives.
				onOpenError(message);
			});
		return () => { alive = false; };
	}, [env, conn, onOpenError]);

	// Publish the active connection for the sidebar's schema tree, and stop a
	// direct connection's temp pipeline when its document closes (the 15-min
	// idle TTL backstops teardowns this cleanup never sees).
	useEffect(() => {
		if (!endpoint) return;
		setActiveConnection(endpoint.key);
		return () => {
			if (isDirectEndpointKey(endpoint.key)) env.releaseEndpoint(connId);
		};
	}, [endpoint, env, connId]);

	let body: React.ReactNode;
	switch (connectionDocState({ ready: env.ready, listStatus: status, found: conn !== null, failed: resolveError !== null, opened: endpoint !== null })) {
		case 'not-connected':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Not connected" description="Connect to a RocketRide server to open this connection." /></div>;
			break;
		case 'failed':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Could not open connection" description={resolveError ?? ''} /></div>;
			break;
		case 'not-found':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Connection not found" description="This saved connection no longer exists." /></div>;
			break;
		case 'loading':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title="Loading…" description="Reading your saved connections." /></div>;
			break;
		case 'opening':
			body = <div style={styles.welcome}><EmptyState icon={<DatabaseIcon />} title={conn?.name ?? ''} description="Opening the connection…" /></div>;
			break;
		default:
			body = endpoint ? <ConnectionView endpoint={endpoint} /> : null;
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, height: '100%' }}>
			{body}
			{/* Sidebar-requested dialogs — one host per realm (see the claim). */}
			<OverlayHost />
		</div>
	);
};

/**
 * Whether the controller vouches for a signed-in account (see followVouched).
 *
 * @param channel - The frame's channel.
 * @returns True once its retained identity carries a fingerprint.
 */
function useVouched(channel: ToolChannel): boolean {
	const [vouched, setVouched] = useState(false);
	useEffect(() => followVouched(channel, setVouched), [channel]);
	return vouched;
}

/**
 * Dev-tool FRAME. With a `docKey` (a saved connection id, opened through
 * DevToolProps.documents) it renders that connection's workbench; `edit:…`
 * renders the connection editor; without one — the tool's generic document —
 * it shows the landing state. The connections list lives in the HOST's
 * sidebar panel (SqlDevToolSidebar, the controller).
 */
export const SqlDevTool: React.FC<DevToolProps> = ({ peer, channel, docKey, documents }) => {
	// The frame's channel (the host's, or one per peer) and its wiring: the
	// frame caller, the realm's read-only connection replica, the active-key
	// pushes, and the identity guard — mounted in an effect, disposed with it.
	const toolChannel = useMemo(() => frameChannel(peer, channel), [peer, channel]);
	// The host's documents API, read at call time: a new object on a re-render
	// must not remount the frame wiring (which drops pending calls).
	const documentsRef = useRef(documents);
	documentsRef.current = documents;
	const [mount, setMount] = useState<{ frame: SqlFrameMount; history: RemoteHistory } | null>(null);
	useEffect(() => {
		let history: RemoteHistory | null = null;
		const frame = attachSqlFrame({
			peer,
			channel: toolChannel,
			docKey: docKey ?? null,
			documents: {
				open: (key, title) => documentsRef.current?.open(key, title),
				close: (key) => documentsRef.current?.close(key),
			},
			protocol: SQL_TOOL_PROTOCOL,
			// Identity changed, unknown, or the host connection dropped: the
			// frame wiring clears the realm's schemas; the history view is ours.
			onReset: () => history?.reset(),
		});
		history = createRemoteHistory({ caller: frame.caller, channel: sqlChannel(frame.channel), owner: frame.owner });
		setMount({ frame, history });
		return () => {
			history?.dispose();
			frame.dispose();
		};
	}, [peer, toolChannel, docKey]);

	// FRAMES HOLD NO ROCKETRIDE CLIENT: run/apply enablement is the host's
	// `host:connection` snapshot, and every call is a controller op.
	// ...and on a signed-in account the controller vouches for: until then a
	// frame's own first calls (opening its connection, the first schema read)
	// would only be refused as "not signed in", and announced.
	const engineReady = useConnectionReady(toolChannel);
	const vouched = useVouched(toolChannel);
	const ready = engineReady && vouched;
	const env = useMemo(() => (mount ? createRemoteSqlEnv(mount.frame.caller, ready, mount.frame.owner, mount.history) : null), [mount, ready]);
	const onOpenError = useCallback((message: string) => sqlChannel(toolChannel).sendEvent('openError', message), [toolChannel]);

	if (!env) return null;
	const route = routeDocKey(docKey);
	let body: React.ReactNode;
	if (route.kind === 'editor') {
		body = (
			<ConnectionEditorBody
				connId={route.connId}
				onCloseSelf={() => { if (docKey) documents?.close(docKey); }}
				onOpenSaved={(saved) => documents?.open(saved.id, saved.name)}
			/>
		);
	} else if (route.kind === 'connection') {
		body = <SqlConnectionDocument connId={route.connId} onOpenError={onOpenError} />;
	} else {
		body = (
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
				<div style={styles.welcome}>
					<EmptyState icon={<DatabaseIcon />} title="SQL Explorer" description="Open a connection from the sidebar, or add one with New Connection." />
				</div>
				<OverlayHost />
			</div>
		);
	}
	return (
		<SqlEnvProvider value={env}>
			{/* The realm's one live region (the first alive mount renders it). */}
			<LiveRegion />
			{body}
		</SqlEnvProvider>
	);
};

export default SqlDevTool;
