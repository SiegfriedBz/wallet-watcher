import type { Address } from "viem";

export type Wallet = {
	index: number;
	address: Address;
};

// Why a ledger row exists. "outflow" is only written when the service broadcasts.
export type LedgerType = "initial" | "inflow" | "outflow" | "external_outflow";
