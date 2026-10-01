import { type Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import type { WithdrawalInputs } from "./withdrawal.js";

// The only place the network is chosen.
export const CHAIN = sepolia;

// Read-only connection: no key, cannot sign or send anything.
export const createChainClient = (rpcUrl: string) =>
	createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });

export type ChainClient = ReturnType<typeof createChainClient>;

// What a withdrawal needs from the chain, read fresh just before signing.
export type WithdrawalChainInputs = Pick<
	WithdrawalInputs,
	"balanceWei" | "nonce" | "gas" | "maxFeePerGas" | "maxPriorityFeePerGas"
>;

// Gas of a plain ETH transfer: the minimum any transaction costs.
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

	// The node refuses to estimate a tx the wallet cannot afford. The funds check
	// will fail anyway, so use the minimum gas to report how much could be sent.
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
