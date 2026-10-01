import { validateMnemonic } from "@scure/bip39";
import { english } from "viem/accounts";
import { z } from "zod";

export const MIN_WALLETS = 1;
export const MAX_WALLETS = 20;

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
