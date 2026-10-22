# Testing

Apeiron is tested in six layers. Each answers a different question, and the cheaper layers run on every change.

| Layer | Question it answers | Where | Run it with | Needs |
|---|---|---|---|---|
| Unit | Does this function or component do what it says? | `*.spec.ts(x)` beside the source, in every package | `pnpm test` | nothing |
| Property | Does the incremental engine agree with a simple reference on random data? | `apps/antikythera/src/query/*.property.spec.ts`, `view.incremental.property.spec.ts` | `pnpm test` (part of the unit run) | nothing |
| Integration | Do the pieces work together over a real socket, bus and database? | `apps/antikythera/src/server*.spec.ts`, `session*.spec.ts`, `packages/mnemosyne` contract suite (an in-process MongoDB) | `pnpm test` | nothing |
| End to end | Does the browser show the right thing for a user's actions? | `e2e/tests/*.e2e.ts` (Playwright) | `pnpm e2e` | the stack on :8080 |
| Resilience | After the network breaks, does the grid still show complete, current data? | `e2e/tests/resilience/*.e2e.ts` | `pnpm e2e:resilience` | the stack plus the `resilience` profile |
| Load | How much does the server cost, and how late is a tick? | `apps/talos` | `pnpm --filter @apeiron/talos start` | the stack |

Conventions that apply to all of it: Vitest for unit tests (`vi.mock`, `vi.spyOn`, `vi.fn`, never `jest.mock`), React Testing Library for components, Playwright for the browser, no fixed sleeps in the browser tests (`expect.poll` and `waitForFunction`; a `sleep` is only used to wait out a fault of known length), and every new module ships with a `*.spec.ts`.

**Who the tests sign in as.** The blotter needs a user. The end-to-end page object opens the app with `?user=SUPERVISOR`
(`Blotter.open(user)`), the protocol clients (the resilience reader, talos, the restart test) send `userId: 'SUPERVISOR'`,
and `e2e/tests/users.e2e.ts` opens `TRADER1`, `TRADER2` and the supervisor side by side: each trader sees only their own
orders, a command forged across users gets `FORBIDDEN`, an unknown user `UNKNOWN_USER`, and switching user in the header
reloads the grid.

## Running each layer

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build      # unit, property, integration (about 1 minute)

docker compose --profile core --profile seed up -d --build  # the stack with 1,000,000 orders (CI seeds 200,000)
pnpm e2e                                                    # end to end against http://localhost:8080

docker compose --profile core --profile resilience up -d --build   # adds toxiproxy and pharos-e2e
pnpm e2e:resilience                                         # every resilience scenario, about 35 minutes
pnpm e2e:resilience:smoke                                   # S1 shortened plus S3, about 3 minutes (this runs in CI)
pnpm --filter @apeiron/e2e exec playwright test -c playwright.resilience.config.ts s6   # one scenario

scripts/loadtest-reset.sh                                   # fresh state before a load test
pnpm --filter @apeiron/talos start -- --clients 50 --duration 300 --codec both
```

The resilience run stops the real hermes while it works (so the test driver is the only publisher) and starts it again at the end, even when a scenario fails or times out (`e2e/support/global-teardown.ts` repeats this and clears the proxy). If a run is killed with a signal that skips even that, restore the stack by hand:

```bash
curl -s -X POST localhost:8474/reset       # no toxics, proxy enabled
docker compose --profile core start hermes
```

## The resilience suite

### What it proves

After any connection disruption the grid shows **complete, current data**: it does not miss updates, show stale values, show out-of-sync aggregates or counts, or let a value move backwards. It proves this with an independent model of what the data should be, not by trusting the system under test.

### The harness

```
 Playwright (5 pages, one per view)          the update driver (in the test process)
        |                                       |  hermes's own generator, seeded, behind a
   pharos-e2e :8081  (test hooks build)         |  tee bus that also feeds the independent model
        | /ws                                   |
   toxiproxy :4100  <-- fault controller :8474  |
        |                                       v
   antikythera :4000  <------------- NATS (ORDER_STATE, prices.*, orders.cmd)
