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
   antikythera :4000  <------------- NATS (orders.events, prices.*, orders.commands)
```

- **Toxiproxy** (`ghcr.io/shopify/toxiproxy:2.12.0`, the latest release) sits between the browser's web container and antikythera. The `resilience` compose profile adds it and `pharos-e2e`, the same web image built with `VITE_TEST_HOOKS=1` whose nginx sends `/ws` to `WS_UPSTREAM=toxiproxy:4100`. The normal `pharos` image is unchanged (the upstream defaults to `antikythera:4000`).
- **Test hooks** (`window.__apeironTest`, read-only, only in that build): every loaded leaf and group row from `api.forEachNode`, the root row count, the summary, the connection state (reconnects, close reasons, pending requests), delta, row and purge counters, the view state, the latest `getRows` request, and the tick-to-screen figures. A unit test builds the production bundle and asserts none of it is there (`apps/pharos/src/testing/hooks-gate.spec.ts`).
- **Fault controller** (`e2e/support/faults.ts`): `dropClean()` (a `reset_peer` toxic for 600 ms), `down(ms)` (disable the proxy), `stall()` (a `timeout` toxic of 0 in both directions: data stops, nothing closes), `latency(ms, jitter)`, `bandwidth(kbps, direction)`, `clear()`.
- **Update driver** (`e2e/support/driver.ts`): hermes's own `startHermes` running in the test process on a seeded generator, so the stream is hermes's (price ticks at 3 per second per pair, fills, PENDING to LIVE, LIVE to FILLED or CANCELLED, new orders with ascending ids, and everything that moves rows between status groups and in and out of filters), plus PAUSE and RESUME commands injected through the normal command path. Rates are hermes's own presets: `normal` is Medium, `stress` is Stress. Nothing is reimplemented. Every event and tick passes through a tee bus that applies it to the model before forwarding it.
- **The model** (`e2e/support/model.ts`): the orders as they were when the stream started, with each published event applied (NEW upserts, UPDATE merges its absolute fields) and the latest tick per pair kept. It uses nothing from the server. For orders still open (LIVE or PAUSED) it applies the shared logos `derivePriceFields` to the final tick, which is what the server does. Two kinds of field are not compared, and the reason is part of the contract:
  - `lastUpdateTime`, which the server stamps from its own clock;
  - for a closed or pending order, the five quote-derived fields (`marketBid`, `marketAsk`, `marketMid`, `spreadBps`, `distanceToLimitBps`). Whether a tick landed on the server just before or just after the closing event within one flush cannot be known to a model.

  The driver finishes with one last tick per pair, so the server's final price join and the model's use the same quote.
- **The five views** open at once, each in its own browser context: V1 the default flat view at the top; V2 flat, scrolled to about row 300,000 (30% of the table, so about row 60,000 in CI's 200,000-row dataset); V3 grouped by status with the LIVE group open (a deviation from Appendix G's "by pair": the LIVE group is the one whose membership churns, so drilling into it exercises group moves); V4 status = LIVE sorted by `unrealisedPnlUsd` descending, so the sort key ticks; V5 trader T2 only over msgpack.

### The three checks

After the stream stops, the harness waits until the server has applied and persisted everything (`/health`, `/debug/lag` and NATS's `/jsz` report nothing queued and nothing unacknowledged, twice in a row) and every page has been connected, not busy and delta-free for 2 seconds. Then:

1. **Model against server.** A fresh protocol client (the logos codecs over a plain WebSocket, straight to antikythera, not through the proxy) reads every order the stream created (they are the top of the table by id, read as one block), checks the total row count equals the starting count plus the orders created, and reads every other order an event touched or a tick repriced, one at a time. Each must equal the model on every field except the exclusions above.
2. **Server against screen.** For each page, the checker takes the page's view (trader, sort, filter, grouping, columns) from the last `getRows` request, then reads from a fresh client, at the same positions, every row the grid holds. Each loaded row must equal the server's field for field, including `lastUpdateTime`, and sit at the same index (the order of the loaded blocks). The root row count and the status-bar count must equal the server's; each loaded group row's `childCount` and aggregates must equal the server's group row (matched by key; aggregates within a relative 1e-9, since the incremental and the from-scratch sums may differ in the last bit); and the status-chip summary must equal the summary the fresh client receives for the same view. If this check fails, it looks again 4 seconds later and records whether the page was still wrong, to tell a late page from a stuck one.
3. **Invariants during the run.** A sampler inside each page reads `loadedRows()` every 500 ms. For every order, `filledQty`, `numFills` and `lastUpdateTime` must never go backwards, and an order seen FILLED or CANCELLED must never be seen LIVE or PAUSED again. A scenario also fails unless every page saw at least the expected number of reconnects and deltas, so it cannot pass by doing nothing.

A suite that cannot fail proves nothing, so `canary.e2e.ts` freezes the connection (a stall shorter than the client's heartbeat, so the page does not notice), lets the server move on, and requires check 2 to report the frozen page as out of date, then requires the checks to pass once the page has caught up. The oracle's pure logic is also unit tested (`oracle.spec.ts`), including cases that must fail.

### The client and server heartbeat

Scenario S3 depends on it, and both sides were missing a way to notice a half-open socket:

- **Client** (`connection-core.ts`): if no frame of any kind (pong, delta, summary, reply) arrives for 3 ping intervals (`staleAfterMs`, 6 s), checked at each 2-second ping tick, the socket is abandoned, in-flight requests fail with `DISCONNECTED`, and the core reconnects with backoff. A socket still connecting is held to the same limit. The app store exposes `reconnects`, `lastCloseReason` (`code:1006`, `stale:7361ms`, `connect-timeout:6000ms`), `closes` and `closeHistory`.
- **Server** (`ws-transport.ts`): a WebSocket-level ping every `HEARTBEAT_TIMEOUT_MS / 3` (default 5 s); a client that has sent no frame and answered no ping for `HEARTBEAT_TIMEOUT_MS` (default 15 s) is terminated, which fires `close` and releases its session, tracker and view references.

### Scenarios

Every scenario runs against the 1,000,000-row stack, opens all five views, and ends with the three checks. Each writes `e2e/results/<scenario>-<timestamp>.json` (gitignored).

SCENARIOS_PLACEHOLDER

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

LATEST_RESULTS_PLACEHOLDER
