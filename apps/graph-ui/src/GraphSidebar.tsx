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
// GRAPH-UI - SIDEBAR (navigation menu + the active connection's schema)
// =============================================================================
//
// The stock Explorer tree shows what the schema holds for the active connection:
// node labels and relationship types, each with its properties and observed types.
// Clicking a label or type is the user's request for the 25-row preview, which the
// connection's workbench shows and runs. The status line under the tree says how far
// the schema can be trusted (fresh, sampled, stale, an older format, or unreadable);
// an old node's snapshot is never presented as "the whole graph".
//
// It is mounted by the full app (in the shell's sidebar chrome) and, as a dev
// tool, by the CONTROLLER (devtool: true), where it also lists the connections:
// a click opens that connection's workbench document. Either way it reads the
// LOCAL GraphEnv of its realm; documents open only on a click.
// =============================================================================

import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Explorer, NOOP_VFS, SidebarMenu } from 'shell';
import type { ViewMenu, ViewMenuEntry } from 'shell';
import { useActiveConnection, useGraphEndpoints, useGraphEnv } from './env';
import type { IGraphEnv } from './env';
import { connectionView } from './graph/connections';
import { NO_SCHEMA, SAMPLED_NOTE, schemaStatusText } from './graph/schema';
import { buildSchemaTree } from './graph/schemaTree';
import type { ISchemaEntry } from './graph/schemaStore';
import { GraphIcon } from './icons';

/** Said when the schema listing was cut by the node's own bounds. */
export const TRUNCATED_NOTE = 'The node lists only part of a very large schema.';

/** A subscription that never fires. */
const NO_SUBSCRIBE = (): (() => void) => () => undefined;

/** The entry of a connection nothing was loaded for. */
const IDLE_ENTRY: ISchemaEntry = { status: 'idle', view: NO_SCHEMA, failure: null, loadedAt: 0 };

/**
 * Follow one connection's full schema entry (the full app's and the controller's own store).
 *
 * @param env - The env.
 * @param key - The connection, or null.
 * @returns The entry.
 */
function useSchemaEntry(env: IGraphEnv, key: string | null): ISchemaEntry {
	const store = env.schemas;
	const get = (): ISchemaEntry => (store && key !== null ? store.get(key) : IDLE_ENTRY);
	return useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIBE, get, get);
}

/** Props. */
export interface IGraphSidebarProps {
	/** The dev-tool sidebar (the controller): also lists the connections, each opening its workbench. */
	devtool?: boolean;
}

/** The sidebar: the navigation menu (and, as a dev tool, the connections) plus the active connection's schema. */
const GraphSidebar: React.FC<IGraphSidebarProps> = ({ devtool = false }) => {
	const env = useGraphEnv();
	const isConnected = env.ready;
	const { endpoints, probes } = useGraphEndpoints();
	const activeKey = useActiveConnection();
	const entry = useSchemaEntry(env, activeKey);
	const endpoint = useMemo(() => endpoints.find((e) => e.key === activeKey) ?? null, [endpoints, activeKey]);
	const probe = activeKey ? probes[activeKey] : undefined;
	const tree = useMemo(() => buildSchemaTree(entry.view), [entry.view]);

	// Read the schema once when a connection becomes active and has answered its probe.
	useEffect(() => {
		if (isConnected && endpoint && endpoint.state === 'ready' && probe?.ok && entry.status === 'idle') void env.loadSchema(endpoint.key);
	}, [env, isConnected, endpoint, probe, entry.status]);

	const menu: ViewMenu = useMemo(() => {
		const entries: ViewMenuEntry[] = [{ id: 'connections', label: 'Connections', icon: <GraphIcon />, ...(endpoints.length > 0 ? { count: endpoints.length } : {}) }];
		if (devtool) for (const e of endpoints) entries.push({ id: e.key, label: connectionView(e, probes[e.key]).title, icon: <GraphIcon /> });
		return { entries };
	}, [devtool, endpoints, probes]);

	const select = (id: string): void => {
		const chosen = id === 'connections' ? null : endpoints.find((e) => e.key === id) ?? null;
		env.openDocument(chosen ? { kind: 'workbench', endpoint: chosen } : { kind: 'connections' });
	};

	const open = (path: string): void => {
		const target = tree.target(path);
		if (!target || !endpoint) return;
		env.openDocument({ kind: 'workbench', endpoint });
		env.previews.request({ endpointKey: endpoint.key, action: target.kind === 'label' ? 'label-preview' : 'type-preview', name: target.name });
	};

	const showTree = activeKey !== null && endpoint !== null && (entry.status !== 'idle' || entry.view.labels.length > 0);
	const status = entry.status === 'loading' ? 'Reading the schema\u2026' : schemaStatusText(entry.view, Date.now());

	return (
		<>
			<SidebarMenu menu={menu} activeId={devtool ? activeKey ?? '' : activeKey ? '' : 'connections'} onSelect={select} sectionLabel="Graph Explorer" />
			{showTree && (
				<>
					<Explorer
						vfs={NOOP_VFS}
						config={{
							title: entry.view.labels.length + entry.view.relationshipTypes.length === 0 ? 'Schema' : endpoint.nodeName || 'Schema',
							extensions: null,
							displayName: (filename) => tree.displayName(filename),
							emptyMessage: entry.status === 'loading' ? 'Reading the schema\u2026' : 'No labels or relationship types listed',
							allowFolders: false,
						}}
						entries={tree.entries}
						isConnected={isConnected}
						onOpenFile={open}
						onRefresh={() => {
							if (isConnected && endpoint) void env.loadSchema(endpoint.key, { fresh: true });
						}}
					/>
					<div style={{ padding: '8px 14px', fontSize: 12, lineHeight: 1.45, color: 'var(--rr-text-secondary)' }}>
						<div>{status}</div>
						{entry.failure && entry.failure.headline !== '' && (
							<div style={{ marginTop: 4, color: 'var(--rr-color-warning)' }}>
								{entry.failure.headline}
								{entry.failure.hint ? ` ${entry.failure.hint}` : ''}
							</div>
						)}
						{entry.view.error && entry.view.error.headline !== '' && (
							<div style={{ marginTop: 4 }}>
								<div>{entry.view.error.headline}</div>
								{entry.view.error.detail !== '' && <div style={{ fontFamily: 'var(--rr-font-mono, monospace)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{entry.view.error.detail}</div>}
							</div>
						)}
						{entry.view.sampled && entry.view.labels.length > 0 && <div style={{ marginTop: 4 }}>{SAMPLED_NOTE}</div>}
						{entry.view.truncated && <div style={{ marginTop: 4 }}>{TRUNCATED_NOTE}</div>}
						{tree.entries.length > 0 && <div style={{ marginTop: 4 }}>Click a label or type to preview 25 of its rows.</div>}
					</div>
				</>
			)}
		</>
	);
};

export default GraphSidebar;
