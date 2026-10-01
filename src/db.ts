import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Address, Hash } from "viem";
import type { Settlement } from "./settlement.js";
import type { LedgerType } from "./shared/types.js";

// Amounts are TEXT (decimal wei): SQLite integers stop at 2^63, wei values can be bigger.
// Rows are keyed by address, not index: if the mnemonic changes, index 0 is a different wallet.
// ledger      = what the balance did (append-only).
// withdrawals = what the service sent (pending until mined, then mined/reverted + fee).
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

CREATE TABLE IF NOT EXISTS withdrawals (
	tx_hash      TEXT PRIMARY KEY,
	address      TEXT NOT NULL,
	wallet_index INTEGER NOT NULL,
	to_address   TEXT NOT NULL,
	value_wei    TEXT NOT NULL,
	status       TEXT NOT NULL CHECK (status IN ('pending', 'mined', 'reverted')),
	fee_wei      TEXT,
	broadcast_at TEXT NOT NULL,
	settled_at   TEXT
);

CREATE INDEX IF NOT EXISTS withdrawals_address_status_idx
	ON withdrawals (address, status);
`;

export const openDb = (path: string): DatabaseSync => {
	if (path !== ":memory:") {
		mkdirSync(dirname(path), { recursive: true });
	}
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	return db;
};

// Runs fn inside one transaction: all its writes happen, or none.
const inTransaction = (db: DatabaseSync, fn: () => void): void => {
	db.exec("BEGIN");
	try {
		fn();
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
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

// The two writes of a balance change. Must run inside a transaction.
const writeBalanceChange = (
	db: DatabaseSync,
	change: BalanceChange,
	now: string,
): void => {
	db.prepare(
		`INSERT INTO balances (address, wallet_index, balance_wei, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT (address) DO UPDATE SET
			balance_wei = excluded.balance_wei,
			updated_at = excluded.updated_at`,
	).run(change.address, change.walletIndex, change.balanceWei.toString(), now);

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
};

// Writes the new balance and the ledger row together: both or neither.
export const recordBalanceChange = (
	db: DatabaseSync,
	change: BalanceChange,
): void => {
	const now = new Date().toISOString();
	inTransaction(db, () => writeBalanceChange(db, change, now));
};

export type BroadcastWithdrawal = {
	txHash: Hash;
	walletIndex: number;
	address: Address;
	to: Address;
	valueWei: bigint;
};

// At broadcast: the send is recorded as pending. The ledger is not touched:
// the balance only changes once the tx is mined.
export const recordBroadcast = (
	db: DatabaseSync,
	withdrawal: BroadcastWithdrawal,
): void => {
	db.prepare(
		`INSERT INTO withdrawals
			(tx_hash, address, wallet_index, to_address, value_wei, status, broadcast_at)
		VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
	).run(
		withdrawal.txHash,
		withdrawal.address,
		withdrawal.walletIndex,
		withdrawal.to,
		withdrawal.valueWei.toString(),
		new Date().toISOString(),
	);
};

export type PendingWithdrawal = {
	txHash: Hash;
	walletIndex: number;
	address: Address;
	valueWei: bigint;
};

type PendingWithdrawalRow = {
	tx_hash: Hash;
	wallet_index: number;
	address: Address;
	value_wei: string;
};

export const getPendingWithdrawal = (
	db: DatabaseSync,
	address: Address,
): PendingWithdrawal | null => {
	const row = db
		.prepare(
			`SELECT tx_hash, wallet_index, address, value_wei
			FROM withdrawals WHERE address = ? AND status = 'pending'`,
		)
		.get(address) as PendingWithdrawalRow | undefined;

	return row
		? {
				txHash: row.tx_hash,
				walletIndex: row.wallet_index,
				address: row.address,
				valueWei: BigInt(row.value_wei),
			}
		: null;
};

// At mining: withdrawal status + real fee, ONE ledger outflow (amount + fee), new balance.
// All three in one transaction: they can never disagree.
export const recordSettlement = (
	db: DatabaseSync,
	pending: PendingWithdrawal,
	settlement: Settlement,
): void => {
	const now = new Date().toISOString();
	inTransaction(db, () => {
		const storedWei = getStoredBalance(db, pending.address);
		if (storedWei === null) {
			throw new Error(`No stored balance for ${pending.address}`);
		}

		db.prepare(
			`UPDATE withdrawals SET status = ?, fee_wei = ?, settled_at = ?
			WHERE tx_hash = ?`,
		).run(settlement.status, settlement.feeWei.toString(), now, pending.txHash);

		writeBalanceChange(
			db,
			{
				walletIndex: pending.walletIndex,
				address: pending.address,
				type: "outflow",
				deltaWei: settlement.deltaWei,
				balanceWei: storedWei + settlement.deltaWei,
				txHash: pending.txHash,
			},
			now,
		);
	});
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
