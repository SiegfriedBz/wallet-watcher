import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

// The only place the network is chosen.
export const CHAIN = sepolia;

// Read-only connection: no key, cannot sign or send anything.
export const createChainClient = (rpcUrl: string) =>
	createPublicClient({ chain: CHAIN, transport: http(rpcUrl) });

export type ChainClient = ReturnType<typeof createChainClient>;
