import { describe, expect, it } from "vitest";
import {
	AddressSchema,
	AmountEthSchema,
	createWithdrawalRequestSchema,
} from "../src/shared/schemas.js";
import type { Wallet } from "../src/shared/types.js";

// Hardhat test address #1 (public), checksummed and lowercase.
const CHECKSUMMED = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const LOWERCASE = CHECKSUMMED.toLowerCase();
// Same address, one letter's case flipped: the checksum no longer matches.
const BAD_CHECKSUM = "0x70997970c51812dc3A010C7d01b50e0d17dc79C8";

describe("AmountEthSchema", () => {
	it.each([
		"1",
		"1.5",
		"0.0005",
		"0.000000000000000001",
		"123456789.123456789123456789",
	])("accepts '%s'", (input) => {
		expect(AmountEthSchema.parse(input)).toBe(input);
	});

	it.each([
		"0",
		"0.0",
		"-1",
		"1e-3",
		".5",
		"1.",
		" 1",
		"1,5",
		"",
		"abc",
		"0.0000000000000000001",
	])("rejects '%s'", (input) => {
		expect(AmountEthSchema.safeParse(input).success).toBe(false);
	});

	it("rejects a JSON number (would already have lost precision)", () => {
		expect(AmountEthSchema.safeParse(0.5).success).toBe(false);
	});
});

describe("AddressSchema", () => {
	it("accepts a checksummed address", () => {
		expect(AddressSchema.parse(CHECKSUMMED)).toBe(CHECKSUMMED);
	});

	it("accepts a lowercase address and returns it checksummed", () => {
		expect(AddressSchema.parse(LOWERCASE)).toBe(CHECKSUMMED);
	});

	it.each([BAD_CHECKSUM, "0x1234", "not an address", ""])(
		"rejects '%s'",
		(input) => {
			expect(AddressSchema.safeParse(input).success).toBe(false);
		},
	);
});

describe("createWithdrawalRequestSchema", () => {
	// Watched wallets 0..4: the public Hardhat addresses (#1 is CHECKSUMMED above).
	const WALLETS: Wallet[] = [
		{ index: 0, address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
		{ index: 1, address: CHECKSUMMED },
		{ index: 2, address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" },
		{ index: 3, address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" },
		{ index: 4, address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65" },
	];
	const schema = createWithdrawalRequestSchema(WALLETS);
	const VALID = { fromIndex: 0, to: LOWERCASE, amountEth: "0.0005" };

	it("parses a valid request into { fromIndex, to, amountWei }", () => {
		expect(schema.parse(VALID)).toEqual({
			fromIndex: 0,
			to: CHECKSUMMED,
			amountWei: 500000000000000n,
			broadcast: false,
		});
	});

	it.each([
		["1", 10n ** 18n],
		["1.5", (3n * 10n ** 18n) / 2n],
		["0.000000000000000001", 1n],
		["123456789.123456789123456789", 123456789123456789123456789n],
	])("converts amountEth '%s' to exact wei", (amountEth, expected) => {
		expect(schema.parse({ ...VALID, amountEth }).amountWei).toBe(expected);
	});

	it.each([0, 4])(
		"accepts fromIndex = %d (watched wallets 0..4)",
		(fromIndex) => {
			expect(schema.safeParse({ ...VALID, fromIndex }).success).toBe(true);
		},
	);

	it.each([5, -1, 1.5, "0"])("rejects fromIndex = %s", (fromIndex) => {
		expect(schema.safeParse({ ...VALID, fromIndex }).success).toBe(false);
	});

	it("rejects the zero address", () => {
		const to = "0x0000000000000000000000000000000000000000";
		expect(schema.safeParse({ ...VALID, to }).success).toBe(false);
	});

	it("rejects sending to the sending wallet, whatever the letter case", () => {
		// VALID.to is wallet #1 in lowercase; wallet #1 is stored checksummed.
		const result = schema.safeParse({ ...VALID, fromIndex: 1 });
		expect(result.success).toBe(false);
		expect(result.error?.issues[0]?.path).toEqual(["to"]);
	});

	it.each(["fromIndex", "to", "amountEth"])("rejects a missing %s", (field) => {
		const body = Object.fromEntries(
			Object.entries(VALID).filter(([key]) => key !== field),
		);
		expect(schema.safeParse(body).success).toBe(false);
	});

	it("rejects unknown fields", () => {
		expect(schema.safeParse({ ...VALID, memo: "hello" }).success).toBe(false);
	});

	it("accepts broadcast: true", () => {
		expect(schema.parse({ ...VALID, broadcast: true }).broadcast).toBe(true);
	});

	it("rejects a non-boolean broadcast", () => {
		expect(schema.safeParse({ ...VALID, broadcast: "yes" }).success).toBe(
			false,
		);
	});
});
