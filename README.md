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

## Quick start

Requirements: Node >= 24, pnpm 10, Docker.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
cp .env.example .env                      # optional local overrides
docker compose --profile core up -d --build   # mongo + nats + antikythera (127.0.0.1:4000) + pharos (http://localhost:8080)
docker compose --profile core --profile seed up gaia   # seed 1M orders (idempotent; second run is a no-op)
pnpm --filter @apeiron/pharos dev          # web app on :5173 (Vite proxies /ws to localhost:4000)
pnpm --filter @apeiron/gaia stats          # sample statistics of the generated dataset
pnpm --filter @apeiron/antikythera bench   # engine benchmarks on 1M generator rows (cold and warm)
```

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

Load test: `talos`, 50 WebSocket clients for 300 seconds against the containerised stack (1M rows, Medium preset), on one laptop (Apple silicon, Docker Desktop VM with 6 GB). The mix has scrolling at 2 blocks/s per client, a sort/filter/group change about every 45 s, a Pause or Resume about every 10 s, one slow consumer, one codec switcher, and a 60 s stress window (about 2,000 order updates/s, up to 5,000 LIVE rows) from 120 s to 180 s. Latencies are measured from each request's *intended* send time, so a stalled server cannot hide its own delay. Full method, raw output and the incident behind the numbers are in [`docs/checkpoints/CP-4.md`](docs/checkpoints/CP-4.md).

```bash
scripts/loadtest-reset.sh                                      # fresh state: re-seed, empty JetStream, Medium
pnpm --filter @apeiron/talos start -- --clients 50 --duration 300 --codec json      # or msgpack, or both
docker compose --profile core --profile loadtest run --rm talos                      # the same, from a container
```

| | JSON | msgpack |
|---|---|---|
| Bytes in per client | 151 KB/s | 130 KB/s (-14%) |
| Messages in per client | 8.7 /s | 9.0 /s |
| Of which `rows` / `delta` bytes | 112 / 39 KB/s | 93 / 37 KB/s |
| getRows warm p50 / p95 / p99 | 5.0 / 17.4 / 27.0 ms | 5.3 / 18.3 / 29.2 ms |
| getRows cold (view change) p50 / p95 / p99 | 18.6 / 110 / 220 ms | 18.9 / 118 / 335 ms |
| Delta latency p50 / p95 / p99 (`serverTs` to receipt) | 5 / 21 / 27 ms | 5.5 / 25 / 35 ms |
| Command ack p50 / p95 | 67 / 114 ms | 64 / 115 ms |
| Server CPU median (max) | 21% (121%) of one core | 24% (144%) |
| Server RSS median (max) | 986 (1,035) MB | 1,025 (1,094) MB |
| Event-loop lag p99 over the run | 17.8 ms | 19.2 ms |

POC targets, both codecs: getRows p95 under 50 ms, view change under 300 ms, delta p95 under 150 ms, event-loop lag p99 under 50 ms and RSS under 2 GB are all met. msgpack saves about 14% of the bytes (17% on `rows`, 6% on `delta`) and costs a little more server CPU; neither changes a latency target. The delta latency above is only the final hop; add the age of the oldest event when its flush runs (p95 151 to 193 ms) for the whole server-side path from hermes, which is over 150 ms (see CP-4, known weaknesses).

Monitoring: `docker compose --profile core --profile monitoring up -d` adds Prometheus (<http://127.0.0.1:9090>) and Grafana (<http://127.0.0.1:3001>, dashboard "Apeiron: Blotter Server"). Grafana allows anonymous viewing without a login; that is for local use only, and both ports bind to 127.0.0.1. Edit with `admin` / `GRAFANA_ADMIN_PASSWORD` (default `admin`).

## Memory

The `antikythera` container has `mem_limit: 3g` in `infra/docker-compose.yml` (matching the remote box budget, and keeping a runaway process from swapping the Docker VM). It needs about 0.9GB at the load peak and about 0.7-0.8GB once loaded.

## Licence

MIT
