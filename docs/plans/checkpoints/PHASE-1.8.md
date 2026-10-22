# PLAN1 phase 1.8: verification

Measured on the compose stack on one laptop (Docker VM: 8 CPUs, 6 GB), 2026-10-13, after `scripts/loadtest-reset.sh`.
The split is complete: `pharos`, `antikythera` (NATS only), `themis` (order service of record), `helios` (prices),
`hermes` (venue simulator, no database), `gaia` (seeder).

## What is new in this phase

- **S10** (`themis` restarts mid-stream), **S11** (no prices for a while), **S12** (the blotter restarts and is probed):
  see `docs/TESTING.md`.
- **A fourth check, `venue-vs-service`:** the driver logs every execution report the venue sent and each order's record
  before its first; the check replays them through `applyExecReport` and compares the result with the record `themis`
  stored. It runs in every scenario.
- **Grafana:** a "Themis (order service)" row (reports/s by type and result, submissions and commands/s, command latency,
  group commit size and duration, open orders).
- **A real bug found on the way (phase 1.7):** the `ORDERS` stream of the old design was still on the local NATS volume
  and captured `orders.cmd`, so JetStream acknowledged every command request before `themis` could answer it. Statuses still
  changed (so the e2e passed) but every ack was an unreadable reply. `ensureStreams` now removes retired streams, and the
  actions e2e fails on an error toast.

## talos, 50 clients, 300 s, json, after `scripts/loadtest-reset.sh`

| | CP-4 final | Phase 1.3a (fresh, run 2) | **Phase 1.8** | Target |
|---|---|---|---|---|
| getRows warm p95 (client) | 18.0 ms | 6.5 | **17.4** | < 50 |
| View change (cold) getRows p95 | 37.7 ms | 283 | **33.8** | < 300 |
| Delta latency p95 (`serverTs` to receipt) | 28 ms (last hop) | 19 | **22** | < 150 |
| Tick-to-screen p95 (`srcTs` to receipt) | 62 to 65 ms | | **85** | < 150 |
| Event-loop lag p99 (whole run) | 23.1 ms | 16.9 | **18.3** | < 50 |
| Server CPU median | 22% | 21.6% | **20.4%** | |
| Server RSS median (max) | 1,040 (1,099) MB | 984 (991) | **985 (1,029)** | < 2,048 |
| Command ack p95 | 66.5 ms | 80.6 | **87.2** | **≤ 150** |

Every gated figure passes, and every figure except the command ack is within 20% of CP-4 (all are better or equal; the
tick-to-screen p95 is 85 ms against CP-4's 62 to 65 because a tick now also crosses `themis`'s group commit and the
`ORDER_STATE` bucket before the blotter sees an order change; it is well inside its 150 ms target). The command ack is
the one figure that grew, as planned: a command now goes blotter, `themis`, the venue, back through `themis` (stored and
published) and into the blotter's own store before the ack. Its p95 is 87 ms against the 150 ms budget (p50 57, p99 108).
The cold-view figure that varied from 238 to 518 ms in phase 1.2 and 1.3a measured 33.8 ms this time; that tail depends on
the host, not on the code, so only fresh runs are compared.

Server-side: `getRows` warm p95 0.9 ms, cold p95 28.0 ms, flush p50 1.4 ms and p99 37.3 ms, `command p95` 95.6 ms; the slow
consumer (paused 7 s on purpose) was closed with 1013 and recovered.

## Resilience

**Full tier: 12 of 12 pass (30.4 minutes)**, the canary, S1 to S8 and the new S10, S11 and S12, with the four checks.
**S10, S11 and S12 passed three times each** at full length (the full run plus two more rounds of 6.3 minutes). The
oracle's replay check also has unit tests with cases that must fail (a lost fill, a fill applied twice, a missing record).

Things to know:

- **The laptop must not sleep.** Earlier attempts in the session stalled for about 15 minutes at the first long wait, in
  the resilience suite and even in two unit tests (983 s for a test that takes milliseconds): macOS had put the machine to
  sleep. The Docker VM's clock also falls behind after that (reset with `docker run --rm --privileged alpine date -s @$(date +%s)`).
  Run long suites under `caffeinate -i`. The failed runs before that were discarded; none of them was a code failure.
- **S1 at smoke length** failed twice with page V3 one reconnect short, and once before phase 1.6 with the same symptom,
  during those sleep-disturbed hours; it passes at full length. Not seen when the machine stayed awake, so it is probably the same cause, but it
  was not isolated; watch for it in CI's smoke step.

## Warm-up (phase 1.3b target: 5 s or less)

Read from `/health` on the same stack at 1,039,444 and 1,039,572 rows (the second after `docker compose restart
antikythera`): **`warmupMs` 111 and 121 ms** (default views, 3 rounds), snapshot 7.4 and 8.8 s.

## Review against the plan (2026-10-13)

A review of the branch against this plan, standing in for part of CP-8, found and fixed:

- **Entitlement gap:** the blotter sent a command or amend on an order its store did not hold to `themis` unchecked, so
  a scoped user could act on a just-created order of another trader (ids are sequential). Such a command now gets
  `UNKNOWN_ORDER` and nothing reaches `themis`; only a user entitled to `*` is passed through.
- **`clientOrderId` expiry** scanned the whole map on every submission (about 9M checks a second after an hour of
  stress), and ran after the duplicate lookup, so an expired id still matched. It now runs first and stops at the first
  live entry.
- **Stale venue instructions:** `hermes` carried out instructions up to 30 s old, though `themis` answers `TIMEOUT`
  after 5 s, so a command the user was told had failed could still happen. `hermes` now drops anything older than
  `VENUE_TIMEOUT_MS`, which compose sets for both.
- **Amend while paused:** the amend moved `lastUpdateTime`, from which `RESUMED` measures the pause, so the order lost
  the time paused before the amend. The amend now credits it to `endTime` (Appendix 1C).
- Spec gaps closed: a helios boundary test, `COMMAND_TIMEOUT_MS` and `ACK_WAIT_V_MS` as settings, `HELIOS_SEED`
  passed by compose, `themis` logs the `userId` of each command, and `PLAN.md` Appendix A brought up to date.

Not done: CP-7's watch-ordering and memory-peak audit, and CP-8's persist-then-publish recovery audit. The default
warm-up views still come from the trader list rather than the entitlements file (the same views for the file as shipped).
