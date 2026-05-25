# Club Pool Backend (Polygon + Polymarket) - MVP

This backend is responsible for:

- Discovering eligible Polymarket football “win” markets per club (Gamma API)
- Scheduling two tranches (T-48h and T-24h) per eligible match
- Performing offchain liquidity + risk checks
- Posting orders to Polymarket CLOB (authenticated endpoint)
- Recalculating “official token price” = `total pool value / total token supply`
- Persisting all state (pools, candidates, queue, positions, price snapshots)

## Quick start

1. Create and configure `.env` from `.env.example`
2. Create DB (Postgres) and run:

```bash
cd backend
npm install
cp .env.example .env
npx prisma generate
npx prisma migrate dev
```

3. Run the server/worker:

```bash
npm run dev
```

## Notes

- Order posting uses `@polymarket/clob-client-v2` with `POLY_SIGNATURE_TYPE=3` (`POLY_1271`). `POLY_FUNDER_ADDRESS` can be set explicitly, otherwise the backend derives the Polymarket Deposit Wallet from `EXECUTOR_PRIVATE_KEY`. No pool vault is passed as `taker`.
- Pool creation can run the full onchain setup in one call by posting `deployOnchain: true` to `POST /admin/pools`; when a vault address exists, the backend also derives/deploys the Deposit Wallet and approves pUSD unless `bootstrapPolymarket: false`.
- Polymarket trading readiness can be checked without moving capital:
  - `GET /admin/polymarket/deposit-wallet/derive`
  - `POST /admin/polymarket/deposit-wallet/deploy`
  - `POST /admin/polymarket/deposit-wallet/approve-pusd`
  - `POST /admin/polymarket/deposit-wallet/bootstrap`
  - `GET /admin/polymarket/readiness?tokenId=...`
- Onchain integration is implemented as an optional adapter (`src/onchain/vaultExecutor.ts`). You must set:
  - `VAULT_CONTRACT_ADDRESS`
  - `RPC_URL`
  - `EXECUTOR_PRIVATE_KEY`
- Smart contracts live in `contracts/` and are compiled/tested with Hardhat:
  - `npm run contracts:compile`
  - `npm run contracts:test`
- Base deposits are USDC-only in v1. Users approve/deposit USDC into `BaseDepositReceiver`; the backend relayer bridges Base USDC to Polygon USDC through LI.FI, deposits into the Polygon vault, then mints wrapped shares on Base.
