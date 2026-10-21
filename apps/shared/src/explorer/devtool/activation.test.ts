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
// EXPLORER DEV TOOL — ACTIVATION GATE (R7; T6 base)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionManager } from 'shell';
import { createActivationGate } from './activation';
import type { ActivationReason, IActivationBus } from './activation';
import { realmKind } from './realm';
import { account, createFakeClientRealm, createFakeSocketlessRealm, settle } from './testing';

const APP = 'sql-ui';

describe('the ConnectionManager satisfies the structural activation bus', () => {
	it('compiles: a realm ConnectionManager is an IActivationBus', () => {
		const check = (cm: ConnectionManager): IActivationBus => cm;
		assert.equal(typeof check, 'function');
	});
});

describe('realmKind', () => {
	it('socketless only when connected without a client; undecided while a clientless realm is down', async () => {
		const vscode = createFakeSocketlessRealm();
		assert.equal(realmKind(vscode.cm), 'unknown');
		vscode.root.connect(account('u'));
		await settle();
		assert.equal(realmKind(vscode.cm), 'socketless');
		const rocket = createFakeClientRealm();
		assert.equal(realmKind(rocket.cm), 'client');
		assert.equal(realmKind({ isConnected: () => true }), 'unknown', 'no getClient: cannot tell');
	});
});

describe('createActivationGate — rocket-ui mounts every pinned controller at boot', () => {
	it('stays closed through a boot: login, connect, other tools activating, a null activeDocKey', () => {
		const realm = createFakeClientRealm();
		const gate = createActivationGate({ appId: APP, cm: realm.cm, activeDocKey: null });
		realm.login(account('u'));
		realm.activate('graph-ui');
		realm.deactivate('graph-ui');
		gate.noteActiveDocKey(null);
		gate.noteActiveDocKey(undefined);
		assert.equal(gate.isOpen(), false);
		assert.equal(gate.reason(), null);
		assert.deepEqual(realm.requests, [], 'creating the gate calls nothing');
		gate.dispose();
	});

	it('opens on shell:toolSidebarActivated for THIS app', () => {
		const realm = createFakeClientRealm();
		realm.login(account('u'));
		const gate = createActivationGate({ appId: APP, cm: realm.cm });
		realm.activate(APP);
		assert.equal(gate.isOpen(), true);
		assert.equal(gate.reason(), 'activated');
		gate.dispose();
	});

	it("opens on an activeDocKey that is a string ('' is this tool's generic frame)", () => {
		for (const key of ['', 'workbench:k1']) {
			const realm = createFakeClientRealm();
			const gate = createActivationGate({ appId: APP, cm: realm.cm, activeDocKey: null });
			gate.noteActiveDocKey(key);
			assert.equal(gate.reason(), 'activeDoc', JSON.stringify(key));
			gate.dispose();
		}
		const realm = createFakeClientRealm();
		const atMount = createActivationGate({ appId: APP, cm: realm.cm, activeDocKey: '' });
		assert.equal(atMount.reason(), 'activeDoc', 'a restored generic frame at boot counts');
		atMount.dispose();
	});

	it('opens on the first op from a frame and on an explicit user action', () => {
		for (const reason of ['op', 'user'] as ActivationReason[]) {
			const realm = createFakeClientRealm();
			const gate = createActivationGate({ appId: APP, cm: realm.cm });
			gate.open(reason);
			assert.equal(gate.reason(), reason);
			gate.dispose();
		}
	});

	it('opens once: the first reason sticks and subscribers hear it exactly once', () => {
		const realm = createFakeClientRealm();
		const gate = createActivationGate({ appId: APP, cm: realm.cm });
		const heard: ActivationReason[] = [];
		gate.subscribe((reason) => heard.push(reason));
		realm.activate(APP);
		gate.open('user');
		realm.activate(APP);
		assert.deepEqual(heard, ['activated']);
		const late: ActivationReason[] = [];
		gate.subscribe((reason) => late.push(reason));
		assert.deepEqual(late, ['activated'], 'a late subscriber hears the open state at once');
		gate.dispose();
	});
});

describe('createActivationGate — VS Code mounts a tool sidebar lazily, so mount IS the first activation', () => {
	it('opens at mount in a connected socketless realm', async () => {
		const realm = createFakeSocketlessRealm();
		realm.root.connect(account('u'));
		await settle();
		const gate = createActivationGate({ appId: APP, cm: realm.cm, activeDocKey: undefined });
		assert.equal(gate.reason(), 'lazyMount');
		gate.dispose();
	});

	it('mounted while the root is down: opens when the realm proves socketless on shell:connected', async () => {
		const realm = createFakeSocketlessRealm();
		const gate = createActivationGate({ appId: APP, cm: realm.cm });
		assert.equal(gate.isOpen(), false);
		realm.root.connect(account('u'));
		await settle();
		assert.equal(gate.reason(), 'lazyMount');
		gate.dispose();
	});

	it('a bus without getClient cannot tell, so it falls back to the explicit signals', () => {
		const realm = createFakeClientRealm();
		const bare: IActivationBus = { on: (event, handler) => realm.cm.on(event, handler), isConnected: () => realm.cm.isConnected() };
		const gate = createActivationGate({ appId: APP, cm: bare });
		realm.login(account('u'));
		assert.equal(gate.isOpen(), false);
		realm.activate(APP);
		assert.equal(gate.reason(), 'activated');
		gate.dispose();
	});

	it('dispose removes its listeners', () => {
		const realm = createFakeClientRealm();
		const before = realm.cm.listenerCount();
		const gate = createActivationGate({ appId: APP, cm: realm.cm });
		gate.dispose();
		assert.equal(realm.cm.listenerCount(), before);
		realm.activate(APP);
		assert.equal(gate.isOpen(), false);
	});
});
