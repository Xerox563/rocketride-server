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
// GRAPH-UI - WHAT A DEV-TOOL FRAME SAYS WHEN IT CANNOT REACH ITS CONTROLLER
// =============================================================================
//
// A frame reaches the server only through the sidebar (the controller). In VS
// Code the sidebar mounts on its first tab select, so a document restored at
// start-up can be on screen with no controller at all: its calls are never
// sent. It says to open the sidebar, never the name of an internal op.
// =============================================================================

import { ExplorerToolError, readErrorMessage } from 'shared/explorer';
import type { EndpointStatus } from 'shared/explorer';

/** Said when no controller is up to carry a frame's calls. */
export const CONTROLLER_NOT_READY_TEXT = 'Open the Graph Explorer sidebar to connect: this document reaches the server through it.';

/**
 * What to announce for a failure nobody awaits.
 *
 * @param error - The failure.
 * @param controllerReady - Whether a controller is up.
 * @returns The sentence, or null to say nothing (a dropped, stale call).
 */
export function frameFailureText(error: unknown, controllerReady: boolean): string | null {
	if (error instanceof ExplorerToolError && error.kind === 'stale') return null;
	if (!controllerReady && error instanceof ExplorerToolError && error.kind === 'timeout') return CONTROLLER_NOT_READY_TEXT;
	return readErrorMessage(error);
}

/**
 * Why a connection document has no connection to show.
 *
 * @param status - The controller's discovery status.
 * @param omitted - Connections the controller left out of a capped list.
 * @param controllerReady - Whether a controller is up.
 * @returns The empty state's title and description.
 */
export function missingConnectionText(status: EndpointStatus, omitted: number, controllerReady: boolean): { title: string; description: string } {
	if (!controllerReady) return { title: 'Waiting for the Graph Explorer sidebar', description: CONTROLLER_NOT_READY_TEXT };
	if (status === 'idle' || status === 'loading') return { title: 'Looking for this connection', description: 'The sidebar is finding the graph connections of your running pipelines.' };
	if (omitted > 0) {
		return {
			title: 'This connection is not listed here',
			description: `There are too many connections to send them all to this window (${omitted.toLocaleString('en-US')} left out), and this one may be among them; or its pipeline stopped. Open Connections from the sidebar.`,
		};
	}
	return { title: 'This connection is not listed', description: 'Its pipeline is not running, or it belongs to another account. Open Connections to see what is available.' };
}
