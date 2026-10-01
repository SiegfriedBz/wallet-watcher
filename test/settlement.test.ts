import { describe, expect, it } from "vitest";
import { settleWithdrawal } from "../src/settlement.js";

const GWEI = 10n ** 9n;
const VALUE = 500000000000000n; // 0.0005 ETH
const FEE = 21000n * 2n * GWEI; // 21,000 gas at an effective 2 gwei

describe("settleWithdrawal", () => {
	it("charges amount + real fee for a successful tx", () => {
		expect(
			settleWithdrawal(VALUE, {
				status: "success",
				gasUsed: 21000n,
				effectiveGasPrice: 2n * GWEI,
			}),
		).toEqual({ status: "mined", feeWei: FEE, deltaWei: -(VALUE + FEE) });
	});

	it("charges only the fee for a reverted tx (the amount never left)", () => {
		expect(
			settleWithdrawal(VALUE, {
				status: "reverted",
				gasUsed: 21000n,
				effectiveGasPrice: 2n * GWEI,
			}),
		).toEqual({ status: "reverted", feeWei: FEE, deltaWei: -FEE });
	});
});
