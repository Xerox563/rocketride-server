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
// README CLAIMS — what the README says is what the code does
// =============================================================================
//
// The README states numbers and rules a user acts on: which engines connect,
// which pipelines the New Connection picker offers, how long each engine call
// may take, when a statement is sent twice, and where a dev tool keeps
// history. Each claim below is pinned to the constant or the code that makes
// it true, so the two cannot drift apart without a test failing.
//
// Port of df15771bd (tests/readmeClaims.test.ts), rewritten for this branch's
// README (the original pinned the shared Connections landing, which this app
// does not use).
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_RETRY_WINDOW_MS } from 'shared/explorer/connect/session';
import { historyPrefsPath } from 'shared/explorer/devtool/prefs';
import { UNBOUNDED_TOOL_TIMEOUT_MS } from 'shared/explorer/devtool/timeouts';
import { DATABASE_PROVIDERS } from '../src/connect';
import { DIALECT_WAIT_MS, GET_SCHEMA_WAIT_MS, REFRESH_SCHEMA_WAIT_MS, STATEMENT_WAIT_PAD_MS } from '../src/connect/tools';
import { MAX_WATCHED_HISTORY_KEYS } from '../src/sqlController';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';

const README = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
const prose = README.replace(/\s+/g, ' ');
const core = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'sqlCore.ts'), 'utf8');

describe('README claims', () => {
	it('names every engine the app connects to', () => {
		for (const provider of DATABASE_PROVIDERS) assert.ok(prose.includes(`\`${provider}\``), `${provider} is not named`);
	});

	it('says the picker offers your own development runs only, as the code filters', () => {
		assert.match(prose, /finds the database nodes in the pipelines you are running yourself \(your own development runs\)/);
		assert.match(core, /\.filter\(\(endpoint\) => endpoint\.legacyKey !== null && endpoint\.state !== 'stopped'\)/);
	});

	it('states the waits the code names', () => {
		assert.equal(DIALECT_WAIT_MS, 15_000);
		assert.equal(GET_SCHEMA_WAIT_MS, 60_000);
		assert.equal(REFRESH_SCHEMA_WAIT_MS, 135_000);
		assert.equal(STATEMENT_WAIT_PAD_MS, 10_000);
		assert.match(prose, /Reading the schema waits up to 60 seconds, re-reading it 135, and the engine check 15\./);
		assert.match(prose, /No client timeout on a statement\*\* unless the node publishes a statement deadline/);
	});

	it('states the one retry the way the session takes it', () => {
		assert.equal(DEFAULT_RETRY_WINDOW_MS, 15_000);
		assert.match(prose, /the same connection is running again within 15 seconds; a write never is\./);
		assert.match(prose, /a `SELECT … INTO`, which fills a new table, a file or variables .* counts as a write and is never re-sent/);
	});

	it('names the dev tool\'s history file where the code keeps it', () => {
		assert.equal(historyPrefsPath('sql'), '@/User/.workspace/rocketride.sql.history.json');
		assert.match(prose, /`\.workspace\/rocketride\.sql\.history\.json` in your user storage/);
		assert.match(prose, /the last one to save wins/);
	});

	it('states the dev tool\'s gate, history and wait rules the way the code applies them', () => {
		assert.match(prose, /If the node cannot say which dialect it speaks, the statement is\s+sent once and never repeated\./);
		assert.match(prose, /`NO_BACKSLASH_ESCAPES`/);
		assert.match(prose, /`SELECT\s+nextval\('s'\)`\) still counts as a read/);
		assert.equal(UNBOUNDED_TOOL_TIMEOUT_MS, 24 * 60 * 60 * 1000);
		assert.match(prose, /waited for up to 24 hours/);
		// 24 h plus reaching the connection (a few minutes at most).
		const extra = SQL_OP_TIMEOUT_MS['sql.execute'] - UNBOUNDED_TOOL_TIMEOUT_MS;
		assert.ok(extra > 0 && extra < 10 * 60_000, `${extra} ms beyond 24 h`);
		assert.match(prose, /plus the few minutes it may take to reach the connection/);
		assert.equal(MAX_WATCHED_HISTORY_KEYS, 128);
		assert.match(prose, /More than 128 history views open at once/);
		assert.match(prose, /Another account signs in\*\* \(or the organization or team changes\): the previous account's last unsaved statements are dropped\. They are never written into another account's file\./);
		assert.match(prose, /nothing is written while nobody is signed in\. They are written when the same account is known again while the sidebar is open\. They are dropped if the sidebar closes while nobody is signed in/);
		const controller = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'sqlController.ts'), 'utf8');
		assert.match(controller, /return now\.known \? now\.fingerprint : null;/, 'writes hold while nobody is vouched for');
	});

	it('links only to sections that exist', () => {
		const anchors = new Set([...README.matchAll(/^#{2,3} (.+)$/gm)].map((m) => (m[1] as string).toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')));
		for (const match of README.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(anchors.has(match[1] as string), `#${match[1]} is not a section`);
	});
});
