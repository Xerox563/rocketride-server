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
// EXPLORER DEV TOOL — RETAINED STATE SIZE (T11: no bulk result is retained state)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertRetainedStateSize, guardRetainedState, jsonByteLength, MAX_RETAINED_STATE_BYTES, RetainedStateTooLargeError } from './state';
import { createDevToolHarness, settle, shellProtocol } from './testing';

describe('jsonByteLength', () => {
	it('counts the UTF-8 bytes of the JSON text', () => {
		assert.equal(jsonByteLength({ a: 1 }), 7);
		assert.equal(jsonByteLength('é'), 4, 'two quotes and a two-byte character');
		assert.equal(jsonByteLength(['😀']), 8, 'brackets, quotes and a four-byte character');
		assert.equal(jsonByteLength(undefined), 0);
	});
});

describe('the retained-state cap', () => {
	it('is a documented 64 KiB per snapshot', () => {
		assert.equal(MAX_RETAINED_STATE_BYTES, 64 * 1024);
	});

	it('assertRetainedStateSize passes a small snapshot and refuses a bulk one', () => {
		assert.equal(assertRetainedStateSize('endpoints', { list: [1, 2, 3] }), jsonByteLength({ list: [1, 2, 3] }));
		const bulk = { rows: Array.from({ length: 20_000 }, (_, i) => [i, `row ${i}`]) };
		assert.throws(() => assertRetainedStateSize('rows', bulk), (error: unknown) => {
			assert.ok(error instanceof RetainedStateTooLargeError);
			assert.equal(error.topic, 'rows');
			assert.ok(error.bytes > MAX_RETAINED_STATE_BYTES);
			assert.equal(error.maxBytes, MAX_RETAINED_STATE_BYTES);
			return true;
		});
		assert.doesNotThrow(() => assertRetainedStateSize('rows', bulk, 10 * 1024 * 1024), 'the cap is a parameter');
	});
});

describe('guardRetainedState — a channel that refuses bulk state', () => {
	it('publishes small snapshots and THROWS on a bulk one, which never reaches the wire', async () => {
		const h = createDevToolHarness();
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), { maxBytes: 1_024 });
		channel.publishState('schemas', { k1: ['users'] });
		await settle();
		const writes = h.wire.length;
		assert.throws(() => channel.publishState('preview', { rows: 'x'.repeat(2_000) }), RetainedStateTooLargeError);
		await settle();
		assert.equal(h.wire.length, writes, 'nothing was published');
		const seen: unknown[] = [];
		channel.onState('schemas', (snapshot) => seen.push(snapshot));
		assert.deepEqual(seen, [{ k1: ['users'] }], 'the rest of the channel is the original');
	});

	it('with onOversize: reports and refuses instead of throwing', () => {
		const h = createDevToolHarness();
		const reported: RetainedStateTooLargeError[] = [];
		const channel = guardRetainedState(shellProtocol.createToolChannel(h.sidebarPeer), { maxBytes: 10, onOversize: (error) => reported.push(error) });
		assert.doesNotThrow(() => channel.publishState('big', { text: 'more than ten bytes' }));
		assert.equal(reported.length, 1);
		assert.equal(reported[0].topic, 'big');
	});
});
