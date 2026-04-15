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


- Onchain integration is implemented as an optional adapter (`src/onchain/vaultExecutor.ts`). You must set:
  - `VAULT_CONTRACT_ADDRESS`
  - `RPC_URL`
  - `EXECUTOR_PRIVATE_KEY`

