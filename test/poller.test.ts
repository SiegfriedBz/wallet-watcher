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

type ChainState = {
	balanceWei: bigint;
	mined: boolean; // has the withdrawal been mined?
};

// Fake chain: only the two methods the poller uses.
const fakeClient = (chain: ChainState) =>
	({
		getBalance: vi.fn(async () => chain.balanceWei),
		getTransactionReceipt: vi.fn(async () => {
			if (!chain.mined) {
				throw new TransactionReceiptNotFoundError({ hash: TX_HASH });
			}
			return {
				status: "success",
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
});
