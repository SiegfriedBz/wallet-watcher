// The parts of a transaction receipt we need (viem's receipt has these fields).
export type ReceiptSummary = {
	status: "success" | "reverted";
	gasUsed: bigint;
	effectiveGasPrice: bigint;
};

export type Settlement = {
	status: "mined" | "reverted";
	feeWei: bigint;
	deltaWei: bigint;
};

// Pure: what a mined withdrawal really cost the wallet.
// Success: the amount AND the fee left the wallet.
// Reverted: the amount stayed, but the gas was still paid.
export const settleWithdrawal = (
	valueWei: bigint,
	receipt: ReceiptSummary,
): Settlement => {
	const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
	if (receipt.status === "reverted") {
		return { status: "reverted", feeWei, deltaWei: -feeWei };
	}
	return { status: "mined", feeWei, deltaWei: -(valueWei + feeWei) };
};
