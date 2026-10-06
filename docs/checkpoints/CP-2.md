# CP-2: Engine (Phase 3)

- **Branch:** `phase-3-engine` (PR "Phase 3: engine", not merged; Opus reviews first)
- **Tag:** `cp-2` on the PR head
- **Scope:** Phase 3 only: shared filter model, columnar store, query engine, view cache, Fastify + WebSocket server, Docker.

## Headline numbers (1M rows of real generator data)

| Target | Result | Verdict |
|---|---|---|
| Load from Mongo under 30s | **16.0s** in the container, **16.1s** on the host (of which 1.0-1.5s is building string sort ranks) | met |
| Heap under 800MB | **223MB** retained after a forced GC (389-565MB right after loading, before the GC) | met |
| Filter + sort under 300ms (cold) | default view **24ms**, selective filter + sort **12ms**, three-column sort **30ms** (means) | met, about 10x headroom |
| One-level group under 300ms (cold) | **11ms** (four aggregates) | met |
| Block fetch under 5ms | **0.11ms** mean, **0.27ms** p99 (warm, 100 rows) | met |
| RSS | **steady 0.77-0.83GB**, but a **transient 1.7-1.8GB peak** while loading (see weaknesses) | needs review |

## What was built

### `packages/logos`
- `filter-model.ts`: zod schemas and types for the Appendix B filter shapes (text, number, date, set, combined) and `parseFilterModel`, which returns `{ok, value}` or `{ok: false, code: 'UNSUPPORTED_FILTER', error}`. `parseFilterDate` parses `'YYYY-MM-DD HH:mm:ss'` as UTC and rejects rollovers such as 2026-02-31. The spec covers every operator and many malformed shapes.
- `fixtures.ts` is now exported from the package index (the engine tests use `sampleOrders`).

### `apps/antikythera`
| Module | Purpose |
|---|---|
| `config.ts` | zod-validated env: `MONGO_URL`, `MONGO_DB`, `DB_ADAPTER`, `PORT`, `HOST`, `LOG_LEVEL`, plus the later-phase vars with plan defaults (`NATS_URL` optional for now, `FLUSH_MS`, `WRITE_BEHIND_MS`, `MAX_TRACKED_BLOCKS`, `LOAD_PRESET`) and `STORE_CAPACITY`, `VIEW_CACHE_MAX_VIEWS`, `VIEW_CACHE_MAX_MB`, `MAX_BLOCK_ROWS`. |
| `store/columnar-store.ts` | Columnar store. All typed arrays on `SharedArrayBuffer`. Numbers and dates: `Float64Array` (null is `NaN`, `-0` stored as `0`). Enums: dictionary codes in `Uint8Array` (widens to `Uint16Array` past 256 values) with a per-dictionary rank array. `orderId`, `parentOrderId`, `clientOrderId`, `strategyParams`: one `string[]` each. `orderId -> row` Map. Capacity 1.5M rows reserved up front, grows 1.5x. Rows are materialised only for returned blocks. Tracks `version` and `idsAscending`. |
| `store/dictionary.ts` | Append-only string dictionary with a lazily computed rank array. |
| `loader.ts` | Streams `repo.loadAll()` in 10k batches (never holds full `Order` objects), yields to the loop between batches, builds string sort ranks, forces a GC for honest heap figures, reports load time, heap, RSS, peak RSS and event-loop lag. |
| `query/request.ts` | Validates an SSRM request and reduces it to a canonical form plus the view key (trader, filter, sort, group columns, value columns; key order, set-value order and condition order do not matter). |
| `query/filter.ts` | Compiles the filter model plus trader scope into predicates over column arrays. Set filters use a precomputed allowed-code lookup table; dates compare epoch ms. |
| `query/sort.ts` | Multi-column sort to a `Uint32Array` of row indexes. LSD radix sort over 16-bit digits (Float64 bit-pattern keys, enum ranks, string ranks); comparator fallback when ids are not ascending in row order. |
| `query/group.ts` | One-pass bucketing by enum code or UTC day, aggregates (`sum`, `avg`, `count`, `wavg` weighted by `notionalUsd`), group ordering, rows partitioned per group in display order. |
| `query/view.ts`, `view-cache.ts` | A view holds the filtered rows and lazily builds, per route, the group level and the sorted leaf index. LRU cache capped by view count and total index bytes. |
| `query/engine.ts` | `getRows` and `setFilterValues` (cached per trader and column, capped at 5,000). Any store append invalidates every cached view. |
| `session.ts` | Appendix C protocol per connection: JSON `hello`, then the negotiated codec; `welcome`, `rows` (with `ms`), `filterValues`, `pong`, `error`; `command` and `control` answer `NOT_IMPLEMENTED`; nothing a client sends can throw out of the handler. |
| `transport.ts`, `ws-transport.ts` | Small `Connection` interface (`send`, `close`, `bufferedAmount`) so uWS could be swapped in; the `ws` adapter. |
| `server.ts`, `index.ts` | Fastify 5 + `@fastify/websocket`: `GET /health` (503 until loaded), `GET /ws`. Listens first and loads after, so health answers during the load. |
| `lag.ts`, `memory.ts` | `monitorEventLoopDelay` wrapper and heap/RSS helpers. |
| `testing/` | Naive reference implementation, seeded dataset builders, random request generator, `lag-report.ts`, `memory-report.ts` (excluded from the build). |
| `bench/engine.bench.ts` | `vitest bench` on 1M generator rows. |

### Docker and compose
- `antikythera` service in the `core` profile, shared Dockerfile, `/health` healthcheck (a `node -e fetch` one-liner, since `node:24-slim` has no curl), depends on mongo healthy, `NODE_OPTIONS=--max-old-space-size=3072`, port `127.0.0.1:4000:4000`.
- `docker compose --profile core up` gives mongo, nats and antikythera all `healthy`. The stack is left running.
- `.env.example` and the README are updated.

## Deviations and decisions (every one is open to review)

