import type { DatabaseSync } from "node:sqlite";
import { detectChange } from "./balance-change.js";
import type { ChainClient } from "./chain.js";
import { getStoredBalance, recordBalanceChange } from "./db.js";
import type { Wallet } from "./shared/types.js";

// 8 minutes: any on-chain change is reflected within 10 minutes.
export const POLL_INTERVAL_MS = 8 * 60 * 1000;

type PollerDeps = {
	client: ChainClient;
	db: DatabaseSync;
	wallets: Wallet[];
};

// One round: read each wallet on-chain, record only what changed.
// An error on one wallet is logged and does not stop the others.
export const pollOnce = async ({ client, db, wallets }: PollerDeps) => {
	for (const wallet of wallets) {
		try {
			const currentWei = await client.getBalance({ address: wallet.address });
			const change = detectChange(
				getStoredBalance(db, wallet.address),
				currentWei,
			);
			if (change) {
				recordBalanceChange(db, {
					walletIndex: wallet.index,
					address: wallet.address,
					type: change.type,
					deltaWei: change.deltaWei,
					balanceWei: currentWei,
				});
				console.log(
					`[poller] wallet #${wallet.index}: ${change.type} ${change.deltaWei} wei`,
				);
			}
		} catch (error) {
			console.error(
				`[poller] wallet #${wallet.index}: ${error instanceof Error ? error.message : error}`,
			);
		}
	}
};

export type Poller = {
	stop: () => void;
	lastPolledAt: () => string | null;
};

// Polls now, then every POLL_INTERVAL_MS. The next round is scheduled only after
// the current one finishes, so two rounds never overlap.
// lastPolledAt = start of the last finished round: every balance was read after it.
export const startPoller = (deps: PollerDeps): Poller => {
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;
	let lastPolledAt: string | null = null;

	const tick = async () => {
		const startedAt = new Date().toISOString();
		await pollOnce(deps);
		lastPolledAt = startedAt;
		if (!stopped) {
			timer = setTimeout(tick, POLL_INTERVAL_MS);
		}
	};

	void tick();

	return {
		stop: () => {
			stopped = true;
			clearTimeout(timer);
		},
		lastPolledAt: () => lastPolledAt,
	};
};
