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
// EXPLORER DEV TOOL — ACTIVATION GATE (first discovery waits, R7)
// =============================================================================
//
// A controller must not discover (or register monitors, or probe) just
// because it mounted: rocket-ui's TabPanel mounts EVERY pinned tool's sidebar
// at boot, so a mount-time discovery would hit the engine once per pinned
// tool. The gate opens ONCE, on the first of:
//
//   activated   `shell:toolSidebarActivated` for this appId (useToolStrip)
//   op          the first op a frame sends (attachController onFirstOp)
//   activeDoc   an `activeDocKey` that is a string: '' is this tool's generic
//               frame; null means another tab is active, undefined that the
//               host cannot tell yet (VS Code before devtools:activeDoc)
//   user        an explicit action in the sidebar (`open('user')`)
//   lazyMount   the mount itself, in a realm that mounts sidebars lazily
//
// LAZY MOUNT. VS Code mounts a tool sidebar on its first tab select, and that
// selection's `shell:toolSidebarActivated` fires before the sidebar exists to
// hear it (it is not replayed; types/shell.ts says "mounting IS the first
// activation"). rocket-ui contradicts that comment: it mounts every pinned
// sidebar at boot, so there mounting is NOT an activation. The signal used
// to tell them apart: a SOCKETLESS realm (connected with no client, see
// realm.ts) is a VS Code webview, and its sidebar mounts lazily. A realm that
// is down and clientless cannot be classified yet, so the gate re-checks on
// `shell:connected`. Fallback: when the realm cannot be classified (no
// `getClient` on the bus), the gate waits for the explicit signals; the cost
// is that the first discovery waits for the user's next action.
// =============================================================================

import type { ShellEventMap } from 'shell';
import { realmKind } from './realm';

/** Why the gate opened. */
export type ActivationReason = 'activated' | 'op' | 'activeDoc' | 'user' | 'lazyMount';

/** The events the gate follows. */
export type ActivationEvent = 'shell:toolSidebarActivated' | 'shell:connected';

/** What the gate needs from a realm's ConnectionManager (structural). */
export interface IActivationBus {
	/** Follow a shell event; returns the unsubscribe function. */
	on<K extends ActivationEvent>(event: K, handler: (payload: ShellEventMap[K]) => void): () => void;
	/** Whether the realm is connected. */
	isConnected(): boolean;
	/** The realm's client (null in a socketless realm). */
	getClient?(): unknown;
}

/** What {@link createActivationGate} needs. */
export interface IActivationGateOptions {
	/** This tool's app id. */
	appId: string;
	/** The realm's ConnectionManager. */
	cm: IActivationBus;
	/** The sidebar's `activeDocKey` prop at mount. */
	activeDocKey?: string | null;
}

/** The gate. */
export interface IActivationGate {
	/** Whether the controller may start its first discovery. */
	isOpen(): boolean;
	/** Why it opened, or null while closed. */
	reason(): ActivationReason | null;
	/** Open it (a no-op once open). Lanes call `open('user')` on sidebar actions, `open('op')` on the first frame op. */
	open(reason: ActivationReason): void;
	/** Feed every new `activeDocKey` prop value. */
	noteActiveDocKey(key: string | null | undefined): void;
	/** Be told once, when it opens (at once if it already is); returns unsubscribe. */
	subscribe(cb: (reason: ActivationReason) => void): () => void;
	/** Stop following the realm (idempotent). */
	dispose(): void;
}

/**
 * Build a controller's activation gate.
 *
 * @param opts - See {@link IActivationGateOptions}.
 * @returns The gate.
 */
export function createActivationGate(opts: IActivationGateOptions): IActivationGate {
	const { appId, cm } = opts;
	let opened: ActivationReason | null = null;
	const listeners = new Set<(reason: ActivationReason) => void>();
	const offs: Array<() => void> = [];
	let disposed = false;

	const open = (reason: ActivationReason): void => {
		if (opened !== null || disposed) return;
		opened = reason;
		for (const off of offs.splice(0)) off();
		for (const listener of [...listeners]) listener(reason);
		listeners.clear();
	};

	const noteActiveDocKey = (key: string | null | undefined): void => {
		if (typeof key === 'string') open('activeDoc');
	};

	const checkLazyMount = (): void => {
		if (realmKind(cm) === 'socketless') open('lazyMount');
	};

	offs.push(cm.on('shell:toolSidebarActivated', (payload: unknown) => {
		const target = payload !== null && typeof payload === 'object' ? (payload as { appId?: unknown }).appId : undefined;
		if (target === appId) open('activated');
	}));
	// The payload may be undefined in a mirrored realm: never read it.
	offs.push(cm.on('shell:connected', () => checkLazyMount()));

	checkLazyMount();
	noteActiveDocKey(opts.activeDocKey);

	return {
		isOpen: () => opened !== null,
		reason: () => opened,
		open,
		noteActiveDocKey,
		subscribe(cb) {
			if (opened !== null) {
				cb(opened);
				return () => undefined;
			}
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			listeners.clear();
		},
	};
}