1. **Extra error codes.** The plan names `UNSUPPORTED_FILTER`, `UNSUPPORTED_AGG` and `NOT_IMPLEMENTED`. I added `UNSUPPORTED_PIVOT` (pivotMode), `UNSUPPORTED_GROUP` (not groupable), `UNSUPPORTED_COLUMN` (setFilterValues on a non-set column), `UNKNOWN_COLUMN` (sort, group, value column, or setFilterValues), `BAD_REQUEST` (range, too many keys, duplicate group column, conflicting aggregates), `BAD_FRAME` (undecodable frame), `BAD_MESSAGE` (fails zod), `HELLO_REQUIRED`, `UNKNOWN_TRADER`, `NOT_READY` (store still loading), `INTERNAL`. A filter on an unknown column, or of the wrong kind for the column, is `UNSUPPORTED_FILTER`.
2. **`inRange` is inclusive at both ends** (Appendix B does not say). AG Grid's own client-side default is exclusive. Chosen because a server-side range is normally `BETWEEN`.
3. **Date operators.** Only `equals` and `notEqual` are UTC-day granular, as specified. `lessThan`, `greaterThan` and the rest compare the exact instant of `dateFrom`, so "greater than 2026-10-06" includes the afternoon of the 6th. `inRange` compares exact instants and is inclusive. This follows the plan literally but is probably not what a user picking a day expects (open question 1).
4. **Null semantics** follow Appendix B. `notEqual` and `notContains` do not match null numbers or dates. Text columns are never null; text `blank` matches the empty string.
5. **Aggregates.** An all-null group gives null for **every** aggregate including `count` (literal reading of Appendix B; a count of 0 would be more natural). `count` on a string or enum column counts rows. `sum`, `avg` and `wavg` need a `number`-type column, otherwise `UNSUPPORTED_AGG`. An absent `aggFunc` falls back to the column's default (`wavg:notionalUsd` maps to `wavg`); `wavg:notionalUsd` on the wire is rejected. Aggregates are accumulated in ascending row order per group, so the reference comparison is exact, not approximate.
6. **Group-row ordering.** Sort entries naming the group column or `ag-Grid-AutoColumn` order by key; entries naming a value column id order by aggregate; the group column wins if an id is both. Ties end with the key, in the direction of the last applicable sort entry (ascending when none). Leaf-only sort entries are ignored for group rows, and `ag-Grid-AutoColumn` is ignored for leaves. Group keys follow Appendix B (`YYYY-MM-DD` UTC for `valueDate`, `(blank)` for null, which sorts first).
7. **Flat views ignore `valueCols` in the cache key**, so clients that differ only in value columns share one view. They are still validated. An empty flat sort is normalised to `createdAt desc`, so it shares a view with the explicit form.
8. **The `orderId` tiebreak uses row order.** `loadAll` yields ascending `_id`, so row order equals id order and the tiebreak is the radix sort's starting order. The store tracks `idsAscending`; if an append ever breaks it, sorts fall back to a comparator on the real ids. Both paths are in the property tests.
9. **String sort ranks (not in the plan).** A sort on `parentOrderId`, `clientOrderId` or `strategyParams` first cost 800ms with a comparator. The store now builds a rank array per string column on first use (`stringRank`), so those sorts use the radix path. The ranks are built at the end of loading (about 1.0-1.5s, 3 x 4MB). Any append invalidates them (phase 5 problem, see weaknesses).
10. **`-0` is stored as `0`** so sort and equality agree. The property tests compare with `-0` normalised on the reference side.
11. **`valueDate` nulls.** The schema has no null `valueDate`, but the property-test dataset nulls about 3% of them on purpose, to exercise the `(blank)` group key and date-filter null handling. Real data never reaches that path.
12. **A bad `hello` trader** (not `ALL`, not one of the 5) gets `UNKNOWN_TRADER` and leaves the session un-negotiated. A later `hello` may change the codec as well as the trader; it is decoded with the current codec and answered in the new one. `ping` works before `hello` (JSON then).
13. **`rows.ms` is engine time** (validate, view build, block materialise), not encode or socket time.
14. **Forced GC at the end of load** (`v8.setFlagsFromString('--expose-gc')`), so the reported heap is what the store retains. It costs about 100-300ms once.
15. **Tools and dependencies.** New runtime deps are only Fastify 5.12.5 and `@fastify/websocket` 11.3.3 (both in Appendix A). Dev only: `ws` and `@types/ws` (integration test client and types) and `tsx` (runs the lag and memory report scripts). The shared Dockerfile needed no change.
16. **`vitest bench` in Vitest 5 is a test-context fixture** (`test('..', async ({ bench }) => bench(..).run())`), not the old top-level `bench`. The docs mark it experimental. Checked with context7.
17. **Fastify 5.12 deprecates the top-level `disableRequestLogging`**, so request logging is switched off with `logController: new LogController({ disableRequestLogging: true })`.
18. **`welcome.traders`** comes from the `TRADERS` constant in logos, not from the data.

## Verification

All four commands ran through turbo with `--force` (no cache). Exit status 0 for each.

### lint
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running lint in 6 packages
   • Remote caching disabled

@apeiron/logos:build: cache bypass, force executing 8b67c1f5fadd9237
@apeiron/logos:lint: cache bypass, force executing 22bb9d898cd27a83
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/logos:lint: 
@apeiron/logos:lint: > @apeiron/logos@0.0.0 lint /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:lint: > eslint .
@apeiron/logos:lint: 
@apeiron/mnemosyne:build: cache bypass, force executing 7b9d82b2fcb8e73b
@apeiron/mnemosyne:lint: cache bypass, force executing b3f7854acbaa46e1
@apeiron/mnemosyne:lint: 
@apeiron/mnemosyne:lint: > @apeiron/mnemosyne@0.0.0 lint /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:lint: > eslint .
@apeiron/mnemosyne:lint: 
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/antikythera:lint: cache bypass, force executing 1b42efcf526f35d0
@apeiron/gaia:lint: cache bypass, force executing 377e9fe902c0ef09
@apeiron/gaia:lint: 
@apeiron/gaia:lint: > @apeiron/gaia@0.0.0 lint /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:lint: > eslint .
@apeiron/gaia:lint: 
@apeiron/antikythera:lint: 
@apeiron/antikythera:lint: > @apeiron/antikythera@0.0.0 lint /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:lint: > eslint .
@apeiron/antikythera:lint: 

 Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
  Time:    1.931s
```

### typecheck
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running typecheck in 6 packages
   • Remote caching disabled

@apeiron/logos:build: cache bypass, force executing 8b67c1f5fadd9237
@apeiron/logos:typecheck: cache bypass, force executing 037477864fe6d315
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/logos:typecheck: 
@apeiron/logos:typecheck: > @apeiron/logos@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:typecheck: > tsc -p tsconfig.json
@apeiron/logos:typecheck: 
@apeiron/mnemosyne:typecheck: cache bypass, force executing 26a3560580fe503a
@apeiron/mnemosyne:build: cache bypass, force executing 7b9d82b2fcb8e73b
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:typecheck: 
@apeiron/mnemosyne:typecheck: > @apeiron/mnemosyne@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:typecheck: > tsc -p tsconfig.json
@apeiron/mnemosyne:typecheck: 
@apeiron/gaia:typecheck: cache bypass, force executing 879e5aba48cf4293
@apeiron/antikythera:typecheck: cache bypass, force executing 473279e0d0f514d3
@apeiron/gaia:typecheck: 
@apeiron/gaia:typecheck: > @apeiron/gaia@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:typecheck: > tsc -p tsconfig.json
@apeiron/gaia:typecheck: 
@apeiron/antikythera:typecheck: 
@apeiron/antikythera:typecheck: > @apeiron/antikythera@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:typecheck: > tsc -p tsconfig.json
@apeiron/antikythera:typecheck: 

 Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
  Time:    2.143s
```

### test
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running test in 6 packages
   • Remote caching disabled

