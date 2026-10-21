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
// EXPLORER DEV TOOL — RETAINED STATE SIZE (bulk results are op results, R4/T11)
// =============================================================================
//
// Retained channel state is cheap only while it is small. The sidebar peer
// keeps ONE retained map of every state topic and republishes the WHOLE map on
// every publish (busPeer.ts stateMap); every frame replays it on attach; in
// VS Code each copy crosses postMessage as JSON. So a snapshot is a summary
// (endpoints, schemas by key, identity, previews), and anything bulky (graph
// rows, vector samples of up to ~1.2 MB) travels as an op RESULT, to the one
// frame that asked.
//
// MAX_RETAINED_STATE_BYTES caps one snapshot's JSON at 64 KiB: room for a few
// hundred endpoints or a large schema tree, and well under any bulk result.
// `guardRetainedState(channel)` enforces it on every publish; lanes assert
// their largest snapshots with `assertRetainedStateSize`.
// =============================================================================

import type { ToolChannel } from 'shell';

/** The largest JSON (in UTF-8 bytes) one retained state snapshot may have. */
export const MAX_RETAINED_STATE_BYTES = 64 * 1024;

/**
 * The size of a value as it crosses the wire: the UTF-8 bytes of its JSON.
 *
 * @param value - Anything JSON can serialise.
 * @returns The byte length (0 when JSON drops the value entirely).
 */
export function jsonByteLength(value: unknown): number {
	const text = JSON.stringify(value);
	return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

/** A state snapshot too large to be retained (it belongs in an op result). */
export class RetainedStateTooLargeError extends RangeError {
	/** The state topic. */
	readonly topic: string;

	/** The snapshot's JSON size in bytes. */
	readonly bytes: number;

	/** The cap it exceeded. */
	readonly maxBytes: number;

	/**
	 * @param topic - The state topic.
	 * @param bytes - The snapshot's size.
	 * @param maxBytes - The cap.
	 */
	constructor(topic: string, bytes: number, maxBytes: number) {
		super(`State '${topic}' is ${bytes} bytes of JSON, over the ${maxBytes}-byte cap for retained state; send bulk data as an op result.`);
		this.name = 'RetainedStateTooLargeError';
		this.topic = topic;
		this.bytes = bytes;
		this.maxBytes = maxBytes;
		Object.setPrototypeOf(this, RetainedStateTooLargeError.prototype);
	}
}

/**
 * Check a snapshot fits the retained-state cap.
 *
 * @param topic - The state topic (named in the error).
 * @param snapshot - The snapshot.
 * @param maxBytes - The cap (default {@link MAX_RETAINED_STATE_BYTES}).
 * @returns The snapshot's size in bytes.
 * @throws RetainedStateTooLargeError when it does not fit.
 */
export function assertRetainedStateSize(topic: string, snapshot: unknown, maxBytes: number = MAX_RETAINED_STATE_BYTES): number {
	const bytes = jsonByteLength(snapshot);
	if (bytes > maxBytes) throw new RetainedStateTooLargeError(topic, bytes, maxBytes);
	return bytes;
}

/** How {@link guardRetainedState} reacts to an oversize snapshot. */
export interface IStateGuardOptions {
	/** The cap (default {@link MAX_RETAINED_STATE_BYTES}). */
	maxBytes?: number;
	/** Report instead of throwing; the snapshot is refused either way. */
	onOversize?: (error: RetainedStateTooLargeError) => void;
}

/**
 * A channel whose `publishState` refuses a snapshot over the cap (it is
 * never published). Everything else is the original channel.
 *
 * @param channel - The controller's channel.
 * @param opts - Cap and reporting.
 * @returns The guarded channel.
 */
export function guardRetainedState(channel: ToolChannel, opts: IStateGuardOptions = {}): ToolChannel {
	const maxBytes = opts.maxBytes ?? MAX_RETAINED_STATE_BYTES;
	return {
		publishState(topic, snapshot) {
			try {
				assertRetainedStateSize(topic, snapshot, maxBytes);
			} catch (error) {
				if (opts.onOversize && error instanceof RetainedStateTooLargeError) {
					opts.onOversize(error);
					return;
				}
				throw error;
			}
			channel.publishState(topic, snapshot);
		},
		onState: (topic, cb) => channel.onState(topic, cb),
		sendEvent: (name, payload) => channel.sendEvent(name, payload),
		onEvent: (name, cb) => channel.onEvent(name, cb),
	};
}
