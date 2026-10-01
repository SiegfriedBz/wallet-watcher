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

// Raw rows as SQLite returns them: snake_case, amounts as text.
// Not exported: the rest of the code only sees the app types below.
type LedgerRow = {
	type: LedgerType;
	delta_wei: string;
	balance_after_wei: string;
	tx_hash: Hash | null;
	created_at: string;
};

type BalanceRow = {
	address: Address;
	balance_wei: string;
	updated_at: string;
};

export type LedgerEntry = {
	type: LedgerType;
	deltaWei: bigint;
	balanceAfterWei: bigint;
	txHash: Hash | null;
	createdAt: string;
};

export type StoredBalance = {
	address: Address;
	balanceWei: bigint;
	updatedAt: string;
};

export const getLedger = (
	db: DatabaseSync,
	address: Address,
): LedgerEntry[] => {
	const rows = db
		.prepare(
			`SELECT type, delta_wei, balance_after_wei, tx_hash, created_at
			FROM ledger WHERE address = ? ORDER BY id`,
		)
		.all(address) as LedgerRow[];

	return rows.map((row) => ({
		type: row.type,
		deltaWei: BigInt(row.delta_wei),
		balanceAfterWei: BigInt(row.balance_after_wei),
		txHash: row.tx_hash,
		createdAt: row.created_at,
	}));
};

export const getBalances = (db: DatabaseSync): StoredBalance[] => {
	const rows = db
		.prepare("SELECT address, balance_wei, updated_at FROM balances")
		.all() as BalanceRow[];

	return rows.map((row) => ({
		address: row.address,
		balanceWei: BigInt(row.balance_wei),
		updatedAt: row.updated_at,
	}));
};
