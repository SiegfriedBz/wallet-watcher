import { BaseError } from "viem";

// viem's full error message includes the RPC URL, and providers like Alchemy put the
// API key in that URL. Log viem's short message only: never the URL, never the key.
export const safeErrorMessage = (error: unknown): string => {
	if (error instanceof BaseError) {
		return error.shortMessage;
	}
	return error instanceof Error ? error.message : String(error);
};
