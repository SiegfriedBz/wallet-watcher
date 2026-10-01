import { z } from "zod";
import { MnemonicSchema, WalletCountSchema } from "./shared/schemas.js";

// Env vars are always text: accept digits only, then convert to a number.
const DigitsString = z
	.string()
	.regex(/^\d+$/, { error: "Must contain digits only" })
	.transform(Number);

const PortSchema = z
	.number()
	.int()
	.min(1, { error: "Port must be at least 1" })
	.max(65535, { error: "Port must be at most 65535" });

const EnvSchema = z.object({
	MNEMONIC: MnemonicSchema,
	WALLET_COUNT: DigitsString.pipe(WalletCountSchema),
	RPC_URL: z.url(),
	PORT: DigitsString.pipe(PortSchema).default(3000),
	// Protects POST /withdrawals. Required: the service can always sign.
	ADMIN_API_KEY: z.string().min(32, {
		error:
			"ADMIN_API_KEY must be at least 32 characters (openssl rand -hex 32)",
	}),
});

export type Config = z.infer<typeof EnvSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
	const result = EnvSchema.safeParse(env);
	if (!result.success) {
		const details = result.error.issues
			.map((issue) => `- ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid configuration:\n${details}`);
	}
	return result.data;
};
