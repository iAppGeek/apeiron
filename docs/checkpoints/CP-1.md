# CP-1: Foundations (Phases 1 and 2)

PR for review: phase-2-data (Phase 1 was merged earlier as PR #1). Tag: `cp-1`.

## What was built

### Phase 1: scaffold (merged, PR #1, CI green)
- pnpm 10.33 + Turborepo 2.11 monorepo, `engines.node >=24`, root scripts `build lint typecheck test dev` (plus `seed`).
- `@apeiron/tsconfig` (`base.json` strict + `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, NodeNext; `node.json`) and `@apeiron/eslint-config` (flat config: `no-explicit-any`, `explicit-function-return-type` with `allowExpressions` and `allowTypedFunctionExpressions`, `consistent-type-definitions: type`, `consistent-type-imports`, bans TODO/FIXME comments).
- `compose.yaml` at the repo root `include`s `infra/docker-compose.yml`. mongo 8 and nats 2 (`-js`, monitor 8222) with healthchecks and named volumes. Profiles: mongo in `core` and `seed`; nats in `core`; gaia in `seed`.
- `infra/docker/Dockerfile`: reusable multi-stage pattern (`--build-arg APP=<folder>`): `turbo prune --docker`, cached `pnpm install --frozen-lockfile`, `turbo run build --filter`, `pnpm deploy --legacy --prod`, `node:24-slim` runtime as non-root `node` user (verified `uid=1000(node)`).
- `.github/workflows/ci.yml` (PR + push to main; pnpm cache; caches the mongodb-memory-server binary; lint, typecheck, test, build), README, MIT licence, `.env.example`, `.gitignore` per spec.

### Phase 2: data
- `packages/logos`
  - `order.ts`: the 50-field `Order` type and enums (status, side, algo, order type, TIF, urgency, venue, tenor, 20 pairs), the 5 traders (weights, 3 accounts each) and the 20-pair table (mid, decimals, weight, daily vol, G10 flag).
  - `columns.ts`: `ColumnMeta` and the 50-column `COLUMNS` table (types, filter kinds, groupable set and aggregates exactly per Appendix B), `COLUMNS_VERSION` (FNV-1a fingerprint of the column list, for `welcome.columnsVersion`).
  - `prng.ts`: `mulberry32` plus sampling helpers (`normal`, `pickWeighted`, ...).
  - `generator.ts`: `generateOrders(seed, n, now)` and `generateOrderBatches({seed,n,now,batchSize})`, a lazy stream. Historical orders are produced day by day in `createdAt` order, then the current LIVE and PENDING_START orders, so IDs (`ALG` + 8-digit sequence) ascend through the stream.
  - `protocol.ts`: Appendix C types plus the zod schema `clientMsgSchema`/`parseClientMsg`.
  - `codec.ts`: `Codec` interface, `jsonCodec`, `msgpackCodec`, `getCodec`.
  - `fixtures.ts`: sample messages and orders shared by the specs.
- `packages/mnemosyne`
  - `OrderRepository` (`loadAll(batchSize?)`, `upsertMany`, `count`, `isSeeded`).
  - `MongoOrderRepository` (`_id = orderId`; indexes `{traderId:1, createdAt:-1}` and `{status:1}`; unordered `bulkWrite` `replaceOne` upserts; `loadAll` is a cursor sorted by `_id`, yielded in 10k batches and closed in `finally`).
  - `InMemoryOrderRepository` fake.
  - `repository.contract.ts` (`runOrderRepositoryContract(name, create)`, also exported as `@apeiron/mnemosyne/contract` for future adapters), run against Mongo (mongodb-memory-server) and the fake (11 behavioural tests each).
- `apps/gaia`: `runSeed` (idempotent, 10k batches, up to 4 concurrent bulk writes, progress, rows/s, total time), zod `config.ts`, `cli.ts`, `stats.ts` (`pnpm --filter @apeiron/gaia stats` prints the dataset statistics reproducibly), wired into compose under the `seed` profile with `depends_on: mongo: service_healthy`.

## Done criteria

| Criterion | Result |
|---|---|
| `pnpm build` passes; compose starts mongo and nats healthy; CI green (Phase 1) | Yes. PR #1 merged with green CI. |
| Seeder loads 1M rows in under 3 min | **11.4 s** (87k rows/s), against the compose mongo, via the container |
| Second run is a no-op | Yes: about 1 s total, no writes (`Already seeded`) |
| Generator deterministic, snapshot of first 100 rows | `packages/logos/src/__snapshots__/generator.spec.ts.snap`; also whole-stream and batch-size-independence tests |
| Contract tests pass against Mongo and the fake | 11 + 11 pass |
| JSON and msgpack round-trip every message type | `codec.spec.ts` round-trips all 14 sample messages (5 client types and the 8 server types, with both `error` variants) through both codecs |

## Deviations from the plan

1. **TypeScript 5.9.3, not the latest (7.0.2).** The plan says "TypeScript 5.x"; `typescript-eslint` 8.71 only supports `<6.1`.
2. **Git remote is HTTPS, not SSH.** `gh repo create --push` failed because this machine has no SSH key for GitHub. The repo was created, the remote was switched to `https://github.com/iAppGeek/apeiron.git`, and a repo-local `credential.helper = !gh auth git-credential` was set. No global git config was touched.
3. **`turbo.json` has `"agentGuidance": false`.** Turbo writes an `AGENTS.md` file when it detects an AI agent; I opted out and did not commit it.
4. **Added optional env vars** `SEED_NOW` (ISO time that pins "now" for full reproducibility) and `BATCH_SIZE` to gaia. Without `SEED_NOW` the dataset's "now" is the wall clock, so two seeds on different days differ in their absolute dates (the seed-run log prints the `now` used; the stats above were generated with it).
5. **Idempotency rule.** `isSeeded()` is `count > 0`, as the interface says. The seeder itself skips only when `count >= SEED_ROWS`, so a crashed partial run is completed by re-upserting the same deterministic data rather than skipped. No marker document was added, to keep the 4-method interface from the plan.
6. **`loadAll(batchSize?)`** has an optional batch-size parameter (the plan shows none); the default is 10k.
7. **`OrderRepository` extras live on the Mongo class only** (`connect()`, `clear()`, `close()`, `database`), not on the interface.
8. **London hours are approximated as UTC 07:00-17:00** (no DST handling).
9. **Spreads:** USDSEK and USDNOK are treated as G10 (0.5-3 bps), as the plan literally says; USDMXN, USDZAR, USDSGD, USDHKD, USDCNH and USDTRY are EM (5-30 bps). USDSEK/NOK at 0.5-3 bps is tight against real markets.
10. **Quantity floor.** Log-normal (median 6M, sigma 0.9) clamped to [1M, 100M], so about 1-2% of rows sit exactly on the 1M floor (visible as p1 = 1,000,000).
11. **Nullable fields.** `limitPrice` (MARKET orders), `avgFillPrice`, `lastFillPrice`, `slippageBps`, `vwapBenchmark`, `perfVsVwapBps`, `distanceToLimitBps` and `completedAt` are `number | null`. The plan does not say how "not applicable" is encoded; the engine will need NaN or a null mask in the typed arrays.
12. **Time encoding:** all timestamps and `valueDate` are epoch ms numbers (not `Date`), per Appendix F's Float64 guidance. `valueDate` is UTC midnight, T+2 business days for SPOT.
13. **Order type values** (not in the plan): LIMIT 70 / MARKET 20 / PEGGED 10; TIF DAY 60 / GTC 5 / IOC 10 / GTD 25; urgency LOW 25 / MEDIUM 50 / HIGH 25; 8 venues; tenor SPOT 85 / TOM 5 / 1W 4 / 1M 4 / 3M 2.
14. **`SsrmRequest`, `Row`, `TraderInfo`** are not defined in Appendix C; I defined them (`protocol.ts`, `order.ts`). `SsrmRequest` is the supported subset of AG Grid's request, with `filterModel` as `Record<string, unknown> | null`.
15. **Package build model.** Packages compile with `tsc` to `dist/` and are consumed via their `exports` (so `typecheck`, `lint`, `test` depend on `^build` in turbo).
16. **mongodb-memory-server** downloads a `mongod` 8.2.6 binary (76.6 MB, from fastdl.mongodb.org) on first test run (cached in `~/.cache/mongodb-binaries`; cached in CI). Its pnpm postinstall script is left unapproved on purpose so install does not download it.
17. No `vitest bench` or benchmarks yet (Phase 3). `pnpm dev` has no tasks until later phases.

## Verification output

### Lint, typecheck, test, build (raw, `--force`, no cache)

```
$ pnpm turbo run lint typecheck test build --force

   • turbo 2.11.7
   • Packages in scope: @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running lint, typecheck, test, build in 5 packages
   • Remote caching disabled

@apeiron/logos:typecheck: cache bypass, force executing 2be1753806dfa75f
@apeiron/logos:lint: cache bypass, force executing 18a448bf2ed78b55
@apeiron/logos:test: cache bypass, force executing e25cf73b94498218
@apeiron/logos:build: cache bypass, force executing 033f2c35ec008b26
@apeiron/logos:typecheck: 
@apeiron/logos:typecheck: > @apeiron/logos@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:typecheck: > tsc -p tsconfig.json
@apeiron/logos:typecheck: 
@apeiron/logos:lint: 
@apeiron/logos:lint: > @apeiron/logos@0.0.0 lint /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:lint: > eslint .
@apeiron/logos:lint: 
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/logos:test: 
@apeiron/logos:test: > @apeiron/logos@0.0.0 test /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:test: > vitest run
@apeiron/logos:test: 
@apeiron/logos:test: 
@apeiron/logos:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:test: 
@apeiron/logos:test:  ✓ src/order.spec.ts (4 tests) 3ms
@apeiron/logos:test:  ✓ src/columns.spec.ts (6 tests) 6ms
@apeiron/logos:test:  ✓ src/fixtures.spec.ts (1 test) 8ms
@apeiron/logos:test:  ✓ src/index.spec.ts (1 test) 1ms
@apeiron/logos:test:  ✓ src/protocol.spec.ts (6 tests) 10ms
@apeiron/logos:test:  ✓ src/codec.spec.ts (12 tests) 13ms
@apeiron/logos:test:  ✓ src/prng.spec.ts (9 tests) 336ms
@apeiron/logos:test:    ✓ mulberry32 (4)
@apeiron/logos:test:      ✓ stays in [0, 1) with a roughly uniform mean 315ms
@apeiron/mnemosyne:typecheck: cache bypass, force executing ab95c25d7a60c469
@apeiron/mnemosyne:build: cache bypass, force executing 8e53b508c8f333e4
@apeiron/mnemosyne:test: cache bypass, force executing b8a10bb1cb248fa6
@apeiron/mnemosyne:lint: cache bypass, force executing 2d7a68b0ea9382b6
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test: > @apeiron/mnemosyne@0.0.0 test /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:test: > vitest run
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:typecheck: 
@apeiron/mnemosyne:typecheck: > @apeiron/mnemosyne@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:typecheck: > tsc -p tsconfig.json
@apeiron/mnemosyne:typecheck: 
@apeiron/mnemosyne:lint: 
@apeiron/mnemosyne:lint: > @apeiron/mnemosyne@0.0.0 lint /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:lint: > eslint .
@apeiron/mnemosyne:lint: 
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  ✓ src/order-repository.spec.ts (1 test) 1ms
@apeiron/mnemosyne:test:  ✓ src/index.spec.ts (1 test) 2ms
@apeiron/gaia:test: cache bypass, force executing 04f4ec87711f224b
@apeiron/gaia:build: cache bypass, force executing 68533e92040ebc40
@apeiron/gaia:typecheck: cache bypass, force executing 9eb0f9acef320321
@apeiron/gaia:lint: cache bypass, force executing 1347f65b29649af6
@apeiron/gaia:typecheck: 
@apeiron/gaia:typecheck: > @apeiron/gaia@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:typecheck: > tsc -p tsconfig.json
@apeiron/gaia:typecheck: 
@apeiron/gaia:lint: 
@apeiron/gaia:lint: > @apeiron/gaia@0.0.0 lint /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:lint: > eslint .
@apeiron/gaia:lint: 
@apeiron/gaia:test: 
@apeiron/gaia:test: > @apeiron/gaia@0.0.0 test /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:test: > vitest run
@apeiron/gaia:test: 
@apeiron/gaia:build: 
@apeiron/gaia:build: > @apeiron/gaia@0.0.0 build /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:build: > tsc -p tsconfig.build.json
@apeiron/gaia:build: 
@apeiron/mnemosyne:test:  ✓ src/in-memory-order-repository.spec.ts (12 tests) 376ms
@apeiron/gaia:test: 
@apeiron/gaia:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:test: 
@apeiron/gaia:test:  ✓ src/stats-params.spec.ts (3 tests) 6ms
@apeiron/gaia:test:  ✓ src/config.spec.ts (4 tests) 7ms
@apeiron/gaia:test:  ✓ src/cli.spec.ts (4 tests) 42ms
@apeiron/gaia:test:  ✓ src/stats.spec.ts (6 tests) 77ms
@apeiron/gaia:test:  ✓ src/seed.spec.ts (6 tests) 133ms
@apeiron/gaia:test: 
@apeiron/gaia:test:  Test Files  5 passed (5)
@apeiron/gaia:test:       Tests  23 passed (23)
@apeiron/gaia:test:    Start at  22:05:48
@apeiron/gaia:test:    Duration  544ms (import 44%, transform 33%, tests 22%, worker 2%)
@apeiron/gaia:test: 
@apeiron/mnemosyne:test:  ✓ src/mongo-order-repository.spec.ts (13 tests) 1824ms
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  Test Files  4 passed (4)
@apeiron/mnemosyne:test:       Tests  27 passed (27)
@apeiron/mnemosyne:test:    Start at  22:05:47
@apeiron/mnemosyne:test:    Duration  2.08s (tests 84%, import 11%, transform 4%)
@apeiron/mnemosyne:test: 
@apeiron/logos:test:  ✓ src/generator.spec.ts (13 tests) 5109ms
@apeiron/logos:test:    ✓ generated data shape (8)
@apeiron/logos:test:      ✓ keeps historical createdAt ascending, on weekdays, within the last 182 days 1179ms
@apeiron/logos:test:      ✓ keeps every order internally consistent 3538ms
@apeiron/logos:test: 
@apeiron/logos:test:  Test Files  8 passed (8)
@apeiron/logos:test:       Tests  52 passed (52)
@apeiron/logos:test:    Start at  22:05:46
@apeiron/logos:test:    Duration  5.53s (tests 87%, import 7%, transform 5%)
@apeiron/logos:test: 

 Tasks:    12 successful, 12 total
Cached:    0 cached, 12 total
  Time:    6.08s 

exit=0
```

### Seeding: first run (compose stack, container `gaia`, mongo 8.3.11, 8 CPU / 6 GB Docker VM)

```
 Container apeiron-mongo-1 Running 
 Container apeiron-gaia-1 Creating 
 Container apeiron-gaia-1 Created 
Attaching to gaia-1
 Container apeiron-mongo-1 Waiting 
 Container apeiron-mongo-1 Healthy 
 Container apeiron-gaia-1 Starting 
 Container apeiron-gaia-1 Started 
[gaia] Seeding 1,000,000 rows (seed=42, now=2026-10-06T21:04:53.475Z, batch=10,000)
[gaia]   100,000 / 1,000,000 rows (68,859 rows/s)
[gaia]   200,000 / 1,000,000 rows (76,850 rows/s)
[gaia]   300,000 / 1,000,000 rows (79,799 rows/s)
[gaia]   400,000 / 1,000,000 rows (81,457 rows/s)
[gaia]   500,000 / 1,000,000 rows (83,588 rows/s)
[gaia]   600,000 / 1,000,000 rows (83,492 rows/s)
[gaia]   700,000 / 1,000,000 rows (84,664 rows/s)
[gaia]   800,000 / 1,000,000 rows (86,149 rows/s)
[gaia]   900,000 / 1,000,000 rows (86,708 rows/s)
[gaia]   1,000,000 / 1,000,000 rows (87,391 rows/s)
[gaia] Seeded 1,000,000 rows in 11.4s (87,390 rows/s)

[Kgaia-1 exited with code 0
docker compose --profile core --profile seed up --no-log-prefix gaia  0.05s user 0.04s system 0% cpu 12.375 total
```

### Seeding: second run (no-op)

```
 Container apeiron-mongo-1 Running 
Attaching to gaia-1
 Container apeiron-mongo-1 Waiting 
 Container apeiron-mongo-1 Healthy 
 Container apeiron-gaia-1 Starting 
 Container apeiron-gaia-1 Started 
[gaia] Already seeded: 1,000,000 rows present (target 1,000,000). Nothing to do.

[Kgaia-1 exited with code 0
docker compose --profile core --profile seed up --no-log-prefix gaia  0.04s user 0.03s system 6% cpu 1.077 total
```

Collection state afterwards: 1,000,000 docs; indexes `_id_`, `traderId_createdAt`, `status`; data size 1.08 GB, storage size 373 MB. Status counts from Mongo: FILLED 919,802; CANCELLED 79,598; LIVE 400; PENDING_START 200.

Extra measurement for Phase 3: streaming all 1M rows through `MongoOrderRepository.loadAll()` (100 batches of 10k) from the host took **9.0 s** (process RSS 932 MB, no retention).

Image size of `local/apeiron/gaia:dev`: 369 MB (runs as `uid=1000(node)`).

## Generator sample statistics

Generated with `SEED_NOW=2026-10-06T21:04:53.475Z pnpm --filter @apeiron/gaia stats`, which is the same `now` that the seed run used (1M rows, seed 42).

```
Total rows: 1,000,000; LIVE: 400; PENDING_START: 200
createdAt range: 2026-04-07T00:02:05.521Z .. 2026-10-06T21:04:38.336Z
Historical orders created 07:00-17:00 UTC: 84.99%; on weekends: 0
Slippage bps (filled orders): mean 0.504, sd 2.000

### Status

| value | count | share |
|---|---:|---:|
| FILLED | 919,802 | 91.98% |
| CANCELLED | 79,598 | 7.96% |
| LIVE | 400 | 0.04% |
| PENDING_START | 200 | 0.02% |

### Currency pair

| value | count | share |
|---|---:|---:|
| EURUSD | 250,546 | 25.05% |
| USDJPY | 149,920 | 14.99% |
| GBPUSD | 120,416 | 12.04% |
| AUDUSD | 69,604 | 6.96% |
| USDCAD | 60,176 | 6.02% |
| GBPJPY | 23,609 | 2.36% |
| USDNOK | 23,594 | 2.36% |
| AUDJPY | 23,496 | 2.35% |
| USDSEK | 23,486 | 2.35% |
| USDTRY | 23,483 | 2.35% |
| USDHKD | 23,344 | 2.33% |
| USDCHF | 23,318 | 2.33% |
| USDZAR | 23,270 | 2.33% |
| NZDUSD | 23,260 | 2.33% |
| USDCNH | 23,149 | 2.31% |
| EURCHF | 23,144 | 2.31% |
| EURJPY | 23,121 | 2.31% |
| USDMXN | 23,095 | 2.31% |
| USDSGD | 23,034 | 2.30% |
| EURGBP | 22,935 | 2.29% |

### Trader

| value | count | share |
|---|---:|---:|
| T1 | 350,532 | 35.05% |
| T2 | 250,019 | 25.00% |
| T3 | 199,302 | 19.93% |
| T4 | 120,402 | 12.04% |
| T5 | 79,745 | 7.97% |

### Algo

| value | count | share |
|---|---:|---:|
| TWAP | 300,339 | 30.03% |
| VWAP | 249,935 | 24.99% |
| POV | 150,200 | 15.02% |
| ICEBERG | 119,703 | 11.97% |
| IS | 99,966 | 10.00% |
| SNIPER | 79,857 | 7.99% |

### Side

| value | count | share |
|---|---:|---:|
| BUY | 500,360 | 50.04% |
| SELL | 499,640 | 49.96% |

### Order type

| value | count | share |
|---|---:|---:|
| LIMIT | 700,003 | 70.00% |
| MARKET | 199,884 | 19.99% |
| PEGGED | 100,113 | 10.01% |

### Venue

| value | count | share |
|---|---:|---:|
| LMAX | 180,129 | 18.01% |
| EBS | 160,662 | 16.07% |
| REFINITIV | 149,753 | 14.98% |
| CURRENEX | 120,227 | 12.02% |
| HOTSPOT | 120,211 | 12.02% |
| FXALL | 99,427 | 9.94% |
| BLOOMBERG | 89,932 | 8.99% |
| INTERNAL | 79,659 | 7.97% |

### Tenor

| value | count | share |
|---|---:|---:|
| SPOT | 849,867 | 84.99% |
| TOM | 50,223 | 5.02% |
| 1W | 40,044 | 4.00% |
| 1M | 39,765 | 3.98% |
| 3M | 20,101 | 2.01% |

### Order quantity (base ccy)

| min | p1 | p5 | p25 | p50 | p75 | p95 | p99 | max | mean |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000,000 | 1,000,000 | 1,400,000 | 3,300,000 | 6,000,000 | 11,000,000 | 26,300,000 | 48,600,000 | 100,000,000 | 8,973,446 |

### Notional USD

| min | p1 | p5 | p25 | p50 | p75 | p95 | p99 | max | mean |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 589,722 | 1,000,000 | 1,312,309 | 3,221,906 | 6,000,000 | 11,058,306 | 26,699,483 | 49,497,508 | 126,401,117 | 9,026,836 |

```

## Library versions

Node 25.8.2 locally (CI and images: Node 24), pnpm 10.33.0, turbo 2.11.7, TypeScript 5.9.3, vitest 5.0.3, eslint 10.12.0, typescript-eslint 8.71.1, @eslint/js 10.0.1, mongodb driver 7.7.0, mongodb-memory-server 11.3.0 (mongod 8.2.6), @msgpack/msgpack 3.1.3, zod 4.6.5, @types/node 24.19.1. Docker 29.8.1, Compose 5.5.1, images `mongo:8` (resolved to 8.3.11), `nats:2-alpine`, `node:24-slim`.

vitest 5.0.3 declares `engines.node ^22.12 || ^24 || >=26`, so it technically excludes the local Node 25; it works, and CI uses Node 24.

## Open questions and known weaknesses

- **Mongo version:** `mongo:8` floats to a rapid release (8.3.11) rather than an 8.0 LTS. Pin before sharing the compose file (a volume created on 8.3 cannot be opened by 8.0).
- **Clock-dependent dataset:** see deviation 4. CI/e2e that need stable absolute dates should set `SEED_NOW`.
- **Day volumes are even** across weekdays (no seasonality or holiday effects); price paths are a driftless random walk from the given mid levels, so USDTRY etc. do not trend.
- **`isSeeded()` is `count > 0`.** It cannot tell a half-seeded database from a full one; the seeder compares against `SEED_ROWS`, but the server (Phase 3) only knows "non-empty".
- **PENDING_START and LIVE orders have no linkage** to a live price feed yet: their market snapshot is the generator's pair mid at seed time; Phase 5 must reconcile with hermes's own walk.
- **Parent orders are 1:1** (`parentOrderId = PAR` + sequence), so grouping by parent is not interesting.
- The contract tests exercise 300-1200 rows; the 1M-row path is covered only by the real seeding run and the `loadAll` timing above.
- `docker-compose.yml` profile sets are minimal: mongo is in `core` and `seed`; `monitoring`, `loadtest` and `edge` services come in later phases.
