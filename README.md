# Wallet Watcher

[![CI](https://github.com/SiegfriedBz/wallet-watcher/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SiegfriedBz/wallet-watcher/actions/workflows/ci.yml)

A small custody-style backend in Node.js and TypeScript, on the **Sepolia testnet**.

- Derives a set of Ethereum wallets from a single mnemonic.
- Tracks their ETH balances and records every change in an append-only ledger.
- Builds and signs withdrawal transactions, and optionally broadcasts them.
- Exposes all of it through a small HTTP API.

> Testnet only. Never use a mnemonic that holds real funds.

## What it does

| Feature | How |
|---|---|
| **Wallet generation** | `WALLET_COUNT` wallets (1 to 20) derived from one mnemonic (BIP-44). Deterministic: the wallet at a given index is always the same. |
| **Balance tracking** | Every wallet's balance is read on-chain at startup and every 8 minutes, and persisted in SQLite. Any on-chain change is reflected within 10 minutes. |
| **Balance-change log** | An append-only ledger: inflows detected by tracking, outflows recorded only for withdrawals the service actually broadcast. |
| **Withdrawals** | Build and sign a transaction from a selected wallet to any address. Returned as JSON (payload + signature), or broadcast and recorded as an outflow. |
| **API** | `GET /wallets` (addresses and balances), `POST /withdrawals` (create, optionally broadcast; protected by an API key). |

## Status

| Feature | Status |
|---|---|
| HD wallet derivation (1 to 20 wallets) | ✅ |
| Balance tracking with an 8-minute poller | ✅ |
| SQLite ledger + current balances | ✅ |
| API: list wallets and balances | ✅ |
| Withdrawal: build and sign a transaction (protected) | ✅ |
| Withdrawal: broadcast and record the outflow | ✅ |

## Requirements

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`; tested on Node 24)
- **pnpm** 10
- A **Sepolia RPC URL** (Alchemy, Infura, or a public endpoint)

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm generate:mnemonic      # prints a new testnet mnemonic: paste it into .env yourself
openssl rand -hex 32        # prints a random admin key: paste it into .env yourself
```

Fill in `.env`:

```bash
MNEMONIC="word1 word2 ... word12"
WALLET_COUNT=5
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/<your-key>
PORT=3000                   # optional, defaults to 3000
ADMIN_API_KEY=<64 hex characters from openssl>
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
✅ API on http://127.0.0.1:3000
[poller] wallet #0: initial 0 wei
...
```

In another terminal:

```bash
curl -s http://127.0.0.1:3000/wallets
```

Send some Sepolia ETH to one of the printed addresses (from a faucet or another wallet). Within 8 minutes the service logs an `inflow` and `/wallets` shows the new balance.

## Configuration

All settings come from `.env`. They are validated once at startup, and the service refuses to start if anything is invalid. Error messages name the variable but never repeat its value.

| Variable | Rule |
|---|---|
| `MNEMONIC` | A valid 12- or 24-word BIP-39 phrase (checksum verified). Surrounding spaces are ignored. |
| `WALLET_COUNT` | Digits only, integer from 1 to 20 (`"3.5"`, `"0x10"`, `" 7 "` are rejected). |
| `RPC_URL` | A valid URL to a **Sepolia** node. Checked at startup (`eth_chainId`): the service refuses to start on any other network. |
| `PORT` | Optional. Digits only, 1 to 65535. Default `3000`. |
| `ADMIN_API_KEY` | Required, at least 32 characters. Protects `POST /withdrawals`. Generate with `openssl rand -hex 32`. |

## API

The API listens on `127.0.0.1` only: it is an admin tool, not reachable from other machines.

| Method | Path | Auth | Returns |
|---|---|---|---|
| `GET` | `/health` | — | `{ "status": "ok" }` |
| `GET` | `/wallets` | — | Every watched wallet with its balance |
| `POST` | `/withdrawals` | `Bearer ADMIN_API_KEY` | A signed withdrawal transaction, optionally broadcast |

All amounts in requests and responses are **strings**: JSON has no bigint type, and a JSON number would lose precision.

### `GET /wallets`

```json
{
  "chainId": 11155111,
  "lastPolledAt": "2026-10-01T17:10:02.114Z",
  "wallets": [
    {
      "index": 0,
      "address": "0x5963…4Ed5",
      "balanceWei": "1000000000000000",
      "balanceEth": "0.001",
      "balanceChangedAt": "2026-10-01T12:38:09.393Z"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `lastPolledAt` | Start of the last completed poll round: every balance was read on-chain after this time. `null` until the first round finishes. |
| `balanceWei` / `balanceEth` | The balance, exact. `balanceEth` is for display. `null` if the wallet has not been polled yet. |
| `balanceChangedAt` | When this wallet's balance last changed (not when it was last checked). |

Only wallets `0` to `WALLET_COUNT − 1` are listed. Balances are read from the database (see [Balance tracking](#balance-tracking)).

### `POST /withdrawals`

Builds and signs a transaction sending ETH from one watched wallet to any address. By default it is **not broadcast**: nothing moves on-chain and nothing is recorded. With `"broadcast": true`, the service also sends it (see [Broadcast and outflow recording](#broadcast-and-outflow-recording)).

```bash
KEY=$(grep '^ADMIN_API_KEY=' .env | cut -d= -f2)

# build and sign only
curl -s -X POST http://127.0.0.1:3000/withdrawals \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"fromIndex":0,"to":"0x8c10Cce599693f9D0c9c3C14B130f3137379E873","amountEth":"0.0005"}'

# build, sign and broadcast
curl -s -X POST http://127.0.0.1:3000/withdrawals \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"fromIndex":0,"to":"0x8c10Cce599693f9D0c9c3C14B130f3137379E873","amountEth":"0.0005","broadcast":true}'
# then look up the returned hash on https://sepolia.etherscan.io/tx/<hash>
```

**Request**

| Field | Rule |
|---|---|
| `fromIndex` | Integer, `0` to `WALLET_COUNT − 1`. Only watched wallets can send. |
| `to` | An Ethereum address: lowercase, or correctly checksummed (a mixed-case typo is rejected). Not the zero address. |
| `amountEth` | A **string** in ETH, e.g. `"0.0005"`. Digits with at most 18 decimals, greater than 0. No sign, no exponent, no JSON number. |
| `broadcast` | Optional boolean, default `false`. `true` = also send the transaction. |

Unknown fields are rejected.

**Response `200`** (not broadcast)

```json
{
  "broadcast": false,
  "from": "0x5963…4Ed5",
  "hash": "0x…",
  "transaction": {
    "type": "eip1559",
    "chainId": 11155111,
    "to": "0x8c10…E873",
    "valueWei": "500000000000000",
    "valueEth": "0.0005",
    "nonce": 0,
    "gas": "21000",
    "maxFeePerGas": "…",
    "maxPriorityFeePerGas": "…",
    "maxFeeWei": "…"
  },
  "signature": { "r": "0x…", "s": "0x…", "yParity": 0 },
  "serializedTransaction": "0x02…"
}
```

| Field | Meaning |
|---|---|
| `transaction` | The transaction that was signed (the payload). `maxFeeWei` = `gas × maxFeePerGas`, the most the fee can be. |
| `signature` | The ECDSA signature produced by the `from` wallet. Anyone can recover the signer's address from it. |
| `serializedTransaction` | Transaction + signature, encoded (`0x02…` = EIP-1559). Ready to broadcast as-is. |
| `hash` | The transaction id, as Etherscan shows it once broadcast. |

**Response `202`** (`"broadcast": true`): the same body, with `"broadcast": true` and `"status": "pending"`. The transaction was sent; the ledger records the outflow once it is mined.

**Errors**

| Status | When | Body |
|---|---|---|
| `401` | Missing or wrong `Authorization` header. Nothing else runs. | — |
| `400` | Invalid JSON or invalid fields. No chain call. | `{ "error": "Invalid request", "issues": [{ "field", "message" }] }` |
| `409` | `broadcast: true`, but the wallet already has a withdrawal waiting to be mined, or has not been polled yet | `{ "error" }` |
| `422` | Valid request, but the balance cannot cover amount + worst-case fee | `{ "error", "balanceWei", "maxFeeWei", "maxSendableWei", "maxSendableEth" }` |
| `502` | `broadcast: true`, but sending failed. Nothing is recorded. | `{ "error" }` |
| `500` | Unexpected error (e.g. RPC down). Details are logged, never returned. | `{ "error": "Internal server error" }` |

## How it works

### Wallet derivation

Each wallet is derived from the mnemonic with the standard Ethereum path `m/44'/60'/0'/0/i`, where `i` is the wallet index.

- The same mnemonic and index always give the same wallet. Raising `WALLET_COUNT` adds new wallets after the existing ones; lowering it keeps the first ones.
- Private keys are never stored. Only `{ index, address }` leaves the derivation code.
- The addresses match MetaMask's: importing the mnemonic shows wallet #0 as Account 1, #1 as Account 2, and so on.

### Balance tracking

Plain ETH transfers emit no on-chain events, so the service **polls** balances. At startup, then every 8 minutes, it reads each wallet's balance and compares it with the stored one. A row is written only when something changed, so any change shows up within 10 minutes.

- A new round starts only after the previous one finished, so rounds never overlap.
- An RPC error on one wallet is logged; the other wallets are still checked and the service keeps running.

The API reads balances from the database, never from the chain: responses are fast, consistent with the ledger, and at most one poll interval old (`lastPolledAt` shows exactly how old). Withdrawals do the opposite (see below).

### Storage

A local SQLite file (`data/wallet-watcher-<chainId>.db`), so there is no database server to install. One file per chain, so balances from different networks never mix.

| Table | Content |
|---|---|
| `balances` | One row per wallet: the current balance. Overwritten when it changes. |
| `ledger` | One row per balance change, never edited or deleted: type, signed delta, balance after, tx hash (for withdrawals), timestamp. |
| `withdrawals` | One row per broadcast: tx hash, wallet, destination, amount, status (`pending` → `mined` / `reverted`), real fee. |

Writes that belong together (a balance and its ledger row; a settlement, its ledger row and the new balance) happen in a **single transaction**, so the tables always agree, even after a crash.

| Ledger type | Meaning |
|---|---|
| `initial` | First reading of a wallet |
| `inflow` | Balance went up |
| `outflow` | A withdrawal broadcast by this service, once mined: amount + real fee, with its tx hash |
| `external_outflow` | Balance went down, but this service sent nothing |

**Amounts** are `bigint` wei everywhere in the code. They are strings only at the edges: in requests (`amountEth`, converted exactly with `parseEther`), in the database, and in JSON responses. A JavaScript `number` would lose precision above 2⁵³; strings never round.

### Withdrawals

```
POST /withdrawals
  1. API key check (constant time)                → 401, nothing else runs
  2. Validate the request                         → 400, no chain call
  3. broadcast only: one pending withdrawal per
     wallet, wallet already polled                → 409
  4. Read fresh from the chain: balance, nonce, fees, gas estimate
  5. balance ≥ amount + gas × maxFeePerGas ?      → 422 with the max sendable amount
  6. Derive the wallet's key, sign
  7. not broadcast → 200, nothing recorded
     broadcast     → send (502 if it fails, nothing recorded)
                     → "pending" withdrawal recorded → 202
```

- **Fresh chain state, never the database.** The stored balance can be minutes old; a spend is always decided on the current on-chain balance.
- **Worst-case fee.** An EIP-1559 fee is at most `gas × maxFeePerGas`. The balance must cover the amount *plus* that worst case, so the network can never reject the transaction for lack of funds. Sending a wallet's entire balance therefore fails, and the `422` response says how much could be sent instead.
- **Gas** comes from `estimateGas`, so a destination contract that needs more than 21,000 gas is handled.
- **Nonce** is read with `blockTag: "pending"`, so a transaction still waiting to be mined is not reused.
- **Signing**: the private key for that one wallet is derived from the mnemonic, used once, and dropped. Only the signed transaction and the signature leave the signer.

### Broadcast and outflow recording

The real fee is only known once the transaction is mined, so a broadcast is recorded in two steps, linked by the tx hash:

| When | What is written |
|---|---|
| At broadcast | A `withdrawals` row: `pending`, amount, tx hash. The ledger is not touched: the balance has not changed yet. |
| At the next poll, once mined | In one transaction: status `mined` + real fee (`gasUsed × effectiveGasPrice`), **one** `outflow` ledger row of −(amount + fee), and the new balance. |

While a wallet has a pending withdrawal, the poller does not compare its balance: the chain does not show the transaction yet, and comparing would record a fake inflow. Once settled, the stored balance equals the on-chain balance, so the drop is **never counted twice**.

Example (Sepolia): sending 0.0005 ETH recorded one `outflow` of −0.000523183071527 ETH = 0.0005 + a real fee of 0.000023183071527, below the 0.000024728757984 worst case checked before signing. The receiving watched wallet recorded an `inflow` of exactly 0.0005.

| Case | Behaviour |
|---|---|
| Sending fails | `502`, nothing recorded |
| Crash between sending and recording (milliseconds) | The poller sees the drop and records `external_outflow`: the balance stays correct and the event is flagged |
| Transaction reverted | `outflow` = −fee only (gas is paid, the amount stays), status `reverted` |
| Deposit while a withdrawal is pending | Recorded as `inflow` right after the settlement |

## Deposit handling

The service compares the balance between two polls; it does not look at individual transactions. As a result:

| Situation | What is recorded |
|---|---|
| Several deposits within one polling interval (e.g. +0.1 then +0.2 ETH) | **One** `inflow` row of +0.3 ETH. Individual deposits are not distinguished. |
| Service offline for a while | Nothing while offline. On restart, the first poll records **one** row for the total change. No funds are missed in the balance; only the per-deposit detail is lost. |
| A wallet is not watched for a while (`WALLET_COUNT` lowered, then raised) | Same as offline: one row covering the whole gap. |

Per-deposit detail would require scanning blocks for transactions to the watched addresses, or a provider webhook. That is out of scope here.

## Security

- The **mnemonic is the only key material**. It is read from `.env`, which is git-ignored, and is never logged or returned. Error messages never include input values.
- **Private keys are never stored**: derived for one wallet at signing time, then dropped. The HTTP layer never sees the mnemonic or the RPC client; it receives "sign" and "broadcast" functions.
- **`POST /withdrawals` is protected** by `ADMIN_API_KEY` (Bearer token, compared in constant time), even without broadcast: a signed transaction can be broadcast by anyone who holds it, so building one is as sensitive as sending one.
- **Only watched wallets can send**, and the zero address is refused as a destination.
- The API listens on **localhost only**. Errors return a generic message; the request log contains method, path, status and duration, never bodies or headers.
- The balance-reading client has no key material and cannot sign.
- **Testnet enforced, not just documented**: at startup the service asks the RPC node for its chain id and refuses to start unless it is Sepolia.
- **The RPC URL is never logged.** Providers like Alchemy put the API key in the URL, and RPC error messages include it; logs use the short error message only.
- In production: the mnemonic in a KMS/HSM or MPC signing, mTLS or an identity provider in front of the API, and per-withdrawal limits or approvals.

## Design choices and trade-offs

| Choice | Why | Trade-off |
|---|---|---|
| Ethereum Sepolia, native ETH | Worst-case fee is exactly `gasLimit × maxFeePerGas` | On an L2 (e.g. Base), an extra L1 data fee would need estimating |
| Polling every 8 minutes | Simple, no third-party dependency, works after downtime | Deposits within one interval are merged; up to 8 minutes of delay |
| SQLite via `node:sqlite` | Transactions, single local file, nothing to install | Node prints an `ExperimentalWarning` at startup |
| API serves balances from the DB | Fast, consistent with the ledger, works if the RPC is down | Up to one poll interval old (shown by `lastPolledAt`) |
| Withdrawals read the chain fresh | A stale balance must never decide a spend | One RPC round-trip per withdrawal |
| Funds check on the worst-case fee | The network can never reject the tx for lack of funds | The last fraction of a balance cannot be sent while fees are high |
| Amounts in ETH as strings | Readable, and exact (`parseEther`, max 18 decimals) | Callers must send a string, not a number |
| Send recorded at broadcast, outflow at mining | One exact ledger row (amount + real fee); a sent tx can still fail | The outflow appears up to one poll interval after mining |
| One pending withdrawal per wallet | Simple settlement, no nonce race between two sends | A second broadcast from the same wallet waits until the first is mined |
| Settlement by the poller, not inside the request | The request returns at once; pending state survives a restart (it is in the DB) | No "mined" notification: check `/wallets` or Etherscan |
| API key + localhost | Simple, no external service | Single shared secret; no per-user identity or audit |
| Withdrawals from each wallet directly | Keeps the scope small | In production, deposit wallets would be swept to a hot/cold wallet structure |

## Known limitations

- **A broadcast transaction that is never mined** (dropped by the network) keeps its wallet "pending": the wallet's balance is not compared until then. Production would monitor pending transactions and replace them (same nonce, higher fee).
- **Two broadcasts for the same wallet at the exact same moment** could both pass the "pending" check; the second reuses the same nonce and is rejected by the node (`502`). Acceptable for a single-operator admin tool.
- **Deposits are not itemized** (see [Deposit handling](#deposit-handling)).

## Scripts

| Command | What it does |
|---|---|
| `pnpm start` | Start the service (poller + API) |
| `pnpm dev` | Start with auto-restart on file changes |
| `pnpm test` | Run the unit tests (Vitest) |
| `pnpm typecheck` | Type-check with `tsc` |
| `pnpm lint` / `pnpm lint:fix` | Lint and format with Biome |
| `pnpm generate:mnemonic` | Print a fresh testnet mnemonic |

## Tests

```bash
pnpm test
```

No network and no secrets needed: tests use Hardhat's public test mnemonic, an in-memory database and fake chain clients.

- **Wallet generation**: known test vector, determinism, adding and removing wallets, range limits, invalid mnemonics, no key material in the output.
- **Config**: every accepted and rejected `WALLET_COUNT` and `PORT` format, required `ADMIN_API_KEY`, missing values, secrets never appearing in error messages.
- **Balance tracking**: change detection, DB writes, precision above 2⁶³, rollback when a write fails.
- **Request validation**: ETH amounts converted exactly (up to 27 digits), rejected formats (`"1e-3"`, `".5"`, 19 decimals, JSON numbers), address checksums, wallet index range, `broadcast` flag, unknown fields.
- **Transaction building**: worst-case fee, the exact maximum sendable amount passes and one wei more fails, sending the whole balance fails.
- **Signing**: the signer recovered from the signature is the selected wallet, the signed fields match the request, no key material in the output.
- **Settlement**: amount + real fee for a mined transaction, fee only for a reverted one.
- **Poller**: nothing recorded while a withdrawal is pending, one outflow once mined, no double count on the next round, a deposit during the pending period recorded afterwards.
- **API**: wallet listing; `401` without or with a wrong key (and no chain call); `400` before any chain call; `422` with the max sendable amount; a transaction signed by the right wallet and nothing recorded when not broadcast; with broadcast: `202` + pending withdrawal and no ledger row yet, `409` when pending or not polled, `502` records nothing.
- **Safety guards**: the service refuses an RPC on another network; error messages never contain the RPC URL or its key.

CI (GitHub Actions) runs type-check, lint and tests on every pull request.

## Project structure

```
src/
  index.ts             entry point: config → wallets → chain check → DB → poller → API
  config.ts            env validation (zod)
  generate-wallets.ts  HD wallet derivation (addresses only)
  chain.ts             network definition, testnet guard, read-only client, fresh reads for withdrawals
  balance-change.ts    compares stored and on-chain balances
  db.ts                SQLite schema and queries
  poller.ts            8-minute poller: balances + settlement of broadcast withdrawals
  withdrawal.ts        funds check + unsigned transaction (pure)
  signer.ts            derives one wallet's key and signs
  settlement.ts        real cost of a mined withdrawal (pure)
  api.ts               HTTP API (Hono)
  shared/              zod schemas, types, safe error messages
scripts/
  generate-mnemonic.ts
test/                  unit tests (Vitest)
```
