# Apeiron

*Apeiron* (ἄπειρον) is the Greek word for "the infinite". This repo is the **Infinity Blotter** proof of concept:
a React + AG Grid Enterprise blotter showing **1M FX algo orders x 50 columns**, ticking live, served by a Node
WebSocket server over MongoDB and NATS, all running in Docker.

See [`docs/PLAN.md`](docs/PLAN.md) for the full design and phase plan.

## Packages

| Codename | Role |
|---|---|
| `@apeiron/pharos` | web app (React + AG Grid) |
| `@apeiron/antikythera` | blotter server |
| `@apeiron/hermes` | mock middleware (NATS publisher: price feed and order lifecycle) |
| `@apeiron/gaia` | seeder |
| `@apeiron/talos` | load-test harness |
| `@apeiron/logos` | shared schema, columns, protocol, codecs, PRNG |
| `@apeiron/mnemosyne` | `OrderRepository` interface and adapters |
| `@apeiron/iris` | NATS adapter: JetStream stream and consumer definitions, the `Bus` implementation |
| `@apeiron/e2e` | Playwright end-to-end tests against the containerised stack |

## Quick start

Requirements: Node >= 24, pnpm 10, Docker (Compose v2, about 6 GB of RAM for the Docker VM).

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build

cp .env.example .env                                           # optional local overrides, never committed
docker compose --profile core up -d --build mongo nats        # the database and the bus
docker compose --profile core --profile seed run --rm gaia     # seed 1M orders (idempotent; a second run is a no-op)
docker compose --profile core up -d --build                    # server, mock middleware and web app
docker compose --profile core --profile monitoring up -d       # optional: Prometheus and Grafana
open http://localhost:8080                                     # the blotter
```

The server loads the database once at startup, so seed before starting it (or restart it afterwards). Everything
binds to `127.0.0.1`. Other useful commands:

```bash
pnpm --filter @apeiron/pharos dev          # web app on :5173 with hot reload (Vite proxies /ws to localhost:4000)
pnpm --filter @apeiron/gaia stats          # sample statistics of the generated dataset
pnpm --filter @apeiron/antikythera bench   # engine benchmarks on 1M generator rows (cold and warm)
pnpm e2e                                   # Playwright end-to-end tests against http://localhost:8080
```

### End-to-end tests

`pnpm e2e` runs the Playwright suite in `e2e/tests` against the containerised stack (`E2E_BASE_URL` overrides
`http://localhost:8080`). Install the browser once with `pnpm --filter @apeiron/e2e exec playwright install chromium`.
`pnpm e2e:ci` is the compact variant CI uses (list and HTML reporters, stops after five failures). The tests cover the grid
load, sorting, set, number and date filters, grouping with drill-down and aggregates, live tick flashes, new orders on
top, scroll anchoring and the badge (including the refresh path of a non-default sort), Cancel with confirmation, Pause
and Resume, trader and codec switching, the load-preset pill, and that group rows offer no order actions. The commands
mutate a few orders; `scripts/loadtest-reset.sh` restores the dataset.

## Documentation

