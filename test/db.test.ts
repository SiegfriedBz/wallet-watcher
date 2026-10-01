import { describe, expect, it } from "vitest";
import {
	getLedger,
	getPendingWithdrawal,
	getStoredBalance,
	openDb,
	recordBalanceChange,
	recordBroadcast,
	recordSettlement,
} from "../src/db.js";
import type { LedgerType } from "../src/shared/types.js";

const ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("db", () => {
	it("has no stored balance for an unknown wallet", () => {
		const db = openDb(":memory:");
		expect(getStoredBalance(db, ADDRESS)).toBeNull();
	});

	it("updates the balance and appends ledger rows", () => {
		const db = openDb(":memory:");
		recordBalanceChange(db, {
			walletIndex: 0,
			address: ADDRESS,
			type: "initial",
			deltaWei: 500n,
			balanceWei: 500n,
		});
		recordBalanceChange(db, {
			walletIndex: 0,
			address: ADDRESS,
			type: "inflow",
			deltaWei: 300n,
			balanceWei: 800n,
		});

		expect(getStoredBalance(db, ADDRESS)).toBe(800n);
		expect(getLedger(db, ADDRESS).map((e) => [e.type, e.deltaWei])).toEqual([
			["initial", 500n],
			["inflow", 300n],
		]);
	});

	it("keeps amounts above 2^63 exact", () => {
		const db = openDb(":memory:");
		const huge = 2n ** 70n;
		recordBalanceChange(db, {
			walletIndex: 0,
			address: ADDRESS,
			type: "initial",
			deltaWei: huge,
			balanceWei: huge,
		});
		expect(getStoredBalance(db, ADDRESS)).toBe(huge);
	});

	it("writes nothing if the ledger insert fails (one transaction)", () => {
		const db = openDb(":memory:");
		recordBalanceChange(db, {
			walletIndex: 0,
			address: ADDRESS,
			type: "initial",
			deltaWei: 500n,
			balanceWei: 500n,
		});

		// The CHECK constraint rejects this type AFTER the balance was updated.
		expect(() =>
			recordBalanceChange(db, {
				walletIndex: 0,
				address: ADDRESS,
				type: "bogus" as LedgerType,
				deltaWei: 300n,
				balanceWei: 800n,
			}),
		).toThrow();

		expect(getStoredBalance(db, ADDRESS)).toBe(500n);
		expect(getLedger(db, ADDRESS)).toHaveLength(1);
	});
});

describe("withdrawals", () => {
	const TX_HASH = `0x${"ab".repeat(32)}` as const;
	const TO = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

	const setupWithPending = () => {
		const db = openDb(":memory:");
		recordBalanceChange(db, {
			walletIndex: 0,
			address: ADDRESS,
			type: "initial",
			deltaWei: 1000n,
			balanceWei: 1000n,
		});
		recordBroadcast(db, {
			txHash: TX_HASH,
			walletIndex: 0,
			address: ADDRESS,
			to: TO,
			valueWei: 100n,
		});
		return db;
	};

	it("records a broadcast as pending, without touching the ledger", () => {
		const db = setupWithPending();

		expect(getPendingWithdrawal(db, ADDRESS)).toEqual({
			txHash: TX_HASH,
			walletIndex: 0,
			address: ADDRESS,
			valueWei: 100n,
		});
		expect(getLedger(db, ADDRESS)).toHaveLength(1); // only "initial"
		expect(getStoredBalance(db, ADDRESS)).toBe(1000n);
	});

	it("at settlement: one outflow (amount + fee), new balance, no longer pending", () => {
		const db = setupWithPending();
		const pending = getPendingWithdrawal(db, ADDRESS);
		if (!pending) throw new Error("expected a pending withdrawal");

		recordSettlement(db, pending, {
			status: "mined",
			feeWei: 5n,
			deltaWei: -105n,
		});

		expect(
			getLedger(db, ADDRESS).map((e) => [e.type, e.deltaWei, e.txHash]),
		).toEqual([
			["initial", 1000n, null],
			["outflow", -105n, TX_HASH],
		]);
		expect(getStoredBalance(db, ADDRESS)).toBe(895n);
		expect(getPendingWithdrawal(db, ADDRESS)).toBeNull();
	});
});
