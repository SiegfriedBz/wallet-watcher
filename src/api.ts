import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { formatEther } from "viem";
import { getBalances } from "./db.js";
import type { Wallet } from "./shared/types.js";

type ApiDeps = {
	db: DatabaseSync;
	wallets: Wallet[];
	chainId: number;
};

export const createApi = ({ db, wallets, chainId }: ApiDeps) => {
	const app = new Hono();

	app.get("/health", (c) => c.json({ status: "ok" }));

	// Balances come from the DB (kept fresh by the poller), never from the chain.
	// Amounts are strings: JSON has no bigint, and a JSON number would lose precision.
	app.get("/wallets", (c) => {
		const stored = new Map(getBalances(db).map((b) => [b.address, b]));

		return c.json({
			chainId,
			wallets: wallets.map(({ index, address }) => {
				const balance = stored.get(address);
				return {
					index,
					address,
					balanceWei: balance ? balance.balanceWei.toString() : null,
					balanceEth: balance ? formatEther(balance.balanceWei) : null,
					updatedAt: balance?.updatedAt ?? null,
				};
			}),
		});
	});

	app.notFound((c) => c.json({ error: "Not found" }, 404));

	// Log the real error, return a generic message: no internals leak to the client.
	app.onError((error, c) => {
		console.error(`[api] ${error.message}`);
		return c.json({ error: "Internal server error" }, 500);
	});

	return app;
};
