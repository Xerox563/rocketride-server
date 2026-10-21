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
// AGENT GUIDES — the RocketRide agent docs, bundled into rocket-ui
// =============================================================================

/**
 * Bundles docs/agents at build time and serves it as the agent's guides.
 * rocket-ui's rsbuild loads `.md` as source text, so each guide is a lazy
 * chunk that resolves to the file's text. The bundling lives here,
 * not in shared, because shared's test runner and the VS Code build have no
 * `.md` rule. guidePathFor, below, decides which bundle files are guides and
 * the path of each; the agent's read_guide shows that path under '.rocketride/'.
 */

import type { GuideSource } from 'shared/modules/agent/host';

// =============================================================================
// GUIDE PATHS
// =============================================================================

/**
 * Maps a docs/agents bundle key to its guide path.
 * './context/X.md' becomes 'docs/X.md' (the installer stubs under
 * './context/stubs/' are not guides), and './skills/<path>.md' keeps its path.
 * Everything else, such as the folder README, the task battery and scripts,
 * is not a guide.
 *
 * @param contextKey - A key from the docs/agents bundle, e.g. './context/ROCKETRIDE_APPS.md'.
 * @returns The guide path (e.g. 'docs/ROCKETRIDE_APPS.md'), or null when the file is not a guide.
 */
function guidePathFor(contextKey: string): string | null {
	const key = contextKey.replace(/^\.\//, '');
	if (!key.endsWith('.md') || key.startsWith('context/stubs/')) return null;
	if (key.startsWith('context/')) return `docs/${key.slice('context/'.length)}`;
	if (key.startsWith('skills/')) return key;
	return null;
}

// =============================================================================
// GUIDE SOURCE
// =============================================================================

/**
 * Builds the guide source over the bundled docs/agents folder. The guide
 * paths are computed once here, so paths() stays cheap on every listing.
 *
 * @returns The guides, by guide path (e.g. 'docs/ROCKETRIDE_APPS.md').
 */
export function createRocketGuideSource(): GuideSource {
	const bundle = import.meta.webpackContext('../../../../docs/agents', { recursive: true, regExp: /\.md$/, mode: 'lazy' });

	// step: guide path -> bundle key; files that are not guides drop out
	const keys = new Map<string, string>();
	for (const key of bundle.keys()) {
		const path = guidePathFor(key);
		if (path) keys.set(path, key);
	}
	const paths = [...keys.keys()];

	return {
		paths: () => paths.slice(),
		read: async (path) => {
			const noGuide = () => new Error(`No guide at .rocketride/${path}. Call read_guide with no path to see the guides.`);
			const key = keys.get(path);
			if (!key) throw noGuide();
			// step: rspack resolves an asset/source module to its text itself; a toolchain that wraps it as { default } still works
			const loaded = await bundle<Promise<unknown>>(key);
			if (typeof loaded === 'string') return loaded;
			const wrapped = (loaded as { default?: unknown } | null)?.default;
			if (typeof wrapped === 'string') return wrapped;
			throw noGuide();
		},
	};
}
