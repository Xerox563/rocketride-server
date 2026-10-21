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
// EXPLORER DEV TOOL — FS-BACKED HISTORY PREFERENCES (§3.5)
// =============================================================================
//
// Dev-tool mounts get no workspace preferences (neither host gives store
// tools ToolHostServices/prefs), so the CONTROLLER persists history itself, in
// a per-user file beside the SQL tool's saved connections:
//
//   @/User/.workspace/rocketride.<tool>.history.json      historyPrefsPath(tool)
//
// `createFsPrefs` is an IPrefsAccessor over that file, for the history store's
// `attachPrefs`. The rules:
//
//   LOAD FIRST. The history store reads getPref synchronously at attach, so an
//     accessor attached before the file is read starts empty and its first
//     write overwrites the file. `attachWhenLoaded(prefs, attach)` attaches
//     only once `load()` settled.
//   NEVER CLOBBER. `client.fsStat` tells a missing file (first run: start
//     empty, writes allowed) from one that exists; a file that exists but
//     cannot be read, or holds an unknown or newer format, is never written:
//     the session keeps its history in memory and the failure is reported.
//   ONE BAG PER OWNER. The owner is the identity fingerprint (user,
//     organization, development team). The file keeps one bag per owner and
//     an accessor reads and writes only its own; the others are written back
//     untouched (at most MAX_PREFS_OWNERS bags, the least recently written
//     dropped). An accessor is made for ONE owner and never writes once
//     `ownerNow()` names someone else (an identity change drops its pending
//     write, as the history store drops its own).
//   CAPS. The history store trims its bag to MAX_HISTORY_BAG_CHARS (256 KB);
//     the whole file is capped at MAX_PREFS_FILE_CHARS, other owners' bags
//     being dropped first, and a file still over it is refused, not written.
//   WRITES are debounced (PREFS_WRITE_DEBOUNCE_MS), serialised, and made
//     after one `client.fsMkdir` of the folder. Every fs request names its
//     bus timeout (PREFS_FS_TIMEOUT_MS).
//   LAST WRITER WINS across windows: each window writes the whole file from
//     what it loaded, so two windows of the same user that both write keep
//     only the later one's view. A known limitation.
// =============================================================================

import { isPlainObject } from '../checks';
import { MAX_HISTORY_BAG_CHARS } from '../history/types';
import type { IPrefsAccessor } from '../history/types';
import { busRequest } from './busClient';
import type { IExplorerBus } from './busClient';
import { assertTimeoutMs } from './timeouts';

/** The file format version this module reads and writes. */
export const PREFS_FILE_VERSION = 1;

/** Bus timeout of each fs request (stat, read, mkdir, write). */
export const PREFS_FS_TIMEOUT_MS = 15_000;

/** Quiet period before a batch of preference changes is written. */
export const PREFS_WRITE_DEBOUNCE_MS = 1_000;

/** Ceiling on the whole file's JSON (characters): two full history bags. */
export const MAX_PREFS_FILE_CHARS = 2 * MAX_HISTORY_BAG_CHARS;

/** Owner bags one file keeps (the least recently written beyond it are dropped). */
export const MAX_PREFS_OWNERS = 8;

/**
 * The history file of a tool.
 *
 * @param tool - The tool's short name ('sql', 'graph', 'vector').
 * @returns `@/User/.workspace/rocketride.<tool>.history.json`.
 */
export function historyPrefsPath(tool: string): string {
	return `@/User/.workspace/rocketride.${tool}.history.json`;
}

/** Where the accessor is in its life. */
export type FsPrefsStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** One owner's bag in the file. */
interface IOwnerBag {
	/** Epoch ms of its last write. */
	at: number;
	/** Its preferences, by key. */
	prefs: Record<string, unknown>;
}

