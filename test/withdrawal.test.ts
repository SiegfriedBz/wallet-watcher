import { describe, expect, it } from "vitest";
import { planWithdrawal } from "../src/withdrawal.js";

const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;

// Fixed chain values: 21,000 gas at max 30 gwei → worst-case fee 0.00063 ETH.
const BASE = {
	chainId: 11155111,
	to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
	nonce: 7,
	gas: 21000n,
	maxFeePerGas: 30n * GWEI,
	maxPriorityFeePerGas: 2n * GWEI,
} as const;
const MAX_FEE = 21000n * 30n * GWEI;

describe("planWithdrawal", () => {
	it("builds an EIP-1559 tx when the balance covers amount + worst-case fee", () => {
		const plan = planWithdrawal({
			...BASE,
			balanceWei: ETH,
			amountWei: ETH / 2n,
		});

		expect(plan).toEqual({
			ok: true,
			maxFeeWei: MAX_FEE,
			tx: {
				type: "eip1559",
				chainId: 11155111,
				to: BASE.to,
				value: ETH / 2n,
				nonce: 7,
				gas: 21000n,
				maxFeePerGas: 30n * GWEI,
				maxPriorityFeePerGas: 2n * GWEI,
			},
		});
	});

	it("refuses to send the whole balance: the fee comes on top (0.1 ETH trap)", () => {
		const tenth = ETH / 10n;
		const plan = planWithdrawal({
			...BASE,
			balanceWei: tenth,
			amountWei: tenth,
		});

		expect(plan).toEqual({
			ok: false,
			reason: "insufficient_funds",
			balanceWei: tenth,
			maxFeeWei: MAX_FEE,
			maxSendableWei: tenth - MAX_FEE,
		});
	});

	it("accepts exactly the max sendable amount", () => {
		const balance = ETH / 10n;
		const plan = planWithdrawal({
			...BASE,
			balanceWei: balance,
			amountWei: balance - MAX_FEE,
		});
		expect(plan.ok).toBe(true);
	});

	it("refuses one wei more than the max sendable amount", () => {
		const balance = ETH / 10n;
		const plan = planWithdrawal({
			...BASE,
			balanceWei: balance,
			amountWei: balance - MAX_FEE + 1n,
		});
		expect(plan.ok).toBe(false);
	});

	it("reports 0 sendable when the balance cannot even pay the fee", () => {
		const plan = planWithdrawal({
			...BASE,
			balanceWei: MAX_FEE - 1n,
			amountWei: 1n,
		});
		expect(plan).toMatchObject({ ok: false, maxSendableWei: 0n });
	});

	it("computes the worst-case fee as gas × maxFeePerGas", () => {
		const plan = planWithdrawal({
			...BASE,
			gas: 50000n,
			balanceWei: ETH,
			amountWei: 1n,
		});
		expect(plan.maxFeeWei).toBe(50000n * 30n * GWEI);
	});
});
