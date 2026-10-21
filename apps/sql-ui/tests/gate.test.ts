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
// T10 — THE CONTROLLER'S STATEMENT GATE (pure cases)
// =============================================================================
//
// The controller classifies every statement again before it sends it
// (sql/gate.ts). These are the cases the gate must get right whatever the
// frame asked for; the end-to-end cases are in devtool.wiring.test.ts (T10).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gateStatement } from '../src/sql/gate';

describe('T10 — a write the server runs is never repeatable, however it is hidden', () => {
	it('mysql: a write inside an executable comment (/*!50000 ... */) makes the text a write', () => {
		assert.equal(gateStatement('SELECT 1; /*!50000 DELETE FROM orders */', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('/*!50000 DELETE FROM orders */', 'mysql', true).idempotent, false);
		assert.equal(gateStatement('SELECT 1 /*!50000 , 2 */', 'mysql', true).idempotent, true, 'control: a read stays a read');
	});

	it('postgres: a write behind a line comment that a bare carriage return ends', () => {
		assert.equal(gateStatement('SELECT 1 -- x\r; DELETE FROM orders', 'postgres', true).idempotent, false);
		assert.equal(gateStatement('SELECT 1 -- x\r\nFROM t', 'postgres', true).idempotent, true, 'control');
	});
});
