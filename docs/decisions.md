# Decisions, limitations and next steps

Why the POC is built the way it is, what it does not do, and what would come next. The reasoning behind each decision is
recorded in full in the plans ([`plans/PLAN.md`](plans/PLAN.md) "Decisions log",
[`plans/PLAN1-architecture-split.md`](plans/PLAN1-architecture-split.md)) and the checkpoint reviews; this page is the
current summary.

- [Decisions and trade-offs](#decisions-and-trade-offs)
- [Known limitations](#known-limitations)
- [Next steps](#next-steps)

## Decisions and trade-offs

| Decision | Alternatives | Why |
|---|---|---|
| **Server-side row model (SSRM)**: the server holds all rows and does sort, filter, group and aggregate; the client lazily loads 100-row blocks | Client-side row model with every row in the browser; viewport row model | Grouping with aggregates over 1M rows is required; 1M × 50 in each browser is ~1.5 GB of objects; one server view is shared by many clients |
| **AG Grid Enterprise 36**, watermark accepted | Community grid; a custom grid | SSRM and row grouping are Enterprise features; no licence key in a public repo |
| **Columnar typed arrays on SharedArrayBuffer**, dictionary-encoded strings | JS objects; an embedded database | ~260 MB of typed arrays vs ~1.5 GB of objects; contiguous scans; SharedArrayBuffer keeps a worker-thread pool a drop-in |
| **LSD radix sort over Float64 bit patterns**, ranks for enums and strings | `Array.prototype.sort` with a comparator | 1M-row sorts in ~25–30 ms; stable, so the `orderId` tiebreak is free while ids ascend |
| **Incremental view maintenance** from a per-tick ChangeSet | Rebuild affected views at most once a second | Value updates every 50 ms without rebuilding; property-tested equal to a rebuild |
| **Budgeted flush (40 ms), untracked views stale, deferred rebuilds, shared tick log** (CP-4) | Synchronous patch-everything; a `worker_threads` pool | Fixed the death spiral on one thread ([performance.md](performance.md#the-death-spiral-cp-4)); the worker pool was not needed |
| **`FLUSH_MS` 50** (CP-4) | 100 ms (original) | End-to-end p95 from ~220 ms to ~65 ms for ~4 points of CPU |
| **Tick-to-screen measured end to end via `delta.srcTs`** (CP-4) | Last hop (`serverTs` → receipt) | That is what a trader experiences |
| **Split into a blotter, an order service of record (`themis`) and a price feed (`helios`)** (PLAN1) | One blotter process that also stores orders and prices | Each owns one thing: the blotter needs no database driver and restarts from NATS alone; `themis` is the only writer, so every published version is durable; prices can fail without stopping order flow |
| **NATS JetStream**: execution reports on a stream, the latest state of every order in a KV bucket (`ORDER_STATE`), ack after the commit | Kafka; direct database polling; events with increments | Durable replay after a restart; a versioned record (`v`) per order makes replays and redeliveries idempotent |
| **Group commit in `themis`** (20 ms or 500 changes), publish only after the write | Write every change at once; write-behind from the blotter | Bounded write rate; nothing is published before it is stored; price-only changes are never stored |
| **Users and entitlements from a file**, no passwords (PLAN1 1.6) | Real authentication | Enough to prove per-user scoping (`FORBIDDEN`, `UNKNOWN_USER`) in a POC |
| **Fastify + `ws`, transport behind an interface** | uWebSockets.js | Mainstream and fast enough; uWS stays swappable |
| **Self-describing frames**, JSON default, msgpack toggle (CP-3) | Decode by negotiated codec; msgpack only | Fixed the codec-switch bug; JSON is debuggable; msgpack −11% bytes |
| **Web Worker owns the socket and codec** | Main-thread WebSocket | Decoding never blocks rendering |
| **Synchronous `applyServerSideTransaction`** with merge-before-apply | Async transactions | Async merges partials against stale data and loses fields |
| **Anchor from the rendered DOM** | `scrollTop / rowHeight` | AG Grid scales the scroll position past ~16M px |
| **One tracked view per client**, a block LRU mirroring the grid | Server-side cursor; snapshot diffs | Simple and bounded; the resilience suite hardened it (bugs 1, 7, 9 in [testing.md](testing.md#bugs-the-resilience-suite-found)) |
| **Mongo adapter in full; Oracle and KDB as interface, contract suite and docs only** | Build all three | POC scope; the `OrderRepository` contract keeps them pluggable ([db-adapters.md](db-adapters.md)) |
| **Toxiproxy + an independent model + independent checks** (CP-6) | Unit-level fault injection; trusting the system under test | Proves sync end to end through real sockets; found 9 product bugs |
| **Every service in a container**; the same compose file locally and remotely; one AWS Graviton box created per session | ECS Fargate + ALB + Atlas (~$250+/month) | ~$0.16/hour while testing and $0 between sessions ([hosting.md](hosting.md)) |
| **Cloudflare Tunnel + Access** for the remote box | Open ports with an IP allowlist; a load balancer and certificates | No inbound port, a fixed HTTPS host name and an email login, all free |
| **`MONGO_CACHE_GB=1`** on 6 GB hosts | Mongo's default (half the RAM) | The default swapped the VM and stalled everything (CP-4) |
| **Latest stable versions**, exceptions recorded | Pin older | TypeScript 6.0.x (7 is blocked by typescript-eslint), `@types/node` ^24 to match the runtime |

## Known limitations

| Limitation | Detail | Source |
|---|---|---|
| **Non-default-sort anchoring drift** | Under a sort other than `createdAt desc`, new rows arrive by background refresh; the first refresh after scrolling can drift about one row | CP-5 review |
| **Connect-storm cold burst** | 50 clients opening cold views at the same instant queue on one thread: startup burst max 265 ms (json) / 445 ms (msgpack) | CP-4 §12.1 |
| **Rare long stalls** | Single event-loop stalls of 200–350 ms show in the longest-stall figure (p99 stays ~18–23 ms) | CP-4 §12.1 |
| **Saturated links** | the page gives up before the server does; data is correct once the link recovers | details in [testing.md](testing.md#known-limitations-the-suite-surfaced) |
| **Tracking bound** | rows far below the top of a route in an unrefreshed client cache could go stale (not observed) | details in [testing.md](testing.md#known-limitations-the-suite-surfaced) |
| **`getRowNode` is a linear scan** in SSRM | Cheap at ≤ 2,000 cached rows; would not scale to a much larger client cache | CP-3 |
| **Single blotter process, no real authentication** | One Node process serves every client; users come from a file with no passwords | PLAN1 1.6 |
| **One CPU thread** | Capacity is bound by one thread: a host 4–7× slower missed four of five targets | [performance.md](performance.md#a-slower-host-the-2026-10-09-reproduction) |
| **AWS not yet run end to end** | The Cloudflare side is applied; the AWS box (Terraform, `remote-*` scripts) is validated and planned against the real account but has not been started | [runbooks/aws-remote-box.md](../runbooks/aws-remote-box.md) |

## Next steps

1. **First AWS session** ([runbook](../runbooks/aws-remote-box.md)): START, verify, run talos on the Graviton box, STOP,
   and record the measured timings and figures in [performance.md](performance.md).
2. **Oracle and KDB adapters:** implement `OrderRepository` and run the existing contract suite
   ([db-adapters.md](db-adapters.md) has the DDL and schema sketches).
3. **Worker threads if needed:** the store is already on `SharedArrayBuffer`; move cold view builds and rebuilds to a
   `worker_threads` pool if more clients, more distinct views or the connect storm demand it.
4. **Anchoring under non-default sorts:** a server-computed position for the client's top order would remove the one-row
   drift.
5. **Exact client tracking:** a server-side record of what the grid really holds (or a periodic reload) instead of the
   self-healing heuristics, if more tracking bugs appear.
6. **Production hardening:** real authentication, horizontal scale (shard by trader, or replicate the store behind a bus
   fan-out).
7. **A Java blotter side by side, then a comparison** ([`plans/PLAN2-java-blotter.md`](plans/PLAN2-java-blotter.md),
   [`plans/PLAN2.5-comparison-dashboards.md`](plans/PLAN2.5-comparison-dashboards.md); agreed drafts).
