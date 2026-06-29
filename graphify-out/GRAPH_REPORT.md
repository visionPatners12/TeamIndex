# Graph Report - TeamIndex  (2026-06-29)

## Corpus Check
- 74 files · ~51,384 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 518 nodes · 1089 edges · 33 communities (26 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f2041665`
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
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 43|Community 43]]

## God Nodes (most connected - your core abstractions)
1. `getVaultContract()` - 29 edges
2. `Env` - 24 edges
3. `executeLimitlessTranche()` - 18 edges
4. `syncLimitlessPortfolioForPool()` - 17 edges
5. `runAllocationEngine()` - 17 edges
6. `scripts` - 16 edges
7. `postLimitlessOrder()` - 15 edges
8. `getBaseProvider()` - 14 edges
9. `recalculateOfficialPrices()` - 14 edges
10. `withBaseRpcRetry()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `recalculateOfficialPrices()` --calls--> `getMidpoint()`  [INFERRED]
  src/services/priceEngine.ts → src/limitless/limitlessOrderClient.ts
- `main()` --calls--> `startLimitlessWebsocketTicker()`  [EXTRACTED]
  src/index.ts → src/workers/limitlessWebsocketTicker.ts
- `main()` --calls--> `startVaultSyncTicker()`  [EXTRACTED]
  src/index.ts → src/workers/vaultSyncTicker.ts
- `startLimitlessWebsocketTicker()` --calls--> `limitlessWebsocketAuthHeaders()`  [EXTRACTED]
  src/workers/limitlessWebsocketTicker.ts → src/limitless/limitlessAuth.ts
- `getJson()` --calls--> `limitlessGetJson()`  [EXTRACTED]
  src/limitless/limitlessOrderClient.ts → src/limitless/limitlessAuth.ts

## Import Cycles
- None detected.

## Communities (33 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (49): getMarketBySlug(), getOrderBook(), claimQueue(), decToNumber(), ExecuteLimitlessParams, executeLimitlessTranche(), finishQueue(), getLiquidityMinUsd() (+41 more)

### Community 1 - "Community 1"
Cohesion: 0.14
Nodes (26): discoverLimitlessClubCandidates(), assertUuid(), ColumnRow, getCachedLimitlessMarketsForTeam(), getEntityLinkedLimitlessMarketsForTeam(), getLegacyLimitlessTeamCounts(), getLimitlessMarketsForTeam(), getLimitlessTeamCountsFromEntityLinks() (+18 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (41): alignedLogitReturnCorr(), blendedCorr(), buildCovariance(), chosenSideSeries(), clamp(), computeEdge(), computeTsFeatures(), Edge (+33 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (31): Env, EnvSchema, loadEnv(), createLogger(), assertRequiredTablesExist(), baselineMigrations, commandErrorOutput(), initDb() (+23 more)

### Community 4 - "Community 4"
Cohesion: 0.13
Nodes (15): dependencies, bullmq, dotenv, ethers, express, ioredis, pino, @polymarket/builder-relayer-client (+7 more)

### Community 5 - "Community 5"
Cohesion: 0.14
Nodes (28): ERC20, USDC4626VAULT, adminAddAuthorizedOperator(), adminAddTrustedStrategy(), adminAddWhitelistedContract(), adminPause(), adminRemoveAuthorizedOperator(), adminRemoveTrustedStrategy() (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (26): authHeaders(), detectSportHints(), extractPrices(), getHistoricalPrices(), getJson(), limitlessBase(), LimitlessCategory, LimitlessMarket (+18 more)

### Community 7 - "Community 7"
Cohesion: 0.06
Nodes (65): assertAddress(), CdpSqlResponse, CdpTransferEvent, fetchVaultTransferEventsFromCdpSql(), isCdpSqlConfigured(), runCdpSqlQuery(), tokenFromEnv(), CLUB_VAULT_FACTORY_ABI (+57 more)

### Community 8 - "Community 8"
Cohesion: 0.12
Nodes (16): scripts, build, contracts:check-balance, contracts:compile, contracts:deploy:base, contracts:deploy:chiliz, contracts:deploy:polygon, contracts:diagnose:polygon (+8 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (16): `artifacts/api-server` (`@workspace/api-server`), `artifacts/team-index` (`@workspace/team-index`), Environment Variables, `lib/api-client-react` (`@workspace/api-client-react`), `lib/api-spec` (`@workspace/api-spec`), `lib/api-zod` (`@workspace/api-zod`), `lib/db` (`@workspace/db`), Overview (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.09
Nodes (42): hasLimitlessHmacConfig(), limitlessGetJson(), limitlessWsBase(), applyNormalizedPortfolioPositions(), asArray(), authHeaders(), extractRealizedPnl(), fetchPortfolioHistory() (+34 more)

### Community 12 - "Community 12"
Cohesion: 0.14
Nodes (26): buildPathWithQuery(), limitlessBase(), limitlessRequestJson(), limitlessRestAuthHeaders(), limitlessWebsocketAuthHeaders(), requireLimitlessHmacConfig(), signLimitlessMessage(), asRecord() (+18 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir, resolveJsonModule, rootDir (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.13
Nodes (15): devDependencies, chai, hardhat, @nomicfoundation/hardhat-ethers, @openzeppelin/contracts, @openzeppelin/contracts-upgradeable, prisma, ts-node (+7 more)

### Community 15 - "Community 15"
Cohesion: 0.29
Nodes (6): name, prisma, seed, private, type, version

### Community 27 - "Community 27"
Cohesion: 0.50
Nodes (3): Club Pool Backend (Polygon + Polymarket) - MVP, Notes, Quick start

## Knowledge Gaps
- **137 isolated node(s):** `allow`, `PreToolUse`, `config`, `name`, `version` (+132 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Env` connect `Community 3` to `Community 0`, `Community 5`, `Community 6`, `Community 7`, `Community 11`, `Community 12`?**
  _High betweenness centrality (0.055) - this node is a cross-community bridge._
- **Why does `runAllocationEngine()` connect `Community 2` to `Community 5`?**
  _High betweenness centrality (0.020) - this node is a cross-community bridge._
- **Why does `syncLimitlessPortfolioForPool()` connect `Community 11` to `Community 5`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **What connects `allow`, `PreToolUse`, `config` to the rest of the system?**
  _137 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07826694619147449 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.13793103448275862 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09191919191919191 - nodes in this community are weakly interconnected._