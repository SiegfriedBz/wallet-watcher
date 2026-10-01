import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

// Read-only connection to Sepolia: no key, cannot sign or send anything.
export const createChainClient = (rpcUrl: string) =>
	createPublicClient({ chain: sepolia, transport: http(rpcUrl) });

export type ChainClient = ReturnType<typeof createChainClient>;