| | |
|---|---|
| [`docs/TECHNICAL-OVERVIEW.md`](docs/TECHNICAL-OVERVIEW.md) | **start here**: the engineering overview: problem, architecture, server and client internals, protocol, performance results, the CP-4 death spiral, testing strategy, decisions and trade-offs, limitations |
| [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md) | how to run it, use the blotter, run every test tier and the load test, and troubleshoot |
| [`docs/TESTING.md`](docs/TESTING.md) | the six test layers and the resilience suite: scenarios, tiers, the three checks, latest results |
| [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md) | speaker notes for the deck and the live-demo run-sheet (commands, clicks, expected numbers, fallbacks) |
| [Engineering deck](https://claude.ai/artifact/DkgeXrrCpFVoxPcY3WsPrh) | the 18-slide presentation for the development team (private until shared by its owner) |
| [`docs/screenshots/demo/`](docs/screenshots/demo) | screenshots from the phase 10 browser pass and Grafana under load |
| [`docs/architecture.md`](docs/architecture.md) | components, data flow, the key algorithms (columnar store, incremental views, flush loop with a budget, client tracking, anchoring), Mermaid diagrams |
| [`docs/hosting.md`](docs/hosting.md) | local compose profiles and ports, AWS on demand (Terraform, `remote-*` scripts, costs), GHCR or ECR, alternatives, security notes |
| [`docs/db-adapters.md`](docs/db-adapters.md) | the `OrderRepository` contract, running the contract suite, Oracle and KDB sketches |
| [`docs/PLAN.md`](docs/PLAN.md) | the design and phase plan, with the authoritative contracts in its appendices |
| [`docs/checkpoints/`](docs/checkpoints) | what each phase built, with raw verification output |

## Live updates

`hermes` publishes `prices.<PAIR>` (3 ticks/s per pair) and `orders.events` (fills, status changes, new orders) to NATS;
`antikythera` applies them to its store, patches every cached view incrementally, writes lifecycle changes back to Mongo
(write-behind) and pushes `delta` and `summary` messages to clients. Switch the load with `LOAD_PRESET=medium|stress`
or live with a `control` message (it is published on `control.load`). Verify a running stack:

```bash
pnpm --filter @apeiron/antikythera exec tsx src/testing/live-report.ts --scenario default --seconds 15   # also: grouped, stress, writebehind, consistency
curl localhost:4000/debug/lag                                                                           # flush, lag and write-behind figures
```

## Benchmarks

Load test: `talos`, 50 WebSocket clients for 300 seconds against the containerised stack (1M rows, Medium preset, 50 ms flush), on one laptop (Apple silicon, Docker Desktop VM with 6 GB). The mix has scrolling at 2 blocks/s per client, a sort/filter/group change about every 45 s, a Pause or Resume about every 10 s, one slow consumer, one codec switcher, and a 60 s stress window (about 2,000 order updates/s, up to 5,000 LIVE rows) from 120 s to 180 s. Latencies are measured from each request's *intended* send time, so a stalled server cannot hide its own delay. **Tick-to-screen is end to end**: from the source event's timestamp in hermes (`delta.srcTs`) to the client receiving the delta. Full method, raw output and the incident behind the numbers are in [`docs/checkpoints/CP-4.md`](docs/checkpoints/CP-4.md).

```bash
scripts/loadtest-reset.sh                                      # fresh state: re-seed, empty JetStream, Medium
pnpm --filter @apeiron/talos start -- --clients 50 --duration 300 --codec json      # or msgpack, or both
docker compose --profile core --profile loadtest run --rm talos                      # the same, from a container
```

| | JSON | msgpack |
|---|---|---|
| Bytes in per client | 147 KB/s | 131 KB/s (-11%) |
| Messages in per client | 9.3 /s | 9.2 /s |
| Of which `rows` / `delta` bytes | 111 / 36 KB/s | 97 / 34 KB/s |
| **Tick-to-screen** p50 / p95 / p99 (source event to client) | 38 / 65 / 80 ms | 38 / 62.5 / 76 ms |
| Last hop only (`serverTs` to receipt) p50 / p95 | 4.5 / 28 ms | 4 / 22 ms |
| getRows warm p50 / p95 / p99 | 5.1 / 18.0 / 31 ms | 5.5 / 18.1 / 27 ms |
| View change (cold) p50 / p95 / p99 | 16.8 / 37.7 / 52 ms | 16.8 / 38.2 / 47 ms |
| Startup burst, 50 cold views at once: p50 / p95 / max | 83 / 207 / 265 ms | 194 / 380 / 445 ms |
| Command ack p50 / p95 | 38 / 67 ms | 38 / 66 ms |
| Server CPU median (max) | 22% (112%) of one core | 24% (114%) |
| Server RSS median (max) | 1,040 (1,099) MB | 1,019 (1,065) MB |
| Event-loop lag p99 / p99.9 / longest stall | 23 / 35 / 216 ms | 19 / 32 / 346 ms |

All POC targets are met with both codecs: getRows p95 under 50 ms, view change under 300 ms, end-to-end tick-to-screen p95 under 150 ms, event-loop lag p99 under 50 ms, RSS under 2 GB. msgpack saves about 11% of the bytes (13% on `rows`, 5% on `delta`) and costs a little more server CPU; neither changes a latency target. A 600 s soak with 240 s of stress ran without a stall (CP-4, section 5.3). A reproduction on 2026-10-09 on a 4-vCPU cloud container (4–7× slower per engine operation than the laptop)
missed four of the five targets without collapsing; see [`docs/checkpoints/PHASE-10.md`](docs/checkpoints/PHASE-10.md) and
[`docs/TECHNICAL-OVERVIEW.md`](docs/TECHNICAL-OVERVIEW.md) §9.4.

## What the POC proved

- **The grid.** A single Node server process holds 1M+ orders x 50 columns in memory (about 1 GB RSS) and serves 50 concurrent blotters. Each client can have its own sort, filter or grouping, and live updates keep coming.
- **Latency.** Warm block fetch about 18 ms p95 (client-measured); view change about 38 ms p95; end-to-end tick-to-screen about 65 ms p95 (62.5 with msgpack), also under the stress window (75 ms); an order action (Pause, Resume) round trip about 67 ms p95.
- **Load.** Under stress (about 5,000 LIVE orders ticking 3x/s, about 15k row updates/s), event-loop p99 stays under 25 ms, and median CPU is about 22-24% of one core (peaks of 110% across threads).
- **Correctness under load.** Incremental views are proven identical to full rebuilds (property tests, including the deferred and carried-over paths, plus live cross-checks against fresh builds). Slow consumers are conflated and then disconnected (`SLOW_CONSUMER`) without hurting anyone else, and can reconnect.
- **Limits found.**
  - Synchronous rebuilds and maintaining views nobody uses caused a death spiral (fixed: untracked views go stale, rebuilds are deferred, the flush has a time budget over a shared tick log).
  - A connect storm of 50 cold views queues for about 0.3-0.4 s on one thread (startup burst max 265 ms json, 445 ms msgpack).
  - MongoDB needs its cache capped on a small host (`MONGO_CACHE_GB`), or the Docker VM swaps and everything stalls.
  - Rare single stalls of 200-350 ms are still visible in the longest-stall figure.
- **JSON vs msgpack.** msgpack is about 11% fewer bytes, uses slightly more server CPU, and latency is the same. Either is fine. Default to JSON for debuggability, and use msgpack on constrained links.

Monitoring: `docker compose --profile core --profile monitoring up -d` adds Prometheus (<http://127.0.0.1:9090>) and Grafana (<http://127.0.0.1:3001>, dashboard "Apeiron: Blotter Server"). Grafana allows anonymous viewing without a login; that is for local use only, and both ports bind to 127.0.0.1. Edit with `admin` / `GRAFANA_ADMIN_PASSWORD` (default `admin`).

## Memory

The `antikythera` container has `mem_limit: 3g` in `infra/docker-compose.yml` (matching the remote box budget, and keeping a runaway process from swapping the Docker VM). It needs about 0.9GB at the load peak and about 0.7-0.8GB once loaded.

## Licence

MIT
