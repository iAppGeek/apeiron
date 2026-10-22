# Apeiron

*Apeiron* (ἄπειρον) is the Greek word for "the infinite". This repo is the **Infinity Blotter** proof of concept: a
React + AG Grid Enterprise blotter showing **1M FX algo orders × 50 columns**, ticking live, with server-side sort,
filter, group and aggregation for 50 concurrent clients, all running in Docker. A Node blotter server holds every order
in memory and follows an order service of record (`themis`, over MongoDB) and a price feed (`helios`) through NATS
JetStream.

## Start here

Requirements: Node ≥ 24, pnpm 10, Docker with Compose v2 and about 6 GB of RAM for its VM. To run it locally, follow
[docs/user-guide.md](docs/user-guide.md#running-it) (clone, seed, start, open <http://localhost:8080>).

## Documentation

`docs/` is the current description of the project, with each fact in one place. `runbooks/` holds step-by-step
procedures that link back to it. `docs/plans/` holds the plans and their phase records (history, not the current state).

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | how it works: components, data flow, the blotter's store, query engine, incremental views and flush loop, the order service, the protocol, the client, observability |
| [docs/data-model.md](docs/data-model.md) | the 50 columns, null semantics, ordering and group keys, the seeded dataset |
| [docs/user-guide.md](docs/user-guide.md) | running it locally, using the blotter, the load test, troubleshooting |
| [docs/hosting.md](docs/hosting.md) | compose profiles, ports and variables; AWS on demand and the Cloudflare Tunnel; costs; registries; security |
| [docs/testing.md](docs/testing.md) | the test layers, the resilience suite, latest results, the bugs it found |
| [docs/performance.md](docs/performance.md) | targets, method, current and baseline results, the CP-4 death spiral |
| [docs/decisions.md](docs/decisions.md) | decisions and trade-offs, known limitations, next steps |
| [docs/db-adapters.md](docs/db-adapters.md) | the `OrderRepository` contract, the contract suite, Oracle and KDB sketches |
| [runbooks/aws-remote-box.md](runbooks/aws-remote-box.md) | START, verify, STOP and verify $0 for the AWS box |
| [docs/plans/](docs/plans) | `PLAN.md` (the original POC plan), `PLAN1` (the architecture split, done), `PLAN2` and `PLAN2.5` (agreed drafts), the 2026-10-08 handoff, and `checkpoints/` (what each phase built, with raw verification output) |
| [docs/screenshots/demo/](docs/screenshots/demo) | screenshots of the blotter and of Grafana under load |

## Packages

| Codename | Role |
|---|---|
| `@apeiron/pharos` | web app (React + AG Grid) |
| `@apeiron/antikythera` | blotter server |
| `@apeiron/themis` | order service of record |
| `@apeiron/helios` | price feed |
| `@apeiron/hermes` | venue simulator (the order lifecycle) |
| `@apeiron/gaia` | seeder |
| `@apeiron/talos` | load-test harness |
| `@apeiron/logos` | shared schema, columns, protocol, codecs, PRNG, order rules |
| `@apeiron/mnemosyne` | `OrderRepository` interface and adapters |
| `@apeiron/iris` | NATS adapter: JetStream stream and consumer definitions, the `Bus` implementation |
| `@apeiron/e2e` | Playwright end-to-end tests and the resilience suite |

Each is described in [docs/architecture.md](docs/architecture.md#components).

## Licence

MIT
