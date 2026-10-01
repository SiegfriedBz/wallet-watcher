import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { openDb, recordBalanceChange } from "../src/db.js";
import type { Wallet } from "../src/shared/types.js";

// Hardhat test addresses (public).
const ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADDRESS_2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const WALLETS: Wallet[] = [
	{ index: 0, address: ADDRESS_0 },
	{ index: 1, address: ADDRESS_1 },
];

// In-memory DB + app: no file, no port, no network.
const setup = (lastPolledAt: string | null = null) => {
	const db = openDb(":memory:");
	const app = createApi({
		db,
		wallets: WALLETS,
		chainId: 11155111,
		getLastPolledAt: () => lastPolledAt,
	});
	return { db, app };
};

describe("GET /wallets", () => {
	it("lists every watched wallet, with null balances before the first poll", async () => {
		const { app } = setup();
		const res = await app.request("/wallets");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			chainId: 11155111,
			lastPolledAt: null,
			wallets: [
				{
					index: 0,
					address: ADDRESS_0,
					balanceWei: null,
					balanceEth: null,
					balanceChangedAt: null,
				},
				{
					index: 1,
					address: ADDRESS_1,
					balanceWei: null,
					balanceEth: null,
					balanceChangedAt: null,
				},
			],
		});
	});

	it("returns stored balances as exact strings", async () => {
		const { db, app } = setup();
		recordBalanceChange(db, {
			walletIndex: 0,
			address: ADDRESS_0,
			type: "initial",
			deltaWei: 1234567890123456789n,
			balanceWei: 1234567890123456789n,
		});

		const body = await (await app.request("/wallets")).json();

		expect(body.wallets[0]).toEqual({
			index: 0,
			address: ADDRESS_0,
			balanceWei: "1234567890123456789",
			balanceEth: "1.234567890123456789",
			balanceChangedAt: expect.any(String),
		});
		expect(body.wallets[1].balanceWei).toBeNull();
	});

	it("only lists watched wallets (0..N-1), even if the DB knows more", async () => {
		const { db, app } = setup();
		recordBalanceChange(db, {
			walletIndex: 2,
			address: ADDRESS_2,
			type: "initial",
			deltaWei: 5n,
			balanceWei: 5n,
		});

		const body = await (await app.request("/wallets")).json();

		expect(body.wallets).toHaveLength(2);
	});

	it("returns the poller's last poll time", async () => {
		const { app } = setup("2026-10-01T17:00:00.000Z");
		const body = await (await app.request("/wallets")).json();
		expect(body.lastPolledAt).toBe("2026-10-01T17:00:00.000Z");
	});
});

describe("other routes", () => {
	it("GET /health returns ok", async () => {
		const { app } = setup();
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("unknown route returns a JSON 404", async () => {
		const { app } = setup();
		const res = await app.request("/nope");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Not found" });
	});
});
