// MIT License
//
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
// GUIDE TOOLKIT — read_guide, over the guides the host hands in
// =============================================================================

/**
 * One tool, `read_guide`, that reads the guides from the GuideSource the host
 * passes in and from nowhere else. Guides are reference text, not workspace
 * files: the file tools never see them, and nothing can change them.
 *
 * The guides name each other by '.rocketride/' paths (e.g.
 * '.rocketride/docs/ROCKETRIDE_APPS.md'), so read_guide takes a path with or
 * without that prefix and shows every path with it. That prefix is the
 * toolkit's only RocketRide rule; another app can pass its own guides as they
 * are. An empty path or a folder lists the guides; a path that is not a guide
 * fails with the list. A long guide is capped and windowed the way read_file
 * caps and windows a long file.
 */

import type { GuideSource } from '../host';
import { AgentTool, AgentToolkit } from '../tools';
import { numberArg } from './common';

// =============================================================================
// CONSTANTS
// =============================================================================

/** The folder the guides are shown under; read_guide takes paths with or without it. */
const GUIDE_ROOT = '.rocketride';

/** Default read cap in bytes, as read_file's. */
const READ_DEFAULT_BYTES = 256 * 1024;
/** Hard read cap in bytes, as read_file's. */
const READ_MAX_BYTES = 4 * 1024 * 1024;

/** What the model is told about the guides. */
const INSTRUCTIONS = 'Open guides with read_guide, not the file tools, because guides are not workspace files.';

// =============================================================================
// PATHS AND WINDOWS
// =============================================================================

/**
 * A guide path as the source names it: backslashes become slashes, empty and
 * '.' segments drop out (so './' and a leading slash do), and a leading
 * '.rocketride' segment goes.
 *
 * @param raw - The path as the model wrote it.
 * @returns The path relative to the guide root ('' for the root itself).
 */
function guidePath(raw: unknown): string {
	const segments = String(raw ?? '')
		.replace(/\\/g, '/')
		.split('/')
		.filter((s) => s !== '' && s !== '.');
	if (segments[0] === GUIDE_ROOT) segments.shift();
	return segments.join('/');
}

/**
 * A guide path as the model sees it.
 *
 * @param path - A path relative to the guide root.
 * @returns The path under '.rocketride/'.
 */
function shown(path: string): string {
	return `${GUIDE_ROOT}/${path}`;
}

/**
 * A guide's text, capped and windowed as read_file does a file: an
 * offset/limit line window first, then a byte cap, each one labeled.
 *
 * @param text - The whole guide.
 * @param label - The guide path the labels name.
 * @param offset - Optional 1-based first line of a partial read.
 * @param limit - Optional line count of a partial read.
 * @param maxBytes - Optional byte cap (clamped to READ_MAX_BYTES).
 * @returns The text or window, truncation always labeled.
 */
function windowed(text: string, label: string, offset?: number, limit?: number, maxBytes?: number): string {
	const cap = Math.min(Math.max(1, maxBytes ?? READ_DEFAULT_BYTES), READ_MAX_BYTES);

	// step: line window first, then the byte cap on what is left
	let header = '';
	let body = text;
	if (offset !== undefined || limit !== undefined) {
		const lines = text.split('\n');
		const start = Math.max(1, Math.floor(offset ?? 1));
		const slice = lines.slice(start - 1, start - 1 + Math.max(1, Math.floor(limit ?? lines.length)));
		if (slice.length === 0) return `[EMPTY WINDOW: ${label} has ${lines.length} lines; requested from line ${start}]`;
		header = `[Lines ${start}-${start - 1 + slice.length} of ${lines.length} in ${label}]\n`;
		body = slice.join('\n');
	}
	const bytes = new TextEncoder().encode(body);
	if (bytes.length <= cap) return header + body;
	return `${header}${new TextDecoder().decode(bytes.slice(0, cap))}\n[TRUNCATED: showing first ${cap} of ${bytes.length} bytes — narrow with offset/limit or raise maxBytes]`;
}

// =============================================================================
// TOOLKIT
// =============================================================================

/** The guide toolkit: one tool, `read_guide`. */
export class GuideToolkit extends AgentToolkit {
	readonly name = 'guides';
	readonly instructions = INSTRUCTIONS;
	/** The guides read so far, as read_guide shows them (e.g. '.rocketride/docs/ROCKETRIDE_APPS.md'), for the run's log line. */
	readonly guidesRead = new Set<string>();

	/** Where the guides come from. */
	private readonly guides: GuideSource;

	/**
	 * Builds the toolkit.
	 *
	 * @param guides - The host's guides; the toolkit reads nothing else.
	 */
	constructor(guides: GuideSource) {
		super();
		this.guides = guides;
	}

	/**
	 * read_guide: one guide's text, or the guides in a folder.
	 *
	 * @param args - The tool arguments: path, and optional offset, limit and maxBytes.
	 * @returns The guide's text or window, or the list of guides for an empty path or a folder.
	 * @throws When the path is neither a guide nor a folder of guides; the message lists the guides.
	 */
	private async readGuide(args: Record<string, unknown>): Promise<string> {
		const path = guidePath(args.path);
		const all = [...this.guides.paths()].sort();

		// step: a guide reads as text
		if (all.includes(path)) {
			const text = await this.guides.read(path);
			this.guidesRead.add(shown(path));
			return windowed(text, shown(path), numberArg(args, 'offset'), numberArg(args, 'limit'), numberArg(args, 'maxBytes'));
		}

		// step: the root or a folder lists its guides; anything else fails with the whole list
		const inFolder = path === '' ? all : all.filter((p) => p.startsWith(`${path}/`));
		if (path === '' || inFolder.length > 0) {
			return inFolder.length > 0 ? `Guides in ${shown(path ? `${path}/` : '')}:\n${inFolder.map(shown).join('\n')}` : 'There are no guides.';
		}
		throw new Error(`No guide '${shown(path)}'. Guides: ${all.map(shown).join(', ') || 'none'}`);
	}

	/**
	 * The `read_guide` tool.
	 *
	 * @returns The group's tools.
	 */
	tools(): AgentTool[] {
		return [
			new AgentTool({
				name: 'read_guide',
				description: `Read one guide as text, or a line window of it via offset/limit (1-based). Guides are reference docs, not workspace files. The path may start with ${GUIDE_ROOT}/ or not. An empty path or a folder lists the guides; a path that is not a guide fails with the list. Truncation is always labeled. Default cap ${READ_DEFAULT_BYTES} bytes, maximum ${READ_MAX_BYTES}.`,
				parameters: {
					type: 'object',
					properties: {
						path: { type: 'string', description: `Guide path, with or without the ${GUIDE_ROOT}/ prefix; '' or a folder lists the guides` },
						offset: { type: 'number', description: 'Optional 1-based first line of a partial read' },
						limit: { type: 'number', description: 'Optional number of lines to return' },
						maxBytes: { type: 'number', description: `Optional read cap in bytes (1..${READ_MAX_BYTES})` },
					},
					additionalProperties: false,
				},
				execute: (a) => this.readGuide(a),
			}),
		];
	}
}
