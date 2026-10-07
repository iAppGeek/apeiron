# Apeiron (ἄπειρον, "the infinite"): Infinity Blotter POC Plan

## Context
This is a new POC. It should prove that a React blotter can show **1M FX algo orders × 50 columns**, ticking live, with fast filtering, sorting and grouping. It should also prove that a Node server can serve **50 concurrent WebSocket clients**. The POC itself runs one client while we watch CPU and memory, and a load harness proves the 50-client target. Everything lives in one pnpm/Turborepo monorepo, runs fully in Docker locally, and can be deployed later at little or no cost.

**Repo location:** `~/Development/apeiron`, a new git repo next to the user's other projects. The session moves there before phase 1, because the current temporary folder is deleted along with the session.

**GitHub:** **public** repo `iAppGeek/apeiron`, created in phase 1 with `gh repo create iAppGeek/apeiron --public --source . --push`. `gh` is already logged in as iAppGeek.
- Work for each phase happens on a branch `phase-N-<name>`, is merged to `main` after its checkpoint or done criteria pass, and the merge is tagged `cp-N` at checkpoints.
- CI runs on PRs and on main.
- Multi-arch image builds use native runners: `ubuntu-24.04-arm` for arm64 and `ubuntu-latest` for amd64, merged into one manifest.
- **Public-repo hygiene:**
  - Only `.env.example` is committed; `.gitignore` covers `.env*`, `*.tfstate*` and `.terraform/`.
  - Terraform state stays local and is gitignored.
  - AWS credentials for the ECR push come from GitHub OIDC (an IAM role created in `infra/aws`), not stored access keys.
  - No AG Grid licence key appears anywhere.

### Decisions (agreed with user)
| Area | Choice |
|---|---|
| Data delivery | **Server-side**: the server holds all rows in memory and does sort, filter, group and aggregation. The client lazily loads blocks. |
| Grid | **AG Grid Enterprise, Server-Side Row Model (SSRM)**, chosen because grouping is required. A watermark without a licence is acceptable. |
| Live source | **Message bus (NATS + JetStream)**. A mock middleware publishes order events and price ticks. |
| Transport | **Fastify + `ws`**, with a pluggable codec (JSON default, MessagePack toggle). The transport sits behind an interface so uWS can be swapped in later. |
| Price ticks | **Server-side join.** Price-derived columns stay sortable and filterable. |
| DB | **Mongo full adapter.** Oracle and KDB get the `OrderRepository` interface, a contract test suite and mapping docs only. |
| Load | Default ~100 order updates/s, ~5 new orders/s, 20 pairs × 3 ticks/s. A **stress** preset runs ~2,000 updates/s and 50 new orders/s. |
| New rows | Respect the current sort. The default sort is `createdAt desc`, so new orders land on top. The scroll position stays anchored, with an "N new orders ↑" badge. |
| Actions | Right-click **Cancel / Pause / Resume** on LIVE orders. |
| Users | Trader selector (5 mock traders + "All"). No auth. |
| Monitoring | **Load-test harness** + **Prometheus + Grafana** (compose profile). |
| Monorepo | **pnpm + Turborepo**, TypeScript everywhere, Node 24 LTS. |
| Runtime | **Every service in a container.** The laptop and remote run the same compose file. Remote is **AWS EC2 Graviton + ECR**, started only for short test sessions and stopped afterwards. |

## Repo layout
Each package is named `@apeiron/<codename>`, and its folder name matches. Throughout this plan, role names (web, server, mock-middleware, seeder, loadtest, shared, db) map to the codenames below. Compose service names use the codenames too.
```
apeiron/
  apps/
    pharos/            [web]             Vite + React 19 + AG Grid Enterprise (SSRM). The lighthouse you watch.
    antikythera/       [server]          Fastify + ws blotter server, in-memory engine. The computing mechanism.
    hermes/            [mock-middleware] NATS publisher: order lifecycle + price feed. Messenger of trade.
    gaia/              [seeder]          one-shot: generate 1M orders → DB (idempotent). Mother of all.
    talos/             [loadtest]        N-client WS harness (default 50). Bronze automaton testing the defences.
  packages/
    logos/             [shared]          order schema, column metadata, protocol types, codecs, PRNG
    mnemosyne/         [db]              OrderRepository interface, Mongo adapter, contract tests. Memory.
    iris/              [bus]             NATS/JetStream adapter (streams, consumers, NatsBus), used by hermes and antikythera. Messenger of the gods. (Added in phase 5a: it can't live in logos, which the browser imports.)
    tsconfig/, eslint-config/            (@apeiron/tsconfig, @apeiron/eslint-config)
  e2e/tests/           Playwright *.e2e.ts
  infra/
    docker/            Dockerfiles (multi-stage, node:24-slim)
    docker-compose.yml profiles: core | seed | monitoring | loadtest
    prometheus/, grafana/ (provisioned dashboard), caddy/, nginx/
    aws/               Terraform: ECR, EC2 t4g.xlarge, SG, IAM (SSM + ECR pull)
  scripts/             remote-up.sh, remote-down.sh, remote-destroy.sh, remote-loadtest.sh
  docs/                architecture.md, hosting.md, db-adapters.md (Oracle/KDB mapping)
  turbo.json, pnpm-workspace.yaml, .github/workflows/ci.yml
```

## Data model (packages/logos)
**Statuses:** `PENDING_START`, `LIVE`, `PAUSED`, `FILLED`, `CANCELLED`. Seeded over the last 6 months (configurable `SEED_ROWS=1_000_000`) across 5 traders. About 99.9% are historical FILLED/CANCELLED orders, plus ~300–500 LIVE and ~200 PENDING_START (future `startTime`).

**Pairs (20):** EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD, EURGBP, EURJPY, GBPJPY, EURCHF, AUDJPY, USDSEK, USDNOK, USDMXN, USDZAR, USDSGD, USDHKD, USDCNH, USDTRY.

**50 columns.** A single `columns.ts` metadata file (field, type, filter kind, groupable, aggFunc) drives both the server engine and the client column definitions.
- **Identity (6):** orderId, parentOrderId, clientOrderId, traderId, traderName, account
- **Instrument (5):** currencyPair, baseCcy, quoteCcy, tenor, valueDate
- **Order (8):** side, algoType (TWAP/VWAP/POV/ICEBERG/SNIPER/IS), status, orderType, timeInForce, urgency, venue, strategyParams
- **Quantity (6):** orderQty, filledQty, remainingQty, pctComplete, notionalUsd, filledNotionalUsd
- **Price (9):** limitPrice, arrivalPrice, avgFillPrice, marketBid, marketAsk, marketMid, lastFillPrice, distanceToLimitBps, spreadBps
- **Performance (6):** slippageBps, slippageUsd, unrealisedPnlUsd, realisedPnlUsd, vwapBenchmark, perfVsVwapBps
- **Execution (4):** numFills, numChildOrders, participationRate, lastFillQty
- **Time (6):** createdAt, startTime, endTime, lastUpdateTime, completedAt, durationMins

## Server design (apps/antikythera)
**Columnar in-memory store.** Strings are dictionary-encoded into `Uint16/Uint32Array`, numbers and dates go into `Float64Array`, and an `orderId → rowIndex` map handles lookups. This comes to roughly 300–400MB for 1M rows, compared with about 1.5GB as JS objects. Row objects are only built for blocks being sent.

**Startup.** The repository streams `loadAll()` from Mongo in 10k batches into the store. The server reports load time and RSS.

**Query engine** (pure functions, unit-tested and benchmarked):
- **Filter:** translates the AG filter model into a predicate over the columns. Supports text, number, date and set filters, and AND/OR conditions.
- **Sort:** a multi-column sort produces a `Uint32Array` of row indexes.
- **Group and aggregate:** handles `rowGroupCols` and `groupKeys`, returns group rows with `childCount`, and computes aggregates (sum notional/filled, count, notional-weighted avg slippage).
- **View cache:** results are cached per query key (trader + filter + sort + group), so clients with the same view share one result. This matters for the 50-client target.

**Ingest.** NATS JetStream durable consumers on `orders.events` and `prices.*`:
- Order events go into the store, then a write-behind batched `bulkWrite` to Mongo every 500ms.
- Price ticks go to an index of LIVE orders by pair, and the server recomputes market price, distance-to-limit, slippage and unrealised P&L for those rows.

