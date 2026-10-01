import { sepolia } from "viem/chains";
import { z } from "zod";
import { createChainClient } from "./chain.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { generateWallets } from "./generate-wallets.js";
import { startPoller } from "./poller.js";

// One DB file per chain: balances from different networks can never mix.
const DB_PATH = `data/wallet-watcher-${sepolia.id}.db`;

try {
	process.loadEnvFile();
	const config = loadConfig();

	const wallets = generateWallets({
		mnemonic: config.MNEMONIC,
		count: config.WALLET_COUNT,
	});

	const db = openDb(DB_PATH);
	const client = createChainClient(config.RPC_URL);

	const stopPoller = startPoller({ client, db, wallets });
	console.log(`✅ Watching ${wallets.length} wallets on Sepolia`);
	for (const wallet of wallets) {
		console.log(`  #${wallet.index}  ${wallet.address}`);
	}

	const shutdown = () => {
		stopPoller();
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
} catch (error) {
	if (error instanceof z.ZodError) {
		console.error(`Invalid input:\n${z.prettifyError(error)}`);
	} else {
		console.error(error instanceof Error ? error.message : error);
	}
	process.exit(1);
}
