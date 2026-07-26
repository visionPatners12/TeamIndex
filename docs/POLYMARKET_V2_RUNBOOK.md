# Polymarket V2 legacy recovery runbook

> **Current status (2026-07-25):** new Deposit Wallet bootstrap, funding,
> approvals and order execution are disabled. TeamIndex requires all pool assets
> to remain in the ERC-4626 vault, while Polymarket's public CLOB documentation
> does not document a generic custom ERC-1271 vault as maker/funder. The flows
> below describe the previous architecture and are retained only to recover or
> unwind already-created accounts. Do not use them for new pools.

## Architecture and trust boundaries

The active asset is Polygon pUSD. A pool is identified by the same `club_pools.id` and canonical `sports_data.teams.id` already shared with TeamIndex clients through Supabase.

```text
User wallet
  └─ signs pUSD transfer through its Polymarket Deposit Wallet
       └─ TeamIndexPUSDVaultV2 mints pool shares

TeamIndexPUSDVaultV2
  └─ proposal-capped pUSD allocation
       └─ pool Deposit Wallet (CLOB maker/funder, signature type 3)
            └─ Polymarket CTF Exchange / Neg Risk Exchange

Railway API/executor/accounting/WS
  └─ authenticated private request
       └─ Railway signer service
            └─ CDP-managed EOA (no exported private key)
```

The Deposit Wallet is not the vault. The vault is a smart contract with no key; the Deposit Wallet is the only external trading account. Its owner is a separate CDP EOA. The immutable registry prevents reuse of the same vault, Deposit Wallet or owner across pools.

## Hard invariants

- Chain ID is always `137`.
- Active asset is pUSD; amounts are handled as integer base units.
- CLOB orders use signature type `3` with the pool Deposit Wallet as maker/funder.
- Each accepted proposal is canonically hashed before any vault allocation.
- Each order is FAK and capped by `POLYMARKET_MAX_ORDER_PUSD` (default 25 pUSD).
- The contract hard cap for external allocation is 80%; the deployed operational default is 30%.
- The deployed minimum idle reserve is 20%.
- New deposits and allocations fail closed when external valuation is stale.
- The CDP signer rejects arbitrary messages, native value, other chains, other Deposit Wallets, other exchanges and unknown selectors.
- CLOB credentials are encrypted with per-pool authenticated context.
- No automatic key or account rotation exists. Any owner/Deposit Wallet mismatch stops bootstrap.
- There is no user geoblock. Only the Railway service's own egress is checked before trading.
- There is no oracle contract. The restricted valuator writes an aggregate reconciliation attestation directly to the vault.

## Supabase rollout

1. Back up the linked database and review migration `20260715000000_polymarket_v2_polygon_pusd`.
2. Apply it with `npx prisma migrate deploy` using the existing `team_index` schema connection.
3. Regenerate Prisma with `npx prisma generate`.
4. Confirm RLS is enabled on all new public tables. Backend services use the server database URL; clients must use dedicated read APIs or explicit policies.
5. Keep existing pool and team identifiers. Do not duplicate `sports_data` or create a second Supabase backend.

## Contract rollout

1. Run the compile and 33-contract-test suite.
2. Deploy V2 implementation, registry, factory and escrow on Polygon.
3. Save factory and escrow addresses in Railway.
4. Transfer factory/registry/escrow ownership to the intended multisig before increasing pilot limits.
5. Verify source code and deployment parameters on Polygonscan.
6. Keep every V1/Limitless contract untouched; the active backend never calls it.

The initial factory defaults are 30% external allocation, 20% idle reserve and 15-minute maximum valuation age. Change them only through an audited deployment/configuration decision.

## Railway layout

| Service | Public | Secrets | Start command |
| --- | --- | --- | --- |
| API | yes | database, admin key, Polygon operator key, signer URL/token | `npm run start:api` |
| Signer | no | database, CDP credentials, builder credentials, encryption key, signer token | `npm run start:signer` |
| Executor | no | database, Polygon operator key, signer URL/token, encryption key | `npm run start:executor` |
| Accounting | no | database, Polygon valuator key, encryption key | `npm run start:accounting` |
| Pool WS | no | database, encryption key | `npm run start:pool-ws` |

Use a private Railway hostname for `POLYMARKET_SIGNER_URL`. Health probes may call `/health`; the signer process returns `404` for every non-health, non-internal route. The bearer token comparison is timing-safe.

## Pool activation

1. Create or reuse the `club_pools` row linked to the canonical team ID.
2. Call `POST /admin/pools/:poolId/polymarket/bootstrap`.
   - CDP `getOrCreateAccount` produces one stable named EOA for the pool.
   - The relayer derives and deploys the EOA's Deposit Wallet.
   - The factory deploys and registers the vault if the pool has no V2 vault.
   - CLOB V2 credentials are derived and encrypted.
3. Call `POST /admin/pools/:poolId/polymarket/approvals`.
4. Call the reconciliation endpoint and compare database snapshot with on-chain NAV.
5. Enable user deposits for one pilot pool only.

## Deposit flow

The API creates an idempotent deposit intent. Preferred mode is a single Deposit Wallet batch: pUSD approval followed by `vault.deposit(assets, receiver)`. The API verifies the successful receipt and emitted vault deposit.

If the hosted relayer refuses a custom vault target, the response also provides an escrow transfer fallback. The user only transfers pUSD to the V2 escrow; after receipt verification, the escrow operator atomically deposits into the registered vault and cannot redirect shares to another pool.

## Trading flow

1. An allocation proposal is accepted and persisted.
2. Activation produces a canonical hash and capped immutable FAK intents.
3. The executor acquires a database lease/idempotency claim.
4. Immediately before each order, the vault transfers only that intent's pUSD budget to its Deposit Wallet.
5. The executor fetches current tick size, fee, neg-risk status, order book and market price.
6. CDP signs the type-3 order for the exact registered Deposit Wallet.
7. On success, error or cancellation, idle pUSD is returned to the vault and reconciled on-chain.
8. Ambiguous network responses become `NEEDS_RECONCILIATION`; they are never blindly retried.

## Accounting and redemptions

Authenticated user WebSocket events trigger a debounced REST reconciliation. The periodic accounting worker remains authoritative and records positions, trades and orders before writing the next monotonic valuation sequence to the vault.

Redemptions are asynchronous when cash is invested. A user first signs `requestRedeem`. After orders are cancelled and enough pUSD has returned, the operator calls `make-claimable`; the user can then claim. The endpoint intentionally fails if the vault does not yet have sufficient idle pUSD. The current pilot runbook therefore requires an operator to unwind/redeem Polymarket positions before marking a liquidity-constrained request claimable.

## Failure handling

- Pause the vault and stop the executor service if the signer or reconciliation invariant fails.
- Keep accounting running to recover visibility.
- Cancel all open orders and return idle pUSD through the admin endpoints.
- Never rotate or replace the CDP EOA automatically. A mismatch is a manual incident requiring registry and ownership review.
- Do not submit another order for a `NEEDS_RECONCILIATION` intent until its CLOB order/trade state is proven.
- Do not re-enable any Limitless route as a fallback.

## Pilot exit criteria

- Contract bytecode/source verified and ownership transferred.
- Supabase migration applied and RLS reviewed.
- Signer has no public domain and no CDP secret exists outside it.
- At least one complete deposit → allocation → FAK order → return → valuation → redemption cycle succeeds on Polygon.
- Monitoring alerts on stale valuation, signer rejection, reconciliation failure, ambiguous order state and external-allocation cap.
- Independent smart-contract and backend security review completed before increasing the 1,000 pUSD pilot cap.
