import {
	type Address,
	type ContractFunctionParameters,
	createPublicClient,
	http,
	parseAbi,
} from "viem";
import { sepolia } from "viem/chains";
import type { WithdrawalInputs } from "./withdrawal.js";

// The only place the network is chosen.
export const CHAIN = sepolia;

// No account, no key: this client cannot sign. It reads the chain, and relays
// transactions already signed by signer.ts.
export const createChainClient = (rpcUrl: string) =>
	createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });

export type ChainClient = ReturnType<typeof createChainClient>;

// The two Multicall3 helpers the poller reads (viem's bundled ABI has no getBlockNumber).
const multicall3Abi = parseAbi([
	"function getBlockNumber() view returns (uint256)",
	"function getEthBalance(address addr) view returns (uint256)",
]);

export type BalanceSnapshot = {
	blockNumber: bigint;
	balances: Map<Address, bigint>;
};

// Every balance in ONE eth_call through the Multicall3 contract: one node, one block,
// and that block's number. Behind a load-balanced RPC, separate calls can reach nodes
// a block apart; the block number tells the poller which state it actually read.
export const readBalanceSnapshot = async (
	client: Pick<ChainClient, "multicall">,
	addresses: Address[],
): Promise<BalanceSnapshot> => {
	const multicall3 = CHAIN.contracts.multicall3.address;
	const calls: ContractFunctionParameters<typeof multicall3Abi>[] = [
		{ address: multicall3, abi: multicall3Abi, functionName: "getBlockNumber" },
		...addresses.map((address) => ({
			address: multicall3,
			abi: multicall3Abi,
			functionName: "getEthBalance" as const,
			args: [address] as const,
		})),
	];
	const [blockNumber, ...results] = await client.multicall({
		allowFailure: false, // a missing balance fails the read, never defaults to 0
		batchSize: 0, // never split into several eth_calls: the snapshot must be atomic
		contracts: calls,
	});
	if (blockNumber === undefined) {
		throw new Error("Multicall3 returned no block number");
	}

	const balances = new Map<Address, bigint>();
	for (const [i, address] of addresses.entries()) {
		const balance = results[i];
		if (balance === undefined) {
			throw new Error(`Multicall3 returned no balance for ${address}`);
		}
		balances.set(address, balance);
	}
	return { blockNumber, balances };
};

// What a withdrawal needs from the chain, read fresh just before signing.
export type WithdrawalChainInputs = Pick<
	WithdrawalInputs,
	"balanceWei" | "nonce" | "gas" | "maxFeePerGas" | "maxPriorityFeePerGas"
>;

// Gas of a plain ETH transfer to an existing account: the least a withdrawal costs.
const TRANSFER_GAS = 21000n;

export const readWithdrawalInputs = async (
	client: ChainClient,
	{ from, to, amountWei }: { from: Address; to: Address; amountWei: bigint },
): Promise<WithdrawalChainInputs> => {
	const [balanceWei, nonce, fees] = await Promise.all([
		client.getBalance({ address: from }),
		// "pending" counts txs already sent but not mined yet, so the nonce is not reused.
		client.getTransactionCount({ address: from, blockTag: "pending" }),
		client.estimateFeesPerGas(),
	]);

	// The node can refuse to estimate a transfer of the whole balance or more. The funds
	// check fails anyway, so use the minimum gas to report the most that could be sent
	// (a never-used recipient costs far more: 204,600 gas on Sepolia since Glamsterdam).
	const gas =
		amountWei >= balanceWei
			? TRANSFER_GAS
			: await client.estimateGas({ account: from, to, value: amountWei });

	return {
		balanceWei,
		nonce,
		gas,
		maxFeePerGas: fees.maxFeePerGas,
		maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
	};
};

// Testnet only: refuse an RPC_URL that points to another network (e.g. mainnet).
// eth_chainId asks the node itself, so a wrong URL is caught before anything runs.
export const assertExpectedChain = async (
	client: Pick<ChainClient, "getChainId">,
): Promise<void> => {
	const rpcChainId = await client.getChainId();
	if (rpcChainId !== CHAIN.id) {
		throw new Error(
			`RPC_URL points to chain ${rpcChainId}, expected ${CHAIN.name} (${CHAIN.id}). Testnet only: refusing to start.`,
		);
	}
};
