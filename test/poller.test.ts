import { type Hash, TransactionReceiptNotFoundError } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { ChainClient } from "../src/chain.js";
import {
	getLedger,
	getPendingWithdrawal,
	getStoredBalance,
	openDb,
	recordBalanceChange,
	recordBroadcast,
} from "../src/db.js";
import { pollOnce } from "../src/poller.js";
import type { Wallet } from "../src/shared/types.js";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TX_HASH: Hash = `0x${"ab".repeat(32)}`;
const WALLETS: Wallet[] = [{ index: 0, address: ADDRESS }];

const ETH = 10n ** 18n;
const VALUE = ETH / 10n; // 0.1 ETH sent
const FEE = 21000n * 1_000_000_000n; // real fee: 21,000 gas at 1 gwei
const MINED_IN = 100n; // the block the withdrawal is mined in

type ChainState = {
	balanceWei: bigint;
	mined: boolean; // has the withdrawal been mined (in block MINED_IN)?
	blockNumber?: bigint; // block the node answers from (default: MINED_IN)
};

// Fake chain: only the two reads the poller makes, from the state at call time.
// multicall answers like Multicall3: [block number, then one balance per wallet].
const fakeClient = (chain: ChainState) =>
	({
		multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => [
			chain.blockNumber ?? MINED_IN,
			...contracts.slice(1).map(() => chain.balanceWei),
		]),
		getTransactionReceipt: vi.fn(async () => {
			if (!chain.mined) {
				throw new TransactionReceiptNotFoundError({ hash: TX_HASH });
			}
			return {
				status: "success",
				blockNumber: MINED_IN,
				gasUsed: 21000n,
				effectiveGasPrice: 1_000_000_000n,
			};
		}),
	}) as unknown as ChainClient;

// Wallet #0: 1 ETH stored, then a 0.1 ETH withdrawal broadcast (pending).
const setupWithPending = () => {
	const db = openDb(":memory:");
	recordBalanceChange(db, {
		walletIndex: 0,
		address: ADDRESS,
		type: "initial",
		deltaWei: ETH,
		balanceWei: ETH,
	});
	recordBroadcast(db, {
		txHash: TX_HASH,
		walletIndex: 0,
		address: ADDRESS,
		to: TO,
		valueWei: VALUE,
	});
	return db;
};

const ledgerTypes = (db: ReturnType<typeof openDb>) =>
	getLedger(db, ADDRESS).map((e) => [e.type, e.deltaWei]);

