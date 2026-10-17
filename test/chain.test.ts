import { describe, expect, it, vi } from "vitest";
import {
	assertExpectedChain,
	CHAIN,
	type ChainClient,
	readBalanceSnapshot,
} from "../src/chain.js";

// Public Hardhat test addresses #0 and #1.
const ADDRESS_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADDRESS_B = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

type MulticallArgs = {
	allowFailure: boolean;
	batchSize: number;
	contracts: { address: string; functionName: string; args?: unknown[] }[];
};

// Fake client: answers like Multicall3, [block number, then one balance per address].
const fakeMulticall = (answer: bigint[]) => {
	const multicall = vi.fn(async (_args: MulticallArgs) => answer);
	const client = { multicall } as unknown as Pick<ChainClient, "multicall">;
	return { multicall, client };
};

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

describe("readBalanceSnapshot", () => {
	it("reads the block number and every balance in ONE Multicall3 call", async () => {
		const { multicall, client } = fakeMulticall([100n, 1n, 2n]);

		const snapshot = await readBalanceSnapshot(client, [ADDRESS_A, ADDRESS_B]);

		expect(snapshot).toEqual({
			blockNumber: 100n,
			balances: new Map([
				[ADDRESS_A, 1n],
				[ADDRESS_B, 2n],
			]),
		});
		expect(multicall).toHaveBeenCalledTimes(1);
		const args = multicall.mock.calls[0]?.[0];
		// Never split into several eth_calls (they could reach different nodes), and
		// never a silent failure (a missing balance must not become 0).
		expect(args).toMatchObject({ batchSize: 0, allowFailure: false });
		const multicall3 = CHAIN.contracts.multicall3.address;
		expect(
			args?.contracts.map((c) => [c.address, c.functionName, c.args]),
		).toEqual([
			[multicall3, "getBlockNumber", undefined],
			[multicall3, "getEthBalance", [ADDRESS_A]],
			[multicall3, "getEthBalance", [ADDRESS_B]],
		]);
	});

	it("fails if a balance is missing from the answer", async () => {
		const { client } = fakeMulticall([100n, 1n]);
		await expect(
			readBalanceSnapshot(client, [ADDRESS_A, ADDRESS_B]),
		).rejects.toThrow(/no balance for/);
	});
});
