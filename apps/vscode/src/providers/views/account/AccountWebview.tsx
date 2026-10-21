// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * AccountWebview — the Account framework page as a shell bus realm.
 *
 * The page IS the shell's own AccountProvider (the same component the cloud
 * overlay renders), running socketless: every engine call rides the brokered
 * `client.account.*` / `client.billing.*` bus ops and connection/account
 * state arrives on the mirror feed. This file adds only the host-specific
 * seams the shell cannot own:
 *
 *   - the bus-realm attachment (module scope, once),
 *   - the mirrored prefs store (the `shell` partition) so
 *     DataGrid layouts persist exactly as in the web shell,
 *   - the Stripe publishable key (host-probed via `host.stripeKey`),
 *   - the subscribe entry point: `shell:subscribe` toward the mounted
 *     CheckoutFlow, or the unavailable notice when the server has no key.
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { AccountProvider, CheckoutFlow, ConnectionManager, createMirroredPrefsStore, useGridConfigAnswering } from 'shell';
import { SHELL_PARTITION } from 'shell/src/workspace/workspaceStore';
import type { ConnectResult } from 'rocketride';
import { attachBusRealm } from '../hooks/busRealm';
import { CheckoutUnavailableNotice } from '../components/CheckoutUnavailableNotice';
import type { StripeKeyReason as StripeKeyUnavailableReason } from 'shared/ops/hostOps';

attachBusRealm();

/** The one subscribable app this host offers (same identity the old page
 *  hardcoded into its CheckoutModal). */
const PIPE_BUILDER_APP = {
	id: 'rocketride.pipeBuilder',
	name: 'Pipe Builder',
	description: 'Visual AI pipeline editor: run and deploy pipelines on RocketRide Cloud.',
};

/**
 * VS Code webview entry point for the Account page.
 */
const AccountWebview: React.FC = () => {
	const cm = ConnectionManager.getInstance();

	// ── Prefs: the SHELL partition, mirrored off the workspace manager.
	//    This is a framework page, so its grid layouts are shell chrome state;
	//    reads are synchronous off the mirror, which is what DataGrid
	//    persistence needs.
	const prefs = useMemo(() => createMirroredPrefsStore(cm, SHELL_PARTITION), [cm]);
	useGridConfigAnswering(prefs.store);
	useEffect(() => prefs.dispose, [prefs]);

	// ── Stripe key (host-probed; matches the CONNECTED server's account).
	const [stripe, setStripe] = useState<{ key: string | null; reason?: StripeKeyUnavailableReason } | null>(null);
	useEffect(() => {
		void cm.request('host.stripeKey', {}).then(
			(r) => setStripe(r as { key: string | null; reason?: StripeKeyUnavailableReason }),
			() => setStripe({ key: null, reason: 'probe-failed' })
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// ── orgId for CheckoutFlow — mirrored account info.
	const [account, setAccount] = useState<ConnectResult | null>(() => cm.getAccountInfo() ?? null);
	useEffect(() => cm.on('shell:accountUpdate', (data) => setAccount(data)), [cm]);
	const orgId = account?.organization?.id ?? '';

	// ── Subscribe entry point: hand off to CheckoutFlow, or explain why not.
	const [showUnavailable, setShowUnavailable] = useState(false);
	const handleSubscribe = useCallback(() => {
		if (!stripe?.key) {
			setShowUnavailable(true);
			return;
		}
		cm.emit('shell:subscribe', { app: PIPE_BUILDER_APP } as never);
	}, [cm, stripe]);

	return (
		<>
			<AccountProvider onSubscribe={handleSubscribe} />
			<CheckoutFlow stripeKey={stripe?.key ?? ''} orgId={orgId} />
			{showUnavailable && <CheckoutUnavailableNotice reason={stripe?.reason} onClose={() => setShowUnavailable(false)} />}
		</>
	);
};

export default AccountWebview;
