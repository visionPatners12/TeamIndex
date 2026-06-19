# Graph Report - TeamIndex  (2026-06-19)

## Corpus Check
- 65 files · ~40,493 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 410 nodes · 786 edges · 31 communities (24 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `8cb730be`
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
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 43|Community 43]]

## God Nodes (most connected - your core abstractions)
1. `getVaultContract()` - 27 edges
2. `Env` - 20 edges
3. `runAllocationEngine()` - 17 edges
4. `executeLimitlessTranche()` - 16 edges
5. `scripts` - 15 edges
6. `fetchLimitlessMarketData()` - 12 edges
7. `compilerOptions` - 11 edges
8. `postLimitlessOrder()` - 10 edges
9. `clamp()` - 10 edges
10. `main()` - 9 edges

## Surprising Connections (you probably didn't know these)
- `recalculateOfficialPrices()` --calls--> `getMidpoint()`  [INFERRED]
  src/services/priceEngine.ts → src/limitless/limitlessOrderClient.ts
- `executeLimitlessTranche()` --calls--> `decodeLimitlessTokenId()`  [EXTRACTED]
  src/limitless/limitlessExecutor.ts → src/limitless/limitlessDiscoveryService.ts
- `syncLimitlessFillsAndSettle()` --calls--> `getMidpoint()`  [EXTRACTED]
  src/limitless/limitlessPositionSync.ts → src/limitless/limitlessOrderClient.ts
- `syncVaultEventsToDb()` --calls--> `getVaultContract()`  [EXTRACTED]
  src/onchain/poolSync.ts → src/onchain/vaultExecutor.ts
- `main()` --calls--> `loadEnv()`  [EXTRACTED]
  src/index.ts → src/config/env.ts

## Import Cycles
- None detected.

## Communities (31 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.10
Nodes (40): getMarketBySlug(), getOrderBook(), claimQueue(), decToNumber(), ExecuteLimitlessParams, executeLimitlessTranche(), finishQueue(), getLiquidityMinUsd() (+32 more)

### Community 1 - "Community 1"
Cohesion: 0.16
Nodes (18): discoverLimitlessClubCandidates(), assertUuid(), ColumnRow, getCachedLimitlessMarketsForTeam(), getLimitlessMarketsForTeam(), getSportsDataTeamName(), listLimitlessTeams(), mapRowsToMarkets() (+10 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (41): alignedLogitReturnCorr(), blendedCorr(), buildCovariance(), chosenSideSeries(), clamp(), computeEdge(), computeTsFeatures(), Edge (+33 more)

### Community 3 - "Community 3"
Cohesion: 0.11
Nodes (32): Env, EnvSchema, loadEnv(), createLogger(), assertRequiredTablesExist(), baselineMigrations, commandErrorOutput(), initDb() (+24 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (35): dependencies, bullmq, dotenv, ethers, express, ioredis, pino, @polymarket/builder-relayer-client (+27 more)

### Community 5 - "Community 5"
Cohesion: 0.10
Nodes (36): ERC20, USDC4626VAULT, CLUB_VAULT_FACTORY_ABI, computeClubId(), ensureClubVaultExists(), adminAddAuthorizedOperator(), adminAddTrustedStrategy(), adminAddWhitelistedContract() (+28 more)

### Community 6 - "Community 6"
Cohesion: 0.14
Nodes (22): authHeaders(), detectSportHints(), extractPrices(), getHistoricalPrices(), getJson(), limitlessBase(), LimitlessCategory, LimitlessMarket (+14 more)

### Community 7 - "Community 7"
Cohesion: 0.12
Nodes (26): globalForPrisma, compactRpcError(), errorText(), getLogsBlockChunkSize(), getRpcRateLimitCooldownUntil(), isRpcRateLimitError(), LogRetryLogger, normalizeOptions() (+18 more)

### Community 8 - "Community 8"
Cohesion: 0.13
Nodes (15): scripts, build, contracts:check-balance, contracts:compile, contracts:deploy:base, contracts:deploy:chiliz, contracts:deploy:polygon, contracts:diagnose:polygon (+7 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (16): `artifacts/api-server` (`@workspace/api-server`), `artifacts/team-index` (`@workspace/team-index`), Environment Variables, `lib/api-client-react` (`@workspace/api-client-react`), `lib/api-spec` (`@workspace/api-spec`), `lib/api-zod` (`@workspace/api-zod`), `lib/db` (`@workspace/db`), Overview (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.30
Nodes (13): asArray(), authHeaders(), fetchPortfolioPnlChart(), fetchPortfolioPositions(), fetchPortfolioTrades(), getJson(), JsonRecord, limitlessBase() (+5 more)

### Community 12 - "Community 12"
Cohesion: 0.24
Nodes (12): checkPartnerAccountAllowances(), createPartnerServerAccount(), hmacHeaders(), JsonRecord, limitlessBase(), limitlessJson(), partnerAccountCreationEnabled(), PartnerAccountResult (+4 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir, resolveJsonModule, rootDir (+4 more)

### Community 27 - "Community 27"
Cohesion: 0.50
Nodes (3): Club Pool Backend (Polygon + Polymarket) - MVP, Notes, Quick start

## Knowledge Gaps
- **121 isolated node(s):** `allow`, `PreToolUse`, `config`, `name`, `version` (+116 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Env` connect `Community 3` to `Community 0`, `Community 5`, `Community 6`, `Community 7`, `Community 11`, `Community 12`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **Why does `runAllocationEngine()` connect `Community 2` to `Community 5`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `executeLimitlessTranche()` connect `Community 0` to `Community 3`, `Community 5`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **What connects `allow`, `PreToolUse`, `config` to the rest of the system?**
  _121 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.10042283298097252 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09191919191919191 - nodes in this community are weakly interconnected._
- **Should `Community 3` be split into smaller, more focused modules?**
  _Cohesion score 0.10741971207087486 - nodes in this community are weakly interconnected._