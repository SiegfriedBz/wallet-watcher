import {
	keccak256,
	parseTransaction,
	recoverTransactionAddress,
	type TransactionSerializableEIP1559,
} from "viem";
import { describe, expect, it } from "vitest";
import { signWithdrawal } from "../src/signer.js";

// Public Hardhat/Anvil test mnemonic and its published addresses.
const TEST_MNEMONIC =
	"test test test test test test test test test test test junk";
const ADDRESS_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ADDRESS_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const TX: TransactionSerializableEIP1559 = {
	type: "eip1559",
	chainId: 11155111,
	to: ADDRESS_1,
	value: 500000000000000n,
	nonce: 7,
	gas: 21000n,
	maxFeePerGas: 30_000_000_000n,
	maxPriorityFeePerGas: 2_000_000_000n,
};

describe("signWithdrawal", () => {
	it("is signed by the selected wallet (recovered from the signature alone)", async () => {
		const signed = await signWithdrawal({
			mnemonic: TEST_MNEMONIC,
			walletIndex: 0,
			tx: TX,
		});

		const signer = await recoverTransactionAddress({
			serializedTransaction: signed.serializedTransaction,
		});
		expect(signer).toBe(ADDRESS_0);
		expect(signed.from).toBe(ADDRESS_0);
	});

	it("uses the key of the requested index, not another wallet's", async () => {
		const signed = await signWithdrawal({
			mnemonic: TEST_MNEMONIC,
			walletIndex: 1,
			tx: TX,
		});

		const signer = await recoverTransactionAddress({
			serializedTransaction: signed.serializedTransaction,
		});
		expect(signer).toBe(ADDRESS_1);
	});

	it("signs exactly the transaction it was given", async () => {
		const signed = await signWithdrawal({
			mnemonic: TEST_MNEMONIC,
			walletIndex: 0,
			tx: TX,
		});

		// Addresses are raw bytes in a signed tx: decoding gives them back in lowercase.
		expect(parseTransaction(signed.serializedTransaction)).toMatchObject({
			...TX,
			to: ADDRESS_1.toLowerCase(),
		});
	});

	it("returns the hash of the signed transaction", async () => {
		const signed = await signWithdrawal({
			mnemonic: TEST_MNEMONIC,
			walletIndex: 0,
			tx: TX,
		});

		expect(signed.hash).toBe(keccak256(signed.serializedTransaction));
	});

	it("returns no key material", async () => {
		const signed = await signWithdrawal({
			mnemonic: TEST_MNEMONIC,
			walletIndex: 0,
			tx: TX,
		});

		expect(Object.keys(signed).sort()).toEqual([
			"from",
			"hash",
			"serializedTransaction",
			"signature",
		]);
		expect(Object.keys(signed.signature).sort()).toEqual(["r", "s", "yParity"]);
	});
});
