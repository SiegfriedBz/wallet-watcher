// Dev helper: prints a fresh BIP-39 mnemonic to paste into .env (testnet only).
import { english, generateMnemonic } from "viem/accounts";

console.log(generateMnemonic(english));
