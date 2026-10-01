import {
	type Address,
	type Hash,
	type Hex,
	keccak256,
	parseTransaction,
	type TransactionSerializableEIP1559,
	type TransactionSerializedEIP1559,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

export type SignedWithdrawal = {
	from: Address;
	// Signed raw EIP-1559 transaction (starts with 0x02): ready to broadcast.
	serializedTransaction: TransactionSerializedEIP1559;
	// Transaction id, as shown on Etherscan once broadcast.
	hash: Hash;
	signature: { r: Hex; s: Hex; yParity: number };
};

type SignParams = {
	mnemonic: string;
	walletIndex: number;
	tx: TransactionSerializableEIP1559;
};

// viem types a signed tx as plain Hex. EIP-1559 txs start with the type byte 0x02:
// checking it lets TypeScript (and us) be sure of what we return.
const isSignedEip1559 = (tx: Hex): tx is TransactionSerializedEIP1559 =>
	tx.startsWith("0x02");

// The only place a private key exists: derived for one wallet, used once to sign,
// then dropped when the function returns. Only the signed tx and signature leave.
export const signWithdrawal = async ({
	mnemonic,
	walletIndex,
	tx,
}: SignParams): Promise<SignedWithdrawal> => {
	const account = mnemonicToAccount(mnemonic, { addressIndex: walletIndex });
	const serializedTransaction = await account.signTransaction(tx);
	if (!isSignedEip1559(serializedTransaction)) {
		throw new Error("Expected a signed EIP-1559 transaction");
	}

	// Read the signature back from the signed tx, to return it as separate fields.
	const { r, s, yParity } = parseTransaction(serializedTransaction);

	if (r === undefined || s === undefined || yParity === undefined) {
		throw new Error("Signed transaction has no signature");
	}

	return {
		from: account.address,
		serializedTransaction,
		hash: keccak256(serializedTransaction),
		signature: { r, s, yParity },
	};
};