@apeiron/logos:test: cache bypass, force executing cfcac1c288cb5e5f
@apeiron/logos:build: cache bypass, force executing 8b67c1f5fadd9237
@apeiron/logos:test: 
@apeiron/logos:test: > @apeiron/logos@0.0.0 test /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:test: > vitest run
@apeiron/logos:test: 
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/logos:test: 
@apeiron/logos:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:test: 
@apeiron/logos:test:  ✓ src/order.spec.ts (4 tests) 4ms
@apeiron/logos:test:  ✓ src/fixtures.spec.ts (1 test) 8ms
@apeiron/logos:test:  ✓ src/filter-model.spec.ts (23 tests) 7ms
@apeiron/logos:test:  ✓ src/index.spec.ts (1 test) 2ms
@apeiron/logos:test:  ✓ src/protocol.spec.ts (6 tests) 8ms
@apeiron/logos:test:  ✓ src/codec.spec.ts (12 tests) 11ms
@apeiron/logos:test:  ✓ src/columns.spec.ts (9 tests) 217ms
@apeiron/logos:test:  ✓ src/prng.spec.ts (9 tests) 301ms
@apeiron/mnemosyne:build: cache bypass, force executing 7b9d82b2fcb8e73b
@apeiron/mnemosyne:test: cache bypass, force executing cf3cf7fff7fc97e5
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test: > @apeiron/mnemosyne@0.0.0 test /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:test: > vitest run
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  ✓ src/order-repository.spec.ts (1 test) 1ms
@apeiron/mnemosyne:test:  ✓ src/index.spec.ts (1 test) 1ms
@apeiron/antikythera:test: cache bypass, force executing feaa6185c46ff5b0
@apeiron/gaia:test: cache bypass, force executing b2352799506983cb
@apeiron/gaia:test: 
@apeiron/gaia:test: > @apeiron/gaia@0.0.0 test /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:test: > vitest run
@apeiron/gaia:test: 
@apeiron/antikythera:test: 
@apeiron/antikythera:test: > @apeiron/antikythera@0.0.0 test /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:test: > vitest run
@apeiron/antikythera:test: 
@apeiron/mnemosyne:test:  ✓ src/in-memory-order-repository.spec.ts (13 tests) 309ms
@apeiron/gaia:test: 
@apeiron/gaia:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:test: 
@apeiron/antikythera:test: 
@apeiron/antikythera:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:test: 
@apeiron/gaia:test:  ✓ src/stats-params.spec.ts (3 tests) 2ms
@apeiron/gaia:test:  ✓ src/config.spec.ts (4 tests) 6ms
@apeiron/antikythera:test:  ✓ src/memory.spec.ts (3 tests) 8ms
@apeiron/antikythera:test:  ✓ src/store/dictionary.spec.ts (4 tests) 12ms
@apeiron/gaia:test:  ✓ src/cli.spec.ts (5 tests) 52ms
@apeiron/antikythera:test:  ✓ src/query/request.spec.ts (20 tests) 13ms
@apeiron/antikythera:test:  ✓ src/config.spec.ts (3 tests) 5ms
@apeiron/antikythera:test:  ✓ src/query/group.spec.ts (11 tests) 6ms
@apeiron/gaia:test:  ✓ src/stats.spec.ts (6 tests) 86ms
@apeiron/antikythera:test:  ✓ src/query/filter.spec.ts (41 tests) 7ms
@apeiron/antikythera:test:  ✓ src/store/columnar-store.spec.ts (13 tests) 61ms
@apeiron/antikythera:test:  ✓ src/testing/dataset.spec.ts (2 tests) 110ms
@apeiron/antikythera:test:  ✓ src/query/engine.spec.ts (24 tests) 16ms
@apeiron/gaia:test:  ✓ src/seed.spec.ts (7 tests) 170ms
@apeiron/gaia:test: 
@apeiron/gaia:test:  Test Files  5 passed (5)
@apeiron/gaia:test:       Tests  25 passed (25)
@apeiron/gaia:test:    Start at  23:00:41
@apeiron/gaia:test:    Duration  519ms (import 38%, transform 32%, tests 29%, worker 1%)
@apeiron/gaia:test: 
@apeiron/antikythera:test:  ✓ src/ws-transport.spec.ts (5 tests) 3ms
@apeiron/antikythera:test:  ✓ src/session.spec.ts (20 tests) 16ms
@apeiron/antikythera:test:  ✓ src/query/errors.spec.ts (1 test) 3ms
@apeiron/antikythera:test:  ✓ src/testing/reference.spec.ts (4 tests) 3ms
@apeiron/antikythera:test:  ✓ src/query/view.spec.ts (6 tests) 5ms
@apeiron/antikythera:test:  ✓ src/testing/request-gen.spec.ts (2 tests) 70ms
@apeiron/antikythera:test:  ✓ src/query/view-cache.spec.ts (6 tests) 3ms
@apeiron/antikythera:test:  ✓ src/lag.spec.ts (2 tests) 429ms
@apeiron/antikythera:test:  ✓ src/query/sort.spec.ts (13 tests) 211ms
@apeiron/antikythera:test:  ✓ src/loader.spec.ts (4 tests) 305ms
@apeiron/antikythera:test:  ✓ src/server.spec.ts (9 tests) 850ms
@apeiron/mnemosyne:test:  ✓ src/mongo-order-repository.spec.ts (14 tests) 1862ms
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  Test Files  4 passed (4)
@apeiron/mnemosyne:test:       Tests  29 passed (29)
@apeiron/mnemosyne:test:    Start at  23:00:40
@apeiron/mnemosyne:test:    Duration  2.10s (tests 85%, import 11%, transform 4%)
@apeiron/mnemosyne:test: 
@apeiron/antikythera:test:  ✓ src/query/engine.property.spec.ts (3 tests) 2671ms
@apeiron/antikythera:test:    ✓ engine vs naive reference (property tests) (3)
@apeiron/antikythera:test:      ✓ matches on dataset seed 1 with a tiny view cache 1237ms
@apeiron/antikythera:test:      ✓ matches on dataset seed 2 with a roomy view cache 1094ms
@apeiron/antikythera:test:      ✓ matches on dataset seed 3, where ids are not ascending in row order 338ms
@apeiron/antikythera:test: 
@apeiron/antikythera:test:  Test Files  21 passed (21)
@apeiron/antikythera:test:       Tests  196 passed (196)
@apeiron/antikythera:test:    Start at  23:00:41
@apeiron/antikythera:test:    Duration  3.15s (tests 53%, transform 27%, import 19%, worker 1%)
@apeiron/antikythera:test: 
@apeiron/antikythera:test:   Transform  transforming modules took 2.50s · 27% of tracked time, re-done on every run
@apeiron/antikythera:test:              persist transforms across runs with fsModuleCache: true
@apeiron/antikythera:test:              learn more: https://vitest.dev/guide/improving-performance#caching-between-reruns
@apeiron/antikythera:test: 
@apeiron/logos:test:  ✓ src/generator.spec.ts (15 tests) 5241ms
@apeiron/logos:test:    ✓ generated data shape (8)
@apeiron/logos:test:      ✓ keeps historical createdAt ascending, on weekdays, within the last 182 days 1004ms
@apeiron/logos:test:      ✓ keeps every order internally consistent 3472ms
@apeiron/logos:test:    ✓ finalMids (2)
@apeiron/logos:test:      ✓ matches the marketMid of every LIVE and PENDING_START order 354ms
@apeiron/logos:test: 
@apeiron/logos:test:  Test Files  9 passed (9)
@apeiron/logos:test:       Tests  80 passed (80)
@apeiron/logos:test:    Start at  23:00:40
@apeiron/logos:test:    Duration  5.60s (tests 88%, import 7%, transform 4%)
@apeiron/logos:test: 

 Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
  Time:    5.943s
