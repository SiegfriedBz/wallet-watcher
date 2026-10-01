import { describe, expect, it } from "vitest";
import { assertExpectedChain } from "../src/chain.js";

describe("assertExpectedChain", () => {
	it("accepts an RPC on Sepolia", async () => {
		const client = { getChainId: async () => 11155111 };
		await expect(assertExpectedChain(client)).resolves.toBeUndefined();
	});

	it("refuses an RPC on another network (mainnet)", async () => {
		const client = { getChainId: async () => 1 };
		await expect(assertExpectedChain(client)).rejects.toThrow(
			/chain 1, expected Sepolia \(11155111\)/,
		);
	});
});
