import type { Address } from "viem";

export type Wallet = {
	index: number;
	address: Address;
};

// Why a ledger row exists. "outflow" is only written for a withdrawal the service
// broadcast, once the poller finds its receipt.
export type LedgerType = "initial" | "inflow" | "outflow" | "external_outflow";