**Flush loop (every 100ms, configurable; this also conflates updates):**
1. Collect the changed row indexes from this tick.
2. For each cached view, apply changes incrementally: remove and reinsert changed rows using a batched merge (O(n) once per tick rather than once per change), and adjust group aggregates.
3. For each client, look at the rows it currently holds. The server mirrors the grid's block cache LRU (`maxBlocksInCache`).
   - **Value-only change:** send a partial `update` for that row (route + id + changed fields).
   - **Structural change** (an insert, or a change that moves a row's sort position, filter membership or group): with the default `createdAt desc` sort and the top block loaded, send a precise `add` with `addIndex`. Otherwise mark the route dirty, and the client runs `refreshServerSide({route, purge:false})`, throttled to at most once per second.
   - Always send updated per-route `rowCounts`, `newAbove` counts and the status summary strip.

**Commands.** Cancel/Pause/Resume are validated with zod, published to `orders.commands`, and acknowledged. The resulting state change comes back as a normal order event.

**Backpressure.** Each client has a send-queue cap based on `ws.bufferedAmount`. A slow client gets its updates conflated (latest value per row) rather than queued without limit.

**Metrics (`prom-client`, `/metrics`):** process CPU, RSS/heap, event-loop lag, WS connections, messages and bytes in/out per second, flush duration, getRows latency histogram, ingest rate.

## Protocol (packages/logos/protocol)
- **Client → server:** `hello{traderId, codec}`, `getRows{reqId, request: IServerSideGetRowsRequest}`, `setFilterValues{reqId, colId}`, `command{reqId, orderId, action}`.
- **Server → client:** `rows{reqId, rowData, rowCount}`, `delta{seq, serverTs, updates[], adds[], dirtyRoutes[], rowCounts[], newAbove}`, `summary{...}`, `ack`, `error`. Appendix C is authoritative.
- **Codec interface:** `encode/decode`, with `json` and `msgpack` (`@msgpack/msgpack`) implementations, negotiated in `hello`.

## Web design (apps/pharos)
**WebSocket and decoding** run in a **Web Worker**, which posts decoded batches to the main thread to keep it free.

**AG Grid SSRM:**
- The datasource `getRows` calls the server over WS (request/response by `reqId`). `getRowId` combines the parent keys and orderId.
- Settings: `cacheBlockSize=100`, `maxBlocksInCache=20`, `rowGroupPanelShow='always'`.
- Filters: text, number and date filters, plus set filters whose values come from `setFilterValues`.
- Context menu: Cancel/Pause/Resume, enabled only for LIVE/PAUSED rows.

**Applying deltas:**
- The server already batches updates every 100ms, so the client applies each `delta` message straight away with **synchronous** `applyServerSideTransaction`, one call per route.
- Partial rows are merged into `{...api.getRowNode(id).data, ...partial}` immediately before that call. Don't use the async API for this: two partials queued before the async flush would both merge against stale `node.data` and lose fields.
- If the delta rate ever exceeds 20 messages/s, the worker coalesces them per animation frame.
- `enableCellChangeFlash` is on, with up/down colouring on price columns.
- Dirty routes are refreshed with `refreshServerSide({route, purge:false})`.

**New rows on top.** When the user is scrolled down, the client adjusts the scroll offset by `newAbove × rowHeight` so the view doesn't jump, and shows a clickable "N new orders ↑" badge.

**Status bar:** connection state, codec, client FPS, msgs/s, tick-to-screen latency (`serverTs` → render), and the server's CPU/RSS.

**UI:** trader selector in the header, Zustand for small app state, AG Grid Theming API (Quartz, dark).

## Mock middleware (apps/hermes)
- **Price feed:** 20 pairs on a random walk, 3 ticks/s, published to `prices.<PAIR>`.
- **Order lifecycle:** PENDING_START becomes LIVE at `startTime`. LIVE orders receive fills until FILLED. New orders arrive (mostly LIVE, some PENDING_START). It also handles `orders.commands`.
- **Rates:** set via env or a NATS control subject (`medium` default, `stress` preset), toggleable from a UI dev menu.

## Data layer (packages/mnemosyne)
- **`OrderRepository` interface:** `loadAll(): AsyncIterable<Order[]>`, `upsertMany(orders)`, `count()`, `isSeeded()`, `clear()` (CP-1). Phase 5 adds:
  - `loadCurrent(): Promise<Order[]>`: the LIVE, PAUSED and PENDING_START orders. Hermes uses it to rebuild its state at startup.
  - `maxOrderId(): Promise<string | null>`: the highest `orderId`, so new IDs stay ascending.
  - Both go in the contract suite. A `{status}` index already exists.
- **`MongoOrderRepository`:** `orders` collection, indexes `{traderId, createdAt:-1}` and `{status}`, `bulkWrite` upserts.
- **Contract test suite** (`repository.contract.ts`): runs against Mongo (mongodb-memory-server) and an in-memory fake, ready for future Oracle/KDB adapters.
- **`docs/db-adapters.md`:** Oracle DDL sketch (gvenzl/oracle-free container, `node-oracledb`), and a KDB schema sketch (date-partitioned table, a tickerplant feed as an alternative to NATS, IPC client).
- **Seeder:** a deterministic PRNG (seeded) produces the same dataset every run. It inserts in batches of 10k and skips if the data is already seeded.

## Docker & hosting
**Principle: every service runs in a container.** The laptop and the remote box run the *same* `docker-compose.yml`; only an env file differs (`.env.local` vs `.env.remote`). The Vite dev server is a convenience for UI work only. The reference run is the fully containerised stack.

**Compose profiles:**
- `core`: mongo, nats (JetStream), server, mock-middleware, web (nginx serving the static build and proxying `/ws` to the server)
- `seed`: seeder
- `monitoring`: prometheus, grafana
- `loadtest`: loadtest
- `edge`: Caddy, for optional TLS on the remote box

Mongo and NATS data live on named volumes.

**Images:**
- Multi-stage `node:24-slim` builds via `turbo prune`; multi-arch (amd64 for the laptop, arm64 for Graviton).
- Each compose service has both `build:` and `image: ${REGISTRY}/apeiron/<codename>:${TAG}`. Locally, `compose up --build` builds; remotely, `compose pull` pulls the same tags.
- The GitHub Actions workflow builds and pushes to **Amazon ECR** (private, about $0.10/month for roughly 1GB). GHCR can be selected via env as a free alternative.

### Remote: AWS, on demand for short test sessions
- **Terraform** (`infra/aws/`, small): ECR repos, one EC2 **Graviton `t4g.xlarge`** (4 vCPU/16GB), a 30GB gp3 volume, an IAM role (ECR pull + SSM), and a security group open only to your IP.
  - The instance is created with `cloud-init`, which installs Docker and the compose plugin.
  - **No ALB or NAT gateway**, to keep costs down.
- **Scripts** (`scripts/remote-*.sh`, using the AWS CLI and SSM, so no SSH keys):
  - `remote-up`: start the instance (or `terraform apply` on first run), log in to ECR, `compose pull && compose --profile core --profile monitoring up -d`, run the seeder only if no data has been seeded, and print the URLs.
  - `remote-down`: **stop** the instance. The volume stays, so Mongo data persists and there's no re-seed next time.
  - `remote-destroy`: `terraform destroy`, which removes everything including the data.
  - `remote-loadtest`: run the loadtest container on the box, or from the laptop against it.
- **Access:** HTTP over the instance's public IP, restricted to your IP. Optionally, the `edge` profile adds Caddy and a Let's Encrypt certificate on an `<ip>.sslip.io` hostname.
- **Cost:** about **$0.13/hr while running** (a 4-hour test session costs about $0.55; Spot is about 60–70% cheaper). About **$2.40/month while stopped** (the volume), plus pennies for ECR. Nothing is billed for compute between sessions.

**Alternatives** (`docs/hosting.md`; same images and compose file, different host):
| Option | ~Cost |
|---|---|
| Oracle Cloud Always Free ARM (4 OCPU/24GB) | $0, but capacity can be scarce |
| Hetzner CAX31 (8 vCPU/16GB), hourly billing | ~€0.02/hr |
| AWS ECS Fargate + ALB + Atlas | ~$250+/month; production-style, not needed for the POC |

Atlas M0 (512MB storage) can't hold 1M × 50 columns, and DocumentDB isn't fully Mongo-compatible, so Mongo runs in a container everywhere.

## Load-test harness (apps/talos)
- **Clients:** N (default 50) WS clients, each with a random trader, sort, filter and group mix. They simulate scrolling by requesting random blocks at a set rate and use both codecs.
- **Reports:** getRows p50/p95/p99, delta latency, msgs and bytes per second per client, plus server CPU, RSS and event-loop lag scraped from `/metrics`. Output is a console table plus a JSON file under `loadtest/results/`.

**POC targets:**
- getRows p95 < 50ms
- sort/filter/group change on 1M rows < 300ms
- tick-to-screen p95 < 150ms, **end to end (CP-4 ruling)**: from the source event's `ts` (hermes price tick or order event) to the client receiving the delta, measured with `delta.srcTs`. The browser render (about 5–10ms) is reported separately. Gated with 50 clients over the whole run, including the stress window.
- event-loop lag p99 < 50ms
- server RSS < 2GB with 50 clients
- 60fps scrolling

## Testing (per global conventions)
- **Unit tests:** Vitest `*.spec.ts(x)` next to the source. Covers the engine (filter/sort/group/agg/incremental merge), codecs, flush diffing, the generator, the protocol, and React components (React Testing Library).
- **Mocking:** `vi.fn`/`vi.spyOn` only. Mock factories live in the test file unless shared.
- **Benchmarks:** `vitest bench` on engine operations over 1M synthetic rows.
- **E2E:** Playwright `e2e/tests/*.e2e.ts` covering grid load, sort, filter, group, a live tick flash, a new row on top plus the badge, the cancel action round trip, and switching traders.

## Build phases and done criteria
**Rules for the implementing agent:**
- Work one phase at a time.
- At the end of each phase, `pnpm lint && pnpm typecheck && pnpm test` must pass, the compose stack must start, and the phase is committed.
- Stop and report rather than improvise if any of these happen:
  - a contract in the Appendix seems wrong;
  - a POC target is missed by more than 2×;
  - a fallback (Appendix F) has to be used.
- No TODO comments.
- Check library APIs with context7 before using them, especially AG Grid SSRM and nats.js v3.

| # | Phase | Done when |
|---|---|---|
| 1 | **Scaffold**: `git init`, create the public GitHub repo `iAppGeek/apeiron` and push, pnpm/Turbo, tsconfig/eslint packages, Dockerfile template, compose with mongo + nats, CI workflow (lint/typecheck/test), README stub, MIT licence | `pnpm build` passes; `docker compose --profile core up` starts mongo and nats with healthy healthchecks; CI is green on GitHub |
| 2 | **Data**: `shared` (schema, columns, PRNG, generator, protocol, codecs), `db` (interface, Mongo adapter, contract tests), `seeder` container | The seeder loads 1M rows in under 3 min and a second run is a no-op; the generator is deterministic (same seed gives the same first 100 rows, checked by snapshot); the contract tests pass against Mongo and the in-memory fake; JSON and msgpack round-trip every message type |
| 🔍 | **OPUS REVIEW CP-1: Foundations** | See checkpoint table below |
| 3 | **Engine**: columnar store, filter/sort/group/aggregate, view cache, Fastify + ws `getRows`/`setFilterValues`, `/health` | Load from Mongo takes under 30s with heap under 800MB; benchmarks on 1M rows: filter + sort under 300ms, one-level group under 300ms, block fetch under 5ms; unit tests cover every filter operator in Appendix B |
| 🔍 | **OPUS REVIEW CP-2: Engine** | See checkpoint table below |
| 4 | **Grid**: web app with the worker transport, SSRM datasource, 50 column definitions from metadata, filters (incl. set filter values), sort, row group panel, trader selector, status bar shell | Manual checks pass for 1M rows, scrolling, sort, filter and group, with the web app running as the nginx container through compose; React Testing Library tests for the datasource adapter, worker message handling and trader selector |
| 5 | **Live updates**: mock-middleware (prices + lifecycle), server ingest, write-behind, flush loop (Appendix D), client delta application, flash, new-on-top + anchoring + badge | LIVE rows tick about 3×/s; new orders appear at row 0 under the default sort; with the view scrolled down, the visible rows don't move and the badge counts up; switching to the stress preset keeps event-loop lag p99 under 50ms with one client |
| 🔍 | **OPUS REVIEW CP-3: Live updates** (covers phases 4 and 5) | See checkpoint table below |
| 6 | **Actions**: context menu + command round trip | Cancel/Pause/Resume change the row status within 500ms; invalid actions (e.g. Cancel on FILLED) return an `error` shown as a toast |
| 7 | **Observability**: prom-client metrics, Prometheus/Grafana provisioned dashboard, loadtest harness, codec comparison | `loadtest --clients 50 --duration 300` meets the POC targets and writes a results JSON; the Grafana dashboard shows every metric listed under server design; the README gets a JSON vs msgpack comparison table |
| 🔍 | **OPUS REVIEW CP-4: Performance verdict** (covers phases 6 and 7) | See checkpoint table below |
| 8 | **Ship**: multi-arch ECR workflow, Terraform `infra/aws`, `remote-*` scripts, `docs/hosting.md`, `docs/db-adapters.md`, Playwright E2E | `terraform validate` passes; the scripts pass `shellcheck`; E2E passes against the containerised stack; a remote deploy runs only when the user triggers it (it costs money and needs their AWS credentials) |
| 🔍 | **OPUS REVIEW CP-5: Release review** | See checkpoint table below |
| 9 | **Resilience**: an integration suite proving the grid stays complete and in sync through WebSocket drops, flapping, stalls, high latency, low bandwidth and server restarts (Appendix G) | Every Appendix G scenario passes all three checks (model, server, screen) plus the monotonic invariants; the full suite runs locally with `pnpm e2e:resilience`, and a shortened smoke variant runs in CI; the scenarios are documented in `docs/TESTING.md` and the user guide |
| 🔍 | **OPUS REVIEW CP-6: Resilience** | See checkpoint table below |
| 10 | **Demo pack** (Opus): local E2E run, Chrome DevTools UI validation and screenshots, user guide (how to start everything), technical overview, benchmarks and timings, resilience results; ready to present to the development team | The guide works from a clean clone; every figure in it comes from a recorded run |

### Opus review checkpoints
**How a checkpoint works:**
1. Sonnet finishes the phase(s), makes sure every done criterion passes, commits, and tags the commit `cp-N`.
2. Sonnet writes `docs/checkpoints/CP-N.md` containing:
   - what was built;
   - every deviation from this plan, with the reason;
   - test, benchmark and load results, pasted as raw output;
   - open questions and known weaknesses.
3. **Sonnet then STOPS.** It doesn't start the next phase.
4. The user starts a review with **Opus**: switch the session model to Opus, or open a new Opus session, and ask it to "review CP-N per the plan". Opus reads the plan, `CP-N.md` and `git diff cp-(N-1)..cp-N`, re-runs the verification commands itself, and writes `docs/checkpoints/CP-N-review.md` with a verdict:
   - **APPROVE:** carry on.
   - **APPROVE WITH FIXES:** Sonnet fixes the listed items first; no second review is needed.
   - **REWORK:** Sonnet fixes the items, then Opus reviews again.
5. Opus may change the plan or the Appendix contracts. Any change gets recorded in the review file, and Sonnet follows the updated plan.

| CP | After | Why here | What Opus focuses on |
|---|---|---|---|
| **CP-1 Foundations** | Phase 2 | Everything else builds on the contracts, so mistakes here are the most expensive to fix later. | Types in `logos` (schema, column metadata, protocol) match Appendices B and C; the generator's distributions are realistic (sample stats in CP-1.md); `OrderRepository` will suit Oracle and KDB (streaming load, batch upsert); the contract tests mean something; the codec setup; monorepo hygiene (strict TS, no `any`, explicit return types, test-file conventions); the Dockerfile and compose patterns that later phases will copy. |
| **CP-2 Engine** | Phase 3 | The highest-risk logic in the project (correctness and memory). Live updates in phase 5 build directly on it. | Correctness of filter, sort, group and aggregation against the AG Grid request semantics; the property tests comparing engine results with a naive implementation; whether the benchmarks are honest (warm vs cold, realistic data); heap and RSS figures; how the store is laid out (typed arrays allocated so they can move to `SharedArrayBuffer` later); view cache keys and eviction; WS request/response handling and error paths; event-loop blocking during view builds. **Decides early whether the worker-thread fallback is needed.** |
| **CP-3 Live updates** | Phase 5 (covers 4 and 5) | The trickiest part of the project: incremental view updates, block tracking, deltas, scroll anchoring. Bugs here are subtle (stale cells, rows that never refresh, scroll jumps). | Appendix D implemented faithfully; the incremental-vs-rebuild property test; which changes count as structural; how closely block tracking follows the grid's cache; partial-merge correctness on the client (no lost fields); the new-on-top, anchoring and badge behaviour (Opus runs the app and watches with browser tools); backpressure and conflation; the order lifecycle state machine; write-behind correctness. Checks the pharos grid integration (phase 4) as well. **Decides whether to use the Appendix F fallbacks.** |
| **CP-4 Performance verdict** | Phase 7 (covers 6 and 7) | This is where the POC's main question gets answered with data. | Whether the load-test method is sound (realistic client mix, enough duration, no coordinated omission in latency measurement); results against every POC target; JSON vs msgpack conclusions; profiling hotspots (Opus may run `--cpu-prof` or heap snapshots); the Grafana dashboard tells the story; command round-trip validation and security (zod, state checks). Produces a short **findings summary** for the README: what the POC proved, and the limits found. |
| **CP-5 Release review** | Phase 8 | Before anything touches AWS or gets shared. | Terraform least privilege (IAM, security group limited to your IP, no public ports beyond the web port); no secrets in the repo or images; images run as a non-root user and stay small; the `remote-*` scripts are safe (idempotent, stop rather than destroy by default, show cost warnings); the E2E suite actually covers the manual checks; docs are complete (README quick start, hosting, db-adapters, architecture). Final `/code-review high` across the repo. |
| **CP-6 Resilience** | Phase 9 | It proves the core promise: what the trader sees is complete and current, even over a bad network. | Whether the checks really are independent (the model is not derived from the server); whether the drop types are realistic (clean close, hard down, half-open stall, mid-request); that no scenario passes vacuously (each must observe at least N reconnects and M deltas); flakiness (each scenario run 3 times); the heartbeat and half-open detection fix; that CI's smoke variant is meaningful. |

**Extra Opus reviews outside the checkpoints.** Sonnet stops and asks for an Opus review whenever:
- an Appendix contract seems to need changing;
- an Appendix F fallback looks necessary;
- a POC target is missed by more than 2×;
- the same failing test or bug survives 3 fix attempts;
- a new dependency outside Appendix A is wanted.

---

## Appendix A: Config, ports, versions
**Ports:**
| Service | Port |
|---|---|
| web (nginx) | 8080 |
| server (HTTP: `/health`, `/metrics`; WS at `/ws`) | 4000 |
| mongo | 27017 |
| nats | 4222 (client), 8222 (monitor) |
| prometheus | 9090 |
| grafana | 3001 |
| vite dev | 5173 (dev only) |

**Env vars** (validated with zod at startup; each app has its own `config.ts`; `.env.example` is committed):
| Variable | Default |
|---|---|
| `MONGO_URL` | — |
| `MONGO_DB` | `blotter` |
| `NATS_URL` | — |
| `DB_ADAPTER` | `mongo` |
| `SEED_ROWS` | `1000000` |
| `SEED` | `42` |
| `FLUSH_MS` | `50` (CP-4: was 100. At 50ms, event age at flush p95 fell from 192ms to 78ms under 50 clients plus stress, for about 4 points more median CPU) |
| `FLUSH_BUDGET_MS` | `40` (phase 7, the time budget per flush) |
| `MONGO_CACHE_GB` | `1` (WiredTiger cache cap, so a shared 6GB Docker VM doesn't swap; raise it on the 16GB remote box) |
| `WRITE_BEHIND_MS` | `500` |
| `MAX_TRACKED_BLOCKS` | `100` |
| `LOAD_PRESET` | `medium` (or `stress`) |
| `LOG_LEVEL` | — |
| `REGISTRY` | — |
| `TAG` | — |
| `SEED_NOW` (gaia) | unset = wall clock; ISO timestamp pins the dataset for exact reproducibility |
| `BATCH_SIZE` (gaia) | `10000` |
| `SEED_RESET` (gaia) | `false`; `true` drops the orders collection and re-seeds, which refreshes the 6-month window to the current date |

**Server process:** `NODE_OPTIONS=--max-old-space-size=3072`. Logging uses Fastify's built-in pino.

**Versions (CP-1 decision): always use the latest stable release.** Only stay behind when a peer-dependency range or a runtime incompatibility forces it. Record every such exception in the checkpoint report with the blocking constraint, and revisit it at each checkpoint.
- **Runtime:** Node 24 LTS in containers (`node:24-slim`); `@types/node` stays on `^24` to match the runtime. pnpm 10, Turborepo 2.
- **TypeScript 6.0.x**, strict. **7.x is blocked** because `typescript-eslint` 8.x's peer range is `<6.1.0`; move to 7 as soon as `typescript-eslint` supports it.
- **Libraries:** React 19, Vite 8, `ag-grid-react` + `ag-grid-enterprise` 36 (same version; register modules explicitly), Fastify 5 + `@fastify/websocket` 11, `mongodb` driver 7, `@nats-io/transport-node` + `@nats-io/jetstream` (nats.js v3), `@msgpack/msgpack` 3, `zod` 4, `prom-client`, `zustand` 5, Vitest 5, React Testing Library 16, Playwright, `mongodb-memory-server` 11.
- **Container images:** pin the minor version, never a floating major. Use `mongo:9.0` (current major release; fall back to `mongo:8.0` LTS only if the driver or mongodb-memory-server can't support 9.0) and `nats:2.15-alpine`. mongodb-memory-server is pinned to the same Mongo minor as the image.

**AG Grid modules:** ServerSideRowModel, ServerSideRowModelApi, RowGrouping, SetFilter, TextFilter, NumberFilter, DateFilter, ContextMenu, CellStyle, HighlightChanges, StatusBar. No licence key, so the watermark is accepted.

## Appendix B: Grid ↔ engine contracts
**Columns.** Each `ColumnMeta` has:
- `field`
- `header`
- `type`: `'string' | 'enum' | 'number' | 'datetime' | 'date'`
- `filter`: `'text' | 'set' | 'number' | 'date'`
- `groupable: boolean`
- `aggFunc?`: `'sum' | 'avg' | 'wavg:notionalUsd' | 'count'`
- `decimals?` (fixed display decimals, for non-price numbers)
- `pairDecimals?: boolean` (CP-1). Price columns display with the row's pair decimals: JPY pairs 3, SEK/NOK/MXN/ZAR/CNH/TRY 4, others 5. Look these up from `PAIR_BY_NAME`; price columns have no fixed `decimals`.
- `width?`
- `priceColumn?: boolean` (drives up/down flash)
- `nullable?: boolean` (CP-1): true for `limitPrice`, `avgFillPrice`, `lastFillPrice`, `distanceToLimitBps`, `slippageBps`, `vwapBenchmark`, `perfVsVwapBps`, `completedAt`.

**Null semantics (CP-1 decision), the same everywhere:**
- **Storage:** in the columnar store, a null number or date is `NaN` in its `Float64Array`. It converts back to `null` at the boundary when rows are materialised. On the wire and in the DB it is always `null`.
- **Sort:** null sorts as the *smallest* value, so it comes first in `asc` and last in `desc`. This matches AG Grid's own client-side behaviour.
- **Filter:** `blank` matches null and `notBlank` matches non-null. Every other number or date operator never matches null.
- **Aggregation:** null rows are skipped, along with their weight in weighted averages. If every value is null, the aggregate is null. **The exception is `count`, which is always the number of rows in the group (equal to `childCount`) and is never null (CP-2).**

**Groupable columns:** traderName, account, currencyPair, baseCcy, quoteCcy, tenor, side, algoType, status, orderType, timeInForce, urgency, venue, valueDate.

**Default aggregates:**
- sum: orderQty, filledQty, notionalUsd, filledNotionalUsd, slippageUsd, unrealisedPnlUsd, realisedPnlUsd, numFills
- notional-weighted average: slippageBps, perfVsVwapBps, pctComplete

**SSRM request** (AG `IServerSideGetRowsRequest`):
- `startRow`, `endRow`
- `rowGroupCols[{id, field}]`
- `valueCols[{id, field, aggFunc}]`
- `groupKeys: string[]`
- `sortModel[{colId, sort: 'asc'|'desc'}]`
- `filterModel`

Pivot is not supported; reject the request if `pivotMode` is set.

**Which level is being requested.** Let `level = groupKeys.length`.
- If `level < rowGroupCols.length`, return **group rows**: `{ [rowGroupCols[level].field]: key, childCount, ...aggregates }`, sorted by the sort model where the sort column is an aggregate or the group column, otherwise by key ascending.
- Otherwise return **leaf rows**: full 50-field rows filtered by `groupKeys` equality on each group column.
- Always return `rowCount` equal to the exact total at that level.

**Group keys (pre-phase-3).** Group keys on the wire are strings. The group row's field value equals its key.
- Enum and string columns use the raw value.
- `valueDate` (type `date`) uses `YYYY-MM-DD` (UTC).
- A null group value has the key `"(blank)"`.

**Aggregate names on the wire.** Valid `valueCols[].aggFunc` values are `sum`, `avg`, `count` and `wavg`.
- `wavg` always weights by `notionalUsd`. The client registers it as a custom `aggFuncs` entry so AG Grid accepts the name.
- Any other name gets `error{code:'UNSUPPORTED_AGG'}`.

**Default ordering.** An empty `sortModel` means `createdAt desc`. Every sort ends with an `orderId` tiebreaker in the same direction as the last sort key, so the order is stable and block fetches never overlap or skip rows.

**Row IDs** (`getRowId`, the same rule on server and client):
- Leaf rows: `orderId`.
- Group rows: `"G:" + [...parentKeys, key].join("|")`.

**Filter model** (AG shapes to support, applied with AND across columns):
- text: `{filterType:'text', type: contains|notContains|equals|notEqual|startsWith|endsWith|blank|notBlank, filter}`. Matching is case-insensitive.
- number: `{filterType:'number', type: equals|notEqual|lessThan|lessThanOrEqual|greaterThan|greaterThanOrEqual|inRange|blank|notBlank, filter, filterTo}`.
- date: `{filterType:'date', type: same set as number, dateFrom:'YYYY-MM-DD HH:mm:ss', dateTo}`. **Every date operator is UTC-day granular (CP-2 decision).** Let `D0 = dayStart(dateFrom)` and `D1 = dayStart(dateTo)`:
  - `equals`: `[D0, D0+1d)`
  - `notEqual`: outside that range
  - `lessThan`: `< D0`
  - `lessThanOrEqual`: `< D0+1d`
  - `greaterThan`: `≥ D0+1d`
  - `greaterThanOrEqual`: `≥ D0`
  - `inRange`: `[D0, D1+1d)`, which includes both days
- **`inRange` is inclusive for numbers and dates (CP-2).** The client sets `filterParams.inRangeInclusive: true` on number and date filters so the UI wording matches.
- set: `{filterType:'set', values: string[]}`. Compare against dictionary codes, not strings.
- combined: `{filterType, operator:'AND'|'OR', conditions:[…]}`.
- Unknown shapes return `error{code:'UNSUPPORTED_FILTER'}`.

**Set filter values.** `setFilterValues{colId}` returns the distinct dictionary values for the current trader scope, sorted. It's capped at 5,000 values; free-text-like columns (orderId, clientOrderId, parentOrderId) use a text filter instead.

**Trader scope.** `hello.traderId` is either `'ALL'` or a trader ID. It's applied as an implicit filter on every query; a new `hello` resets the subscription.

## Appendix C: Protocol types (packages/logos/src/protocol.ts)
```ts
type ClientMsg =
  | { t: 'hello'; traderId: string; codec: 'json' | 'msgpack'; clientId: string }
  | { t: 'getRows'; reqId: number; req: SsrmRequest }
  | { t: 'setFilterValues'; reqId: number; colId: string }
  | { t: 'command'; reqId: number; orderId: string; action: 'CANCEL' | 'PAUSE' | 'RESUME' }
  | { t: 'control'; reqId: number; preset: 'medium' | 'stress' }   // CP-1: UI dev menu → server → NATS control.load
  | { t: 'ping'; ts: number };
type ServerMsg =
  | { t: 'welcome'; serverTime: number; traders: TraderInfo[]; columnsVersion: string }
  | { t: 'rows'; reqId: number; rows: Row[]; rowCount: number; ms: number }
  | { t: 'filterValues'; reqId: number; values: string[] }
  | { t: 'delta'; seq: number; serverTs: number;
      updates: { route: string[]; rows: (Partial<Order> & { orderId: string })[] }[];
      groupUpdates: { route: string[]; rows: Row[] }[];
      adds: { route: string[]; addIndex: number; rows: Order[] }[];
      srcTs: number;             // CP-4: earliest source-event ts (hermes) folded into this tick, for true end-to-end latency
      dirtyRoutes: string[][];
      rowCounts: { route: string[]; rowCount: number }[];   // CP-1: was a single rowCount; per route, only tracked routes whose count changed
      newAbove: number }                                      // root route only
  | { t: 'summary'; byStatus: Record<OrderStatus, number>; liveNotionalUsd: number; totalRows: number;   // scoped to the client's trader (and filter)
      server: { cpu: number; rssMb: number; elLagMs: number } }
  | { t: 'ack'; reqId: number }
  | { t: 'error'; reqId?: number; code: string; message: string }
  | { t: 'pong'; ts: number; serverTs: number };
```
- **Codec negotiation:** the first frame (`hello`) is always JSON text. Every later frame uses the negotiated codec: text frames for JSON, binary frames for msgpack.
  - **Frames are self-describing in both directions (CP-3).** A receiver decodes by frame type, never by the negotiated codec: a text frame is JSON, and a binary frame is msgpack. The negotiated codec only chooses what the *sender* emits.
  - Every `hello`, including a mid-session re-hello, is JSON text, so switching back from msgpack to JSON works.
- **Load preset is visible (CP-3).**
  - Hermes publishes `control.state {preset}` on core NATS at startup, on every change, and every 5s.
  - The server caches the latest value and sends it as `welcome.preset` and `summary.preset` (`'medium' | 'stress' | null` until known).
- **Validation:** `ClientMsg` is validated with zod; `ServerMsg` is not, for speed.
- **Error codes (CP-2, complete list):**
  - Request content: `UNSUPPORTED_FILTER`, `UNSUPPORTED_AGG`, `UNSUPPORTED_PIVOT`, `UNSUPPORTED_GROUP`, `UNSUPPORTED_COLUMN`, `UNKNOWN_COLUMN`, `UNKNOWN_TRADER`
  - Message format and order: `BAD_REQUEST`, `BAD_FRAME`, `BAD_MESSAGE`, `HELLO_REQUIRED`
  - Server state: `NOT_READY`, `NOT_IMPLEMENTED`, `INTERNAL`
  - Phases 5 and 6 add: `INVALID_TRANSITION` (a command not allowed in the order's state), `UNKNOWN_ORDER`, `SLOW_CONSUMER` (sent just before closing a client that is too far behind)
- **NATS subjects:** `prices.<PAIR>` with `{pair, bid, ask, ts}`; `orders.events` with `{type: 'NEW'|'UPDATE', order: Partial<Order> & {orderId}, ts}`; `orders.commands` with `{orderId, action, requestedBy, ts}`; `control.load` with `{preset}`.
- **Event rules (pre-phase-5):**
  - **Absolute values:** events carry **absolute post-change values**, never increments (for example `filledQty: 4_200_000`, not `+100_000`). That makes applying them **idempotent**: replaying the ORDERS stream after a restart, or receiving a NEW for an order already in the store, is a safe upsert.
  - **Who sets which fields:** hermes owns the lifecycle and fill fields. The server owns the price-derived fields (`marketBid`/`Ask`/`Mid`, `spreadBps`, `distanceToLimitBps`, `slippageBps`, `unrealisedPnlUsd`) and recomputes them from the latest tick, including right after a fill.
  - **Shared fill maths:** the fill and lifecycle maths lives in logos as pure functions (`applyFill`, `transition`), used by both hermes and the tests.
- **Commands (phase 6):**
  - `orders.commands` adds `commandId = "<clientId>:<reqId>"`.
  - Hermes answers each command with an `orders.events` message: an `UPDATE` carrying `commandId`, or `{type: 'REJECT', commandId, orderId, code: 'INVALID_TRANSITION' | 'UNKNOWN_ORDER', message, ts}`.
  - The server sends the matching client `ack`, or an `error` with that code.
- **JetStream:** streams `ORDERS` (`orders.*`, limits retention, 24h) and `PRICES` (`prices.*`, max 1 message per subject).
  - Durable consumer `blotter-server` with filter subject `orders.events`; the server also consumes `prices.*`.
  - Durable consumer `hermes-commands` with filter subject `orders.commands`.
- **Why the per-route counts (CP-1):** with grouping, every route has its own count, so one top-level `rowCount` was ambiguous. `newAbove` applies to the root route, which is the only one where scroll anchoring matters.
- **Delta semantics (phase 5a, binding for the client):**
  1. **Apply order:** within a delta, apply `adds` before `updates`.
  2. **`updates` includes structural rows:** it can contain rows whose change was structural. Those routes are also listed in `dirtyRoutes`, so patching the values and then refreshing in the background is correct.
  3. **`newAbove`:** counts rows inserted above the start row of the client's last root-block request.
  4. **Slow consumers:** `SLOW_CONSUMER` is sent just before the server closes the socket with code 1013. The client reconnects and purges.
  5. **One view per client:** the server tracks blocks for the client's **current** view only (its most recent `getRows` query). A grid has one view at a time.
- **Server acks after persisting (phase 5a):** the `blotter-server` consumer uses `AckPolicy.All` and acks only after write-behind has persisted the batch. On attach, the consumer is reset so unacked messages replay at once. This needs NATS 2.14 or later; 2.15 is pinned.
- **Diagnostics:** `GET /debug/lag` on antikythera reports the flush, event-loop-lag and write-behind statistics.

## Appendix D: Live update algorithms (server)
**ChangeSet.** Built per flush tick: `Map<rowIdx, { changed: Set<field>, prev: Partial<Order> }>`. `prev` holds the old values of the aggregate, sort, filter and group fields; that's what lets views update without rescanning.

**View.** Keyed by `hash(traderId, filterModel, sortModel, rowGroupCols)`.
- Holds `leaf: Uint32Array` (the filtered and sorted row indexes) and a lazily built `groups: Map<routeKey, {keys, childIdx: Uint32Array, aggs}>` for each level that has been requested.
- Views are LRU-evicted after 60s with no subscribers.

**Applying a tick to a view:**
1. Split the changed rows into `structural` (a changed field is in the view's sort, filter or group fields, or the row is new) and `valueOnly`.
2. For structural rows:
   - If there are 5,000 or fewer, make one O(n) compaction pass that removes them from `leaf`, re-test membership, sort the survivors with the view comparator, and merge them back in O(n).
   - If there are more than 5,000, rebuild the view.
   - Do the same per affected group's `childIdx`. Create or remove group buckets as needed.
3. Aggregates: for each affected group, `agg += new − prev` (using `prev`). For weighted averages, keep `Σ(w·x)` and `Σw`.

**Client tracking.** Each client keeps `{view, blocks: LRU<blockKey = routeKey + '#' + startRow, Uint32Array rowIdx>}`, capped at `MAX_TRACKED_BLOCKS`. Set the grid's `maxBlocksInCache` lower than this so the server never under-tracks; over-sending updates is harmless because the grid ignores unknown IDs. Every `getRows` replaces the tracked entry for that block.

**Building a client delta:**
- **`updates`:** value-only changed rows that are in tracked blocks. Include only the changed fields plus `orderId`, grouped by route.
- **`groupUpdates`:** changed aggregates for group rows in tracked blocks.
- **`adds`:** only when the view sort is exactly `createdAt desc`, the row is new, and block `startRow=0` of its route is tracked. Send `addIndex: 0`.
- **`dirtyRoutes`:** any other structural change touching a route that has a tracked block. The client debounces `refreshServerSide({route, purge:false})` to at most once per second per route.
- **`newAbove`:** the number of rows inserted above the client's last-requested top row since the last delta.
- Skip the delta entirely if it would be empty, except for a `summary` sent every 1s.

**Price join.** `liveByPair: Map<pair, Set<rowIdx>>` is maintained on status transitions. On each tick, for each row:
- marketBid/Ask/Mid come from the tick.
- `distanceToLimitBps = (limit − mid)/mid·1e4`, with the sign set by side.
- `slippageBps = (avgFill − arrival)/arrival·1e4`, with the sign set by side, so a positive value is adverse.
- `unrealisedPnlUsd = filledQty·(mid − avgFill)·sideSign`, converted to USD.
- Then `lastUpdateTime = now`.

**Write-behind.** Dirty order IDs accumulate; every `WRITE_BEHIND_MS`, `upsertMany` is called. Price-only field changes are **not** persisted. Only lifecycle and fill changes are.

**Phase 5 requirements from CP-2.** Today the engine drops every cached view on any store change. That is correct for phase 3 but must not survive into phase 5.
1. **Updates in place.** Add `ColumnarStore.updateRow(row, partial) → { changed: OrderField[], prev: Partial<Order> }`, which writes in place and feeds the ChangeSet. Appends add rows. Neither may bump a global "invalidate everything" version.
2. **Apply changes, don't clear.** `QueryEngine` applies each flush tick's ChangeSet to the cached views, as described in "Applying a tick to a view" above. `clear()` is only for benchmarks and tests. Set-filter value caches are invalidated only when a dictionary gains a value.
3. **String sort ranks stay off the hot path.** After an append, mark the ranks stale. The incremental merge compares the changed rows' strings directly. A full rebuild of a view sorted by a string column uses the comparator path while the ranks are stale. A chunked, yielding background task rebuilds the ranks, at most once per 30s.
4. **Order IDs stay ascending.** Hermes issues new `orderId`s above the current maximum (`ALG` + next sequence), so `store.idsAscending` stays true and radix sorts keep the free `orderId` tiebreak. If an append ever breaks this, the server logs a warning.
5. **Enum dictionaries can grow live.** A new enum value (for example a new venue) invalidates only that dictionary's rank and views that sort or filter on that column.

## Appendix E: Data generation and mock behaviour
**PRNG:** `mulberry32(SEED)`. The generator is a pure function `(seed, n, now) → Order[]` streamed in batches.

**Traders (5, fictional):** T1 35%, T2 25%, T3 20%, T4 12%, T5 8%. Each has 3 accounts.

**Pairs and decimals:**
- Mid levels (decimals): EURUSD 1.08 (5), GBPUSD 1.27 (5), USDJPY 150 (3), AUDUSD 0.66 (5), USDCAD 1.36 (5), USDCHF 0.88 (5), NZDUSD 0.61 (5), EURGBP 0.85 (5), EURJPY 162 (3), GBPJPY 190 (3), EURCHF 0.95 (5), AUDJPY 99 (3), USDSEK 10.5 (4), USDNOK 10.7 (4), USDMXN 17.2 (4), USDZAR 18.6 (4), USDSGD 1.34 (5), USDHKD 7.82 (5), USDCNH 7.25 (4), USDTRY 32 (4).
- Weights: EURUSD 25%, USDJPY 15%, GBPUSD 12%, AUDUSD 7%, USDCAD 6%; the rest share the remainder.
- Spread: 0.5–3 bps for G10, 5–30 bps for EM.

**Historical orders:** `createdAt` falls on weekdays over the last 182 days, weighted to 07:00–17:00 London. Order quantity is log-normal, 1M–100M base (rounded to 100k). Algo weights: TWAP 30, VWAP 25, POV 15, ICEBERG 12, IS 10, SNIPER 8. Side is 50/50. Duration is 5–240 min. Historical statuses are FILLED 92% / CANCELLED 8% (cancelled orders are partially filled). Prices are consistent: arrival is around the mid of that day (random walk per pair), and avgFill is arrival ± a slippage drawn from N(0.5, 2) bps.

**Current orders:** about 400 LIVE (startTime in the past, partially filled) and about 200 PENDING_START (startTime 1–120 min in the future). Their IDs sort after all historical IDs. `orderId = 'ALG' + zero-padded sequence`.

**Mock lifecycle (state machine):**
- PENDING_START becomes LIVE at `startTime`.
- LIVE: on each step, with probability p, a fill arrives. Fill quantity is about orderQty / (durationMins·6). This updates filledQty, avgFill, numFills, lastFill*, and pctComplete. The order becomes FILLED when remainingQty reaches 0, or CANCELLED on random expiry (rare).
- PAUSED orders get no fills.
- Commands: CANCEL (LIVE/PAUSED/PENDING_START → CANCELLED), PAUSE (LIVE → PAUSED), RESUME (PAUSED → LIVE). Anything else publishes a rejection event, which the server turns into an `error`.

**Price-feed start levels (CP-1).** The seeded mids drift during the generator's 6-month walk (EURUSD ends near 1.004, not 1.08). Hermes must therefore **start each pair's walk from the seeded current level**, not from `PAIRS.mid`; otherwise LIVE rows jump on the first tick.
- Read the level from the DB at startup: the latest `marketMid` per pair among LIVE and PENDING_START orders.
- Fall back to `PAIRS.mid` only for a pair with no current orders.
- Logos should also export the generator's final mids (for example `finalMids(seed, n, now)`), so tests can assert this.

**Stale current orders (CP-1).** The dataset is anchored to the seed time, so on a later day the current orders are stale. Hermes reconciles them once at startup, publishing the results as ordinary `orders.events`:
- LIVE orders whose `endTime` is in the past become FILLED (or CANCELLED with probability 0.08).
- PENDING_START orders whose `startTime` is in the past become LIVE.
- It then tops LIVE back up to the preset's target with new orders.

`SEED_RESET=true` re-seeds a fresh 6-month window anchored to today.

**Rates:**
| Preset | Updates/s (fills + status) | New orders/s | Price ticks |
|---|---|---|---|
| medium | 100 | 5 (80% LIVE / 20% PENDING_START, keeping LIVE count around 400–600) | 3/s per pair |
| stress | 2,000 | 50 (LIVE cap raised to 5,000) | 3/s per pair |

**Pacing as built (phase 5a, accepted).** Under stress, the fill formula above drained LIVE to about 150 rows. Hermes instead paces fills per order (32 for medium, 64 for stress) over a 1–2 minute order lifetime. That holds LIVE at about 400–500 on medium and about 4,000 on stress.

## Appendix G: Resilience test suite (phase 9)
**Goal:** after any connection disruption, the grid shows **complete, current data**. It must not miss updates, show stale values, show out-of-sync aggregates or counts, or let a value move backwards.

### Harness
- **Network faults: Toxiproxy** (`ghcr.io/shopify/toxiproxy`, pinned to the latest minor), a new dependency approved by the user's request.
  - Compose profile `resilience`: `toxiproxy` (API on `127.0.0.1:8474`) proxies `toxiproxy:4100` → `antikythera:4000`.
  - A second web container, **`pharos-e2e`**, on `127.0.0.1:8081`. It's the same image, with nginx's `/ws` upstream set by env (`WS_UPSTREAM=toxiproxy:4100`; the default stays `antikythera:4000`) and built with `VITE_TEST_HOOKS=1`.
  - **Test hooks:** only in that build, `window.__apeironTest` exposes **read-only** helpers: loaded rows via `api.forEachNode`, the root row count, the summary, the connection state, and reconnect and delta counters. The production build has none.
- **A deterministic update driver** (`e2e/support/driver.ts`, using `@apeiron/iris` and logos `applyFill`, `transition` and the price recompute) replaces hermes during a scenario. Hermes is stopped in setup and restarted in teardown.
  - **Start:** the "initial image" is the current DB state. It reads `loadCurrent()` and `maxOrderId()`.
  - **During:** it publishes a **seeded** stream for the scenario's duration: price ticks 3/s per pair; fills on LIVE orders; status transitions (PENDING_START→LIVE, LIVE→FILLED/CANCELLED, PAUSE/RESUME); new orders, about 5/s, with ascending IDs; and changes that move rows between groups and in and out of filters.
  - **The model:** every event is applied to an **independent in-memory model** of the expected final state.
- **Fault controller** (`e2e/support/faults.ts`): drives the Toxiproxy API. It can drop a connection cleanly (`reset_peer`), take the proxy fully down for N seconds, add a `timeout` toxic (a half-open stall: data stops and nothing closes), add `latency` with jitter, and add `bandwidth` limits per direction.
- **Browser:** Playwright `e2e/tests/resilience/*.e2e.ts` opens several pages at once, each with a different view.
  - **V1:** the default flat view, at the top.
  - **V2:** flat, scrolled to about row 300,000 (anchoring).
  - **V3:** grouped by pair, with LIVE drilled open.
  - **V4:** status = LIVE, sorted by `unrealisedPnlUsd desc`, so the sort key ticks.
  - **V5:** trader T2 only, using msgpack.

### The three checks (run after the update stream stops)
Stop the driver, wait for the server to flush and the client to go quiet (no deltas for 2s), then:
1. **Model vs server.** A fresh WebSocket client reads every changed order, plus the top 500 of each view, from antikythera. Every field must equal the model, apart from fields set by the server's clock (`lastUpdateTime`).
2. **Server vs screen.** For each page, every row the grid has loaded must equal the fresh server read field for field, including `lastUpdateTime`. The row order of the loaded blocks, the root `rowCount`, the group `childCount`s, the aggregates, and the status-chip summary must match too.
3. **Invariants during the run.** A sampler reads each page's loaded rows every 500ms. For every order, `filledQty`, `numFills` and `lastUpdateTime` never go backwards, and an order that reached FILLED or CANCELLED never shows as LIVE again. It also counts reconnects and deltas: **a scenario fails unless it saw at least the expected number of reconnects and deltas,** so it can't pass by doing nothing.

Fix the client heartbeat first; S3 depends on it. **The client** treats the connection as dead if no frame arrives for 3 ping intervals (6s), then closes it and reconnects, which detects a half-open socket. **The server** pings clients and closes any that stay silent past the timeout, so stale sessions are cleaned up. Check whether either is missing and add it.

### Scenarios
| ID | Scenario | Faults | Asserts, beyond the three checks |
|---|---|---|---|
| **S1** | **The user's required scenario.** Initial image, then about 5 minutes of updates; drop the WebSocket every 30s | 10 drops, rotating between a clean close, proxy down for 3s, and proxy down for 10s | At least 10 reconnects per page; the final screen state is complete and current on all five views |
| S2 | Rapid flapping | Drops every 2–5s for 2 minutes, some timed during an in-flight `getRows`, a `hello`, a trader switch or a codec switch | No stuck "switching…" or loading state; no orphaned request promises; same final state |
| S3 | Half-open stall | A `timeout` toxic: the socket stays open but no data flows, for 20s, 3 times | The client detects it within about 6–8s and reconnects; the data is correct afterwards |
| S4 | Long outage during a burst | Proxy down for 60s while the driver runs at the stress rate | One reconnect; the backlog clears; the anchor and badge behave on V2 |
| S5 | High latency | 300ms ± 100ms each way for 3 minutes, plus 2 drops | Eventually consistent; nothing goes backwards; tick-to-screen p95 recorded |
| S6 | Low bandwidth | Downstream limited to 64KB/s for 3 minutes, then 16KB/s for 1 minute | The server conflates; `SLOW_CONSUMER` is recorded at 16KB/s; the client reconnects and purges; data is correct once bandwidth returns |
| S7 | Server restart | `docker compose restart antikythera` mid-stream, twice | The client recovers; JetStream replays; the model check passes, proving no event was lost on the server side |
| S8 | Command across a drop | Send Pause and Cancel, then drop before the `ack` | The client shows an error or timeout and never hangs; the final grid matches the server, whether or not the command was applied |

**Duration and CI:**
- `pnpm e2e:resilience` runs everything; it's long-running and local.
- `pnpm e2e:resilience:smoke` runs S1 shortened (60s, drops every 10s) plus S3, and is part of CI's E2E job.
- Each scenario writes a JSON report to `e2e/results/`: reconnects, deltas, the checks that passed, and timings.

## Appendix F: Known risks and sanctioned fallbacks
- **SSRM `add` + anchoring is flaky.** Fallback: send every structural change as `dirtyRoutes` (background refresh). The anchor still works by comparing `getFirstDisplayedRowIndex()` before and after and calling `ensureIndexVisible(prev + newAbove, 'top')` on the `storeRefreshed` event.
- **Incremental view maintenance is too complex or buggy.** Fallback: rebuild affected views at most once per second when they have structural changes; value-only updates stay at 100ms. Keep a property test comparing incremental results against a full rebuild over random change sets.
- **Event-loop lag over target under stress.** Fallback: move view rebuilds to a `worker_threads` pool with columns in `SharedArrayBuffer`. Design the store with SAB-backed typed arrays from the start so this stays a drop-in change.
- **Heap over budget.** Store datetimes as Float64 epoch milliseconds, dictionary-encode every enum or string column with fewer than 65k distinct values, and keep the ID strings in one `string[]`.

## Verification
```bash
pnpm install
docker compose --profile core --profile seed up -d     # mongo, nats, seed 1M rows
pnpm dev                                                # server, mock-middleware, web (Vite :5173)
pnpm test && pnpm typecheck && pnpm lint
pnpm bench --filter @apeiron/antikythera
pnpm e2e
docker compose --profile monitoring up -d               # Grafana :3001
pnpm --filter @apeiron/talos start -- --clients 50 --duration 300 --codec both
docker compose --profile core --profile monitoring up --build   # full containerised run (reference)
./scripts/remote-up.sh                                  # same stack on AWS EC2
./scripts/remote-loadtest.sh --clients 50 --duration 300
./scripts/remote-down.sh                                # stop billing for compute
```
**Manual checks in the browser:**
- 1M rows appear, and scrolling stays smooth.
- Sort, filter and group respond in under 300ms.
- LIVE rows tick 3×/s with cell flash.
- New orders appear on top, and the badge works when scrolled down.
- Cancel on a LIVE order changes its status.
- Grafana shows CPU, memory and event-loop lag within targets during the 50-client load test.

---

## Status & handoff (as of 2026-10-07): read this first if you are picking the work up

### Progress
| Phase | State | PR / tag | Review |
|---|---|---|---|
| 1 Scaffold, 2 Data | ✅ merged | #1, #2 / `cp-1` | `docs/checkpoints/CP-1-review.md` |
| 3 Engine | ✅ merged | #3 / `cp-2` | `CP-2-review.md` |
| 4 Grid, 5a Live server, 5b Live client | ✅ merged | #4, #5, #6 / `cp-3` | `PHASE-4-review.md`, `PHASE-5A-review.md`, `CP-3-review.md` |
| 6 Actions | ✅ merged | #7 | `PHASE-6-review.md` |
| 7 Observability + load test | ✅ merged | #8 / `cp-4` | `CP-4-diagnosis.md`, `CP-4-review.md` |
| 8 Ship | 🟡 about 95%: CP-5 fixes F1–F8 in progress, then merge | #9 / `cp-5` | `CP-5-review.md` |
| 9 Resilience suite (Appendix G) | ⏳ next, not started | (none yet) | CP-6 |
| 10 Demo pack (Opus) | ⏳ after CP-6 | (none yet) | (none) |

**Working process:**
- **Sonnet agents** implement one phase per branch and open a PR without merging it. At a checkpoint they tag `cp-N` and write `docs/checkpoints/CP-N.md`.
- **Opus reviews:** clean-worktree checks, independent verification, `CP-N-review.md`. Contract changes go into this plan.
- **Sonnet** then applies the fixes and squash-merges.
- **Rules for everyone:**
  - Always use the latest stable versions, and record any exceptions.
  - Follow the user's CLAUDE.md: TypeScript strict, no `any`, explicit return types, `.spec.ts` beside the source, `vi.*` mocks only, no TODO comments.
  - The commit and PR attribution lines are required.

### Decisions log (binding; detail in the review files and the appendices above)
- **Architecture:** server-side SSRM (grouping needed), AG Grid Enterprise 36 with the watermark accepted, Fastify + `ws` with a pluggable codec, NATS JetStream bus, Mongo-only adapter (Oracle/KDB interface and docs only), pnpm + Turborepo, everything in containers.
- **Names:** Apeiron, with codename packages: pharos, antikythera, hermes, gaia, talos, logos, mnemosyne, plus `iris` (NATS adapter, added in phase 5a).
- **CP-1:**
  - versions: TypeScript 6.0.x (7 blocked by typescript-eslint), `mongo:9.0`, `nats:2.15-alpine`;
  - null semantics: NaN in typed arrays, nulls sort smallest, only blank/notBlank match null;
  - price decimals follow the pair (`pairDecimals`);
  - per-route `rowCounts`, and the `control` message;
  - hermes starts its price walk from the seeded mids and reconciles stale orders; `SEED_RESET`.
- **CP-2:**
  - date filters are UTC-day granular; `inRange` is inclusive;
  - `count` = `childCount`;
  - full error-code list;
  - the phase 5 view-maintenance requirements: no global invalidation, string ranks kept off the hot path, ascending IDs.
- **Phase 5:**
  - events carry absolute values and are idempotent;
  - the server acks after persisting;
  - delta semantics: adds before updates; one view tracked per client;
  - hermes paces fills per order.
- **CP-3:** frames are self-describing (text = JSON, binary = msgpack), which fixed a codec-switch bug; the load preset is shown via `control.state`.
- **CP-4:**
  - fixed the flush-loop death spiral: untracked views go stale, rebuilds are deferred, the flush has a 40ms budget, and skipped ticks share one log;
  - **tick-to-screen is end to end**, measured via `delta.srcTs`;
  - `FLUSH_MS` is 50;
  - `MONGO_CACHE_GB` is 1 on 6GB hosts;
  - the connect-storm cold burst is reported separately.
- **CP-5 / user (2026-10-07): AWS work paused** once the CP-5 fixes are done. Nothing is deployed. Terraform and the `remote-*` scripts are validated but **untested on real AWS**. Before a first deploy:
  - choose GHCR (public packages) or ECR;
  - protect the GitHub `release` environment;
  - run `scripts/remote-up.sh` yourself (it costs about $0.16/hr).
- **User additions:** the resilience suite (phase 9, Appendix G), then the demo pack (phase 10): E2E run, Chrome DevTools UI validation and screenshots, user guide, technical overview, benchmarks, and a presentation for the dev team.

### Headline results so far (CP-4 final: 50 clients × 300s, stress 120–180s)
| Measure | Result |
|---|---|
| Tick-to-screen p95 | 65ms (json) / 62.5ms (msgpack), end to end |
| getRows warm p95 | 18ms |
| View change p95 | 38ms |
| Event-loop lag p99 | 19–23ms |
| RSS | about 1.1GB |
| Command ack p95 | 66ms |
| msgpack vs json | about 11% fewer bytes, same latency |

The browser holds 103–120 FPS, the anchor holds deep in the grid, and E2E passes 18/18.

### Environment state
- **Local stack:** `docker compose --profile core --profile monitoring up -d`.
  - Ports: web on :8080, API on :4000, Grafana on :3001, Prometheus on :9090.
  - `scripts/loadtest-reset.sh` re-seeds and resets JetStream.
  - Docker VM: about 6GB.
- **Repo:** `iAppGeek/apeiron` (public). The git remote is HTTPS with a repo-local `gh` credential helper.

### Open items / next steps
1. Phase 8: apply CP-5 F1–F8, get CI green, squash-merge PR #9.
2. Phase 9: build Appendix G. Fix the client and server heartbeat (half-open detection) first. Then CP-6.
3. Phase 10 (Opus): local E2E, the DevTools pass and screenshots, `docs/USER-GUIDE.md`, `docs/TESTING.md` (including the resilience scenarios), and the presentation deck.
4. Known limitations to carry into the docs:
   - non-default-sort anchoring can drift about 1 row on the first refresh after scrolling;
   - a connect storm of 50 cold views queues for about 0.2–0.4s;
   - rare single event-loop stalls of 200–350ms show in the max figure;
   - AWS is untested.
