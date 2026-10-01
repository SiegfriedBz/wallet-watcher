import { describe, expect, it } from "vitest";
import {
	getLedger,
	getStoredBalance,
	openDb,
	recordBalanceChange,
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
