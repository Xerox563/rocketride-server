// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// APP CATALOG FETCH — the home-ui `useStoreApps` pattern, for the bus
// =============================================================================
//
// Catalog rows ARE manifest entries (`AppManifestEntry` — publisher, readme,
// categories, appStatus, onDesktop, the lot); this module declares NO row
// type of its own. The query shape mirrors home-ui's `useStoreApps`
// (`offset`/`limit`/`search`/`category`/`shell`) and is passed through to
// the wire verbatim, so callers page instead of a library hoarding one list.
//
// The transport is the brokered `client.app.list` op (`rrext_app list`) —
// it resolves locally in a framework root and over the bridge in a webview
// realm, so every surface makes the SAME call. Deliberately `rrext_app
// list`, not `rrext_public_catalog`: the picker needs the caller's @me and
// @team rows, which the public store verb filters off by design. And never
// the ACCOUNT list (the user's desktop — a tool not yet gotten can never
// appear) nor the MF REGISTRATION list (bundle wiring). Both were used as
// catalogs once; five surfaces broke.
// =============================================================================

// Type-only deep import — the ext host compiles this leaf too.
import type { AppManifestEntry } from 'shell/src/components/workspace/types';

/** The minimal bus surface the fetch needs — `IOpBus.request` and the
 *  ConnectionManager's `request` both satisfy it, root and realm alike. */
export interface IOpRequester {
	request(op: string, params: unknown): Promise<unknown>;
}

/** Catalog query parameters — the same shape home-ui's useStoreApps sends. */
export interface CatalogQuery {
	/** Pagination offset (default 0). */
	offset?: number;
	/** Page size (server caps at 100). */
	limit?: number;
	/** Substring filter on name/description. */
	search?: string;
	/** Category filter (NOTE: documented on the wire, implemented by no
	 *  edition yet — filter client-side until it lands). */
	category?: string;
	/** Shell compatibility filter ("saas", "oss", "vscode"). */
	shell?: string;
}

/** One catalog page, as the wire returns it. */
export interface CatalogPage {
	apps: AppManifestEntry[];
	total?: number;
	offset?: number;
	limit?: number;
}

/** An entry's dev-tool membership (`categories` contains 'devTool'). */
export function isDevToolEntry(entry: { categories?: unknown[] }): boolean {
	return (entry.categories ?? []).some((c) => String(c).toLowerCase() === 'devtool');
}

/**
 * One page of the app catalog — the caller's reachable @me/@team/@public
 * rows, manifest-shaped.
 *
 * @param bus - Anything with `request` (a ConnectionManager — realm or
 *              root — or an ext host's root IOpBus).
 * @param query - Pagination/filter parameters, passed through verbatim.
 * @returns The page as returned by the wire.
 */
export async function fetchAppCatalog(bus: IOpRequester, query?: CatalogQuery): Promise<CatalogPage> {
	const body = (await bus.request('client.app.list', { ...(query ?? {}) })) as CatalogPage | undefined;
	return { apps: body?.apps ?? [], total: body?.total, offset: body?.offset, limit: body?.limit };
}

/**
 * The dev-tool catalog: reachable apps carrying the devTool category,
 * name-sorted. A convenience over {@link fetchAppCatalog} for the picker
 * surfaces; the category filters client-side (see {@link CatalogQuery}).
 *
 * @param bus - See {@link fetchAppCatalog}.
 * @returns Dev-tool entries, sorted by display name.
 */
export async function fetchDevToolCatalog(bus: IOpRequester): Promise<AppManifestEntry[]> {
	const page = await fetchAppCatalog(bus);
	return page.apps.filter(isDevToolEntry).sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}
