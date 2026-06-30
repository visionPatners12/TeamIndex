# Graph Report - TeamIndex  (2026-06-30)

## Corpus Check
- 78 files · ~53,596 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 547 nodes · 1179 edges · 37 communities (30 shown, 7 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 1 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `2135f8ba`
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
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 43|Community 43]]

## God Nodes (most connected - your core abstractions)
1. `getVaultContract()` - 34 edges
2. `executeLimitlessTranche()` - 28 edges
3. `Env` - 24 edges
4. `scripts` - 18 edges
5. `syncLimitlessPortfolioForPool()` - 17 edges
6. `getBaseProvider()` - 17 edges
7. `runAllocationEngine()` - 17 edges
8. `postLimitlessOrder()` - 16 edges
9. `recalculateOfficialPrices()` - 15 edges
10. `withBaseRpcRetry()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `recalculateOfficialPrices()` --calls--> `getMidpoint()`  [INFERRED]
  src/services/priceEngine.ts → src/limitless/limitlessOrderClient.ts
- `main()` --calls--> `startLimitlessWebsocketTicker()`  [EXTRACTED]
  src/index.ts → src/workers/limitlessWebsocketTicker.ts
- `main()` --calls--> `startVaultSyncTicker()`  [EXTRACTED]
  src/index.ts → src/workers/vaultSyncTicker.ts
- `getJson()` --calls--> `limitlessGetJson()`  [EXTRACTED]
  src/limitless/limitlessOrderClient.ts → src/limitless/limitlessAuth.ts
- `fetchPortfolioHistory()` --calls--> `limitlessGetJson()`  [EXTRACTED]
  src/limitless/limitlessPortfolio.ts → src/limitless/limitlessAuth.ts

## Import Cycles
- None detected.

## Communities (37 total, 7 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (51): getMarketBySlug(), getOrderBook(), claimQueue(), decToNumber(), ensurePoolLimitlessServerWallet(), ExecuteLimitlessParams, executeLimitlessTranche(), finishQueue() (+43 more)

### Community 1 - "Community 1"
Cohesion: 0.15
Nodes (25): assertUuid(), ColumnRow, getCachedLimitlessMarketsForTeam(), getEntityLinkedLimitlessMarketsForTeam(), getLegacyLimitlessTeamCounts(), getLimitlessMarketsForTeam(), getLimitlessTeamCountsFromEntityLinks(), getSportsDataTeamName() (+17 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (41): alignedLogitReturnCorr(), blendedCorr(), buildCovariance(), chosenSideSeries(), clamp(), computeEdge(), computeTsFeatures(), Edge (+33 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (34): Env, EnvSchema, loadEnv(), createLogger(), SerializedError, assertRequiredTablesExist(), baselineMigrations, commandErrorOutput() (+26 more)

### Community 4 - "Community 4"
Cohesion: 0.13
Nodes (15): dependencies, bullmq, dotenv, ethers, express, ioredis, pino, @polymarket/builder-relayer-client (+7 more)

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (40): ERC20, USDC4626VAULT, CLUB_VAULT_FACTORY_ABI, computeClubId(), ensureClubVaultExists(), syncVaultEventsToDb(), getBaseProvider(), adminAddAuthorizedOperator() (+32 more)

### Community 6 - "Community 6"
Cohesion: 0.12
Nodes (26): authHeaders(), detectSportHints(), extractPrices(), getHistoricalPrices(), getJson(), limitlessBase(), LimitlessCategory, LimitlessMarket (+18 more)

### Community 7 - "Community 7"
Cohesion: 0.07
Nodes (48): compactRpcError(), errorText(), getLogsBlockChunkSize(), getRpcRateLimitCooldownUntil(), isRpcRateLimitError(), LogRetryLogger, normalizeOptions(), positiveIntFromEnv() (+40 more)

### Community 8 - "Community 8"
Cohesion: 0.11
Nodes (18): scripts, build, contracts:check-balance, contracts:compile, contracts:deploy:base, contracts:deploy:base:vault-factory, contracts:deploy:chiliz, contracts:deploy:polygon (+10 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (16): `artifacts/api-server` (`@workspace/api-server`), `artifacts/team-index` (`@workspace/team-index`), Environment Variables, `lib/api-client-react` (`@workspace/api-client-react`), `lib/api-spec` (`@workspace/api-spec`), `lib/api-zod` (`@workspace/api-zod`), `lib/db` (`@workspace/db`), Overview (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.10
Nodes (39): serializeError(), applyNormalizedPortfolioPositions(), asArray(), authHeaders(), extractRealizedPnl(), fetchPortfolioHistory(), fetchPortfolioPnlChart(), fetchPortfolioPositions() (+31 more)

### Community 12 - "Community 12"
Cohesion: 0.11
Nodes (32): buildPathWithQuery(), hasLimitlessHmacConfig(), limitlessBase(), limitlessGetJson(), limitlessRequestJson(), limitlessRestAuthHeaders(), limitlessWebsocketAuthHeaders(), limitlessWsBase() (+24 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir, resolveJsonModule, rootDir (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.13
Nodes (15): devDependencies, chai, hardhat, @nomicfoundation/hardhat-ethers, @openzeppelin/contracts, @openzeppelin/contracts-upgradeable, prisma, ts-node (+7 more)

### Community 15 - "Community 15"
Cohesion: 0.29
Nodes (6): name, prisma, seed, private, type, version

### Community 16 - "Community 16"
Cohesion: 0.19
Nodes (14): assertAddress(), CdpSqlResponse, CdpTransferEvent, fetchVaultTransferEventsFromCdpSql(), isCdpSqlConfigured(), runCdpSqlQuery(), tokenFromEnv(), addTouchedHolder() (+6 more)

### Community 19 - "Community 19"
Cohesion: 0.40
Nodes (4): name, organization_id, organization_slug, ref

### Community 27 - "Community 27"
Cohesion: 0.50
Nodes (3): Club Pool Backend (Polygon + Polymarket) - MVP, Notes, Quick start

## Knowledge Gaps
- **145 isolated node(s):** `allow`, `PreToolUse`, `config`, `name`, `version` (+140 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Env` connect `Community 3` to `Community 0`, `Community 5`, `Community 6`, `Community 7`, `Community 11`, `Community 12`, `Community 16`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Why does `runAllocationEngine()` connect `Community 2` to `Community 5`?**
  _High betweenness centrality (0.018) - this node is a cross-community bridge._
- **Why does `syncLimitlessPortfolioForPool()` connect `Community 11` to `Community 5`?**
  _High betweenness centrality (0.013) - this node is a cross-community bridge._
- **What connects `allow`, `PreToolUse`, `config` to the rest of the system?**
  _145 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.07987012987012987 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.1455026455026455 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09191919191919191 - nodes in this community are weakly interconnected._