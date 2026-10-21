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
// EXPLORER DEV TOOL — FRAME IDENTITY GUARD (the frame half of R9; T7)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameIdentityGuard, IDENTITY_STATE_TOPIC, publishIdentityState } from './frameIdentity';
import type { FrameResetReason } from './frameIdentity';
import { createIdentityTracker } from './identity';
import { account, assertJsonSafe, createDevToolHarness, createFakeClientRealm, settle, shellProtocol } from './testing';

/**
 * A controller publishing a client realm's identity, and a frame over the same tool.
 *
 * @param docKey - The frame's docKey.
 * @returns The pieces.
 */
async function rig(docKey: string | undefined) {
	const h = createDevToolHarness();
	const realm = createFakeClientRealm();
	realm.login(account('user-a'));
	const tracker = createIdentityTracker({ cm: realm.cm });
	const controllerChannel = shellProtocol.createToolChannel(h.sidebarPeer);
	const stopPublishing = publishIdentityState(controllerChannel, tracker);
	const closed: string[] = [];
	const resets: FrameResetReason[] = [];
	const guard = createFrameIdentityGuard({
		channel: shellProtocol.createToolChannel(h.newFramePeer()),
		docKey,
		documents: { close: (key) => closed.push(key) },
		onReset: (reason) => resets.push(reason),
	});
	await settle();
	return { h, realm, tracker, guard, closed, resets, stop: () => { guard.dispose(); stopPublishing(); tracker.dispose(); } };
}

describe('publishIdentityState — the controller side', () => {
	it('publishes { fingerprint } on the identity topic now and on every fingerprint change, JSON-safe', async () => {
		const h = createDevToolHarness();
		const realm = createFakeClientRealm();
		realm.login(account('user-a'));
		const tracker = createIdentityTracker({ cm: realm.cm });
		const channel = shellProtocol.createToolChannel(h.sidebarPeer);
		const seen: unknown[] = [];
		channel.onState(IDENTITY_STATE_TOPIC, (snapshot) => seen.push(snapshot));
		const stop = publishIdentityState(channel, tracker);
		realm.accountUpdate(account('user-a', 'org-1', 'team-1', { permissions: ['task.data'] }));
		realm.drop();
		realm.reconnect(account('user-b'));
		assert.deepEqual(seen, [{ fingerprint: 'user-a|org-1|team-1' }, { fingerprint: null }, { fingerprint: 'user-b|org-1|team-1' }]);
		for (const snapshot of seen) assertJsonSafe(snapshot);
		await settle();
		assert.deepEqual(h.violations, []);
		stop();
		tracker.dispose();
	});
});

describe('createFrameIdentityGuard — the frame side', () => {
	it('remembers the first fingerprint; a different one closes the document and resets its caches', async () => {
		const r = await rig('workbench:k1');
		assert.equal(r.guard.first(), 'user-a|org-1|team-1');
		r.realm.accountUpdate(account('user-a', 'org-1', 'team-1', { permissions: ['task.data'] }));
		await settle();
		assert.deepEqual(r.closed, [], 'a permission-hint change is the same identity');
		r.realm.accountUpdate(account('user-b'));
		await settle();
		assert.deepEqual(r.closed, ['workbench:k1']);
		assert.deepEqual(r.resets, ['identity']);
		assert.equal(r.guard.closed(), true);
		r.stop();
	});

	it('an unknown identity (null) clears caches but closes nothing; the same identity coming back changes nothing', async () => {
		const r = await rig('write:k1');
		r.realm.drop();
		await settle();
		assert.deepEqual(r.resets, ['unknown']);
		r.realm.reconnect(account('user-a'));
		await settle();
		assert.deepEqual(r.closed, []);
		assert.deepEqual(r.resets, ['unknown']);
		r.stop();
	});

	it('clears its caches when host:connection turns false, once per drop', async () => {
		const r = await rig('workbench:k1');
		r.h.setHostConnection(true);
		await settle();
		r.h.setHostConnection(false);
		await settle();
		r.h.setHostConnection(false);
		await settle();
		assert.deepEqual(r.resets, ['disconnected']);
		r.h.setHostConnection(true);
		r.h.setHostConnection(false);
		await settle();
		assert.deepEqual(r.resets, ['disconnected', 'disconnected']);
		assert.deepEqual(r.closed, []);
		r.stop();
	});

	it("a landing frame (docKey undefined or '') resets but is never closed, and adopts the new identity", async () => {
		for (const docKey of [undefined, '']) {
			const r = await rig(docKey);
			r.realm.accountUpdate(account('user-b'));
			await settle();
			assert.deepEqual(r.closed, []);
			assert.deepEqual(r.resets, ['identity']);
			assert.equal(r.guard.first(), 'user-b|org-1|team-1');
			r.realm.accountUpdate(account('user-b', 'org-1', 'team-1', { permissions: [] }));
			await settle();
			assert.deepEqual(r.resets, ['identity'], 'no second reset for the identity it adopted');
			r.stop();
		}
	});

	it('dispose stops it', async () => {
		const r = await rig('workbench:k1');
		r.guard.dispose();
		r.realm.accountUpdate(account('user-b'));
		r.h.setHostConnection(false);
		await settle();
		assert.deepEqual(r.closed, []);
		assert.deepEqual(r.resets, []);
		r.stop();
	});
});