```

Test composition for `antikythera` (196 tests in 21 files): every filter operator with null cases and combined AND/OR; sort (nulls, negatives, -0, multi-key, enum rank, string, fallback, and a 60-case randomised comparison with a naive sort); grouping and aggregates; request validation and key normalisation; view cache (LRU, memory cap, rebalance); engine (blocks, nested routes, set filter values, cache sharing, invalidation); session protocol (both codecs, every error path); WebSocket integration over real sockets; config; loader; store.

**Property tests** (`src/query/engine.property.spec.ts`): the engine against a naive implementation (plain `Order[]` with `Array.filter`/`sort`/`reduce`, in `src/testing/reference.ts`, no shared code with the engine).
- Data is real generator output (3,000 rows, seeded), lightly mutated: 15% random statuses, 8% nulls in every nullable field, 3% null value dates.
- Three runs: 350 random requests on each of two datasets (one with a tiny view cache to force evictions), plus 150 on a dataset whose row order is not id order (comparator fallback).
- Each request is a random mix of trader, 0-3 filters of every kind (including AND/OR combos), 0-3 sort keys over all 50 columns plus the auto group column and aggregate ids, 0-3 group levels, value columns with every aggregate. It then walks down the group tree (sometimes to a missing key), compares the full range, then compares a random block of the now-cached view.
- Of the 350 requests on dataset 1: 271 non-empty, 209 grouped, 258 filtered.
- Mutation checks I ran by hand, each caught: nulls sorting last, `<` changed to `<=`, `inRange` made exclusive, group tiebreak direction, text `startsWith`/`endsWith` losing case-insensitivity, date `equals` boundary, average dividing by the wrong count, auto-column sort ignored. Not caught by the random requests: date `notEqual` skipping its null check, and the null-day group bucket (both have direct unit tests).

**WebSocket integration** (`src/server.spec.ts`): the real server against `InMemoryOrderRepository`, `ws` clients, both codecs. Covers hello, getRows flat and grouped, setFilterValues, a bad message, command (NOT_IMPLEMENTED), ping, trader scope and re-hello, garbage and oversize frames (the server keeps serving), NOT_READY while loading, `/health` 503 then 200, and a failed load.

### build
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running build in 6 packages
   • Remote caching disabled

@apeiron/logos:build: cache bypass, force executing 8b67c1f5fadd9237
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/mnemosyne:build: cache bypass, force executing 7b9d82b2fcb8e73b
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/antikythera:build: cache bypass, force executing f6b5b6ee2f0ba4ab
@apeiron/gaia:build: cache bypass, force executing ff7c724e2e54a538
@apeiron/antikythera:build: 
@apeiron/antikythera:build: > @apeiron/antikythera@0.0.0 build /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:build: > tsc -p tsconfig.build.json
@apeiron/antikythera:build: 
@apeiron/gaia:build: 
@apeiron/gaia:build: > @apeiron/gaia@0.0.0 build /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:build: > tsc -p tsconfig.build.json
@apeiron/gaia:build: 

 Tasks:    4 successful, 4 total
Cached:    0 cached, 4 total
  Time:    1.889s
```

## Benchmarks (`pnpm --filter @apeiron/antikythera bench`)

1,000,000 rows from `generateOrderBatches` (seed 42, the same distributions as the seeded DB), loaded into the store before timing. Machine: Apple Silicon MacBook Pro, Node 25.8 on the host.

- **Cold** = every cached view is cleared before each iteration (`beforeEach`), so each sample builds the filter, sort and group from scratch and fetches the first 100-row block.
- **Warm** = the view is cached and each sample asks for a different 100-row block (a scrolling client). The cost includes request validation and the cache-key build.
- Times are in ms. Vitest warns that module-export getters add overhead to the warm group benchmarks (about 1-2 microseconds per call), which does not matter at these magnitudes.

```

 RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/apps/antikythera

 ✓ |bench| bench/engine.bench.ts > cold: default view (createdAt desc, 1M rows) 1451ms
   name                    hz      min      max     mean      p75      p99     p995     p999     rme  samples
   cold default view  41.0461  21.3408  29.0332  24.4900  25.3469  28.9015  28.9673  29.0200  ±2.32%       41
 ✓ |bench| bench/engine.bench.ts > cold: selective filter + sort 1284ms
   name                               hz      min      max     mean      p75      p99     p995     p999     rme  samples
   cold selective filter + sort  86.4660  10.7151  19.3306  11.7012  11.9450  19.1689  19.2497  19.3144  ±2.81%       86
 ✓ |bench| bench/engine.bench.ts > cold: three-column sort over all rows 1573ms
   name                         hz      min      max     mean      p75      p99     p995     p999     rme  samples
   cold multi-column sort  33.8644  26.9078  33.8120  29.6457  30.9002  33.2974  33.5547  33.7605  ±2.22%       34
 ✓ |bench| bench/engine.bench.ts > cold: one-level group with four aggregates 1320ms
   name                       hz      min      max     mean      p75      p99     p995     p999     rme  samples
   cold one-level group  90.7415  10.3095  20.3495  11.0874  11.1981  13.3378  16.8436  19.6483  ±2.05%       91
 ✓ |bench| bench/engine.bench.ts > cold: two-level group (expand EURUSD) 1283ms
   name                       hz      min      max     mean      p75      p99     p995     p999     rme  samples
   cold two-level group  72.2655  13.1561  15.4467  13.8626  14.1095  15.3099  15.3783  15.4330  ±1.01%       73
 ✓ |bench| bench/engine.bench.ts > cold: setFilterValues for a trader 1257ms
   name                      hz     min     max    mean     p75     p99    p995    p999     rme  samples
   cold setFilterValues  469.42  1.9745  2.8802  2.1369  2.2382  2.4357  2.5005  2.8387  ±0.52%      468



 ✓ |bench| bench/engine.bench.ts > warm: block fetch of 100 rows from a cached view 1276ms
   name                                          hz     min     max    mean     p75     p99    p995    p999     rme  samples
   warm block fetch (100 rows, scrolling)  9,380.24  0.0930  0.5347  0.1091  0.1077  0.2677  0.3865  0.4181  ±0.55%     9169



 ✓ |bench| bench/engine.bench.ts > warm: group and leaf blocks from cached views 4025ms
   name                                hz     min     max    mean     p75     p99    p995    p999     rme  samples
   warm one-level group block  293,472.31  0.0030  0.3727  0.0035  0.0035  0.0042  0.0044  0.0073  ±0.36%   289002

   name                                hz     min     max    mean     p75     p99    p995    p999     rme  samples
   warm two-level group block  593,764.81  0.0014  0.3664  0.0017  0.0017  0.0022  0.0023  0.0043  ±0.40%   580893

   name                                      hz     min     max    mean     p75     p99    p995    p999     rme  samples
   warm selective filter + sort block  9,836.52  0.0914  0.5258  0.1047  0.1017  0.3933  0.4260  0.4779  ±0.67%     9549



 ✓ |bench| bench/engine.bench.ts > warm: setFilterValues 3124ms
   name                            hz     min     max    mean     p75     p99    p995    p999     rme  samples
   warm setFilterValues  8,285,096.59  0.0000  0.2345  0.0001  0.0001  0.0002  0.0002  0.0003  ±0.06%  8026829

 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  22:56:47
   Duration  20.49s (tests 81%, import 18%)
```

Reading the cold numbers: the first request after a server start is slower than the steady-state means above because of JIT warm-up (38ms for the default view in the lag report below, against a 24ms mean here). The cold selective-filter case is T1 + EURUSD + FILLED + quantity over 5M, which matches 46,571 of the 1M rows.

Not in the vitest bench because the store caches it: first use of a string sort column (ranks), shown in the lag report below.

## Event-loop lag

Measured with `perf_hooks.monitorEventLoopDelay` (10ms resolution; figures are lag beyond the resolution).

