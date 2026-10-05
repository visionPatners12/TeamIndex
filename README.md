# TeamIndex — Polygon Vault-Direct Custody

The target TeamIndex custody model keeps pUSD and conditional tokens entirely in each pool's ERC-4626 vault. Polymarket's public CLOB documentation does not currently list a generic custom ERC-1271 vault as a supported maker/funder, so new Polymarket bootstrap, Deposit Wallet funding and order execution are deliberately fail-closed with `POLYMARKET_CUSTOM_VAULT_UNSUPPORTED`.

Read-only market data and legacy account recovery remain available. No new pool capital is moved to a Deposit Wallet. The API exposes the current capability at `/health`.

## Target per-pool model

Each pool has exactly:

- one `TeamIndexPUSDVaultV2` ERC-4626 vault;
- one CDP-managed EOA intended to sign only allowlisted typed data;
- one encrypted set of CLOB credentials;
- pUSD and conditional-token custody at the vault address.

The deployed V2 contracts and database still contain legacy Deposit Wallet fields for recovery and migration compatibility. They must not be used to bootstrap new accounts or allocate new capital. Enabling Vault-direct trading requires both a compatible vault implementation and explicit Polymarket CLOB support for that custom maker/funder.

There is no oracle contract. The accounting worker reconciles CLOB REST state, hashes the complete snapshot and sends only the aggregate external value, reserved collateral, sequence and timestamp directly to the vault's restricted `valuator` function.

## Components

- `contracts/TeamIndexPUSDVaultV2.sol`: capped vault, idle reserve, proposal budget, stale-NAV guard and asynchronous redemptions.
- `contracts/TeamIndexRegistryV2.sol`: legacy V2 registry retained for migration/recovery.
- `contracts/TeamIndexVaultFactoryV2.sol`: deterministic pool setup through ERC-1167 clones.
- `contracts/TeamIndexDepositEscrowV2.sol`: deposit fallback if the hosted relayer refuses a direct Deposit-Wallet-to-vault call.
- `src/polymarket/`: CDP signer boundary, account bootstrap, CLOB V2 client, deposits, immutable trade intents, execution, reconciliation and market data.
- `src/workers/`: executor, accounting and per-pool authenticated WebSocket workers.
- `prisma/migrations/20260715000000_polymarket_v2_polygon_pusd/`: Supabase/Postgres V2 schema and RLS.

## Local validation

```bash
npm install
cp env.example .env
npx prisma generate
npm run build
npm run test:polymarket
npm run contracts:test
```

Apply the database migration to the existing Supabase project only after reviewing it against the linked environment:

```bash
npx prisma migrate deploy
```

## Polygon deployment

Set `RPC_URL` (or `POLYGON_RPC_URL`), Hardhat's Polygon deployer key
`EXECUTOR_PRIVATE_KEY` (or `POLYGON_EXECUTOR_PRIVATE_KEY`),
`POLYMARKET_OPERATOR_ADDRESS`, and `POLYMARKET_VALUATOR_ADDRESS`.
The deployer pays Polygon gas and initially owns the contracts. Before any
transaction, check the chain, pUSD bytecode/decimals, current gas price and
the full deployment budget:

```bash
TEAM_INDEX_DEPLOY_DRY_RUN=true npm run contracts:deploy:polygon:v2
```

The deployment refuses to broadcast while gas exceeds
`TEAM_INDEX_MAX_DEPLOY_GWEI` (default `60`) or the wallet lacks enough POL for
the complete deployment with a 20% fee buffer. When the preflight passes, run:

```bash
npm run contracts:deploy:polygon:v2
```

The script prints each confirmed transaction hash and address, then a final
JSON manifest. The implementation, registry, factory and escrow are
shared infrastructure; a **pool's vault address is different** and exists
only after creating that pool with its own Polymarket Deposit Wallet. Do not
use the implementation or factory address as a deposit receiver.

