import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

// Public Hardhat/Anvil test mnemonic.
const TEST_MNEMONIC =
	"test test test test test test test test test test test junk";

const VALID_ENV = {
	MNEMONIC: TEST_MNEMONIC,
	WALLET_COUNT: "5",
	RPC_URL: "https://sepolia.example.com",
};

describe("loadConfig", () => {
	it("accepts a valid env and turns WALLET_COUNT into a number", () => {
		expect(loadConfig(VALID_ENV)).toEqual({
			MNEMONIC: TEST_MNEMONIC,
			WALLET_COUNT: 5,
			RPC_URL: "https://sepolia.example.com",
		});
	});

	it("keeps only the three expected keys (ignores other env vars)", () => {
		const config = loadConfig({ ...VALID_ENV, HOME: "/home/someone" });
		expect(Object.keys(config).sort()).toEqual([
			"MNEMONIC",
			"RPC_URL",
			"WALLET_COUNT",
		]);
	});

	it("trims spaces around the mnemonic", () => {
		const config = loadConfig({
			...VALID_ENV,
			MNEMONIC: `  ${TEST_MNEMONIC} `,
		});
		expect(config.MNEMONIC).toBe(TEST_MNEMONIC);
	});

	it("accepts WALLET_COUNT = '05' as 5", () => {
		expect(loadConfig({ ...VALID_ENV, WALLET_COUNT: "05" }).WALLET_COUNT).toBe(
			5,
		);
	});

	it.each(["1", "20"])("accepts WALLET_COUNT = '%s' (range limit)", (value) => {
		expect(loadConfig({ ...VALID_ENV, WALLET_COUNT: value }).WALLET_COUNT).toBe(
			Number(value),
		);
	});

	it.each(["3.5", "5abc", "", " 7 ", "0x10", "1e1", "-1", "0", "21"])(
		"rejects WALLET_COUNT = '%s'",
		(value) => {
			expect(() => loadConfig({ ...VALID_ENV, WALLET_COUNT: value })).toThrow(
				/WALLET_COUNT/,
			);
		},
	);

	it("rejects a missing WALLET_COUNT", () => {
		expect(() =>
			loadConfig({ MNEMONIC: TEST_MNEMONIC, RPC_URL: VALID_ENV.RPC_URL }),
		).toThrow(/WALLET_COUNT/);
	});

	it("rejects a missing MNEMONIC", () => {
		expect(() =>
			loadConfig({ WALLET_COUNT: "5", RPC_URL: VALID_ENV.RPC_URL }),
		).toThrow(/MNEMONIC/);
	});

	it("rejects an invalid MNEMONIC (wrong checksum)", () => {
		const invalid =
			"test test test test test test test test test test test test";
		expect(() => loadConfig({ ...VALID_ENV, MNEMONIC: invalid })).toThrow(
			/MNEMONIC/,
		);
	});

	it("rejects an invalid RPC_URL", () => {
		expect(() => loadConfig({ ...VALID_ENV, RPC_URL: "not a url" })).toThrow(
			/RPC_URL/,
		);
	});

	it("never puts the mnemonic in the error message", () => {
		const secretLike =
			"test test test test test test test test test test test jump";
		try {
			loadConfig({ ...VALID_ENV, MNEMONIC: secretLike, WALLET_COUNT: "abc" });
			expect.unreachable("loadConfig should have thrown");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).not.toContain("jump");
			expect((error as Error).message).not.toContain(secretLike);
		}
	});
});
