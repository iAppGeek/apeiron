# PLAN2: Java blotter server (side by side with Node)

Status: **agreed draft** (2026-10-11), revised after review. **Starts after PLAN1 CP-8.** It relies on the split:
after PLAN1 the blotter talks only to NATS, holds no database, lifecycle or persistence code, uses ephemeral watches
only, and its price overlay is a pure function. The working process and conventions in `docs/PLAN.md` apply. The
TypeScript rules in the user's CLAUDE.md map to Java as follows:
- no raw types;
- `Object` only at the boundary, and narrowed straight away;
- records and sealed interfaces for messages;
- a JUnit test class beside each production class (`src/test/java`, same package);
- no TODO comments.

**PLAN1's appendices are the contract.** In particular: 1A (subjects and buckets), 1B (record types), 1D
(entitlements), 1F (snapshot, update rules, readiness), 1G (protocol) and 1I (metrics and debug fields).

## Goal

A second blotter, `antikythera-java`, implements the same WebSocket protocol, health, metrics and readiness contract
as the Node blotter. It runs **in its own container**. The UI can switch between the two **per tab**. Acceptance is
the user's scenario: **tab 1 as TRADER1 on the Node blotter, tab 2 as TRADER2 on the Java blotter, and the data stays
in sync.**

Nothing else changes for the Java blotter's sake: themis, hermes, helios and NATS are untouched, and pharos and nginx
only gain the switch.

## Why the two tabs stay in sync

Both blotters read the same KV bucket (`ORDER_STATE`) and the same `prices.*` stream, each through its own ephemeral
watch, so they never compete for messages. Every displayed value is either:
- a record field copied from themis; or
- `deriveOverlay(record, latestTick)`, a pure function.

Two blotters that hold the same `v` of every record and the same tick are therefore identical. The only allowed
difference is timing: each blotter flushes on its own 50 ms timer, so at any instant one may be one flush ahead. Golden
vectors (2.1) guarantee the arithmetic matches bit for bit, and the twin tests (2.7) prove the whole chain.

## Decisions

