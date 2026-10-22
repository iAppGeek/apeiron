# PLAN1 phase 1.3a: the blotter from NATS only

Measured on the compose stack on one laptop (Docker VM: 8 CPUs, 6 GB), 2026-10-12. `antikythera` has no database
driver; it reads `ORDER_STATE` (written by `themis`) and `prices.*`.

## Cold start

| | Before (phase 1.2, from Mongo) | After (from the bucket) |
|---|---|---|
| 1.0M rows, load to loaded | 15.0 to 17.8 s | **7.0 to 8.4 s** (target ≤ 30 s) |
| 1.7M rows | | 11.8 s (sort 0.5 s, string ranks 1.2 s), peak RSS 2.0 GB |
| `themis` projection rebuild, 1.0M rows | | 30 s (first start only, or after a reset) |

## Tests

- `pnpm lint && pnpm typecheck && pnpm test`: pass.
- `pnpm e2e:ci` (18 tests, 1.7M rows): 18 pass.
- Resilience quick tier: 9 of 9 pass (12.1 min), including S7 (the blotter restarts mid-stream: it reloads from the bucket).
- Dependency test: the blotter has no database package and imports no lifecycle rules.
- A blotter started against a bucket with no marker, or an empty one, stays in `snapshot` and never reports `ok` (tests).

## talos, 50 clients, 300 s, json, after `scripts/loadtest-reset.sh`

| | CP-4 final | Phase 1.2 (fresh) | Phase 1.3a (fresh, run 1) | Phase 1.3a (fresh, run 2) | Target |
|---|---|---|---|---|---|
| getRows warm p95 (client) | 18.0 ms | 10.6 | 9.6 | 6.5 | < 50 |
| View change (cold) getRows p95 | 37.7 ms | 238 | 416 | 283 | < 300 |
| Delta latency p95 (`serverTs` to receipt) | 28 ms (last hop) | 31 | 28 | 19 | < 150 |
| Event-loop lag p99 (whole run) | 23.1 ms | 26.2 | 25.6 | 16.9 | < 50 |
| Server CPU median | 22% | 25.8% | 25.3% | 21.6% | |
| Server RSS median (max) | 1,040 (1,099) MB | 1,077 (1,095) | 1,217 (1,222) | 984 (991) | < 2,048 |
| Command ack p95 | 66.5 ms | 63.7 | 88.1 | 80.6 | |

The gated figures are met in run 2; run 1 missed the cold-view gate (416 ms). Things to know when reading this:

- **The cold-view tail does not reproduce CP-4's 37.7 ms on this machine even for phase 1.2**, which this phase did not
  touch: 238 ms on a fresh run, 518 ms on an unreset one. The server-side histogram for the same requests is 26 to 33 ms at
  p95, so the time is spent outside the view build (queueing behind other work on a shared 8-CPU VM), and it varies a lot from
  run to run. 1.3a is inside that spread (416 and 283 ms against 238 ms).
- Runs that were not preceded by a reset get worse each time (the LIVE population and the store grow: 1,040 LIVE and 1.05M
  rows instead of about 580 and 1.0M), so only fresh runs are compared. One run was discarded because the machine paused
  during it (a 657 s latency in a 300 s test).
- The 20% rule against CP-4 is therefore not meaningful for the cold-view figure on this machine; compared with the phase 1.2
  code run under the same conditions, 1.3a shows no regression. Re-measure at the CP-7 review (remote box or a quieter host).
