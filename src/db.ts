import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Address, Hash } from "viem";
import type { LedgerType } from "./shared/types.js";

// Amounts are TEXT (decimal wei): SQLite integers stop at 2^63, wei values can be bigger.
// Rows are keyed by address, not index: if the mnemonic changes, index 0 is a different wallet.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS balances (
	address      TEXT PRIMARY KEY,
	wallet_index INTEGER NOT NULL,
	balance_wei  TEXT NOT NULL,
	updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger (
	id                INTEGER PRIMARY KEY AUTOINCREMENT,
	address           TEXT NOT NULL,
	wallet_index      INTEGER NOT NULL,
	type              TEXT NOT NULL
		CHECK (type IN ('initial', 'inflow', 'outflow', 'external_outflow')),
	delta_wei         TEXT NOT NULL,
	balance_after_wei TEXT NOT NULL,
	tx_hash           TEXT,
	created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ledger_address_idx ON ledger (address, id);
`;

export const openDb = (path: string): DatabaseSync => {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	return db;
};

export const getStoredBalance = (
	db: DatabaseSync,
	address: Address,
): bigint | null => {
	const row = db
		.prepare("SELECT balance_wei FROM balances WHERE address = ?")
		.get(address) as { balance_wei: string } | undefined;
	return row ? BigInt(row.balance_wei) : null;
};

export type BalanceChange = {
	walletIndex: number;
	address: Address;
	type: LedgerType;
	deltaWei: bigint;
	balanceWei: bigint;
	txHash?: Hash;
};

// Writes the new balance and the ledger row together: both or neither.
export const recordBalanceChange = (
	db: DatabaseSync,
	change: BalanceChange,
): void => {
	const now = new Date().toISOString();
	db.exec("BEGIN");
	try {
		db.prepare(
			`INSERT INTO balances (address, wallet_index, balance_wei, updated_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (address) DO UPDATE SET
				balance_wei = excluded.balance_wei,
				updated_at = excluded.updated_at`,
		).run(
			change.address,
			change.walletIndex,
			change.balanceWei.toString(),
			now,
		);

		db.prepare(
			`INSERT INTO ledger
				(address, wallet_index, type, delta_wei, balance_after_wei, tx_hash, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(
			change.address,
			change.walletIndex,
			change.type,
			change.deltaWei.toString(),
			change.balanceWei.toString(),
			change.txHash ?? null,
			now,
		);
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
};

export type LedgerRow = {
	type: LedgerType;
	delta_wei: string;
	balance_after_wei: string;
	tx_hash: string | null;
	created_at: string;
};

export const getLedger = (db: DatabaseSync, address: Address): LedgerRow[] =>
	db
		.prepare(
			`SELECT type, delta_wei, balance_after_wei, tx_hash, created_at
			FROM ledger WHERE address = ? ORDER BY id`,
		)
		.all(address) as LedgerRow[];