| Area | Decision |
|---|---|
| Location and build | `apps/antikythera-java`, Gradle (Kotlin DSL) with the wrapper committed. A small `package.json` (`@apeiron/antikythera-java`) maps `lint`/`typecheck`/`test`/`build` to `./gradlew spotlessCheck`, `compileJava`, `test` and `bootJar`, so `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and Turbo still cover everything. CI's lint/test job adds `actions/setup-java` (Temurin 25) and a Gradle cache |
| Runtime | **JDK 25 LTS**, Eclipse Temurin JRE base image, Generational ZGC, `-Xmx2g` by default in the image (overridable through `JAVA_TOOL_OPTIONS`) |
| Framework | **Spring Boot 4.x with WebFlux (Reactor Netty), used for transport and operations only.** The engine is plain Java with no Spring or Reactor types. Each WebSocket session gets a bounded outbound sink; conflation and the slow-consumer disconnect stay custom, as in Node. Spring Boot Actuator is **not** used: the operations endpoints are written by hand to match the Node JSON shapes exactly |
| Concurrency (first) | **Like for like:** one writer thread owns the store, views, flush loop and tracker, as in Node's event loop. Sockets and codecs run on Netty threads; they receive prepared frames and never read the store. This gives a fair comparison first; 2.8 then optimises |
| Libraries | Jackson 3 (Spring Boot 4's default; a streaming generator writes rows straight from the columns), `msgpack-core`, `jnats` (KV watch with `endOfData`, ordered consumer, request/reply), Prometheus `client_java` 1.x (keeps `process_cpu_seconds_total` and `process_resident_memory_bytes`, so dashboards line up), `fastutil`, SLF4J and Logback with `logstash-logback-encoder`. Tests: JUnit 5, jqwik (property tests), AssertJ, Testcontainers (NATS), JMH (benchmarks). Exact versions are recorded in 2.2; always the latest stable, checked with context7, including jnats's KV watcher API |
| Message validation | Messages bind to Java records through Jackson with **unknown properties ignored** (`FAIL_ON_UNKNOWN_PROPERTIES` off), which matches zod's default of quietly dropping unknown keys. Hand-written checks then mirror every zod constraint in `clientMsgSchema` (non-negative integer `reqId`, enums, non-empty strings), and a failure gives `BAD_MESSAGE` as in Node. The generated JSON Schema is documentation and a test oracle, not the runtime validator |
| Shared code | The TypeScript `logos` package cannot be imported, so **contract artefacts** are generated from it (2.1) and are the only source the Java blotter builds against. No hand-copied constants |
| Ports and routing | The container listens on 4000 and maps to host `127.0.0.1:4010`. nginx serves `/ws/node` → `antikythera:4000` and `/ws/java` → `antikythera-java:4000` (`WS_UPSTREAM_JAVA`, default `antikythera-java:4000`; toxiproxy overrides it in the resilience profile). `/ws` stays an alias of Node, so talos and the existing e2e tests are unchanged |
| Server identity | `welcome.server = { impl: 'node' \| 'java', version, startedAt }` (PLAN1 Appendix 1G). Both blotters send it from 2.7 |
| Metric parity | The same `apeiron_*` names, labels and buckets (PLAN1 Appendix 1I and today's `metrics.ts`). The event-loop-lag figures (`summary.server.elLagMs`, `apeiron_event_loop_lag_seconds`) report **writer-thread scheduling lag** in Java: how late the flush thread wakes. Same name, with the meaning documented |
| Image | `infra/docker/java.Dockerfile`, multi-stage: a Temurin JDK stage builds the boot jar with Gradle inside Docker, so the images job needs no host JDK; then a Temurin JRE runtime, non-root. The images workflow's Dockerfile choice becomes a mapping (`pharos` → `web.Dockerfile`, `antikythera-java` → `java.Dockerfile`, the rest → `Dockerfile`). Add the service to `infra/aws/variables.tf` |
| Docker resources | Identical `cpus` and `mem_limit` for both blotters (set in PLAN2.5 for fair comparison) |

## Build phases and done criteria

| # | Phase (PR) | Scope | Done when |
|---|---|---|---|
| 2.1 | **Contract artefacts from logos** | `pnpm --filter @apeiron/logos contract` writes `packages/logos/contract/`: `protocol.schema.json` (zod 4's `z.toJSONSchema`, post-processed to allow unknown properties, matching runtime parsing: `ClientMsg`, `ServerMsg`, `OrderStateRecord`, `ProjectionMarker`, `OrderCommandRequest/Reply`, entitlements); `columns.json` (the 50 columns, types, enum dictionaries, decimals per pair, `COLUMNS_VERSION`); `fixtures/messages.json` and `fixtures/messages.msgpack` (**compared by decoded value, never byte for byte**, because encoders choose integer and float formats differently). Vectors: `overlay.json` (records × ticks → overlay fields); `filters.json` (filter models → matching ids over a fixed dataset); `engine/*.json` (a 20k-order generator dataset; requests covering sort, filter, group and aggregation; expected `rows`/`rowCount` from the Node engine); `incremental/*.json` (record and tick sequences → the expected view after each flush, generated **with the flush budget disabled and a fixed clock**, so they're the same on every machine). The budgeted, deferred and carried-over paths are covered separately by each language's own property tests against a full rebuild. CI fails if the artefacts are stale | Artefacts are committed; `contract:check` passes in CI; the Node engine re-reads its own vectors as a self-test |
| 2.2 | **Java skeleton** | Gradle project, Spring Boot app, `/health/live`, `/health/ready`, `/health`, `/metrics`, `/debug/lag` (the same JSON shapes as Node, including PLAN1 Appendix 1I fields); WebSocket `/ws`: `hello` (text JSON first frame), `welcome`, `ping`/`pong`, both codecs, frames self-described by type (text = JSON, binary = msgpack), 1 MB max frame, server ping 5 s / timeout 15 s, `BAD_FRAME`/`BAD_MESSAGE`/`HELLO_REQUIRED`/`UNKNOWN_USER`; entitlements file loading; `java.Dockerfile`; compose service `antikythera-java` (a `curl -fsS` healthcheck on `/health/ready`, `start_period` 120 s, the same entitlements mount); nginx routes; images workflow mapping | Fixture tests pass for every message with both codecs; the image builds for arm64 and amd64 in the images workflow; the stack starts with both blotters healthy (until 2.3, the Java blotter's ready means "skeleton up") |
| 2.3 | **Store, snapshot, prices, readiness** | Columnar store (`double[]`, `int[]`/`char[]` dictionary codes, `NaN` for null, `-0 → 0`), capacity reserved up front, orderId→row map, a per-row `v` array, `sortByOrderId()`; PLAN1 Appendix 1F exactly (the marker, the initial load until jnats's `endOfData`, the count check, the update rules, catch-up, the PRICES last value then live, warm-up, drain with 1012); overlay matching `overlay.json` | `overlay.json` passes exactly; loads 1M rows in ≤ 30 s on the laptop; a blotter against an unmarked bucket never reports ready; RSS reported in the checkpoint |
| 2.4 | **Query engine** | AG Grid filter model → predicates (text, number, date, set; AND/OR), multi-column radix or comparator sort, grouping with child counts, aggregation (sum, avg, count, notional-weighted average), string ranks (UTF-16 order, the same as JS `<`; `toLowerCase(Locale.ROOT)` for text filters), view cache (LRU by size and idle time), `getRows`, `setFilterValues`, all error codes | `filters.json` and `engine/*.json` pass exactly; jqwik property tests against a naive reference; JMH figures (cold and warm) recorded beside Node's `bench` |
| 2.5 | **Live updates** | ChangeSet, incremental views (value-only vs structural, budgeted flush, shared tick log, stale untracked views, deferred throttled rebuilds), client tracking (`MAX_TRACKED_BLOCKS`), deltas (`updates`, `groupUpdates`, `adds`, `dirtyRoutes`, `rowCounts`, `newAbove`, `srcTs`), conflation and the `SLOW_CONSUMER` disconnect, `summary` | `incremental/*.json` pass; jqwik property tests prove an incrementally patched view equals a rebuild, including the budgeted, deferred and carried-over paths; the existing e2e suite passes with `E2E_SERVER=java` |
| 🔍 | **OPUS REVIEW CP-9: Java parity** | | Faithfulness to PLAN.md Appendix D and PLAN1 Appendix 1F; vector coverage; threading (only the writer touches the store); allocation on the hot path; GC behaviour under stress |
| 2.6 | **Commands, amend, entitlements** | Entitlement checks and scoping (PLAN1 Appendix 1D), `orders.cmd` request/reply, ack once the store holds `v ≥ reply.v` (`ACK_WAIT_V_MS` cap), amend forwarding, the error mapping in PLAN1 Appendix 1G | The e2e tests for commands, amend and users pass against Java |
| 2.7 | **Client switch and twin verification** | pharos: a **"Blotter server: Node / Java"** radio in the Dev menu (top right, beside JSON / MessagePack). The choice is kept per tab in `sessionStorage`, can be overridden with `?server=java`, and switching closes the socket and reconnects to `/ws/<server>` with a fresh grid (the path the codec and trader switches already use). The header and status bar show `welcome.server.impl`. Node sends `welcome.server` too. talos gains `--server node\|java` (it picks the WS URL). The e2e suite and resilience tiers can target either (`E2E_SERVER`); toxiproxy gets a second proxy for Java. **Twin tests:** (1) `twin-tabs.e2e.ts` is the user's scenario: one context as TRADER1 on Node and one as TRADER2 on Java, with commands and amends from each, both screens checked against the record model; (2) `twin-protocol.e2e.ts`: SUPERVISOR on both servers; quiesce by stopping hermes and helios through the driver (`stopHermesContainer`, `stopHeliosContainer`), then wait until both blotters' `/debug/lag` show the same `appliedRev` equal to `KV_ORDER_STATE` `last_seq` and the same `lastTickTs` per pair; compare `getRows` for a matrix of views (sorts, filters, two-level groups, aggregates) and require identical values, ignoring `ms` | Both twin tests pass 3× in a row; the full e2e suite and the resilience quick tier pass against Java; talos (50 clients × 300 s) on Java meets every CP-4 target; the twin tests join CI's smoke tier |
| 🔍 | **OPUS REVIEW CP-10: Java blotter release** | | Twin-test independence; remaining protocol differences (should be none); docs (`architecture.md`, README, `hosting.md`); whether the image and runtime settings are sensible |
| 2.8 | **Optional: concurrency optimisation** (only after CP-10, measured with PLAN2.5) | Read requests (`getRows` on clean views, cold view builds) run on a worker pool against a stable snapshot of the views; per-client delta encoding runs in parallel; the writer thread keeps every mutation | The twin tests still pass; the comparison dashboard shows the gain in the startup burst and in `getRows` p99; nothing gets worse |

## Risks

| Risk | Mitigation |
|---|---|
| Floating-point differences (summation order, rounding) | Port `roundTo` exactly. Java's `Math.round(double)` uses the same rule as JS `Math.round` (halves round towards +∞), but it returns 0 for NaN where JS returns NaN, so guard NaN and keep the result as a `double`. Never use `Math.rint` (it rounds halves to even). Aggregation order follows the vectors; `overlay.json` and `engine/*.json` require exact equality |
| JSON output differences | Write `null` for NaN; leave unchanged fields out of partial update rows; integral doubles may print as `1.0` (JS reads them the same); covered by the fixtures, compared by decoded value |
| Spring/WebFlux overhead on the hot path | Spring and Reactor are kept out of the engine; frames are encoded once per delta and shared between clients with the same view where possible |
| JIT warm-up after a restart | Warm-up is part of readiness (PLAN1 Appendix 1F); if needed, a JDK AOT cache (Leyden) in the image |
| The two implementations drift over time | Artefacts are generated from logos with a CI staleness check; the twin tests run in CI's smoke tier |
| Docker VM memory with both blotters | 10 GB VM (PLAN1 Appendix 1J) |
