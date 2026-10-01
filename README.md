# Wallet Watcher

A small custody-style backend in Node.js and TypeScript. It derives a set of Ethereum wallets from a single mnemonic, tracks their ETH balances on the **Sepolia testnet**, and records every balance change in an append-only ledger.

> Testnet only. Never use a mnemonic that holds real funds.

## Status

| Feature | Status |
|---|---|
| HD wallet derivation (1 to 20 wallets) | ✅ |
| Balance tracking with an 8-minute poller | ✅ |
| SQLite ledger + current balances | ✅ |
| API: list wallets and balances | 🚧 planned |
| Withdrawal: build and sign a transaction | 🚧 planned |
| Withdrawal: broadcast and record the outflow | 🚧 planned |

## Requirements

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; tested on Node 24)
- **pnpm** 10
- A **Sepolia RPC URL** (Alchemy, Infura, or a public endpoint)

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm generate:mnemonic      # prints a new testnet mnemonic: paste it into .env yourself
```

Fill in `.env`:

```bash
MNEMONIC="word1 word2 ... word12"
WALLET_COUNT=5
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<your-key>
```

Start the service:

```bash
pnpm start
```

```
✅ Watching 5 wallets on Sepolia
  #0  0x5963…4Ed5
  #1  0x8c10…E873
  ...
[poller] wallet #0: initial 0 wei
...
```

Send some Sepolia ETH to one of the printed addresses (from a faucet or another wallet). Within 8 minutes the service logs an `inflow`.

## Configuration

All settings come from `.env`. They are validated once at startup, and the service refuses to start if anything is invalid.

| Variable | Rule |
|---|---|
| `MNEMONIC` | A valid 12- or 24-word BIP-39 phrase (checksum verified). Surrounding spaces are ignored. |
| `WALLET_COUNT` | Digits only, integer from 1 to 20 (`"3.5"`, `"0x10"`, `" 7 "` are rejected). |
| `RPC_URL` | A valid URL to a Sepolia node. |

## How it works

### Wallet derivation

Each wallet is derived from the mnemonic with the standard Ethereum path `m/44'/60'/0'/0/i`, where `i` is the wallet index.

- The same mnemonic and index always give the same wallet. Raising `WALLET_COUNT` adds new wallets after the existing ones; lowering it keeps the first ones.
- Private keys are never stored: they are recomputed from the mnemonic when needed. Only `{ index, address }` leaves the derivation code.
- The addresses match MetaMask's: importing the mnemonic shows wallet #0 as Account 1, #1 as Account 2, and so on.

### Balance tracking

Plain ETH transfers emit no on-chain events, so the service **polls** balances. At startup, then every 8 minutes, it reads each wallet's balance and compares it with the stored one. A row is written only when something changed, so any change shows up within 10 minutes.

- A new round starts only after the previous one finished, so rounds never overlap.
- An RPC error on one wallet is logged; the other wallets are still checked and the service keeps running.

### Storage

A local SQLite file (`data/wallet-watcher-<chainId>.db`), so there is no database server to install. One file per chain, so balances from different networks never mix.

| Table | Content |
|---|---|
| `balances` | One row per wallet: the current balance. Overwritten when it changes. |
| `ledger` | One row per change, never edited or deleted: type, signed delta, balance after, tx hash (for withdrawals), timestamp. |

Both tables are written in a **single transaction**, so they always agree, even after a crash.

| Ledger type | Meaning |
|---|---|
| `initial` | First reading of a wallet |
| `inflow` | Balance went up |
| `outflow` | A withdrawal broadcast by this service (with its tx hash) |
| `external_outflow` | Balance went down, but this service sent nothing |

**Amounts** are handled as `bigint` wei in code and stored as decimal strings. A JavaScript `number` loses precision above 2⁵³ and SQLite integers stop at 2⁶³; strings never round.

## Deposit handling

The service compares the balance between two polls; it does not look at individual transactions. As a result:

| Situation | What is recorded |
|---|---|
| Several deposits within one polling interval (e.g. +0.1 then +0.2 ETH) | **One** `inflow` row of +0.3 ETH. Individual deposits are not distinguished. |
| Service offline for a while | Nothing while offline. On restart, the first poll records **one** row for the total change. No funds are missed in the balance; only the per-deposit detail is lost. |
| A wallet is not watched for a while (`WALLET_COUNT` lowered, then raised) | Same as offline: one row covering the whole gap. |

Per-deposit detail would require scanning blocks for transactions to the watched addresses, or a provider webhook. That is out of scope here.

## Security

- The **mnemonic is the only secret**. It is read from `.env`, which is git-ignored, and is never logged or returned. Error messages never include input values.
- **Private keys are never stored**: recomputed from the mnemonic on demand.
- The balance-reading client has no key material and cannot sign.
- **Testnet only.** In production, the mnemonic would live in a KMS or HSM, or be replaced by MPC signing.

## Design choices and trade-offs

| Choice | Why | Trade-off |
|---|---|---|
| Ethereum Sepolia, native ETH | Worst-case fee is exactly `gasLimit × maxFeePerGas` | On an L2 (e.g. Base), an extra L1 data fee would need estimating |
| Polling every 8 minutes | Simple, no third-party dependency, works after downtime | Deposits within one interval are merged; up to 8 minutes of delay |
| SQLite via `node:sqlite` | Transactions, single local file, nothing to install | Node prints an `ExperimentalWarning` at startup |
| Withdrawals from each wallet directly | Keeps the scope small | In production, deposit wallets would be swept to a hot/cold wallet structure |

## Scripts

| Command | What it does |
|---|---|
| `pnpm start` | Start the service |
| `pnpm dev` | Start with auto-restart on file changes |
| `pnpm test` | Run the unit tests (Vitest) |
| `pnpm typecheck` | Type-check with `tsc` |
| `pnpm lint` / `pnpm lint:fix` | Lint and format with Biome |
| `pnpm generate:mnemonic` | Print a fresh testnet mnemonic |

## Tests

```bash
pnpm test
```

- **Wallet generation**: known test vector (Hardhat's public mnemonic), determinism, adding and removing wallets, range limits, invalid mnemonics, no key material in the output.
- **Config**: every accepted and rejected `WALLET_COUNT` format, missing values, the mnemonic never appearing in error messages.
- **Balance tracking**: change detection, DB writes, precision above 2⁶³, rollback when a write fails.

CI (GitHub Actions) runs type-check, lint and tests on every pull request. No secrets are needed.

## Project structure

```
src/
  index.ts             entry point: config → wallets → DB → poller
  config.ts            env validation (zod)
  generate-wallets.ts  HD wallet derivation
  chain.ts             read-only Sepolia client (viem)
  balance-change.ts    compares stored and on-chain balances
  db.ts                SQLite schema and queries
  poller.ts            8-minute balance poller
  shared/              zod schemas and types
scripts/
  generate-mnemonic.ts
test/                  unit tests (Vitest)
```
