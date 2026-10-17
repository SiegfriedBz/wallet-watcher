import type { LedgerType } from "./shared/types.js";

export type DetectedChange = {
	type: LedgerType;
	deltaWei: bigint;
};

// Compares the stored balance with the one just read on-chain.
// Never "outflow": that type is only written at settlement, from the receipt of a
// withdrawal this service broadcast.
export const detectChange = (
	storedWei: bigint | null,
	currentWei: bigint,
): DetectedChange | null => {
	if (storedWei === null) {
		return { type: "initial", deltaWei: currentWei };
	}
	const deltaWei = currentWei - storedWei;
	if (deltaWei === 0n) {
		return null;
	}
	return { type: deltaWei > 0n ? "inflow" : "external_outflow", deltaWei };
};