**During load** (the `store loaded` log lines below): p50 0.2-5ms, **p99 144-183ms, max 0.9-1.3s**. The stalls are the synchronous string-rank builds (about 1.0-1.5s in total, with one `await` between the three columns; `clientOrderId` alone is about 600ms), the forced full GC, and BSON decoding. Health checks and WebSocket traffic during the load wait up to about a second in the worst case.

**During a cold 1M-row view build** (`pnpm --filter @apeiron/antikythera lag-report`, real generator data). Each scenario is one synchronous `getRows`, so the stall equals the build time:

```

rows 1000000; lag figures are ms beyond the 10 ms sampling interval
scenario                                                    build ms  lag p50  lag p99  lag max
default view (createdAt desc)                                   38.4      2.1     35.4     35.4
sort notionalUsd desc                                           19.8      2.1     12.5     12.5
sort venue, algoType, notionalUsd                               44.4        2     38.3     38.3
sort strategyParams (first use: builds string ranks)           170.7        2    167.2    167.2
sort strategyParams (ranks cached)                              17.3      1.3     19.4     19.4
sort clientOrderId (first use: 1M unique strings)              645.0      1.1    635.4    635.4
sort clientOrderId (ranks cached)                               13.4      0.5     14.5     14.5
group currencyPair (4 aggs)                                     47.9        2     39.1     39.1
group status, expand FILLED (leaf sort of 920k rows)            27.7        2     29.8     29.8
selective filter + sort (T1)                                    16.7      1.4     11.8     11.8
text filter contains (clientOrderId) + sort                     28.4        2     19.7     19.7
```

Every normal cold build stalls the loop for 12-47ms; the first sort on a text column costs 170ms to 640ms (not reachable in the server any more, because the ranks are prebuilt at load). The 50ms event-loop lag target holds for single cold builds on this machine. **No worker pool was built**, as instructed. These numbers do not suggest one is needed for read traffic; see the weaknesses for what appends will change.

## Load time, heap and RSS

Mongo 9.0 in compose, 1,000,000 seeded rows, `NODE_OPTIONS=--max-old-space-size=3072`.

**Container** (`docker compose --profile core up`, image built from the shared Dockerfile):
```
{
  "rows": 1000000,
  "loadMs": 16047,
  "rankMs": 1484,
  "streamedRssMb": 1716.6,
  "peakRssMb": 1843.3,
  "heapMb": 388.9,
  "rssMb": 1836.5,
  "heapAfterGcMb": 222.9,
  "rssAfterGcMb": 1711.3,
  "arrayBuffersMb": 415.4,
  "typedArrayMb": 257,
  "lag": {
    "p50": 5.2,
    "p99": 183.3,
    "max": 1297.6,
    "samples": 215
  },
  "msg": "store loaded"
}
```
**Host** (`node dist/index.js` against the compose mongo on localhost):
```
{
  "rows": 1000000,
  "loadMs": 16118,
  "rankMs": 978,
  "streamedRssMb": 1702,
  "peakRssMb": 1829.5,
  "heapMb": 564.5,
  "rssMb": 1828.3,
  "heapAfterGcMb": 222.8,
  "rssAfterGcMb": 1728.7,
  "arrayBuffersMb": 415.1,
  "typedArrayMb": 257,
  "lag": {
    "p50": 0.2,
    "p99": 144.4,
    "max": 899.1,
    "samples": 442
  },
  "msg": "store loaded"
}
```

- `heapMb` is heap used right after loading, before the forced GC; `heapAfterGcMb` is what the store retains: **223MB** in both runs.
- `streamedRssMb` and `peakRssMb`: RSS reaches **1.7-1.8GB** by the end of the Mongo stream (driver buffers and young-generation garbage the allocator has not returned) and then settles. `/health` showed `rssMb` 766 in the container about a minute later, and 722 on the host 20s later. `docker stats` showed 825MiB.
- Typed arrays: 257MB used (386MB reserved for 1.5M rows; the headroom is virtual until written). `arrayBuffers` 415MB includes that headroom.
- A flat 1M-row view costs 8MB (filtered rows plus sorted leaf); a grouped view costs 4MB per level plus a few KB per group.

## Store memory layout (1M rows)

`pnpm --filter @apeiron/antikythera memory-report`:
```

> @apeiron/antikythera@0.0.0 memory-report /Users/anthonyladas/Development/apeiron/apps/antikythera
> tsx src/testing/memory-report.ts

rows 1000000, capacity 1500000
column               kind     used MB  reserved MB  note
orderId              string       0.0          0.0  string[], ~38 MB heap (estimate)
parentOrderId        string       0.0          0.0  string[], ~38 MB heap (estimate)
clientOrderId        string       0.0          0.0  string[], ~38 MB heap (estimate)
traderId             enum         1.0          1.4  dictionary 5 values, 1 byte/row
traderName           enum         1.0          1.4  dictionary 5 values, 1 byte/row
account              enum         1.0          1.4  dictionary 15 values, 1 byte/row
currencyPair         enum         1.0          1.4  dictionary 20 values, 1 byte/row
baseCcy              enum         1.0          1.4  dictionary 5 values, 1 byte/row
quoteCcy             enum         1.0          1.4  dictionary 13 values, 1 byte/row
tenor                enum         1.0          1.4  dictionary 5 values, 1 byte/row
valueDate            number       7.6         11.4  8 byte/row
side                 enum         1.0          1.4  dictionary 2 values, 1 byte/row
algoType             enum         1.0          1.4  dictionary 6 values, 1 byte/row
status               enum         1.0          1.4  dictionary 4 values, 1 byte/row
orderType            enum         1.0          1.4  dictionary 3 values, 1 byte/row
timeInForce          enum         1.0          1.4  dictionary 4 values, 1 byte/row
urgency              enum         1.0          1.4  dictionary 3 values, 1 byte/row
venue                enum         1.0          1.4  dictionary 8 values, 1 byte/row
strategyParams       string       0.0          0.0  string[], ~50 MB heap (estimate)
orderQty             number       7.6         11.4  8 byte/row
filledQty            number       7.6         11.4  8 byte/row
remainingQty         number       7.6         11.4  8 byte/row
pctComplete          number       7.6         11.4  8 byte/row
notionalUsd          number       7.6         11.4  8 byte/row
filledNotionalUsd    number       7.6         11.4  8 byte/row
limitPrice           number       7.6         11.4  8 byte/row
arrivalPrice         number       7.6         11.4  8 byte/row
avgFillPrice         number       7.6         11.4  8 byte/row
marketBid            number       7.6         11.4  8 byte/row
marketAsk            number       7.6         11.4  8 byte/row
marketMid            number       7.6         11.4  8 byte/row
lastFillPrice        number       7.6         11.4  8 byte/row
distanceToLimitBps   number       7.6         11.4  8 byte/row
spreadBps            number       7.6         11.4  8 byte/row
slippageBps          number       7.6         11.4  8 byte/row
slippageUsd          number       7.6         11.4  8 byte/row
unrealisedPnlUsd     number       7.6         11.4  8 byte/row
realisedPnlUsd       number       7.6         11.4  8 byte/row
vwapBenchmark        number       7.6         11.4  8 byte/row
perfVsVwapBps        number       7.6         11.4  8 byte/row
numFills             number       7.6         11.4  8 byte/row
numChildOrders       number       7.6         11.4  8 byte/row
participationRate    number       7.6         11.4  8 byte/row
lastFillQty          number       7.6         11.4  8 byte/row
createdAt            number       7.6         11.4  8 byte/row
startTime            number       7.6         11.4  8 byte/row
endTime              number       7.6         11.4  8 byte/row
lastUpdateTime       number       7.6         11.4  8 byte/row
completedAt          number       7.6         11.4  8 byte/row
durationMins         number       7.6         11.4  8 byte/row
typed arrays used        257.5 MB
typed arrays reserved    386.2 MB (virtual until written)
string heap estimate     164.9 MB
orderId -> row Map and string ranks are extra (ranks: 3 x 3.8 MB)
heap after GC: 10.8 -> 274.4 MB (delta 263.6 MB)
arrayBuffers: 1 -> 398.7 MB; rss 80.5 -> 1103.5 MB
```
Dictionary sizes: traderId 5, traderName 5, account 15, currencyPair 20, baseCcy 5, quoteCcy 13, tenor 5, side 2, algoType 6, status 4, orderType 3, timeInForce 4, urgency 3, venue 8 (all fit `Uint8Array`). There are 32 number/date columns at 8 bytes per row, 14 enum columns at 1 byte per row, 4 string columns, and the `orderId` Map. `strategyParams` has 7,634 distinct values over 1M rows; `clientOrderId` and `parentOrderId` are unique.

