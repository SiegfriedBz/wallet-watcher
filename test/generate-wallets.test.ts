import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { generateWallets } from "../src/generate-wallets.js";

// Public Hardhat/Anvil test mnemonic.
const TEST_MNEMONIC =
	"test test test test test test test test test test test junk";

// Addresses published by Hardhat/Anvil for this mnemonic (path m/44'/60'/0'/0/i).
const KNOWN_ADDRESSES = [
	"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
	"0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
	"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
];
const KNOWN_ADDRESS_19 = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";

const generate = (count: number) =>
	generateWallets({ mnemonic: TEST_MNEMONIC, count });

describe("generateWallets", () => {
	it("matches the known test vector", () => {
		expect(generate(3)).toEqual([
			{ index: 0, address: KNOWN_ADDRESSES[0] },
			{ index: 1, address: KNOWN_ADDRESSES[1] },
			{ index: 2, address: KNOWN_ADDRESSES[2] },
		]);
	});

	it("derives the last wallet (#19) correctly when N = 20", () => {
		const wallets = generate(20);
		expect(wallets).toHaveLength(20);
		expect(wallets[19]).toEqual({ index: 19, address: KNOWN_ADDRESS_19 });
	});

	it("returns the same list for the same N (deterministic)", () => {
		expect(generate(5)).toEqual(generate(5));
	});

	it("N + m keeps the original N wallets and adds m new ones", () => {
		const five = generate(5);
		const eight = generate(8);
		expect(eight.slice(0, 5)).toEqual(five);
		expect(eight).toHaveLength(8);
	});

	it("N - m returns a subset (the first N - m wallets)", () => {
		expect(generate(3)).toEqual(generate(5).slice(0, 3));
	});

	it("returns wallets in index order", () => {
		expect(generate(10).map((w) => w.index)).toEqual([
			0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
		]);
	});

	it("gives every wallet a different address", () => {
		const addresses = generate(20).map((w) => w.address);
		expect(new Set(addresses).size).toBe(20);
	});

	it("returns only index and address (no key material)", () => {
		for (const wallet of generate(3)) {
			expect(Object.keys(wallet).sort()).toEqual(["address", "index"]);
		}
	});

	it("ignores spaces around the mnemonic", () => {
		const padded = generateWallets({
			mnemonic: `  ${TEST_MNEMONIC}\n`,
			count: 3,
		});
		expect(padded).toEqual(generate(3));
	});

	it.each([1, 20])("accepts N = %d (range limit)", (count) => {
		expect(generate(count)).toHaveLength(count);
	});

	it.each([0, 21, -1, 2.5])("rejects N = %d", (count) => {
		expect(() => generate(count)).toThrow(ZodError);
	});

	it.each([
		[
			"wrong checksum",
			"test test test test test test test test test test test test",
		],
		["empty", ""],
		["too short", "test test test"],
	])("rejects an invalid mnemonic (%s)", (_label, mnemonic) => {
		expect(() => generateWallets({ mnemonic, count: 1 })).toThrow(ZodError);
	});
});