```

- **Toxiproxy** (`ghcr.io/shopify/toxiproxy:2.12.0`, the latest release) sits between the browser's web container and antikythera. The `resilience` compose profile adds it and `pharos-e2e`, the same web image built with `VITE_TEST_HOOKS=1` whose nginx sends `/ws` to `WS_UPSTREAM=toxiproxy:4100`. The normal `pharos` image is unchanged (the upstream defaults to `antikythera:4000`).
- **Test hooks** (`window.__apeironTest`, read-only, only in that build): every loaded leaf and group row from `api.forEachNode`, the root row count, the summary, the connection state (reconnects, close reasons, pending requests), delta, row and purge counters, the view state, the latest `getRows` request, and the tick-to-screen figures. A unit test builds the production bundle and asserts none of it is there (`apps/pharos/src/testing/hooks-gate.spec.ts`).
- **Fault controller** (`e2e/support/faults.ts`): `dropClean()` (a `reset_peer` toxic for 600 ms), `down(ms)` (disable the proxy), `stall()` (a `timeout` toxic of 0 in both directions: data stops, nothing closes), `latency(ms, jitter)`, `bandwidth(kbps, direction)`, `clear()`.
- **Update driver** (`e2e/support/driver.ts`): hermes's own `startHermes` and helios's own `startHelios` running in the test process on a seeded generator (the real containers of both are stopped for the run), so the stream is theirs (price ticks at 3 per second per pair, fills, PENDING to LIVE, LIVE to FILLED or CANCELLED, new orders with ascending ids, and everything that moves rows between status groups and in and out of filters), plus PAUSE and RESUME commands injected through the normal command path. Rates are hermes's own presets: `normal` is Medium, `stress` is Stress. Nothing is reimplemented. Every event and tick passes through a tee bus that applies it to the model before forwarding it.
- **The model** (`e2e/support/model.ts`): the orders as they were when the stream started, with each record the order service publishes to `ORDER_STATE` applied (the newest version of each order wins; an order never seen before is a new one) and the latest tick per pair kept. hermes's reports reach the order service as in the stack, so the check covers the path from the bucket through the blotter to the screen. It uses nothing from the blotter. For orders still open (LIVE or PAUSED) it applies the shared logos `deriveOverlay` to the final tick, which is what the server does. Nothing is excluded from the comparison: since the blotter stopped stamping `lastUpdateTime` and stopped computing the market snapshot of orders that complete (the simulator sends it with the completing event), every field of every order is deterministic.

  The driver finishes with one last tick per pair, so the server's final price join and the model's use the same quote.
- **The five views** open at once, each in its own browser context: V1 the default flat view at the top; V2 flat, scrolled to about row 300,000 (30% of the table, so about row 60,000 in CI's 200,000-row dataset); V3 grouped by status with the LIVE group open (a deviation from Appendix G's "by pair": the LIVE group is the one whose membership churns, so drilling into it exercises group moves); V4 status = LIVE sorted by `unrealisedPnlUsd` descending, so the sort key ticks; V5 trader T2 only over msgpack.

### The four checks

After the stream stops, the harness waits until the system is idle: two consecutive looks at `/health`, `/debug/lag` and NATS's `/jsz` show the blotter at stage `ready` with nothing queued, `themis`'s consumer with nothing pending or unacknowledged, and the blotter's `appliedRev` equal to the `KV_ORDER_STATE` stream's `last_seq` and unchanged between the two and every page has been connected, not busy and delta-free for 2 seconds. Then:

1. **Model against server.** A fresh protocol client (the logos codecs over a plain WebSocket, straight to antikythera, not through the proxy) reads every order the stream created (they are the top of the table by id, read as one block), checks the total row count equals the starting count plus the orders created, and reads every other order an event touched or a tick repriced, one at a time. Each must equal the model on every field except the exclusions above.
1b. **Venue against service** (`venue-vs-service`). The driver logs every execution report that reached the bus, per order in the order it was sent, and the record of each order before its first report (the database's at the start, or the first `ORDER_STATE` record of a new order). The check replays each order's reports through the order service's own rules (`applyExecReport`) and compares the result with the record the service stored in `ORDER_STATE`: version, `execSeq` and every field. A report that `themis` lost, applied twice or applied out of order, across a restart or not, leaves a different record. The rules are shared code, so what this proves is the delivery, the ordering, the duplicate filter and the persist-then-publish path around them (S10 relies on it; it runs in every scenario).
2. **Server against screen.** For each page, the checker takes the page's view (trader, sort, filter, grouping, columns) from the last `getRows` request, then reads from a fresh client, at the same positions, every row the grid holds. Each loaded row must equal the server's field for field, including `lastUpdateTime`, and sit at the same index (the order of the loaded blocks). The root row count and the status-bar count must equal the server's; each loaded group row's `childCount` and aggregates must equal the server's group row (matched by key; aggregates within a relative 1e-9, since the incremental and the from-scratch sums may differ in the last bit); and the status-chip summary must equal the summary the fresh client receives for the same view. If this check fails, it looks again 4 seconds later and records whether the page was still wrong, to tell a late page from a stuck one.
3. **Invariants during the run.** A sampler inside each page reads `loadedRows()` every 500 ms. For every order, `filledQty`, `numFills` and `lastUpdateTime` must never go backwards, and an order seen FILLED or CANCELLED must never be seen LIVE or PAUSED again. A scenario also fails unless every page saw at least the expected number of reconnects and deltas, so it cannot pass by doing nothing.

A suite that cannot fail proves nothing, so `canary.e2e.ts` freezes the connection (a stall shorter than the client's heartbeat, so the page does not notice), lets the server move on, and requires check 2 to report the frozen page as out of date, then requires the checks to pass once the page has caught up. The oracle's pure logic is also unit tested (`oracle.spec.ts`), including cases that must fail.

### The client and server heartbeat

Scenario S3 depends on it, and both sides were missing a way to notice a half-open socket:

- **Client** (`connection-core.ts`): if no frame of any kind (pong, delta, summary, reply) arrives for 3 ping intervals (`staleAfterMs`, 6 s), checked at each 2-second ping tick, the socket is abandoned, in-flight requests fail with `DISCONNECTED`, and the core reconnects with backoff. A socket still connecting is held to the same limit. The app store exposes `reconnects`, `lastCloseReason` (`code:1006`, `stale:7361ms`, `connect-timeout:6000ms`), `closes` and `closeHistory`.
- **Server** (`ws-transport.ts`): a WebSocket-level ping every `HEARTBEAT_TIMEOUT_MS / 3` (default 5 s); a client that has sent no frame and answered no ping for `HEARTBEAT_TIMEOUT_MS` (default 15 s) is terminated, which fires `close` and releases its session, tracker and view references.

### Scenarios

Every scenario runs against the 1,000,000-row stack, opens all five views, and ends with the three checks. Each writes `e2e/results/<scenario>-<timestamp>.json` (gitignored).

### Tiers

One table (`e2e/support/tiers.ts`) parameterises every scenario, so the three tiers run the same code with different lengths. Every tier runs all the faults it lists and the same three checks, and its minimum reconnects and deltas scale with it, so none can pass vacuously. Each result file records its tier, and the scenario id carries it (`S1`, `S1-quick`, `S1-smoke`).

| Tier | Command | Use it | Scenarios | Wall time |
|---|---|---|---|---|
| quick | `pnpm e2e:resilience:quick` | the standard run, before a merge or after a change to the transport, the tracker or the grid | all eleven, shortened (plus the canary) | about 12 minutes (713 s on the final code; 834 to 875 s before the CP-6 fixes) |
| full | `pnpm e2e:resilience` | releases and demos | all eleven at the Appendix G lengths (plus the canary) | about 24 minutes (1,417 s on the final code; 1,619 s before the CP-6 fixes) |
| smoke | `pnpm e2e:resilience:smoke` | CI | S1 for 60 s with drops every 10 s, and S3 once | about 3 minutes (the CI step takes under 4) |

| Scenario | quick | full | smoke |
|---|---|---|---|
| S1 steady drops | 6 drops 20 s apart (about 150 s) | 10 drops 30 s apart (about 345 s) | 5 drops 10 s apart, shorter outages (about 75 s) |
| S2 flapping | 45 s | 120 s | not run |
| S3 half-open stall | 1 x 20 s | 3 x 20 s | 1 x 12 s |
| S4 outage in a burst | 30 s down, stress rate | 60 s down, stress rate | not run |
| S5 latency | 60 s, 1 drop | 180 s, 2 drops | not run |
| S6 low bandwidth | 60 s at 64 KB/s, then 30 s at 16 KB/s | 180 s then 60 s | not run |
| S7 server restart | 1 restart | 2 restarts | not run |
| S8 command across a drop | as full | 4 commands | not run |
| S10 themis restart | 1 restart | 2 restarts | not run |
| S11 helios outage | 30 s without prices | 60 s | not run |
| S12 blotter restart, probed | 1 restart | 2 restarts | not run |

Verification is the same in all tiers and is not shortened: the checks read the same fields at the same strictness. It is fast because the five pages' checks and the model check run side by side, and the orders an event touched near the top of the table are read in 5,000-row blocks instead of one request each (the ones further away still go one at a time).

Each scenario below gives what it simulates, why, how sync is proven, the pass criteria, and its latest results. Durations are the full tier's; the quick lengths are in the table above.

**S1: steady updates with periodic drops (the required scenario).** *Simulates* the initial image, then updates for about five minutes (normal rate) while the WebSocket is dropped every 30 s, ten times, rotating a clean reset, the proxy down for 3 s and the proxy down for 10 s. A drop is only made once every page is connected again, so each one lands on an established connection. *Why:* it is the user's own acceptance test: leave the blotter running over a flaky link. *Proof:* the three checks on all five views. *Passes when* every page saw at least one reconnect per drop (10 in the full tier), at least 20 deltas, no check failed.

**S2: rapid flapping.** *Simulates* a drop every 2 to 5 s for two minutes, rotating six kinds: a plain reset; one timed during an in-flight `getRows` (V1 is scrolled 4,000 rows as the drop lands); one during a `hello` (the proxy goes down for 1 s and a reset toxic is armed as it returns, so it fires on the welcome); one during a trader switch (V1); one during a codec switch (V3); and a 1 s outage. *Why:* reconnect logic fails in the overlaps. *Proof:* the three checks; after the quiet period no page may be busy (a trader or codec change unfinished, a request unanswered, the overlay up) or still loading. *Passes when* at least 15 reconnects per page (quick: 6).

**S3: half-open stall.** *Simulates* a `timeout` toxic of 0 in both directions for 20 s, three times: the socket stays open and nothing flows, which only the client's own heartbeat can notice. *Why:* a dead Wi-Fi or a NAT that dropped the mapping looks exactly like this. *Proof:* the time from the toxic to the page's close reason `stale:` is measured on every page; then the three checks. *Passes when* every detection takes between 5.0 and 9.5 s (the heartbeat is 6 s checked every 2 s, so about 6 to 8 s), at least 3 reconnects, and the checks pass.

**S4: a long outage during a burst.** *Simulates* the proxy down for 60 s while the driver runs the stress rate (2,000 updates and 50 new orders a second). *Why:* the backlog and the cost of catching up are the hard part of a reconnect. *Proof:* the three checks (the model check reads about 8,000 orders). *Passes when* every page reconnects exactly once, the checks pass, and V2 returns to its old depth: its first row after the reload is its first row before plus the orders that arrived meanwhile (within 2,000 rows), with the badge counting those arrivals. A reconnect or codec switch keeps the user's place (the grid notes the first visible row and order before the purge, scrolls back when the reloaded root reports its size, then anchors on the order itself); a trader switch starts at the top.

**S5: high latency.** *Simulates* 300 ms plus or minus 100 ms each way for three minutes, with a clean reset at 60 s and a 3 s outage at 120 s. *Why:* slow is not down; ordering bugs show when replies and deltas cross. *Proof:* the three checks, and the tick-to-screen p50 and p95 are recorded once a second (they include the 600 ms the proxy adds). *Passes when* at least 2 reconnects, the checks pass and a p95 was recorded for every page.

**S6: low bandwidth.** *Simulates* the downstream limited to 64 KB/s for three minutes, then to 16 KB/s for one minute with the driver switched to the stress rate so the stream outruns the link. *Why:* a slow client must not hold the server hostage, and must come back correct. *Proof:* the server's `apeiron_backpressure_events_total` counters (conflation under the first limit, `slow_consumer` under the second) and the pages' close reasons; then the three checks once the bandwidth is back. *Passes when* the server conflated or cut off at least one client, `slow_consumer` fired, some page was cut off (close code 1013, or its link went so quiet that its own heartbeat abandoned it, which is what the page usually sees because the 1013 frame queues behind the data held for the throttled link) and reconnected, and the checks pass.

**S7: server restart.** *Simulates* `docker compose restart antikythera` in the middle of the stream, twice. *Why:* the server reloads its store from the database and replays the durable consumer; this proves no event was lost on the server side. *Proof:* the model check passes (every created and touched order equals the model), plus the screen check. *Passes when* every page reconnects at least once per restart. During the restart `lastUpdateTime` is allowed to step back (see Known limitations); every other invariant stays on.

**S8: a command across a drop.** *Simulates* four Pause and Cancel commands from the grid, each followed within 150 ms by the proxy going down while the ack is held back by a 1.5 s downstream delay. *Why:* a request that can never be answered must not hang the UI or leave a spinner. *Proof:* an error toast must appear while the link is down; afterwards no row shows the pending spinner, no request is outstanding, and the three checks pass whether or not the server applied the command (the model includes the command's effect either way, because the driver's hermes handled it). *Passes when* every page reconnects once per round.

**S10: the order service restarts mid-stream.** *Simulates* `docker compose restart themis` while the driver keeps sending execution reports (they wait in the `EXEC` stream) and new orders (refused while the service is down), twice. *Why:* `themis` is the system of record; a restart must lose no fill and apply none twice. *Proof:* `venue-vs-service` (every order's stored record equals the replay of the venue's reports), `model-vs-server`, the screen checks, and no publish error in the driver. *Passes when* all checks pass; the pages see only records, so they need not reconnect (the minimum is zero reconnects and 50 deltas).

**S11: the price feed goes quiet.** *Simulates* no `prices.*` message for 60 s (the driver stops publishing prices, as if helios were down; the real helios container is stopped for every run) while orders keep filling, pausing and arriving. *Why:* the blotter must keep serving order changes with the last prices it had, and catch up when prices return. *Proof:* during the outage the model received thousands of records and page V1 applied deltas for them; afterwards the checks pass, which includes the overlay of every open order against the last tick. *Passes when* no page reconnects, order records kept flowing during the outage, and the checks pass.

**S12: the blotter restarts and is probed.** *Simulates* `docker compose restart antikythera` (SIGTERM, drain with close code 1012, start, load, warm up), twice, while a probe opens a fresh socket every 150 ms, says hello and asks for rows, and reads `/health/live` and `/health/ready`. *Why:* a client must never be served before the blotter is ready, and the drain must say "not ready" before it cuts anyone off. *Proof:* the probe's tallies. *Passes when* it was served no rows while `/health/ready` did not say ready, saw the blotter not ready (alive, or between processes), saw it ready and was served rows once it was, every open page reconnected, and the checks pass.

**Canary.** Not a scenario: it proves the screen check can fail (see above).

### Caveats about what the checks prove

- **The model is independent of the server's data path but shares one function with it.** The stream, the order lifecycle and the event application come from hermes and logos and are applied by the model on its own, but for an open order the model computes the overlay fields with logos's `deriveOverlay`, the same function the server uses. A bug inside that function would give the same wrong answer on both sides and pass check 1. It is covered by its own unit tests, and check 2 still compares the screen with the server, but check 1 cannot catch it.
- **V3 is grouped by status**, with the LIVE group open (Appendix G originally said by pair), because the LIVE group is the one whose membership churns.

### Known limitations the suite surfaced

- **Under a saturated link the page may give up before the server does.** At 16 KB/s the client sees no frame for 6 s and reconnects; its tick-to-screen p95 in S6 reaches 20 s or more while the link is throttled.
- **The quick tier takes about 12 minutes.** Ten minutes of it is the fault durations themselves; the rest is the three-check verification, run at full strictness, and two server load times.
- **The server follows at most 2,000 rows below the top of a route.** That is what the grid's cache can hold (20 blocks of 100). A reload that answers after more than about 1,000 new orders arrived (a throttled link) keeps following the old rows; past 2,000 it asks the client to reload the route instead. Rows beyond that in a cache the client has not refreshed would go stale, which the suite has not seen.



### Reading a result file

```jsonc
{
  "scenario": "S1", "title": "...", "ok": true,
  "startedAt": "...", "finishedAt": "...",
  "timings": { "runMs": 320000, "settleMs": 2100, "verifyMs": 42600, "totalMs": 364000 },
  "rate": "normal", "seed": 1001,
  "driver": { "events": 39156, "ticks": 19220, "publishErrors": 0, "created": 1599, "commands": { "pause": 320, "resume": 318 } },
  "faults": [ { "kind": "clean", "atMs": 20003 }, ... ],        // what was injected and when (ms from the start of the run)
  "measurements": { "detectMs": [7361, ...] },                  // scenario-specific numbers
  "views": [ {                                                  // one per page
      "view": "V1", "reconnects": 10, "deltasApplied": 2345, "rowsUpdated": 26017, "purges": 10,
      "lastCloseReason": "code:1006",
      "closeHistory": ["code:1006", "stale:7028ms", ...], "toasts": ["error: ..."],
      "latency": { "samples": 280, "p50MedianMs": 38, "p95MedianMs": 60, "p95MaxMs": 75.5 },   // tick-to-screen, once a second
      "checks": [ { "name": "server-vs-screen", "ok": true, "failures": [], "stats": { "leafRowsCompared": 133, ... } },
                  { "name": "invariants", ... }, { "name": "minimums", ... } ] } ],
  "checks": [ { "name": "model-vs-server", "ok": true, "stats": { "ordersCompared": 5035, "created": 1599, ... } } ],
  "failures": []                                                // empty means the scenario passed
}
```

- `reconnects` counts welcomes on a fresh socket after the first, so a hello for a trader or codec switch does not count; `purges` counts grid reloads (a reconnect, a trader switch or a codec switch each cause one).
- `deltasApplied` counts `delta` messages applied to the grid after coalescing, so it is lower than the server's count at high rates.
- `latency` is the page's own rolling 10-second tick-to-screen p50 and p95 (from `delta.srcTs` to the delta being applied), sampled once a second; the report keeps the median and the worst of those p95 figures. Under S5 it includes the latency the proxy adds.
- `ordersCompared`, `leafRowsCompared`, `groupsCompared` show how much each check actually looked at; a pass with a count of zero would be suspect.

## Latest results

**Current architecture** (PLAN1 phase 1.8, 2026-10-13, [`PHASE-1.8.md`](plans/checkpoints/PHASE-1.8.md)): the **full tier
passed 12 of 12 in 30.4 minutes** (the canary, S1 to S8, and the new S10, S11 and S12, with the four checks), and S10,
S11 and S12 passed three times each at full length. Run long suites under `caffeinate -i`: a laptop that sleeps stalls
the run (and the Docker VM's clock falls behind; reset it with
`docker run --rm --privileged alpine date -s @$(date +%s)`). S1 at smoke length failed twice with page V3 one reconnect
short during sleep-disturbed runs and passes at full length; watch for it in CI's smoke step.

The per-scenario figures below are from the final code of PR #10 (`8820833`, after the CP-6 fixes, before the split), on
the 1,000,000-row stack on one laptop (Docker VM with 6 GB). `reconnects` and `deltas` are the lowest and highest across the five pages; `orders compared` is the model check; `p95` is the median of the pages' once-a-second tick-to-screen p95 (lowest to highest page).

### Full tier, final run (23.6 minutes, 9 of 9 passed, 1,417 s wall time including the canary)

| Scenario | Result | Reconnects | Deltas applied | Orders compared | Run / total | Tick-to-screen p95 |
|---|---|---|---|---|---|---|
| S1 | pass | 10 | 2,324 to 2,735 | 2,272 | 320 s / 328 s | 57 to 64 ms |
| S2 | pass | 28 | 699 to 832 | 1,213 | 125 s / 130 s | 57 to 61 ms |
| S3 | pass | 3 | 271 to 306 | 1,062 | 95 s / 104 s | 58 to 66 ms |
| S4 | pass | 1 | 228 to 295 | 7,598 | 90 s / 106 s | 84 to 150 ms |
| S5 | pass | 2 | 1,247 to 1,804 | 4,848 | 180 s / 189 s | 420 to 430 ms |
| S6 | pass | 1 to 3 | 701 to 1,988 | 7,102 | 242 s / 245 s | 289 ms to 31 s (throttled link) |
| S7 | pass | 2 | 526 to 912 | 4,230 | 120 s / 129 s | 62 to 64 ms |
| S8 | pass | 4 | 293 to 352 | 1,017 | 75 s / 84 s | 56 to 62 ms |

Earlier full runs on earlier code are in [`CP-6.md`](plans/checkpoints/CP-6.md); they failed on the bugs listed below.

### Quick tier, final run (11.9 minutes, 9 of 9 passed, 713 s wall time including the canary)

| Scenario | Result | Reconnects | Deltas applied | Orders compared | Run / total | Tick-to-screen p95 |
|---|---|---|---|---|---|---|
| S1 (6 drops) | pass | 6 | 790 to 949 | 1,338 | 132 s / 139 s | 59 to 66 ms |
| S2 (45 s) | pass | 10 | 248 to 331 | 805 | 47 s / 52 s | 57 to 66 ms |
| S3 (1 x 20 s) | pass | 1 | 127 to 141 | 737 | 35 s / 43 s | 46 to 52 ms |
| S4 (30 s down) | pass | 1 | 174 to 242 | 5,881 | 55 s / 68 s | 80 to 122 ms |
| S5 (60 s, 1 drop) | pass | 1 | 324 to 606 | 3,618 | 60 s / 64 s | 426 to 449 ms |
| S6 (60 s + 30 s) | pass | 0 to 1 | 438 to 686 | 5,423 | 92 s / 97 s | 210 ms to 17 s (throttled link) |
| S7 (1 restart) | pass | 1 | 264 to 493 | 4,111 | 62 s / 66 s | 66 to 72 ms |
| S8 (4 commands) | pass | 4 | 482 to 571 | 2,508 | 75 s / 83 s | 60 to 61 ms |

Stability of the gate for bug 9: S6, S4 and S5 each passed six times in a row on the final server code (18 runs), after S6 had failed in two of the previous four attempts. The same code then passed the quick and full tiers above, and S8 twice more on its own.

### Smoke tier

Passes in CI (`e2e` job, the `Resilience smoke` step) on every PR.

## Bugs the resilience suite found

All nine were real product bugs in the live path, found against the 1M-row stack, each fixed with a reproducing unit
test; none was caught by the unit, property or end-to-end layers ([`CP-6.md`](plans/checkpoints/CP-6.md) §2 and "CP-6
fixes"). A tenth, in the PLAN1 work, was found on the way to S10 (a retired `ORDERS` stream captured `orders.cmd`;
[`PHASE-1.8.md`](plans/checkpoints/PHASE-1.8.md)).

| # | Bug | Found by | Fix |
|---|---|---|---|
| 1 | Tracker kept only 500 rows added to a top block; older rows still on screen stopped ticking | S4 | track up to 2,000; beyond that mark the route dirty |
| 2 | A client that said hello while the store was loading was never registered for deltas after a restart | S7 | register the session on `getRows` once the runtime exists |
| 3 | `lastUpdateTime` stepped backwards from producer/server clock skew | S5 | never lower an order's `lastUpdateTime` (since the split only `themis` writes it) |
| 4 | A timed-out `getRows` failed the block and left the grid empty for good | S6 | `TIMEOUT` is retryable |
| 5 | Root-refresh seam: rows added between block answers left displaced rows | S6 | refresh the root once more after a refresh that overlapped adds |
| 6 | Same seam after a purge reload; adds the grid couldn't take yet were lost | S6 quick | arm the follow-up refresh on purge too |
| 7 | Rows pushed past a reloaded block's end went untracked and stale | S2 (~1 run in 4) | carry the previous tail when re-recording a grown block |
| 8 | A held delta could be overtaken by a later reply, so adds were applied twice | S6 | flush held deltas before any reply |
| 9 | Rows below a slow reload went untracked; held-back adds arrived after a reply that already contained them | S4/S5/S6 | retain 1,000 rows; send pending adds before a reply |

The common cause: tracked blocks mirror a client cache the server cannot see. The fixes make it self-healing (reload when
unsure) rather than exact.