describe("pollOnce", () => {
	it("records the first reading as initial", async () => {
		const db = openDb(":memory:");
		await pollOnce({
			client: fakeClient({ balanceWei: ETH, mined: false }),
			db,
			wallets: WALLETS,
		});

		expect(ledgerTypes(db)).toEqual([["initial", ETH]]);
	});

	it("records nothing while a withdrawal is pending (not mined yet)", async () => {
		const db = setupWithPending();
		const chain = { balanceWei: ETH, mined: false }; // chain does not show the tx yet

		await pollOnce({ client: fakeClient(chain), db, wallets: WALLETS });

		expect(ledgerTypes(db)).toEqual([["initial", ETH]]);
		expect(getPendingWithdrawal(db, ADDRESS)).not.toBeNull();
	});

	it("once mined: ONE outflow (amount + real fee), no double count", async () => {
		const db = setupWithPending();
		const chain = { balanceWei: ETH - VALUE - FEE, mined: true };

		await pollOnce({ client: fakeClient(chain), db, wallets: WALLETS });

		expect(ledgerTypes(db)).toEqual([
			["initial", ETH],
			["outflow", -(VALUE + FEE)],
		]);
		expect(getStoredBalance(db, ADDRESS)).toBe(ETH - VALUE - FEE);
		expect(getPendingWithdrawal(db, ADDRESS)).toBeNull();

		// A second round changes nothing: stored balance = chain balance.
		await pollOnce({ client: fakeClient(chain), db, wallets: WALLETS });
		expect(ledgerTypes(db)).toHaveLength(2);
	});

	it("a deposit during the pending period is recorded after settlement", async () => {
		const db = setupWithPending();
		const deposit = ETH / 2n;

		// Round 1: deposit arrived, withdrawal not mined → nothing recorded.
		await pollOnce({
			client: fakeClient({ balanceWei: ETH + deposit, mined: false }),
			db,
			wallets: WALLETS,
		});
		expect(ledgerTypes(db)).toHaveLength(1);

		// Round 2: mined → outflow, then the remaining difference is the deposit.
		await pollOnce({
			client: fakeClient({
				balanceWei: ETH + deposit - VALUE - FEE,
				mined: true,
			}),
			db,
			wallets: WALLETS,
		});
		expect(ledgerTypes(db)).toEqual([
			["initial", ETH],
			["outflow", -(VALUE + FEE)],
			["inflow", deposit],
		]);
	});

	it("a node behind the receipt's block: waits, reads again, no false inflow", async () => {
		const db = setupWithPending();
		// The receipt says block 100, but the balance read reaches a node still at
		// block 99, which does not show the withdrawal yet.
		const chain = { balanceWei: ETH, mined: true, blockNumber: MINED_IN - 1n };
		const client = fakeClient(chain);

		const round = await pollOnce({
			client,
			db,
			wallets: WALLETS,
			// While the poller waits, the node catches up.
			wait: async () => {
				chain.blockNumber = MINED_IN;
				chain.balanceWei = ETH - VALUE - FEE;
			},
		});

		expect(round).toEqual({ polled: true, floorBlock: MINED_IN });
		expect(client.multicall).toHaveBeenCalledTimes(2);
		expect(ledgerTypes(db)).toEqual([
			["initial", ETH],
			["outflow", -(VALUE + FEE)],
		]);
	});

	it("a node still behind after the wait: no comparison until it catches up", async () => {
		const db = setupWithPending();
		const chain = { balanceWei: ETH, mined: true, blockNumber: MINED_IN - 1n };

		const round1 = await pollOnce({
			client: fakeClient(chain),
			db,
			wallets: WALLETS,
			wait: () => Promise.resolve(),
		});

		// Settled from the receipt; the stale balance is never compared.
		expect(round1).toEqual({ polled: false, floorBlock: MINED_IN });
		expect(ledgerTypes(db)).toEqual([
			["initial", ETH],
			["outflow", -(VALUE + FEE)],
		]);

		// Next round, the node has caught up: nothing more to record.
		chain.blockNumber = MINED_IN;
		chain.balanceWei = ETH - VALUE - FEE;
		const round2 = await pollOnce(
			{ client: fakeClient(chain), db, wallets: WALLETS },
			round1.floorBlock,
		);
		expect(round2.polled).toBe(true);
		expect(ledgerTypes(db)).toHaveLength(2);
	});

	it("never compares against a block older than the previous round's", async () => {
		const db = openDb(":memory:");
		const round1 = await pollOnce({
			client: fakeClient({ balanceWei: ETH, mined: false, blockNumber: 200n }),
			db,
			wallets: WALLETS,
		});

		// A node stuck at block 150 still shows the balance from before round 1.
		const round2 = await pollOnce(
			{
				client: fakeClient({ balanceWei: 0n, mined: false, blockNumber: 150n }),
				db,
				wallets: WALLETS,
				wait: () => Promise.resolve(),
			},
			round1.floorBlock,
		);

		expect(round2).toEqual({ polled: false, floorBlock: 200n });
		expect(ledgerTypes(db)).toEqual([["initial", ETH]]);
	});

	it("a failed balance read records nothing and is not a completed round", async () => {
		const db = openDb(":memory:");
		const client = {
			multicall: vi.fn(async () => {
				throw new Error("RPC unavailable");
			}),
			getTransactionReceipt: vi.fn(),
		} as unknown as ChainClient;

		const round = await pollOnce({ client, db, wallets: WALLETS });

		expect(round.polled).toBe(false);
		expect(ledgerTypes(db)).toEqual([]);
	});
});
