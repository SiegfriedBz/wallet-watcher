import { z } from "zod";
import { MnemonicSchema, WalletCountSchema } from "./shared/schemas.js";

// Env vars are always text: accept digits only, then convert to a number.
const DigitsString = z
	.string()
	.regex(/^\d+$/, { error: "Must contain digits only" })
	.transform(Number);

const EnvSchema = z.object({
	MNEMONIC: MnemonicSchema,
	WALLET_COUNT: DigitsString.pipe(WalletCountSchema),
	RPC_URL: z.url(),
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