## Library versions

| Library | Version | Note |
|---|---|---|
| fastify | 5.12.5 | latest |
| @fastify/websocket | 11.3.3 | latest |
| ws (dev) | 8.22.0 | latest |
| @types/ws (dev) | 8.18.2 | latest |
| zod | 4.6.5 | latest |
| vitest | 5.0.3 | latest |
| typescript | 6.0.3 | **exception**: 7.0.2 is on npm, but `typescript-eslint` 8.71.1 (latest) has peer range `>=4.8.4 <6.1.0` |
| tsx (dev) | 4.23.15 | latest; only runs the report scripts |
| @types/node | 24.19.1 | **exception by policy**: pinned to `^24` to match the Node 24 runtime (26.x exists) |
| mongodb driver | 7.7.0 | from phase 2; works against `mongo:9.0` (load figures above) |
| Node (host) | 25.8.2 | engines `>=24`; containers use `node:24-slim` |
| mongo / nats images | `mongo:9.0`, `nats:2.15-alpine` | unchanged |

## Open questions and known weaknesses

**Questions for the reviewer**
1. **Date comparison granularity.** Should `lessThan`/`greaterThan`/`inRange` on date columns be day-granular like `equals`? As specified they compare exact instants, so choosing a day in the grid and "greater than" includes that day's later hours. A day-granular rule is a small change in `dateCondition`. The same question applies to `inRange` being inclusive or exclusive at the upper bound.
2. **All-null `count`** returns null per the contract. Should it be 0?
3. **Group-row tiebreak direction**: the last sort key's direction (as for leaves), or always ascending?
4. **String sort ranks** are an addition. Is a rank cache the right shape given phase 5 (next section)?

**Weaknesses**
1. **Phase 5 invalidation.** `QueryEngine` drops every cached view, and the string ranks go stale, whenever the store version changes. That is correct but would rebuild views on every flush tick with live appends. Phase 5 needs the incremental design of Appendix D; the string-rank cache in particular needs incremental maintenance or a comparator fallback when stale (a stale `clientOrderId` rebuild is about 600ms).
2. **Synchronous builds.** Every cold build runs on the main thread. 12-47ms measured here, but this is a fast machine (Apple Silicon); on a `t4g` Graviton the figures may be 2-3x worse, which still fits. Many clients with distinct views would serialise.
3. **Load transient.** RSS peaks at about 1.8GB while loading and takes about a minute to settle at about 0.8GB. In a constrained Docker VM (5.8GB, with mongo at 2GB and unrelated containers) a second concurrent instance made the load take 247s, apparently from swapping. The plan's 2GB RSS target is for 50 clients at steady state, but a container memory limit below about 2GB would kill the process during the load. I tried `MALLOC_ARENA_MAX=2` once; that run was confounded by the swapping and proves nothing. Smaller Mongo batches are the next thing to try.
4. **Event-loop lag during load** reaches about 1.3s at worst (rank builds, forced GC). Only `/health` is served then.
5. **The property tests share an author with the engine.** The reference was written from Appendix B with no shared code, but both embody my reading of the contract (the deviations list is the set of readings that matter).
6. **Memory accounting** counts index arrays only (filtered, sorted, group partitions). It excludes the group label and aggregate arrays beyond an estimate, the `Map`s inside views and the filter-values cache; these are small at the cardinalities in the data.
7. **No backpressure, metrics or per-connection limits** yet (phases 5 and 7). A 1MB `maxPayload` is the only protection against oversize frames.
8. **`valueDate` grouping** allocates one bucket per day in the span and throws above 4M days; fine for the data, and `valueDate` is the only groupable number column.
9. **Trader scope is whatever `hello` says** (no auth, as planned).
10. The entry point `index.ts`, the type-only `transport.ts` and the two report scripts have no spec of their own (an accepted pattern from CP-1; their logic is covered through `server.spec.ts`).


---

## CP-2 fixes

Review: [`CP-2-review.md`](CP-2-review.md) (APPROVE WITH FIXES). The contract decisions it made are in `docs/PLAN.md` (Appendix B date operators, `inRange` and `count`; Appendix C error codes; Appendix D "Phase 5 requirements from CP-2"). The `cp-2` tag stays on the reviewed commit `ab2eda6`.

- **F1 (widening bug).** `ColumnarStore.widen()` now copies the written extent (`base + i`, including earlier rows of the same batch) instead of `this.count`. Regression tests: 300 distinct venues in one batch; widening across three batches; widening combined with `ensureCapacity` growth from capacity 4 to 1,500 rows.
- **F2 (day-granular dates).** `dateCondition` implements the Appendix B table (`lessThan < D0`, `lessThanOrEqual < D0+1d`, `greaterThan >= D0+1d`, `greaterThanOrEqual >= D0`, `inRange [D0, D1+1d)`, equals/notEqual as before). The reference implementation was rewritten to the same table independently (day numbers), and the date unit tests were replaced; the property tests pass against it. Number `inRange` stays inclusive.
- **F3 (`count`).** `count` is the group's row count (equals `childCount`), never null, nulls included. Reference and tests updated.
- **F4a (memory limit).** `mem_limit: 3g` on the compose `antikythera` service (`docker inspect` shows 3221225472 bytes); noted in the README. The container reaches healthy under the limit.
- **F4b (load RSS peak).** The cause is the Mongo driver's per-batch buffers, not V8 heap (heap before GC is only about 400MB). Smaller batches fix it and load faster. The loader and the Mongo cursor batch size are now `LOAD_BATCH_SIZE`, default **200** (was 10,000). Figures below.
- **F5 (error codes).** `ERROR_CODES` and the `ErrorCode` union (the full Appendix C list, including `INVALID_TRANSITION`, `UNKNOWN_ORDER`, `SLOW_CONSUMER`) are exported from logos; `ServerMsg` error frames are typed with it, `EngineErrorCode` is a subset of it, and the session's `sendError` takes it. This section and the header above cross-reference the review.

### F4b before and after

Each row is one container start under `mem_limit: 3g` against the compose mongo (1M rows), one run per variant, nothing else changed. RSS figures are from the `store loaded` log line (`streamedRssMb` = RSS when the Mongo stream ended; `peakRssMb` = process peak).

