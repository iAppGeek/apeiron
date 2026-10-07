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

## Memory

The `antikythera` container has `mem_limit: 3g` in `infra/docker-compose.yml` (matching the remote box budget, and keeping a runaway process from swapping the Docker VM). It needs about 0.9GB at the load peak and about 0.7-0.8GB once loaded.

## Licence

MIT
