import type { DatabaseSync } from "node:sqlite";
import { TransactionReceiptNotFoundError } from "viem";
import { detectChange } from "./balance-change.js";
import type { ChainClient } from "./chain.js";
import {
	getPendingWithdrawal,
	getStoredBalance,
	recordBalanceChange,
	recordSettlement,
} from "./db.js";
import { settleWithdrawal } from "./settlement.js";
import { safeErrorMessage } from "./shared/errors.js";
import type { Wallet } from "./shared/types.js";

// 8 minutes: any on-chain change is reflected within 10 minutes.
export const POLL_INTERVAL_MS = 8 * 60 * 1000;

type PollerDeps = {
	client: ChainClient;
	db: DatabaseSync;
	wallets: Wallet[];
};

// If the wallet has a withdrawal waiting to be mined, look for its receipt.
// Mined → one ledger outflow with the real total. Not mined yet → next round.
const settlePendingWithdrawal = async (
	{ client, db }: PollerDeps,
	wallet: Wallet,
): Promise<void> => {
	const pending = getPendingWithdrawal(db, wallet.address);
	if (!pending) {
		return;
	}

	const receipt = await client
		.getTransactionReceipt({ hash: pending.txHash })
		.catch((error) => {
			if (error instanceof TransactionReceiptNotFoundError) {
				return null; // not mined yet: normal
			}
			throw error; // real RPC error: logged by pollOnce
		});
	if (!receipt) {
		return;
	}

	const settlement = settleWithdrawal(pending.valueWei, receipt);
	recordSettlement(db, pending, settlement);
	console.log(
		`[poller] wallet #${wallet.index}: outflow ${settlement.deltaWei} wei (${settlement.status}, tx ${pending.txHash})`,
	);
};

// One round, per wallet: settle a pending withdrawal first, then compare balances.
// An error on one wallet is logged and does not stop the others.
export const pollOnce = async (deps: PollerDeps) => {
	const { client, db, wallets } = deps;
	for (const wallet of wallets) {
		try {
			await settlePendingWithdrawal(deps, wallet);

			const currentWei = await client.getBalance({ address: wallet.address });

			// Still pending (or broadcast during the await above): the chain may not show
			// the withdrawal yet, so comparing now would record a fake inflow. Next round.
			if (getPendingWithdrawal(db, wallet.address)) {
				continue;
			}

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
				`[poller] wallet #${wallet.index}: ${safeErrorMessage(error)}`,
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