| Variant | loadMs | rankMs | streamed RSS MB | peak RSS MB |
|---|---|---|---|---|
| **Before: batch 10,000** | 15,759 | 1,415 | 1,705 | 1,808 |
| batch 2,000 | 13,194 | 851 | 1,475 | 1,604 |
| batch 1,000 | 13,260 | 872 | 1,218 | 1,350 |
| batch 500 | 11,283 | 818 | 1,179 | 1,308 |
| batch 100 | 9,513 | 698 | 738 | 867 |
| batch 50 | 10,235 | 715 | 741 | 869 |
| **After: batch 200 (adopted)** | **9,383-9,521** | **694-722** | **748** | **876** |
| 10,000 + `MALLOC_ARENA_MAX=2` | 16,762 | 1,796 | 1,698 | 1,789 |
| 10,000 + `MALLOC_TRIM_THRESHOLD_=131072` | 16,744 | 1,161 | 1,778 | 1,891 |

Result: peak RSS **1,808MB to 876MB** (about 52% lower) and load time **15.8s to 9.5s** (40% faster), so the 20% slowdown limit was not an issue. The malloc environment variables did nothing and were dropped. Steady RSS after settling: `/health` 584MB, `docker stats` 547MiB of the 3GiB limit (708MB before the change). Event-loop lag during load fell as well: p99 **1.8ms** (was 144-183ms), max 634ms (the `clientOrderId` rank build). Heap retained is unchanged at 226MB.

Final `store loaded` line (container, `mem_limit: 3g`, batch 200):
```
{"level":30,"time":1791324914640,"pid":1,"hostname":"f27e369da259","rows":1000000,"loadMs":9521,"rankMs":694,"streamedRssMb":748,"peakRssMb":876.5,"heapMb":401,"rssMb":876.4,"heapAfterGcMb":225.8,"rssAfterGcMb":727.9,"arrayBuffersMb":415.5,"typedArrayMb":257,"lag":{"p50":0.2,"p99":1.8,"max":634.3,"samples":851},"msg":"store loaded"}
```

### Verification output (after the fixes)

All four ran through turbo with `--force`; exit status 0 for each.

#### lint
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running lint in 6 packages
   • Remote caching disabled

@apeiron/logos:lint: cache bypass, force executing 483de01e6e2191c7
@apeiron/logos:build: cache bypass, force executing aecfd116c98af1a4
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/logos:lint: 
@apeiron/logos:lint: > @apeiron/logos@0.0.0 lint /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:lint: > eslint .
@apeiron/logos:lint: 
@apeiron/mnemosyne:lint: cache bypass, force executing 391c531f2d5bf178
@apeiron/mnemosyne:build: cache bypass, force executing d2a637411a63f736
@apeiron/mnemosyne:lint: 
@apeiron/mnemosyne:lint: > @apeiron/mnemosyne@0.0.0 lint /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:lint: > eslint .
@apeiron/mnemosyne:lint: 
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/gaia:lint: cache bypass, force executing 266a5b5789c7f87b
@apeiron/antikythera:lint: cache bypass, force executing ba01f05371e98c22
@apeiron/gaia:lint: 
@apeiron/gaia:lint: > @apeiron/gaia@0.0.0 lint /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:lint: > eslint .
@apeiron/gaia:lint: 
@apeiron/antikythera:lint: 
@apeiron/antikythera:lint: > @apeiron/antikythera@0.0.0 lint /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:lint: > eslint .
@apeiron/antikythera:lint: 

 Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
  Time:    1.882s
```

#### typecheck
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running typecheck in 6 packages
   • Remote caching disabled

@apeiron/logos:typecheck: cache bypass, force executing 7c8e482c30eda6a8
@apeiron/logos:build: cache bypass, force executing aecfd116c98af1a4
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/logos:typecheck: 
@apeiron/logos:typecheck: > @apeiron/logos@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:typecheck: > tsc -p tsconfig.json
@apeiron/logos:typecheck: 
@apeiron/mnemosyne:build: cache bypass, force executing d2a637411a63f736
@apeiron/mnemosyne:typecheck: cache bypass, force executing be35ba25ea759f58
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:typecheck: 
@apeiron/mnemosyne:typecheck: > @apeiron/mnemosyne@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:typecheck: > tsc -p tsconfig.json
@apeiron/mnemosyne:typecheck: 
@apeiron/gaia:typecheck: cache bypass, force executing e00e7112cae4bccb
@apeiron/antikythera:typecheck: cache bypass, force executing f813088b56dd9c50
@apeiron/gaia:typecheck: 
@apeiron/gaia:typecheck: > @apeiron/gaia@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:typecheck: > tsc -p tsconfig.json
@apeiron/gaia:typecheck: 
@apeiron/antikythera:typecheck: 
@apeiron/antikythera:typecheck: > @apeiron/antikythera@0.0.0 typecheck /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:typecheck: > tsc -p tsconfig.json
@apeiron/antikythera:typecheck: 

 Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
  Time:    2.199s
```

#### test
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running test in 6 packages
   • Remote caching disabled

