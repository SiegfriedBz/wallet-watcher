import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { TransactionReceiptNotFoundError } from "viem";
import { detectChange } from "./balance-change.js";
import {
	type BalanceSnapshot,
	type ChainClient,
	readBalanceSnapshot,
} from "./chain.js";
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

// One Ethereum block: a node that is behind has usually caught up after that.
const SNAPSHOT_RETRY_MS = 12 * 1000;

type PollerDeps = {
	client: ChainClient;
	db: DatabaseSync;
	wallets: Wallet[];
	// Called before reading again from a node that is behind. Default: wait one block.
	wait?: () => Promise<void>;
};

export type PollResult = {
	// Were the balances read and compared this round?
	polled: boolean;
	// Highest block the stored balances rely on: the next snapshot must not be older.
	floorBlock: bigint;
};

// If the wallet has a withdrawal waiting to be mined, look for its receipt.
// Mined → one ledger outflow with the real total; returns the block it was mined in.
// Not mined yet → null, next round.
const settlePendingWithdrawal = async (
	{ client, db }: PollerDeps,
	wallet: Wallet,
): Promise<bigint | null> => {
	const pending = getPendingWithdrawal(db, wallet.address);
	if (!pending) {
		return null;
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
		return null;
	}

	const settlement = settleWithdrawal(pending.valueWei, receipt);
	recordSettlement(db, pending, settlement);
	console.log(
		`[poller] wallet #${wallet.index}: outflow ${settlement.deltaWei} wei (${settlement.status}, tx ${pending.txHash})`,
	);
	return receipt.blockNumber;
};

// Every balance in one snapshot, at or after floorBlock. An older snapshot comes from
// a node that is behind (load-balanced RPCs mix nodes): wait one block, read again.
// Still behind → null: comparing against it could undo what is already recorded.
const readSnapshotAtOrAfter = async (
	{ client, wallets, wait = () => sleep(SNAPSHOT_RETRY_MS) }: PollerDeps,
	floorBlock: bigint,
): Promise<BalanceSnapshot | null> => {
	const addresses = wallets.map((w) => w.address);
	const snapshot = await readBalanceSnapshot(client, addresses);
	if (snapshot.blockNumber >= floorBlock) {
		return snapshot;
	}
	await wait();
	const retried = await readBalanceSnapshot(client, addresses);
	return retried.blockNumber >= floorBlock ? retried : null;
};

// One round: settle mined withdrawals (one receipt each), read every balance in one
// snapshot, then compare each wallet with it. An error on one wallet is logged and does
// not stop the others; a failed or stale snapshot means no comparison this round.
export const pollOnce = async (
	deps: PollerDeps,
	floorBlock = 0n,
): Promise<PollResult> => {
	const { db, wallets } = deps;

	// A receipt just applied raises the floor: its block must be in the snapshot.
	let floor = floorBlock;
	for (const wallet of wallets) {
		try {
			const minedIn = await settlePendingWithdrawal(deps, wallet);
			if (minedIn !== null && minedIn > floor) {
				floor = minedIn;
			}
		} catch (error) {
			console.error(
				`[poller] wallet #${wallet.index}: ${safeErrorMessage(error)}`,
			);
		}
	}

	let snapshot: BalanceSnapshot | null;
	try {
		snapshot = await readSnapshotAtOrAfter(deps, floor);
	} catch (error) {
		console.error(`[poller] balances: ${safeErrorMessage(error)}`);
		return { polled: false, floorBlock: floor };
	}
	if (!snapshot) {
		console.error(
			`[poller] balances: node still behind block ${floor}, next round`,
		);
		return { polled: false, floorBlock: floor };
	}

	for (const wallet of wallets) {
		try {
			// Still pending (or broadcast during this round): no diff this round. The tx can
			// be mined at any moment, so a diff could record the drop as external_outflow and
			// the settlement would record it again. The receipt alone books the outflow.
			if (getPendingWithdrawal(db, wallet.address)) {
				continue;
			}

			const currentWei = snapshot.balances.get(wallet.address);
			if (currentWei === undefined) {
				throw new Error("missing from the balance snapshot");
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
	return { polled: true, floorBlock: snapshot.blockNumber };
};

export type Poller = {
	stop: () => void;
	lastPolledAt: () => string | null;
};

// Polls now, then every POLL_INTERVAL_MS. The next round is scheduled only after
// the current one finishes, so two rounds never overlap.
// lastPolledAt = start of the last round whose balance snapshot was used: every balance
// was read after it. floorBlock carries the newest block relied on into the next round.
export const startPoller = (deps: PollerDeps): Poller => {
	let timer: NodeJS.Timeout | undefined;
	let stopped = false;
	let lastPolledAt: string | null = null;
	let floorBlock = 0n;

	const tick = async () => {
		const startedAt = new Date().toISOString();
		const round = await pollOnce(deps, floorBlock);
		floorBlock = round.floorBlock;
		if (round.polled) {
			lastPolledAt = startedAt;
		}
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
