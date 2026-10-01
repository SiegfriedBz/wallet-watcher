import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import {
	type Address,
	formatEther,
	type TransactionSerializableEIP1559,
} from "viem";
import type { WithdrawalChainInputs } from "./chain.js";
import { getBalances } from "./db.js";
import { createWithdrawalRequestSchema } from "./shared/schemas.js";
import type { Wallet } from "./shared/types.js";
import type { SignedWithdrawal } from "./signer.js";
import { planWithdrawal } from "./withdrawal.js";

type ApiDeps = {
	db: DatabaseSync;
	wallets: Wallet[];
	chainId: number;
	getLastPolledAt: () => string | null;
	adminApiKey: string;
	// Injected by index.ts: api.ts never sees the RPC client or the mnemonic.
	readWithdrawalInputs: (params: {
		from: Address;
		to: Address;
		amountWei: bigint;
	}) => Promise<WithdrawalChainInputs>;
	signWithdrawal: (params: {
		walletIndex: number;
		tx: TransactionSerializableEIP1559;
	}) => Promise<SignedWithdrawal>;
	logRequests?: boolean;
};

export const createApi = ({
	db,
	wallets,
	chainId,
	getLastPolledAt,
	adminApiKey,
	readWithdrawalInputs,
	signWithdrawal,
	logRequests = false,
}: ApiDeps) => {
	const app = new Hono();

	// One line per request (method, path, status, time). Never bodies or headers.
	// Must be registered before the routes to apply to them.
	if (logRequests) {
		app.use(logger());
	}

	app.get("/health", (c) => c.json({ status: "ok" }));

	// Balances come from the DB (kept fresh by the poller), never from the chain.
	// Amounts are strings: JSON has no bigint, and a JSON number would lose precision.
	// lastPolledAt = freshness of all balances; balanceChangedAt = last change of one balance.
	app.get("/wallets", (c) => {
		const stored = new Map(getBalances(db).map((b) => [b.address, b]));

		return c.json({
			chainId,
			lastPolledAt: getLastPolledAt(),
			wallets: wallets.map(({ index, address }) => {
				const balance = stored.get(address);
				return {
					index,
					address,
					balanceWei: balance ? balance.balanceWei.toString() : null,
					balanceEth: balance ? formatEther(balance.balanceWei) : null,
					balanceChangedAt: balance?.updatedAt ?? null,
				};
			}),
		});
	});

	const withdrawalRequestSchema = createWithdrawalRequestSchema(wallets.length);

	// Builds and signs a withdrawal, without broadcasting it. Protected: anyone holding
	// a signed tx can broadcast it. bearerAuth runs first (constant-time key check):
	// without the right key, nothing below runs.
	app.post("/withdrawals", bearerAuth({ token: adminApiKey }), async (c) => {
		const body = await c.req.json().catch(() => undefined);
		const parsed = withdrawalRequestSchema.safeParse(body);
		if (!parsed.success) {
			return c.json(
				{
					error: "Invalid request",
					issues: parsed.error.issues.map((issue) => ({
						field: issue.path.join("."),
						message: issue.message,
					})),
				},
				400,
			);
		}

		const { fromIndex, to, amountWei } = parsed.data;
		const from = wallets.find((w) => w.index === fromIndex)?.address;
		if (!from) {
			return c.json({ error: "Unknown wallet" }, 400);
		}

		// Fresh on-chain state: the DB balance can be minutes old and must never decide a spend.
		const inputs = await readWithdrawalInputs({ from, to, amountWei });
		const plan = planWithdrawal({ chainId, to, amountWei, ...inputs });
		if (!plan.ok) {
			return c.json(
				{
					error:
						"Insufficient funds: balance must cover amount + worst-case fee",
					balanceWei: plan.balanceWei.toString(),
					maxFeeWei: plan.maxFeeWei.toString(),
					maxSendableWei: plan.maxSendableWei.toString(),
					maxSendableEth: formatEther(plan.maxSendableWei),
				},
				422,
			);
		}

		const signed = await signWithdrawal({
			walletIndex: fromIndex,
			tx: plan.tx,
		});

		// Built and signed only: nothing is broadcast, so nothing goes in the ledger.
		return c.json({
			broadcast: false,
			from: signed.from,
			hash: signed.hash,
			transaction: {
				type: "eip1559",
				chainId,
				to,
				valueWei: amountWei.toString(),
				valueEth: formatEther(amountWei),
				nonce: inputs.nonce,
				gas: inputs.gas.toString(),
				maxFeePerGas: inputs.maxFeePerGas.toString(),
				maxPriorityFeePerGas: inputs.maxPriorityFeePerGas.toString(),
				maxFeeWei: plan.maxFeeWei.toString(),
			},
			signature: signed.signature,
			serializedTransaction: signed.serializedTransaction,
		});
	});

	app.notFound((c) => c.json({ error: "Not found" }, 404));

	app.onError((error, c) => {
		// Expected HTTP errors (e.g. 401 from bearerAuth) keep their own status.
		if (error instanceof HTTPException) {
			return error.getResponse();
		}
		// Anything else: log the real error, return a generic message (no internals leak).
		console.error(`[api] ${error.message}`);
		return c.json({ error: "Internal server error" }, 500);
	});

	return app;
};