/** What {@link createFsPrefs} needs. */
export interface IFsPrefsOptions {
	/** The controller realm's bus (its ConnectionManager). */
	cm: IExplorerBus;
	/** The file (see {@link historyPrefsPath}). */
	path: string;
	/** The identity fingerprint this accessor belongs to (required; no identity: no file). */
	owner: string;
	/** Who is signed in NOW; writes stop once it is not `owner` (default: always `owner`). */
	ownerNow?: () => string | null;
	/** The folder to create before the first write (default: the path's folder). */
	dir?: string;
	/** Bus timeout per fs request (default {@link PREFS_FS_TIMEOUT_MS}). */
	timeoutMs?: number;
	/** Write debounce (default {@link PREFS_WRITE_DEBOUNCE_MS}). */
	debounceMs?: number;
	/** File cap (default {@link MAX_PREFS_FILE_CHARS}). */
	maxFileChars?: number;
	/** Owner bags kept (default {@link MAX_PREFS_OWNERS}). */
	maxOwners?: number;
	/** Told about a failed load or write (the file was left alone). */
	onError?: (error: unknown, phase: 'load' | 'write') => void;
	/** Clock and timers (default: real). */
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

/** The accessor. */
export interface IFsPrefs extends IPrefsAccessor {
	/** The owner it reads and writes for. */
	readonly owner: string;
	/** The file. */
	readonly path: string;
	/** Where it is in its life. */
	status(): FsPrefsStatus;
	/** Read the file (once; later calls return the same promise). Never rejects. */
	load(): Promise<FsPrefsStatus>;
	/** Write pending changes now. */
	flush(): Promise<void>;
	/** Write pending changes, then stop (unmount under the same identity). */
	close(): Promise<void>;
	/** Stop, DROPPING pending changes (identity change). Idempotent. */
	dispose(): void;
}

/**
 * Read the stored file.
 *
 * @param raw - What `client.fsReadJson` answered.
 * @returns The owner bags.
 * @throws Error for anything but this module's format (the file is then never written).
 */
function readFile(raw: unknown): Record<string, IOwnerBag> {
	if (!isPlainObject(raw) || raw.version !== PREFS_FILE_VERSION || !isPlainObject(raw.owners)) {
		throw new Error(`The history file is not in format version ${PREFS_FILE_VERSION}; it is left untouched.`);
	}
	const owners: Record<string, IOwnerBag> = {};
	for (const [id, bag] of Object.entries(raw.owners)) {
		if (!isPlainObject(bag) || !isPlainObject(bag.prefs)) continue;
		owners[id] = { at: typeof bag.at === 'number' && Number.isFinite(bag.at) ? bag.at : 0, prefs: bag.prefs };
	}
	return owners;
}

/**
 * Create a history-preferences accessor over a file in the user store.
 *
 * @param opts - See {@link IFsPrefsOptions}.
 * @returns The accessor; `load()` it (or use {@link attachWhenLoaded}) before attaching.
 * @throws RangeError without an owner or with an unusable timeout.
 */
export function createFsPrefs(opts: IFsPrefsOptions): IFsPrefs {
	const { cm, path, owner } = opts;
	if (typeof owner !== 'string' || owner === '') {
		throw new RangeError('createFsPrefs needs the identity fingerprint as its owner; without an identity, history stays in memory.');
	}
	const timeoutMs = assertTimeoutMs(opts.timeoutMs ?? PREFS_FS_TIMEOUT_MS, 'prefs fs timeoutMs');
	const debounceMs = opts.debounceMs ?? PREFS_WRITE_DEBOUNCE_MS;
	const maxFileChars = opts.maxFileChars ?? MAX_PREFS_FILE_CHARS;
	const maxOwners = Math.max(1, opts.maxOwners ?? MAX_PREFS_OWNERS);
	const now = opts.now ?? Date.now;
	const setTimer = opts.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const dir = opts.dir ?? (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
	const stillOwner = (): boolean => (opts.ownerNow ? opts.ownerNow() === owner : true);

	let status: FsPrefsStatus = 'idle';
	let loading: Promise<FsPrefsStatus> | null = null;
	let others: Record<string, IOwnerBag> = {};
	let mine: Record<string, unknown> = {};
	let dirty = false;
	let timer: unknown = null;
	let madeDir = false;
	let disposed = false;
	let chain: Promise<void> = Promise.resolve();

	const load = (): Promise<FsPrefsStatus> => {
		if (loading !== null) return loading;
		status = 'loading';
		loading = (async (): Promise<FsPrefsStatus> => {
			try {
				if (!stillOwner()) throw new Error('The signed-in identity changed before the history file was read.');
				const stat = await busRequest(cm, 'client.fsStat', { path }, timeoutMs);
				if (isPlainObject(stat) && stat.exists === false) {
					status = 'ready';
					return status;
				}
				if (!isPlainObject(stat) || stat.exists !== true) throw new Error('client.fsStat gave no answer about the history file.');
				const owners = readFile(await busRequest(cm, 'client.fsReadJson', { path }, timeoutMs));
				mine = { ...(owners[owner]?.prefs ?? {}) };
				delete owners[owner];
				others = owners;
				status = 'ready';
			} catch (error) {
				status = 'failed';
				opts.onError?.(error, 'load');
			}
			return status;
		})();
		return loading;
	};

	/**
	 * The file to write, or null when it is over the cap (reported).
	 *
	 * @returns The file.
	 */
	const compose = (): { version: number; owners: Record<string, IOwnerBag> } | null => {
		const own: IOwnerBag = { at: now(), prefs: JSON.parse(JSON.stringify(mine)) as Record<string, unknown> };
		const kept = Object.entries(others).sort((a, b) => b[1].at - a[1].at).slice(0, maxOwners - 1);
		for (;;) {
			const file = { version: PREFS_FILE_VERSION, owners: { ...Object.fromEntries(kept), [owner]: own } };
			if (JSON.stringify(file).length <= maxFileChars) {
				others = Object.fromEntries(kept);
				return file;
			}
			if (kept.length === 0) break;
			kept.pop();
		}
		opts.onError?.(new RangeError(`The history file would exceed ${maxFileChars} characters; it was not written.`), 'write');
		return null;
	};

	const write = async (): Promise<void> => {
		if (status !== 'ready' || !dirty) return;
		dirty = false;
		if (!stillOwner()) return;
		const file = compose();
		if (file === null) return;
		try {
			if (!madeDir && dir !== '') {
				try {
					await busRequest(cm, 'client.fsMkdir', { path: dir }, timeoutMs);
				} catch {
					// Usually "already exists"; a real failure surfaces on the write.
				}
				madeDir = true;
			}
			await busRequest(cm, 'client.fsWriteJson', { path, value: file }, timeoutMs);
		} catch (error) {
			dirty = true;
			opts.onError?.(error, 'write');
		}
	};

	const writeNow = (): Promise<void> => {
		if (timer !== null) {
			clearTimer(timer);
			timer = null;
		}
		chain = chain.then(write, write);
		return chain;
	};

	return {
		owner,
		path,
		status: () => status,
		load,
		getPref: (key) => mine[key],
		setPref(key, value) {
			mine[key] = value;
			dirty = true;
			if (disposed || status !== 'ready' || timer !== null) return;
			timer = setTimer(() => {
				timer = null;
				void writeNow();
			}, debounceMs);
		},
		flush: () => (disposed ? chain : writeNow()),
		async close() {
			if (!disposed) await writeNow();
			this.dispose();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
			dirty = false;
		},
	};
}

/**
 * Attach a history store once the file is loaded (whatever the load's
 * outcome: a failed load attaches a session-only accessor that never writes).
 *
 * @param prefs - The accessor.
 * @param attach - Usually `(api, owner) => store.attachPrefs(api, owner)`.
 * @returns Detach; before the load settles it cancels the attach.
 */
export function attachWhenLoaded(prefs: IFsPrefs, attach: (api: IPrefsAccessor, owner: string) => () => void): () => void {
	let detach: (() => void) | null = null;
	let cancelled = false;
	void prefs.load().then(() => {
		if (!cancelled) detach = attach(prefs, prefs.owner);
	});
	return () => {
		cancelled = true;
		detach?.();
		detach = null;
	};
}
