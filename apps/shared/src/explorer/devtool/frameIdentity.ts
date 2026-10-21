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
// EXPLORER DEV TOOL — FRAME IDENTITY GUARD (the frame half of R9)
// =============================================================================
//
// The controller vouches for the session (identity.ts) and publishes ONLY its
// fingerprint, as retained state on the `identity` topic:
//
//   controller   publishIdentityState(channel, tracker)   -> { fingerprint }
//   frame        createFrameIdentityGuard({ channel, docKey, documents, onReset })
//
// A frame remembers the FIRST fingerprint it sees. Then:
//
//   a different fingerprint   another user, organization or development team:
//                             the frame closes its document
//                             (`documents.close(docKey)`) and resets its caches
//                             (`onReset('identity')`). A landing frame (docKey
//                             undefined or '') holds nothing connection-scoped
//                             and is never closed: it resets and adopts the new
//                             fingerprint.
//   null                      the controller cannot vouch for anyone (signed
//                             out, disconnected): caches reset
//                             (`onReset('unknown')`), the document stays; the
//                             SAME fingerprint coming back changes nothing.
//   host:connection false     caches reset (`onReset('disconnected')`), once
//                             per drop.
//
// Fingerprints are compared, never epochs: a remounted VS Code controller
// restarts its own counters. Nothing here posts, so a frame may mount it at
// once; a permission-hint change keeps the fingerprint and publishes nothing.
// =============================================================================

import type { ToolChannel } from 'shell';
import { HOST_CONNECTION_TOPIC } from './frame';
import type { IIdentitySnapshot, IIdentityTracker } from './identity';

/** The retained state topic the controller publishes its identity on. */
export const IDENTITY_STATE_TOPIC = 'identity';

/** What crosses: the fingerprint only (never the identity, never a token). */
export interface IIdentityState {
	/** `identityFingerprint(identity)`, or null when the controller cannot vouch for anyone. */
	fingerprint: string | null;
}

/**
 * The identity state for a tracker snapshot.
 *
 * @param snapshot - The tracker's answer.
 * @returns `{ fingerprint }`.
 */
export function identityState(snapshot: IIdentitySnapshot): IIdentityState {
	return { fingerprint: snapshot.known ? snapshot.fingerprint : null };
}

/**
 * CONTROLLER: publish the tracker's fingerprint now and whenever it changes
 * (a retained state publish, allowed at mount by R7).
 *
 * @param channel - The controller's channel.
 * @param tracker - The identity tracker.
 * @param topic - The state topic (default {@link IDENTITY_STATE_TOPIC}).
 * @returns Stop publishing.
 */
export function publishIdentityState(channel: ToolChannel, tracker: Pick<IIdentityTracker, 'get' | 'subscribe'>, topic: string = IDENTITY_STATE_TOPIC): () => void {
	let last = identityState(tracker.get()).fingerprint;
	channel.publishState(topic, { fingerprint: last } satisfies IIdentityState);
	return tracker.subscribe((snapshot) => {
		const next = identityState(snapshot).fingerprint;
		if (next === last) return;
		last = next;
		channel.publishState(topic, { fingerprint: next } satisfies IIdentityState);
	});
}

/** Why a frame reset its caches. */
export type FrameResetReason = 'identity' | 'unknown' | 'disconnected';

/** What {@link createFrameIdentityGuard} needs. */
export interface IFrameIdentityGuardOptions {
	/** The frame's channel (DevToolProps.channel, or the per-peer one). */
	channel: ToolChannel;
	/** The frame's docKey (undefined or '' for the landing / generic frame). */
	docKey?: string | null;
	/** The mount's documents (DevToolProps.documents). */
	documents?: { close(docKey: string): void };
	/** Clear every cache the frame holds (schemas, results, sessions in flight). */
	onReset: (reason: FrameResetReason) => void;
	/** The state topic (default {@link IDENTITY_STATE_TOPIC}). */
	topic?: string;
}

/** The guard. */
export interface IFrameIdentityGuard {
	/** The fingerprint the frame belongs to (the first it saw), or null before one arrived. */
	first(): string | null;
	/** Whether the guard closed the document. */
	closed(): boolean;
	/** Stop following the channel (idempotent). */
	dispose(): void;
}

/**
 * FRAME: close the document and clear caches when the controller's identity
 * changes, and clear caches when the host connection drops.
 *
 * @param opts - See {@link IFrameIdentityGuardOptions}.
 * @returns The guard; dispose it in the mount's cleanup.
 */
export function createFrameIdentityGuard(opts: IFrameIdentityGuardOptions): IFrameIdentityGuard {
	const { channel, documents, onReset } = opts;
	const docKey = typeof opts.docKey === 'string' && opts.docKey !== '' ? opts.docKey : null;
	let first: string | null = null;
	let current: string | null = null;
	let wasClosed = false;
	let connected: boolean | null = null;
	let disposed = false;

	const offIdentity = channel.onState(opts.topic ?? IDENTITY_STATE_TOPIC, (snapshot) => {
		if (disposed || wasClosed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { fingerprint?: unknown }).fingerprint : undefined;
		const fingerprint = typeof value === 'string' && value !== '' ? value : null;
		if (fingerprint === null) {
			if (current !== null) onReset('unknown');
			current = null;
			return;
		}
		current = fingerprint;
		if (first === null) {
			first = fingerprint;
			return;
		}
		if (fingerprint === first) return;
		first = fingerprint;
		if (docKey !== null) {
			wasClosed = true;
			documents?.close(docKey);
		}
		onReset('identity');
	});

	const offConnection = channel.onState(HOST_CONNECTION_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { connected?: unknown }).connected : undefined;
		if (typeof value !== 'boolean') return;
		const was = connected;
		connected = value;
		if (!value && was !== false) onReset('disconnected');
	});

	return {
		first: () => first,
		closed: () => wasClosed,
		dispose() {
			if (disposed) return;
			disposed = true;
			offIdentity();
			offConnection();
		},
	};
}
