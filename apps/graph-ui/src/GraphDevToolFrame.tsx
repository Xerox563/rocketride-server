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
// GRAPH-UI - DEV-TOOL FRAME MOUNT (AppDescriptor.devToolFrame)
// =============================================================================
//
// A thin React shell over devtool/frame.ts: it builds the frame in an effect
// (disposed in the cleanup), follows `host:connection`, and routes the docKey:
//
//   undefined / ''    the landing (Connections)
//   workbench:<key>   that connection's workbench
//   write:<key>       that connection's write console
//   anything else     a "not found" empty state
//
// It holds no client (R1): every view below reads the REMOTE GraphEnv.
// =============================================================================

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { Button, EmptyState } from 'shell';
import type { DevToolProps } from 'shell';
import { ExplorerToolError, readErrorMessage } from 'shared/explorer';
import { LiveRegion, announcer } from './adapters/explorer';
import { createGraphFrame } from './devtool/frame';
import type { IGraphFrame } from './devtool/frame';
import type { DocRoute } from './devtool/protocol';
import { FRAME_PROTOCOL } from './devtool/wiring';
import { GraphEnvProvider, useGraphEndpoints, useGraphEnv } from './env';
import { GraphIcon } from './icons';
import ConnectionsView from './views/ConnectionsView';
import WorkbenchView from './views/WorkbenchView';
import WriteConsoleView from './views/WriteConsoleView';

const styles = {
	root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden' } as CSSProperties,
	center: { display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' } as CSSProperties,
};

/** Said by a frame whose docKey names no Graph Explorer document. */
export const UNKNOWN_DOCUMENT_TITLE = 'This Graph Explorer document was not found';

/**
 * Say a failure nobody awaits (a history edit, a refused refresh); a dropped (stale) call says nothing.
 *
 * @param error - The failure.
 */
function announceFailure(error: unknown): void {
	if (error instanceof ExplorerToolError && error.kind === 'stale') return;
	announcer.announce(readErrorMessage(error));
}

/**
 * The dev-tool frame: one document of the tool.
 *
 * @param props - The host's DevToolProps.
 * @returns The frame.
 */
export const GraphDevTool: React.FC<DevToolProps> = ({ peer, channel, documents, docKey }) => {
	const [frame, setFrame] = useState<IGraphFrame | null>(null);
	useEffect(() => {
		const created = createGraphFrame({ peer, ...(channel ? { channel } : {}), ...(documents ? { documents } : {}), docKey: docKey ?? null, ...FRAME_PROTOCOL, onError: announceFailure });
		setFrame(created);
		return () => {
			created.dispose();
			setFrame((current) => (current === created ? null : current));
		};
	}, [peer, channel, documents, docKey]);
	if (!frame) return null;
	return <FrameRoot frame={frame} />;
};

/** The frame's env provider (rebuilt when `host:connection` flips) and its routed body. */
const FrameRoot: React.FC<{ frame: IGraphFrame }> = ({ frame }) => {
	const ready = useSyncExternalStore(frame.connected.subscribe, frame.connected.get, frame.connected.get);
	const env = useMemo(() => frame.env(ready), [frame, ready]);
	return (
		<GraphEnvProvider value={env}>
			<div style={styles.root}>
				<LiveRegion />
				<FrameBody route={frame.route} />
			</div>
		</GraphEnvProvider>
	);
};

/**
 * The view a route renders.
 *
 * @param props.route - The frame's route.
 * @returns The view.
 */
export const FrameBody: React.FC<{ route: DocRoute }> = ({ route }) => {
	if (route.kind === 'landing') return <ConnectionsView />;
	if (route.kind === 'unknown') {
		return (
			<div style={styles.center}>
				<EmptyState icon={<GraphIcon />} title={UNKNOWN_DOCUMENT_TITLE} description={`Nothing here is called "${route.docKey}". Open Connections from the sidebar to pick a connection.`} />
			</div>
		);
	}
	return <FrameConnectionDocument kind={route.kind} endpointKey={route.key} />;
};

/**
 * A connection's document, bound to the live endpoint the controller publishes.
 *
 * @param props.kind - Workbench or write console.
 * @param props.endpointKey - The connection.
 * @returns The view, or why there is none yet.
 */
const FrameConnectionDocument: React.FC<{ kind: 'workbench' | 'write'; endpointKey: string }> = ({ kind, endpointKey }) => {
	const env = useGraphEnv();
	const { status, endpoints } = useGraphEndpoints();
	const endpoint = endpoints.find((candidate) => candidate.key === endpointKey) ?? null;

	// A document restored before anything was discovered asks for discovery (an op: it also activates the controller).
	useEffect(() => {
		if (env.ready && status === 'idle') void env.refresh();
	}, [env, status]);

	if (!endpoint) {
		const looking = status === 'idle' || status === 'loading';
		return (
			<div style={styles.center}>
				<EmptyState
					icon={<GraphIcon />}
					title={looking ? 'Looking for this connection' : 'This connection is not listed'}
					description={looking ? 'The sidebar is finding the graph connections of your running pipelines.' : 'Its pipeline is not running, or it belongs to another account. Open Connections to see what is available.'}
					action={
						<Button variant="primary" onClick={() => env.openDocument({ kind: 'connections' })}>
							Open Connections
						</Button>
					}
				/>
			</div>
		);
	}
	return kind === 'write' ? <WriteConsoleView key={endpoint.key} endpoint={endpoint} /> : <WorkbenchView key={endpoint.key} endpoint={endpoint} />;
};

export default GraphDevTool;
