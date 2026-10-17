import { validateMnemonic } from "@scure/bip39";
import { getAddress, isAddress, parseEther, zeroAddress } from "viem";
import { english } from "viem/accounts";
import { z } from "zod";
import type { Wallet } from "./types.js";

export const MIN_WALLETS = 1;
export const MAX_WALLETS = 20;

// Checks the words AND the checksum (last word), so a typo is caught at startup
// instead of silently deriving the wrong wallets.
export const MnemonicSchema = z
	.string()
	.trim()
	.refine((m) => validateMnemonic(m, english), {
		error: "Mnemonic is not a valid BIP-39 phrase (check for typos)",
	});

export const WalletCountSchema = z
	.number({ error: "Wallet count must be a number" })
	.int({ error: "Wallet count must be a whole number" })
	.min(MIN_WALLETS, { error: `Wallet count must be at least ${MIN_WALLETS}` })
	.max(MAX_WALLETS, { error: `Wallet count must be at most ${MAX_WALLETS}` });

// Digits, optionally a dot and 1 to 18 decimals (1 wei = 0.000000000000000001 ETH).
// No sign, no exponent, no leading or trailing dot: parseEther never has to round.
const ETH_AMOUNT = /^\d+(\.\d{1,18})?$/;

// Validates an ETH amount as text. Stays a string here: conversion to wei
// happens once, in createWithdrawalRequestSchema, with parseEther.
export const AmountEthSchema = z
	.string({ error: 'Amount must be a string, e.g. "0.01"' })
	.regex(ETH_AMOUNT, {
		error: 'Amount must be in ETH with at most 18 decimals, e.g. "0.01"',
		abort: true,
	})
	// Runs only if the regex passed (abort: true), so parseEther never sees bad input.
	.refine((value) => parseEther(value) > 0n, {
		error: "Amount must be greater than 0",
	});

// Accepts lowercase or correctly checksummed addresses; mixed case with a wrong
// checksum is rejected (likely a typo). Output is always the checksummed form.
export const AddressSchema = z
	.string({ error: "Address must be a string" })
	.refine((value) => isAddress(value), { error: "Invalid Ethereum address" })
	.transform((value) => getAddress(value));

// Built at startup from the watched wallets: only they (0..N-1) can send.
// Strict: unknown fields are rejected instead of silently ignored.
export const createWithdrawalRequestSchema = (wallets: Wallet[]) =>
	z
		.strictObject({
			fromIndex: z
				.number({ error: "fromIndex must be a number" })
				.int({ error: "fromIndex must be a whole number" })
				.min(0, { error: "fromIndex must be at least 0" })
				.max(wallets.length - 1, {
					error: `fromIndex must be at most ${wallets.length - 1} (watched wallets only)`,
				}),
			to: AddressSchema.refine((address) => address !== zeroAddress, {
				error: "Cannot send to the zero address (funds would be burned)",
			}),
			amountEth: AmountEthSchema,
			// Optional: false (default) = build and sign only; true = also send it.
			broadcast: z
				.boolean({ error: "broadcast must be true or false" })
				.default(false),
		})
		// Sending to itself would only burn the fee, and book an outflow + inflow pair.
		.refine(
			({ fromIndex, to }) => {
				const from = wallets.find((w) => w.index === fromIndex)?.address;
				return from?.toLowerCase() !== to.toLowerCase();
			},
			{ error: "Cannot send to the sending wallet", path: ["to"] },
		)
		// The only place the ETH text becomes wei: exact, string → bigint.
		.transform(({ fromIndex, to, amountEth, broadcast }) => ({
			fromIndex,
			to,
			amountWei: parseEther(amountEth),
			broadcast,
		}));

export type WithdrawalRequest = z.infer<
	ReturnType<typeof createWithdrawalRequestSchema>
>;
