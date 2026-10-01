import { recoverTransactionAddress } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api.js";
import type { WithdrawalChainInputs } from "../src/chain.js";
import { getLedger, openDb, recordBalanceChange } from "../src/db.js";
import type { Wallet } from "../src/shared/types.js";
import { signWithdrawal } from "../src/signer.js";

// Public Hardhat/Anvil test mnemonic and its published addresses.
const TEST_MNEMONIC =
	"test test test test test test test test test test test junk";
const ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADDRESS_2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const API_KEY = "test-admin-key-0123456789abcdef-0123";
const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;

const WALLETS: Wallet[] = [
	{ index: 0, address: ADDRESS_0 },
	{ index: 1, address: ADDRESS_1 },
];

// Fake chain state: 1 ETH, 21,000 gas at max 30 gwei (worst-case fee 0.00063 ETH).
const CHAIN_INPUTS: WithdrawalChainInputs = {
	balanceWei: ETH,
	nonce: 3,
	gas: 21000n,
	maxFeePerGas: 30n * GWEI,
	maxPriorityFeePerGas: 2n * GWEI,
};

type SetupOptions = {
	lastPolledAt?: string | null;
	chainInputs?: WithdrawalChainInputs;
};

// In-memory DB + app: no file, no port, no network. Real signer with the test mnemonic.
const setup = ({
	lastPolledAt = null,
	chainInputs = CHAIN_INPUTS,
}: SetupOptions = {}) => {
	const db = openDb(":memory:");
	const readWithdrawalInputs = vi.fn(async () => chainInputs);
	const app = createApi({
		db,
		wallets: WALLETS,
		chainId: 11155111,
		getLastPolledAt: () => lastPolledAt,
		adminApiKey: API_KEY,
		readWithdrawalInputs,
		signWithdrawal: ({ walletIndex, tx }) =>
			signWithdrawal({ mnemonic: TEST_MNEMONIC, walletIndex, tx }),
	});
	return { db, app, readWithdrawalInputs };
};

const postWithdrawal = (
	app: ReturnType<typeof createApi>,
	body: unknown,
	apiKey: string | null = API_KEY,
) =>
	app.request("/withdrawals", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify(body),
	});

const VALID_BODY = { fromIndex: 0, to: ADDRESS_1, amountEth: "0.0005" };

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
		const { app } = setup({ lastPolledAt: "2026-10-01T17:00:00.000Z" });
		const body = await (await app.request("/wallets")).json();
		expect(body.lastPolledAt).toBe("2026-10-01T17:00:00.000Z");
	});
});

describe("POST /withdrawals: protection", () => {
	it("returns 401 without an API key, and reads nothing from the chain", async () => {
		const { app, readWithdrawalInputs } = setup();
		const res = await postWithdrawal(app, VALID_BODY, null);

		expect(res.status).toBe(401);
		expect(readWithdrawalInputs).not.toHaveBeenCalled();
	});

	it("returns 401 with a wrong API key", async () => {
		const { app, readWithdrawalInputs } = setup();
		const res = await postWithdrawal(
			app,
			VALID_BODY,
			"wrong-key-wrong-key-wrong-key-123",
		);

		expect(res.status).toBe(401);
		expect(readWithdrawalInputs).not.toHaveBeenCalled();
	});
});

describe("POST /withdrawals: validation", () => {
	it.each([
		["amount as a JSON number", { ...VALID_BODY, amountEth: 0.0005 }],
		["unwatched wallet", { ...VALID_BODY, fromIndex: 2 }],
		["invalid address", { ...VALID_BODY, to: "0x1234" }],
		["missing field", { fromIndex: 0, to: ADDRESS_1 }],
	])("returns 400 for %s, before any chain call", async (_label, body) => {
		const { app, readWithdrawalInputs } = setup();
		const res = await postWithdrawal(app, body);

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Invalid request");
		expect(readWithdrawalInputs).not.toHaveBeenCalled();
	});

	it("returns 400 for a body that is not JSON", async () => {
		const { app } = setup();
		const res = await app.request("/withdrawals", {
			method: "POST",
			headers: { Authorization: `Bearer ${API_KEY}` },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /withdrawals: funds and signing", () => {
	it("returns 422 with the max sendable amount when the fee does not fit (0.1 ETH trap)", async () => {
		const { app } = setup({
			chainInputs: { ...CHAIN_INPUTS, balanceWei: ETH / 10n },
		});
		const res = await postWithdrawal(app, { ...VALID_BODY, amountEth: "0.1" });

		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			balanceWei: (ETH / 10n).toString(),
			maxFeeWei: (21000n * 30n * GWEI).toString(),
			maxSendableWei: (ETH / 10n - 21000n * 30n * GWEI).toString(),
		});
	});

	it("returns a tx signed by the selected wallet, with exact amounts", async () => {
		const { app } = setup();
		const res = await postWithdrawal(app, VALID_BODY);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toMatchObject({
			broadcast: false,
			from: ADDRESS_0,
			transaction: {
				chainId: 11155111,
				to: ADDRESS_1,
				valueWei: "500000000000000",
				valueEth: "0.0005",
				nonce: 3,
			},
		});

		const signer = await recoverTransactionAddress({
			serializedTransaction: body.serializedTransaction,
		});
		expect(signer).toBe(ADDRESS_0);
	});

	it("writes nothing to the ledger (built and signed, not broadcast)", async () => {
		const { app, db } = setup();
		await postWithdrawal(app, VALID_BODY);

		expect(getLedger(db, ADDRESS_0)).toHaveLength(0);
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
