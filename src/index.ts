import { z } from "zod";
import { loadConfig } from "./config.js";
import { generateWallets } from "./generate-wallets.js";

try {
	process.loadEnvFile();
	const config = loadConfig();

	const wallets = generateWallets({
		mnemonic: config.MNEMONIC,
		count: config.WALLET_COUNT,
	});
	console.log(wallets);
} catch (error) {
	if (error instanceof z.ZodError) {
		console.error(`Invalid input:\n${z.prettifyError(error)}`);
	} else {
		console.error(error instanceof Error ? error.message : error);
	}
	process.exit(1);
}