@apeiron/logos:test: cache bypass, force executing bb1fb2c9b4dfc4ff
@apeiron/logos:build: cache bypass, force executing aecfd116c98af1a4
@apeiron/logos:test: 
@apeiron/logos:test: > @apeiron/logos@0.0.0 test /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:test: > vitest run
@apeiron/logos:test: 
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/logos:test: 
@apeiron/logos:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:test: 
@apeiron/logos:test:  ✓ src/order.spec.ts (4 tests) 3ms
@apeiron/logos:test:  ✓ src/fixtures.spec.ts (1 test) 8ms
@apeiron/logos:test:  ✓ src/index.spec.ts (1 test) 2ms
@apeiron/logos:test:  ✓ src/filter-model.spec.ts (23 tests) 7ms
@apeiron/logos:test:  ✓ src/protocol.spec.ts (7 tests) 9ms
@apeiron/logos:test:  ✓ src/codec.spec.ts (12 tests) 12ms
@apeiron/logos:test:  ✓ src/columns.spec.ts (9 tests) 222ms
@apeiron/mnemosyne:build: cache bypass, force executing d2a637411a63f736
@apeiron/mnemosyne:test: cache bypass, force executing bbc13499ae454551
@apeiron/logos:test:  ✓ src/prng.spec.ts (9 tests) 300ms
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test: > @apeiron/mnemosyne@0.0.0 test /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:test: > vitest run
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  ✓ src/order-repository.spec.ts (1 test) 1ms
@apeiron/mnemosyne:test:  ✓ src/index.spec.ts (1 test) 1ms
@apeiron/antikythera:test: cache bypass, force executing 021d487958676f4d
@apeiron/gaia:test: cache bypass, force executing 9009513bb24c6ebe
@apeiron/antikythera:test: 
@apeiron/antikythera:test: > @apeiron/antikythera@0.0.0 test /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:test: > vitest run
@apeiron/antikythera:test: 
@apeiron/gaia:test: 
@apeiron/gaia:test: > @apeiron/gaia@0.0.0 test /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:test: > vitest run
@apeiron/gaia:test: 
@apeiron/mnemosyne:test:  ✓ src/in-memory-order-repository.spec.ts (13 tests) 314ms
@apeiron/antikythera:test: 
@apeiron/gaia:test: 
@apeiron/antikythera:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:test: 
@apeiron/gaia:test:  RUN  v5.0.3 /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:test: 
@apeiron/gaia:test:  ✓ src/stats-params.spec.ts (3 tests) 3ms
@apeiron/gaia:test:  ✓ src/config.spec.ts (4 tests) 5ms
@apeiron/antikythera:test:  ✓ src/memory.spec.ts (3 tests) 6ms
@apeiron/antikythera:test:  ✓ src/store/dictionary.spec.ts (4 tests) 13ms
@apeiron/antikythera:test:  ✓ src/query/request.spec.ts (20 tests) 10ms
@apeiron/antikythera:test:  ✓ src/query/filter.spec.ts (42 tests) 8ms
@apeiron/antikythera:test:  ✓ src/query/group.spec.ts (11 tests) 9ms
@apeiron/gaia:test:  ✓ src/stats.spec.ts (6 tests) 73ms
@apeiron/gaia:test:  ✓ src/cli.spec.ts (5 tests) 72ms
@apeiron/antikythera:test:  ✓ src/store/columnar-store.spec.ts (15 tests) 79ms
@apeiron/antikythera:test:  ✓ src/query/view.spec.ts (6 tests) 5ms
@apeiron/antikythera:test:  ✓ src/query/engine.spec.ts (24 tests) 12ms
@apeiron/antikythera:test:  ✓ src/testing/dataset.spec.ts (2 tests) 115ms
@apeiron/antikythera:test:  ✓ src/session.spec.ts (20 tests) 17ms
@apeiron/antikythera:test:  ✓ src/ws-transport.spec.ts (5 tests) 4ms
@apeiron/antikythera:test:  ✓ src/config.spec.ts (3 tests) 7ms
@apeiron/gaia:test:  ✓ src/seed.spec.ts (7 tests) 191ms
@apeiron/gaia:test: 
@apeiron/gaia:test:  Test Files  5 passed (5)
@apeiron/gaia:test:       Tests  25 passed (25)
@apeiron/gaia:test:    Start at  23:14:49
@apeiron/gaia:test:    Duration  549ms (import 36%, transform 32%, tests 31%, worker 1%)
@apeiron/gaia:test: 
@apeiron/antikythera:test:  ✓ src/query/errors.spec.ts (1 test) 2ms
@apeiron/antikythera:test:  ✓ src/testing/request-gen.spec.ts (2 tests) 82ms
@apeiron/antikythera:test:  ✓ src/testing/reference.spec.ts (4 tests) 3ms
@apeiron/antikythera:test:  ✓ src/query/view-cache.spec.ts (6 tests) 2ms
@apeiron/antikythera:test:  ✓ src/query/sort.spec.ts (13 tests) 233ms
@apeiron/antikythera:test:  ✓ src/lag.spec.ts (2 tests) 441ms
@apeiron/antikythera:test:  ✓ src/loader.spec.ts (5 tests) 388ms
@apeiron/antikythera:test:  ✓ src/server.spec.ts (9 tests) 843ms
@apeiron/mnemosyne:test:  ✓ src/mongo-order-repository.spec.ts (14 tests) 1798ms
@apeiron/mnemosyne:test: 
@apeiron/mnemosyne:test:  Test Files  4 passed (4)
@apeiron/mnemosyne:test:       Tests  29 passed (29)
@apeiron/mnemosyne:test:    Start at  23:14:48
@apeiron/mnemosyne:test:    Duration  2.05s (tests 84%, import 11%, transform 5%)
@apeiron/mnemosyne:test: 
@apeiron/antikythera:test:  ✓ src/query/engine.property.spec.ts (3 tests) 2703ms
@apeiron/antikythera:test:    ✓ engine vs naive reference (property tests) (3)
@apeiron/antikythera:test:      ✓ matches on dataset seed 1 with a tiny view cache 1252ms
@apeiron/antikythera:test:      ✓ matches on dataset seed 2 with a roomy view cache 1096ms
@apeiron/antikythera:test:      ✓ matches on dataset seed 3, where ids are not ascending in row order 352ms
@apeiron/antikythera:test: 
@apeiron/antikythera:test:  Test Files  21 passed (21)
@apeiron/antikythera:test:       Tests  200 passed (200)
@apeiron/antikythera:test:    Start at  23:14:49
@apeiron/antikythera:test:    Duration  3.14s (tests 57%, transform 25%, import 18%, worker 1%)
@apeiron/antikythera:test: 
@apeiron/antikythera:test:   Transform  transforming modules took 2.20s · 25% of tracked time, re-done on every run
@apeiron/antikythera:test:              persist transforms across runs with fsModuleCache: true
@apeiron/antikythera:test:              learn more: https://vitest.dev/guide/improving-performance#caching-between-reruns
@apeiron/antikythera:test: 
@apeiron/logos:test:  ✓ src/generator.spec.ts (15 tests) 5333ms
@apeiron/logos:test:    ✓ generated data shape (8)
@apeiron/logos:test:      ✓ keeps historical createdAt ascending, on weekdays, within the last 182 days 1105ms
@apeiron/logos:test:      ✓ keeps every order internally consistent 3461ms
@apeiron/logos:test:    ✓ finalMids (2)
@apeiron/logos:test:      ✓ matches the marketMid of every LIVE and PENDING_START order 358ms
@apeiron/logos:test: 
@apeiron/logos:test:  Test Files  9 passed (9)
@apeiron/logos:test:       Tests  81 passed (81)
@apeiron/logos:test:    Start at  23:14:48
@apeiron/logos:test:    Duration  5.70s (tests 88%, import 7%, transform 5%)
@apeiron/logos:test: 

 Tasks:    6 successful, 6 total
Cached:    0 cached, 6 total
  Time:    6.045s
```

#### build
```

   • turbo 2.11.7
   • Packages in scope: @apeiron/antikythera, @apeiron/eslint-config, @apeiron/gaia, @apeiron/logos, @apeiron/mnemosyne, @apeiron/tsconfig
   • Running build in 6 packages
   • Remote caching disabled

@apeiron/logos:build: cache bypass, force executing aecfd116c98af1a4
@apeiron/logos:build: 
@apeiron/logos:build: > @apeiron/logos@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/logos
@apeiron/logos:build: > tsc -p tsconfig.build.json
@apeiron/logos:build: 
@apeiron/mnemosyne:build: cache bypass, force executing d2a637411a63f736
@apeiron/mnemosyne:build: 
@apeiron/mnemosyne:build: > @apeiron/mnemosyne@0.0.0 build /Users/anthonyladas/Development/apeiron/packages/mnemosyne
@apeiron/mnemosyne:build: > tsc -p tsconfig.build.json
@apeiron/mnemosyne:build: 
@apeiron/gaia:build: cache bypass, force executing 85fa4429bc49bb62
@apeiron/antikythera:build: cache bypass, force executing 096dcb1d6a221789
@apeiron/gaia:build: 
@apeiron/gaia:build: > @apeiron/gaia@0.0.0 build /Users/anthonyladas/Development/apeiron/apps/gaia
@apeiron/gaia:build: > tsc -p tsconfig.build.json
@apeiron/gaia:build: 
@apeiron/antikythera:build: 
@apeiron/antikythera:build: > @apeiron/antikythera@0.0.0 build /Users/anthonyladas/Development/apeiron/apps/antikythera
@apeiron/antikythera:build: > tsc -p tsconfig.build.json
@apeiron/antikythera:build: 

 Tasks:    4 successful, 4 total
Cached:    0 cached, 4 total
  Time:    1.902s
```
