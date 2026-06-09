# Graph Report - TeamIndex  (2026-06-05)

## Corpus Check
- 86 files · ~66,267 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 553 nodes · 867 edges · 48 communities (37 shown, 11 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 2 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `d8a4d438`
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
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]

## God Nodes (most connected - your core abstractions)
1. `getVaultContract()` - 24 edges
2. `compilerOptions` - 22 edges
3. `Env` - 18 edges
4. `runAllocationEngine()` - 17 edges
5. `scripts` - 15 edges
6. `executeLimitlessTranche()` - 15 edges
7. `fetchLimitlessMarketData()` - 12 edges
8. `customFetch()` - 11 edges
9. `compilerOptions` - 11 edges
10. `clamp()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `recalculateOfficialPrices()` --calls--> `getMidpoint()`  [INFERRED]
  src/services/priceEngine.ts → src/limitless/limitlessOrderClient.ts
- `healthCheck()` --calls--> `customFetch()`  [INFERRED]
  TeamIndex-Front/lib/api-client-react/src/generated/api.ts → TeamIndex-Front/lib/api-client-react/src/custom-fetch.ts
- `syncVaultEventsToDb()` --calls--> `queryFilterInBlockChunks()`  [EXTRACTED]
  src/onchain/poolSync.ts → src/onchain/ethersLogChunks.ts
- `main()` --calls--> `loadEnv()`  [EXTRACTED]
  src/index.ts → src/config/env.ts
- `main()` --calls--> `createLogger()`  [EXTRACTED]
  src/index.ts → src/config/log.ts

## Import Cycles
- None detected.

## Communities (48 total, 11 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (47): globalForPrisma, getMarketBySlug(), getOrderBook(), decodeLimitlessTokenId(), discoverLimitlessClubCandidates(), DiscoverLimitlessInputs, claimQueue(), decToNumber() (+39 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (40): Awaited, AwaitedInput, getHealthCheckQueryKey(), getHealthCheckQueryOptions(), getHealthCheckUrl(), healthCheck(), HealthCheckQueryError, HealthCheckQueryResult (+32 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (41): alignedLogitReturnCorr(), blendedCorr(), buildCovariance(), chosenSideSeries(), clamp(), computeEdge(), computeTsFeatures(), Edge (+33 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (30): Env, EnvSchema, loadEnv(), createLogger(), initDb(), CLUB_VAULT_FACTORY_ABI, computeClubId(), ensureClubVaultExists() (+22 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (35): dependencies, bullmq, dotenv, ethers, express, ioredis, pino, @polymarket/builder-relayer-client (+27 more)

### Community 5 - "Community 5"
Cohesion: 0.13
Nodes (28): ERC20, USDC4626VAULT, decToStr(), SyncInputs, syncVaultEventsToDb(), adminAddAuthorizedOperator(), adminAddTrustedStrategy(), adminAddWhitelistedContract() (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.14
Nodes (22): authHeaders(), detectSportHints(), extractPrices(), getHistoricalPrices(), getJson(), limitlessBase(), LimitlessCategory, LimitlessMarket (+14 more)

### Community 7 - "Community 7"
Cohesion: 0.15
Nodes (22): compactRpcError(), errorText(), getLogsBlockChunkSize(), getRpcRateLimitCooldownUntil(), isRpcRateLimitError(), LogRetryLogger, normalizeOptions(), positiveIntFromEnv() (+14 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (22): compilerOptions, alwaysStrict, customConditions, isolatedModules, lib, module, moduleResolution, noEmitOnError (+14 more)

### Community 9 - "Community 9"
Cohesion: 0.11
Nodes (18): dependencies, drizzle-orm, drizzle-zod, pg, zod, devDependencies, drizzle-kit, @types/node (+10 more)

### Community 10 - "Community 10"
Cohesion: 0.12
Nodes (16): `artifacts/api-server` (`@workspace/api-server`), `artifacts/team-index` (`@workspace/team-index`), Environment Variables, `lib/api-client-react` (`@workspace/api-client-react`), `lib/api-spec` (`@workspace/api-spec`), `lib/api-zod` (`@workspace/api-zod`), `lib/db` (`@workspace/db`), Overview (+8 more)

### Community 11 - "Community 11"
Cohesion: 0.13
Nodes (15): scripts, build, contracts:check-balance, contracts:compile, contracts:deploy:base, contracts:deploy:chiliz, contracts:deploy:polygon, contracts:diagnose:polygon (+7 more)

### Community 12 - "Community 12"
Cohesion: 0.15
Nodes (12): devDependencies, prettier, typescript, license, name, private, scripts, build (+4 more)

### Community 13 - "Community 13"
Cohesion: 0.15
Nodes (12): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir, resolveJsonModule, rootDir (+4 more)

### Community 14 - "Community 14"
Cohesion: 0.18
Nodes (10): devDependencies, tsx, @types/node, name, private, scripts, hello, typecheck (+2 more)

### Community 15 - "Community 15"
Cohesion: 0.20
Nodes (9): dependencies, @tanstack/react-query, exports, name, peerDependencies, react, private, type (+1 more)

### Community 16 - "Community 16"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, declarationMap, emitDeclarationOnly, lib, outDir, rootDir, extends (+1 more)

### Community 17 - "Community 17"
Cohesion: 0.20
Nodes (9): compilerOptions, composite, declarationMap, emitDeclarationOnly, outDir, rootDir, types, extends (+1 more)

### Community 18 - "Community 18"
Cohesion: 0.22
Nodes (8): compilerOptions, composite, declarationMap, emitDeclarationOnly, outDir, rootDir, extends, include

### Community 19 - "Community 19"
Cohesion: 0.25
Nodes (7): devDependencies, orval, name, private, scripts, codegen, version

### Community 20 - "Community 20"
Cohesion: 0.25
Nodes (7): dependencies, zod, exports, name, private, type, version

### Community 21 - "Community 21"
Cohesion: 0.29
Nodes (6): compilerOptions, outDir, rootDir, types, extends, include

### Community 22 - "Community 22"
Cohesion: 0.40
Nodes (3): apiClientReactSrc, apiZodSrc, root

### Community 23 - "Community 23"
Cohesion: 0.40
Nodes (4): compileOnSave, extends, files, references

### Community 24 - "Community 24"
Cohesion: 0.40
Nodes (4): buildCommand, framework, outputDirectory, rewrites

### Community 27 - "Community 27"
Cohesion: 0.50
Nodes (3): Club Pool Backend (Polygon + Polymarket) - MVP, Notes, Quick start

## Knowledge Gaps
- **235 isolated node(s):** `allow`, `PreToolUse`, `name`, `version`, `private` (+230 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Env` connect `Community 3` to `Community 0`, `Community 5`, `Community 6`, `Community 7`?**
  _High betweenness centrality (0.014) - this node is a cross-community bridge._
- **Why does `runAllocationEngine()` connect `Community 2` to `Community 5`?**
  _High betweenness centrality (0.009) - this node is a cross-community bridge._
- **Why does `scripts` connect `Community 11` to `Community 4`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **What connects `allow`, `PreToolUse`, `name` to the rest of the system?**
  _235 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08245981830887492 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08115942028985507 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09191919191919191 - nodes in this community are weakly interconnected._