The V2 deploy script is retained for recovery testing. Do not call the legacy bootstrap or approvals endpoints: they return HTTP `501` until Polymarket supports the TeamIndex vault account type.

## Railway services

Build every service with `npm run build`, then use one start command per service:

- public API: `npm run start:api`
- private CDP signer: `npm run start:signer`
- trade executor: `npm run start:executor`
- accounting/valuation: `npm run start:accounting`
- authenticated pool WebSockets: `npm run start:pool-ws`
- public market price stream: `PROCESS_ROLE=market-ws npm start`

The market worker subscribes to selected outcome tokens and open-position
tokens, stores fresh best bids and asks in `polymarket_market_quotes`, and
reconnects when subscriptions change. The accounting worker uses a fresh best
bid to value held positions, writes both valuation and chart snapshots, and
falls back to the paginated Data API when no recent stream bid exists.

Only the private signer service receives CDP and builder credentials. It must not have a public Railway domain. API, executor and WebSocket services call it through `POLYMARKET_SIGNER_URL` with `POLYMARKET_SIGNER_TOKEN`. The Polygon operator/valuator key remains separate in `POLYGON_EXECUTOR_PRIVATE_KEY`; no key rotation is implemented.

See [docs/POLYMARKET_V2_RUNBOOK.md](docs/POLYMARKET_V2_RUNBOOK.md) for rollout, invariants and recovery procedures. Active endpoints are documented at `/docs`.

## pUSD deposit pilot (API only)

The public API can prepare a user's own Polygon pUSD `approve` and ERC-4626
`deposit` calls. The user signs both calls in their wallet. After the Polygon
transaction succeeds, `POST /pools/:poolId/pusd-deposit/confirm` checks the
vault's `Deposit` event and records the shares in Postgres. Repeating a
confirmation with the same transaction hash is idempotent.

For an API-only Railway service, build with `npm run build` and start with
`npm run start:api`. Set `DATABASE_URL`, `TRADING_PROVIDER=polymarket`,
`POLYGON_RPC_URL`, `ADMIN_API_KEY`, and `PROCESS_ROLE=api`. Run
`npx prisma migrate deploy` against the intended database before enabling
deposits. `DATABASE_URL` must point to PostgreSQL with `schema=team_index`.
A Supabase secret API key cannot replace it: this service uses Prisma SQL
transactions and migrations. Check `/health`: `db` and `sportsData` must both
be `true`, and `deposits.chainId` must be `137`.

`POST /admin/pools` requires `primarySportsDataTeamId`, the exact UUID of an
existing `sports_data.teams` row. The API rejects an unknown team and a second
index for the same team. For example, the current FC Barcelona row in the
connected sports database has ID `64e9330e-df17-44fc-88b4-37def5929767`;
look it up again before creating a live pool. A pool created without a vault
starts `PAUSED`. To activate it, attach a deployed Polygon pUSD V2 vault with
`PATCH /admin/pools/:poolId` and set `status` to `ACTIVE`. The API checks its
pUSD asset and Deposit Wallet. The frontend joins this same UUID to the club
profile for the logo and team-page link.

Leave `TEAM_INDEX_PUSD_DEPOSITS_ENABLED=false` until the pool record points to
a deployed `TeamIndexPUSDVaultV2` on Polygon with pUSD as its asset, and its
on-chain deposit cap does not exceed the pilot limit. Then set
`POLYMARKET_PILOT_TVL_PUSD` to the desired maximum and
`TEAM_INDEX_PUSD_DEPOSITS_ENABLED=true`. The API rejects preparation above the
pilot limit; the vault's on-chain cap is the final guard if deposits race.
The preparation body is `{ "assets": "1000000", "receiver": "0x..." }`
for 1 pUSD (6 decimals). The confirmation body is `{ "txHash": "0x..." }`.

This pilot only accepts deposits into an existing vault. Factory deployment,
pool creation and CLOB order execution are separate steps; order execution
remains disabled by the vault-direct capability guard.
