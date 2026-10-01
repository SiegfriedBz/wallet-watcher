import { mnemonicToAccount } from "viem/accounts";
import { MnemonicSchema, WalletCountSchema } from "./shared/schemas.js";
import type { Wallet } from "./shared/types.js";

type Params = {
	mnemonic: string;
	count: number;
};

export const generateWallets = ({ mnemonic, count }: Params): Wallet[] => {
	const validMnemonic = MnemonicSchema.parse(mnemonic);
	const validCount = WalletCountSchema.parse(count);

	const wallets: Wallet[] = [];
	for (let i = 0; i < validCount; i++) {
		const account = mnemonicToAccount(validMnemonic, { addressIndex: i });
		wallets.push({ index: i, address: account.address });
	}
	return wallets;
};
