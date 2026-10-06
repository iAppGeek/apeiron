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
| `@apeiron/hermes` | mock middleware (NATS publisher) |
| `@apeiron/gaia` | seeder |
| `@apeiron/talos` | load-test harness |
| `@apeiron/logos` | shared schema, columns, protocol, codecs, PRNG |
| `@apeiron/mnemosyne` | `OrderRepository` interface and adapters |

## Quick start

Requirements: Node >= 24, pnpm 10, Docker.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
cp .env.example .env                      # optional local overrides
docker compose --profile core up -d       # mongo + nats + antikythera (WS/HTTP on 127.0.0.1:4000, /health)
docker compose --profile core --profile seed up gaia   # seed 1M orders (idempotent; second run is a no-op)
pnpm --filter @apeiron/gaia stats          # sample statistics of the generated dataset
pnpm --filter @apeiron/antikythera bench   # engine benchmarks on 1M generator rows (cold and warm)
```

## Licence

MIT
