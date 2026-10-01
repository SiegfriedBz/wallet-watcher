import type { Address, TransactionSerializableEIP1559 } from "viem";

// Everything read from the chain (balance, nonce, gas, fees) plus the request.
export type WithdrawalInputs = {
	chainId: number;
	to: Address;
	amountWei: bigint;
	balanceWei: bigint;
	nonce: number;
	gas: bigint;
	maxFeePerGas: bigint;
	maxPriorityFeePerGas: bigint;
};

export type WithdrawalPlan =
	| { ok: true; tx: TransactionSerializableEIP1559; maxFeeWei: bigint }
	| {
			ok: false;
			reason: "insufficient_funds";
			balanceWei: bigint;
			maxFeeWei: bigint;
			maxSendableWei: bigint;
	  };

// Pure: no network, no key. Checks the wallet can pay, then builds the unsigned tx.
// Worst-case fee = all the gas at the highest price this tx allows (maxFeePerGas).
// The real fee is usually lower, but checking the worst case means the network
// cannot reject the tx for lack of funds.
export const planWithdrawal = (input: WithdrawalInputs): WithdrawalPlan => {
	const maxFeeWei = input.gas * input.maxFeePerGas;

	if (input.balanceWei < input.amountWei + maxFeeWei) {
		const maxSendableWei =
			input.balanceWei > maxFeeWei ? input.balanceWei - maxFeeWei : 0n;
		return {
			ok: false,
			reason: "insufficient_funds",
			balanceWei: input.balanceWei,
			maxFeeWei,
			maxSendableWei,
		};
	}

	return {
		ok: true,
		maxFeeWei,
		tx: {
			type: "eip1559",
			chainId: input.chainId,
			to: input.to,
			value: input.amountWei,
			nonce: input.nonce,
			gas: input.gas,
			maxFeePerGas: input.maxFeePerGas,
			maxPriorityFeePerGas: input.maxPriorityFeePerGas,
		},
	};
};
