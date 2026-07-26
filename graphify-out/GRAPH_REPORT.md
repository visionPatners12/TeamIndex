# Graph Report - TeamIndex  (2026-07-25)

## Corpus Check
- 105 files · ~70,738 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 760 nodes · 1719 edges · 42 communities (35 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b055e284`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 43|Community 43]]

## God Nodes (most connected - your core abstractions)
1. `Env` - 42 edges
2. `executeLimitlessTranche()` - 35 edges
3. `getVaultContract()` - 35 edges
4. `scripts` - 25 edges
5. `syncLimitlessPortfolioForPool()` - 20 edges
6. `postLimitlessOrder()` - 18 edges
7. `getBaseProvider()` - 17 edges
8. `runAllocationEngine()` - 17 edges
9. `withBaseRpcRetry()` - 16 edges
10. `recalculateOfficialPrices()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `recalculateOfficialPrices()` --calls--> `getMidpoint()`  [INFERRED]
  src/services/priceEngine.ts → src/limitless/limitlessOrderClient.ts
- `main()` --calls--> `startLimitlessPortfolioPollingTicker()`  [EXTRACTED]
  src/index.ts → src/workers/limitlessPortfolioPollingTicker.ts
- `main()` --calls--> `startLimitlessWebsocketTicker()`  [EXTRACTED]
  src/index.ts → src/workers/limitlessWebsocketTicker.ts
- `main()` --calls--> `startVaultSyncTicker()`  [EXTRACTED]
  src/index.ts → src/workers/vaultSyncTicker.ts
- `startLimitlessWebsocketTicker()` --calls--> `limitlessWebsocketAuthHeaders()`  [EXTRACTED]
  src/workers/limitlessWebsocketTicker.ts → src/limitless/limitlessAuth.ts

## Import Cycles
- None detected.

## Communities (42 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (60): getOrderBook(), base6ToNumber(), claimQueue(), decToNumber(), ensurePoolLimitlessServerWallet(), ExecuteLimitlessParams, executeLimitlessTranche(), finishQueue() (+52 more)

### Community 1 - "Community 1"
Cohesion: 0.15
Nodes (27): discoverLimitlessClubCandidates(), assertUuid(), ColumnRow, getCachedLimitlessMarketsForTeam(), getEntityLinkedLimitlessMarketsForTeam(), getLegacyLimitlessTeamCounts(), getLimitlessMarketsForTeam(), getLimitlessTeamCountsFromEntityLinks() (+19 more)

### Community 2 - "Community 2"
Cohesion: 0.08
Nodes (47): alignedLogitReturnCorr(), blendedCorr(), buildCovariance(), chosenSideSeries(), clamp(), computeEdge(), computeTsFeatures(), Edge (+39 more)

### Community 3 - "Community 3"
Cohesion: 0.09
Nodes (38): Env, EnvSchema, loadEnv(), createLogger(), SerializedError, assertRequiredTablesExist(), baselineMigrations, commandErrorOutput() (+30 more)

### Community 4 - "Community 4"
Cohesion: 0.12
Nodes (17): dependencies, bullmq, @coinbase/cdp-sdk, dotenv, ethers, express, ioredis, pino (+9 more)

### Community 5 - "Community 5"
Cohesion: 0.08
Nodes (56): ERC20, USDC4626VAULT, CLUB_VAULT_FACTORY_ABI, computeClubId(), ensureClubVaultExists(), syncVaultEventsToDb(), getBaseProvider(), adminAddAuthorizedOperator() (+48 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (26): authHeaders(), detectSportHints(), extractPrices(), getHistoricalPrices(), getJson(), limitlessBase(), LimitlessCategory, LimitlessMarket (+18 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (54): globalForPrisma, assertAddress(), CdpSqlResponse, CdpTransferEvent, fetchVaultTransferEventsFromCdpSql(), isCdpSqlConfigured(), runCdpSqlQuery(), tokenFromEnv() (+46 more)

### Community 8 - "Community 8"
Cohesion: 0.08
Nodes (25): scripts, build, contracts:check-balance, contracts:compile, contracts:deploy:base, contracts:deploy:base:vault-factory, contracts:deploy:chiliz, contracts:deploy:polygon (+17 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (16): `artifacts/api-server` (`@workspace/api-server`), `artifacts/team-index` (`@workspace/team-index`), Environment Variables, `lib/api-client-react` (`@workspace/api-client-react`), `lib/api-spec` (`@workspace/api-spec`), `lib/api-zod` (`@workspace/api-zod`), `lib/db` (`@workspace/db`), Overview (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.08
Nodes (47): serializeError(), hasLimitlessHmacConfig(), limitlessWsBase(), applyNormalizedPortfolioPositions(), asArray(), authHeaders(), extractRealizedPnl(), fetchPortfolioHistory() (+39 more)

### Community 12 - "Community 12"
Cohesion: 0.09
Nodes (40): buildPathWithQuery(), limitlessBase(), limitlessFetch(), limitlessGetJson(), limitlessRequestJson(), limitlessRequestTimeoutMs(), limitlessRestAuthHeaders(), limitlessWebsocketAuthHeaders() (+32 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir, resolveJsonModule, rootDir (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.06
Nodes (69): TEAM_INDEX_PUSD_VAULT_V2_ABI, activatePoolProposal(), allocatePoolCapital(), deployPoolVaultV2(), getPolygonExecutor(), getPolygonProvider(), getPusdVaultV2(), makePoolRedemptionClaimable() (+61 more)

### Community 15 - "Community 15"
Cohesion: 0.12
Nodes (16): devDependencies, chai, hardhat, @nomicfoundation/hardhat-ethers, @openzeppelin/contracts, @openzeppelin/contracts-upgradeable, prisma, ts-node (+8 more)

### Community 16 - "Community 16"
Cohesion: 0.29
Nodes (6): name, prisma, seed, private, type, version

### Community 19 - "Community 19"
Cohesion: 0.40
Nodes (4): name, organization_id, organization_slug, ref

### Community 20 - "Community 20"
Cohesion: 0.08
Nodes (20): APPROVE_SELECTOR, asChainId(), CdpPolymarketSigner, jsonSafe(), MERGE_POSITIONS_SELECTOR, PoolSigningContext, REDEEM_POSITIONS_SELECTOR, requireAddress() (+12 more)

### Community 21 - "Community 21"
Cohesion: 0.15
Nodes (12): Accounting and redemptions, Architecture and trust boundaries, Contract rollout, Deposit flow, Failure handling, Hard invariants, Pilot exit criteria, Polymarket V2 legacy recovery runbook (+4 more)

### Community 22 - "Community 22"
Cohesion: 0.22
Nodes (5): intentId, poolId, proposalId, redemptionId, swaggerSpec

### Community 27 - "Community 27"
Cohesion: 0.20
Nodes (9): Club Pool Backend (Polygon + Polymarket) - MVP, Components, Local validation, Notes, Polygon deployment, Quick start, Railway services, Target per-pool model (+1 more)

## Knowledge Gaps
- **214 isolated node(s):** `allow`, `PreToolUse`, `config`, `name`, `version` (+209 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Env` connect `Community 3` to `Community 0`, `Community 2`, `Community 5`, `Community 6`, `Community 7`, `Community 11`, `Community 12`, `Community 14`, `Community 20`?**
  _High betweenness centrality (0.071) - this node is a cross-community bridge._
- **Why does `runAllocationEngine()` connect `Community 2` to `Community 5`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `CdpPolymarketSigner` connect `Community 20` to `Community 5`, `Community 14`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `allow`, `PreToolUse`, `config` to the rest of the system?**
  _214 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07067307692307692 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.1471264367816092 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.07993966817496229 - nodes in this community are weakly interconnected._