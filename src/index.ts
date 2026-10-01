import { serve } from "@hono/node-server";
import { z } from "zod";
import { createApi } from "./api.js";
import {
	assertExpectedChain,
	CHAIN,
	createChainClient,
	readWithdrawalInputs,
} from "./chain.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { generateWallets } from "./generate-wallets.js";
import { startPoller } from "./poller.js";
import { safeErrorMessage } from "./shared/errors.js";
import { signWithdrawal } from "./signer.js";

// One DB file per chain: balances from different networks can never mix.
const DB_PATH = `data/wallet-watcher-${CHAIN.id}.db`;

// Admin API: only reachable from this machine.
const HOST = "127.0.0.1";

try {
	process.loadEnvFile();
	const config = loadConfig();

	const wallets = generateWallets({
		mnemonic: config.MNEMONIC,
		count: config.WALLET_COUNT,
	});

	// Checked before anything else touches the chain or the DB.
	const chainClient = createChainClient(config.RPC_URL);
	await assertExpectedChain(chainClient);

	const db = openDb(DB_PATH);

	const poller = startPoller({ client: chainClient, db, wallets });
	console.log(`✅ Watching ${wallets.length} wallets on ${CHAIN.name}`);
	for (const wallet of wallets) {
		console.log(`  #${wallet.index}  ${wallet.address}`);
	}

	const app = createApi({
		db,
		wallets,
		chainId: CHAIN.id,
		getLastPolledAt: poller.lastPolledAt,
		adminApiKey: config.ADMIN_API_KEY,
		// The API gets functions, not the client or the mnemonic itself.
		readWithdrawalInputs: (params) => readWithdrawalInputs(chainClient, params),
		signWithdrawal: ({ walletIndex, tx }) =>
			signWithdrawal({ mnemonic: config.MNEMONIC, walletIndex, tx }),
		broadcastTransaction: (serializedTransaction) =>
			chainClient.sendRawTransaction({ serializedTransaction }),
		logRequests: true,
	});

	const server = serve(
		{ fetch: app.fetch, hostname: HOST, port: config.PORT },
		(info) => console.log(`✅ API on http://${HOST}:${info.port}`),
	);

	// Stop new work first (poller, HTTP), then close the DB they write to.
	const shutdown = () => {
		poller.stop();
		server.close();
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
} catch (error) {
	if (error instanceof z.ZodError) {
		console.error(`Invalid input:\n${z.prettifyError(error)}`);
	} else {
		console.error(safeErrorMessage(error));
	}
	process.exit(1);
}
