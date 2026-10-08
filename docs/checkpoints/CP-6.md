# CP-6: Resilience suite (Phase 9)

- **Branch / PR:** `phase-9-resilience`, PR #10 "Phase 9: resilience suite" (not merged). Tag `cp-6` on the PR head.
- **Spec:** `docs/PLAN.md` Appendix G. Run guide, scenario write-ups and the latest results: [`docs/TESTING.md`](../TESTING.md).
- **CI:** green on the PR, including the `Resilience smoke` step (S1 shortened plus S3) in the `e2e` job.

## 1. What was built

| Area | What | Where |
|---|---|---|
| Heartbeat | Client abandons a socket silent for 3 ping intervals (6 s, checked every 2 s) or still connecting for 6 s; server pings every `HEARTBEAT_TIMEOUT_MS/3` and terminates a client silent for 15 s. The store exposes `reconnects`, `lastCloseReason`, `closes`, `closeHistory`. | `apps/pharos/src/transport/connection-core.ts`, `apps/antikythera/src/ws-transport.ts` |
| Test hooks | `window.__apeironTest`, read-only, only when built with `VITE_TEST_HOOKS=1`; a unit test bundles the production build and proves no hook survives | `apps/pharos/src/testing/` |
| Harness | Compose profile `resilience`: `ghcr.io/shopify/toxiproxy:2.12.0` (API on 127.0.0.1:8474, proxy `ws` :4100 to antikythera) and `pharos-e2e` (hooks build, :8081). nginx upstream is now an envsubst template (`WS_UPSTREAM`, default `antikythera:4000`). | `infra/` |
| Fault controller | `dropClean`, `down`, `stall`, `latency`, `bandwidth`, `clear` (retries a 5xx from the API) | `e2e/support/faults.ts` |
| Update driver | hermes's own `startHermes` in the test process, seeded, behind a tee bus that feeds an independent model; PAUSE/RESUME injected through the command path; hermes container stopped in setup and restarted in teardown and in a global teardown | `e2e/support/driver.ts`, `model.ts`, `global-teardown.ts` |
| Oracle | check 1 model vs server, check 2 server vs screen (positions, root count, group counts and aggregates, summary chips), check 3 in-page invariant sampler every 500 ms, minimum reconnects and deltas | `e2e/support/oracle.ts`, `sampler.ts` |
| Scenarios | S1 to S8 and a canary, three tiers from one table | `e2e/tests/resilience/`, `e2e/support/tiers.ts` |
| Scripts | `pnpm e2e:resilience` (full), `:quick` (standard), `:smoke` (CI) | root and `e2e/package.json` |
| Docs | `docs/TESTING.md`; Appendix G "Duration and CI" now describes the tiers | |

Every new module has a spec (e2e support: 70 tests; the oracle and sampler include cases that must fail).

## 2. Bugs found and fixed

All found by the suite against the 1M-row stack. Each has a reproducing unit test written before or with the fix.

| # | Bug | Found by | Fix | Reproducing test |
|---|---|---|---|---|
| 1 | **Untracked rows after many adds.** The tracker kept at most 500 rows added to a route's top block and silently dropped the tail, which were the rows the client still held, now pushed down by new orders. They stopped receiving prices and fills. At the stress rate 500 adds take 10 s. | S4 (and a no-fault stress scratch run): rows 500 to 960 stale on V1 and V2 | Track up to 2,000 (what the grid can cache for a route); on overflow mark the route dirty so the client reloads and re-records | `tracker.spec.ts`: "keeps sending updates for rows the client still holds after more than MAX_ADDED_ROWS new orders landed above them"; "asks the client to reload the route once adds outgrow what it can hold" |
| 2 | **Sessions that said hello while the store loaded were never registered with the live runtime.** After a server restart a client reconnecting during the load got rows but no deltas and no summary, forever. | S7: every page stale after the restart | `onGetRows` registers the session when the runtime exists (registering twice is harmless) | `session.live.spec.ts`: "joins the flush loop when the runtime comes up after the client said hello" |
| 3 | **`lastUpdateTime` stepped backwards.** Events carry the producer's clock, repricing the server's; a few ms of skew made a row's update time go back. | S5: sampler violation, 3 ms | `LiveStore.monotonic`: never lower an order's `lastUpdateTime`, for events and for repricing | `live-store.spec.ts`: "never moves lastUpdateTime backwards, whichever clock stamped the change" |
| 4 | **A timed-out `getRows` left the grid empty for good.** `TIMEOUT` was not retryable, so the datasource called `params.fail()`; nothing reloads a failed root block once the link recovers. A throttled link starved the reply for 30 s. | S6: V3 stuck with one placeholder row, four "did not answer in time" toasts | `isRetryable` includes `TIMEOUT` | `datasource.spec.ts`: "asks again after a timeout instead of failing the block"; `errors.spec.ts` |
| 5 | **The root-refresh seam.** A refresh reloads cached blocks with one request each, answered one after another; rows added between two answers left a band of rows displaced against their neighbours, and nothing mended it. | S6 (throttled link stretches the refresh to seconds) | After a root refresh that overlapped adds on top, refresh the root once more | `apply-delta.spec.ts`: "refreshes the root once more when it ends, so blocks answered at different moments do not leave a seam" (and two negative cases) |
| 6 | **Reload after a purge had the same seam, and adds the grid could not take yet were lost.** | S6 quick runs (V5, stale top rows after the stale-then-reconnect path) | `beginReload()` after a purge arms the same follow-up refresh, counted on any root add, not only those inserted | `apply-delta.spec.ts`: "does the same after a purge reload, even when the grid could not take the adds yet"; `Blotter.spec.tsx` |
| 7 | **Rows pushed past a reloaded block's end went untracked.** A refresh re-records block 0 as its first 100 rows; the rows adds had pushed to indexes 100 and beyond stayed in the grid but left the server's tracking and went stale. | S2: rows 100 and 101 of V1 stale after a flap (about 1 run in 4) | `record()` carries up to 200 of the previous tail when a block that had grown through adds is re-recorded | `tracker.spec.ts`: "keeps following the rows pushed past its end, which the grid still holds"; "does not grow without bound over repeated reloads" |

Also fixed in the suite itself (not product bugs): the oracle asked for the reader's summary before its view existed (S4, totals instead of the filtered count); an overlapping set of 5,000-row reads made the oracle's own reader a slow consumer; S8 needed a LIVE row, the cancel confirmation and the left-edge scroll; Toxiproxy's API answered 503 once while tearing down links (now retried); the unit timeout for the driver spec on a loaded CI runner; the CI job did not build the workspace packages the driver imports.

### Why S7 tolerates `lastUpdateTime` stepping back, and what the user sees

Price-driven changes (the quote fields, P&L and the `lastUpdateTime` that goes with them) are never persisted; that is a standing design decision (the DB holds lifecycle state only). When antikythera restarts, it loads the last durable state, so an open order's `lastUpdateTime` is the time of its last lifecycle event, which can be seconds older than what the page showed. The next tick for its pair (3 per second, so under a second) reprices it and the time jumps forward again. Fix 3 guarantees monotonic time within one server's life; across a restart the data genuinely resets, and the sampler saw a 6 s step back in the first quick run of S7. Making the server remember it would mean persisting every tick. So S7 switches the sampler to lenient for `lastUpdateTime` only, from the restart until five seconds after all pages are connected; `filledQty`, `numFills` and the terminal-to-LIVE check stay on throughout. **The user sees** an update-time cell a few seconds older for under a second after a server restart, and nothing else; the model check still proves every order's final state.

## 3. Deviations

- **V3 groups by status, not by pair** (Appendix G says "grouped by pair, with LIVE drilled open"): a LIVE group only exists when grouping by status, and its membership is what churns.
- **V2's depth is 30% of the table** (about row 300,000 of 1M; row 60,000 of CI's 200,000).
- **Quick tier takes about 14 minutes**, above the 10 to 12 asked for. About ten minutes of it is fault time; verification is not weakened to save the rest.
- **S6 asserts "cut off", not strictly close code 1013**: the 1013 frame queues behind the data held for a throttled link, so most pages see only their own heartbeat abandon the link (`stale:`). The server counter `slow_consumer` is asserted separately.
- **S4 expects V2 back at the top** after the reload (see Known weaknesses), not at its old depth.
- **Playwright 1.63.0** and **Toxiproxy 2.12.0** are the latest at the time; no exceptions. The e2e package gained workspace dependencies on `@apeiron/hermes` (new `./hermes` export), `iris`, `logos` and `mnemosyne`; no new third-party dependency (the reader uses Node's global `WebSocket`).
- The normal `pnpm e2e` config ignores `tests/resilience/`.

## 4. Results

Full tables are in `docs/TESTING.md`; raw JSON is in `e2e/results/` (gitignored). Wall times include the canary.

**Full tier.** Final run on the final code: 9 of 9 passed, 1,619 s. The earlier full runs, which are what found the bugs above:

| Run | Code | Result |
|---|---|---|
| 1 | first scenarios | S1 pass; S2 fail (bug 7); S3 pass; S4 fail (bug 1, then an oracle race); S5 fail (bug 3); S6 fail (bug 4); S7 fail (bug 2); S8 hung (harness, no action timeout) |
| 2 | after bugs 1 to 4 | 9 of 9 pass (27.0 min) |
| 3 | same | 8 of 9: S6 fail (bug 5) |
| 4 | same | 8 of 9: S8 fail (Toxiproxy API 503 in teardown, harness) |
| 5 | final | 9 of 9 pass (27.0 min, 1,619 s) |

**Quick tier**, per scenario for the last three runs (total wall 834 s, 843 s, 875 s):

| Scenario | Run 1 | Run 2 | Run 3 | What it showed |
|---|---|---|---|---|
| S1 | 154 s | 154 s | 150 s | 6 reconnects per page, 829 to 942 deltas |
| S2 | 63 s | 64 s | 65 s | 10 flaps each, 239 to 327 deltas |
| S3 | 59 s | 60 s | 61 s | stall detected at 7.1 to 7.5 s |
| S4 | 79 s | 80 s | 101 s | one reconnect per page, 6,500 orders compared |
| S5 | 76 s | 78 s | 86 s | tick-to-screen p95 408 to 447 ms |
| S6 | 109 s | 109 s | 112 s | 1,550 to 2,163 conflations, 2 to 3 `slow_consumer` |
| S7 | 84 s | 85 s | 86 s | one restart, about 5,000 orders compared |
| S8 | 101 s | 101 s | 103 s | 4 reconnects per page |

Raw excerpts:

```
S3 [full] PASS - Half-open stall: 3 x 20s ...    detectMs: 7272 7378 7695 7380 7903 7169 7920 7600 7814 7387 ...
S6 [full] ... softConflateEvents 6698, slowConsumerEvents 8
  closeReasons: code:1006 stale:7205ms code:1013 stale:7613ms ... code:1013
canary: ✓ the server-vs-screen check fails on a frozen page and passes once it has caught up (31.5s)
CI: verify pass 2m32s, e2e (containerised stack, 200k rows) pass 6m0s (includes the smoke step)
```

## 5. Flakiness assessment

The quick tier went from failing about once per run to six consecutive all-green runs overnight and three more in the final configuration, with every failure in between traced to a product or harness cause and fixed (section 2). Remaining risk, honestly:

- **S2 and S6 were the flaky ones**, and each flake was a real defect (bugs 4 to 7), not noise. Bug 7 reproduced about once in four runs before the fix and not in eight consecutive runs after it, which is encouraging but not proof; a rarer variant could remain.
- One antikythera unit test (of 442) failed once under turbo's parallel load on the dev machine and passed on every rerun (not identified; passes in CI).
- Timing assertions have slack: S3 detection 5.0 to 9.5 s against a measured 7.1 to 7.9 s; the quiet period is 2 s.
- The full and quick tiers need an otherwise idle Docker VM; running anything heavy beside them can push S6 and S4 timings.

## 6. Versions

Node 25.8.2 locally (24 in CI), pnpm 10.33, TypeScript 6.0, Playwright 1.63.0, Vite 8.3, Vitest 5.0, AG Grid 36.2, `ws` 8.22, Toxiproxy 2.12.0, NATS 2.15, MongoDB 9.0, Docker 29.8.

## 7. Known weaknesses

- **A reload starts at the top.** *Fixed after this review (F1, see "CP-6 fixes" below):* a reconnect now keeps the scroll position.
- **The model cannot judge the quote fields of closed orders** (whether a tick landed before or after the closing event in one flush); they are excluded from check 1 and the reason is documented. Check 2 still compares them between server and screen.
- **Group aggregates are compared within a relative 1e-9**, because incremental and from-scratch sums may differ in the last bits.
- **Check 2 compares the grid's data, not the rendered cells.** Formatting is covered by the unit tests and the normal E2E.
- **The suite shares one stack and the real data.** Each run adds thousands of orders (the table grew from 1,053,388 to about 1,300,000 during this phase); `scripts/loadtest-reset.sh` restores it. Hermes is stopped during a run.
- **A killed run can leave toxics or a stopped hermes.** The global teardown covers failures and timeouts but not SIGKILL; the commands to restore are in `docs/TESTING.md`.
- **The suite found seven bugs in the live path in a few hours; the live-delta design (tracked blocks that mirror a client cache the server cannot see) is the common cause.** The fixes make it self-healing (reload when unsure) rather than exact. If more turn up, the next step is a server-side view of what the grid really holds, or reloading on a timer.
- The quick tier is 14 minutes, not 10 to 12.

## CP-6 fixes

Applied on `phase-9-resilience` after `CP-6-review.md` (APPROVE WITH FIXES), by Sonnet 5.5 under the finishing prompt. **Path taken: c-lite (the fixes, not the fallback).** Every step of the gate passed within the three fix attempts allowed, so the F1 keep-position behaviour stays and S4 keeps its "V2 back at its old depth" assertion.

| Item | Outcome |
|---|---|
| **F1** scroll position across a reconnect | Done (`42c88ee`). The grid saves the first visible row and order before a reconnect purge and restores it when the root lands, anchoring on the order itself when it is loaded; the badge counts the orders that arrived meanwhile. S4 asserts V2 returns to its old depth (within 2,000 rows of the old position plus the growth). |
| **F2** full and quick tier on the final code | Done: quick 9 of 9 in 11.9 minutes (713 s), full 9 of 9 in 23.6 minutes (1,417 s), both on `8820833`. Tables in `TESTING.md`. |
| **F3** flaky unit test | Done (`ac5fe78`): the system-stats unit test now tolerates load. |
| **F4** docs | Done (`ac5fe78`): the independence caveat, the S7 `lastUpdateTime` relaxation and V3 by status are in `TESTING.md`. |
| **Bug 8** frames applied out of order | Fixed (`0527043`). A delta held for the next animation frame could be overtaken by a reply that arrived after it, so a reload built after those adds had them applied twice and deep blocks sat misaligned (found by S6 once F1 kept V2 deep). The transport now flushes held deltas before any reply. |
| **S1 and the second purge** | After a purge that keeps the view, the cache held blocks loaded while the root was briefly at row 0; one more purge after the viewport is restored leaves only blocks around it (`fb5fe49`). S1 waits for every page. |
| **Bug 9** stale rows in blocks 3 to 10 after a throttled reconnect (S4, S5, S6) | **Fixed**, two causes, both on the server (`8820833`). See below. |
| **S8 harness failure** "12 publishes failed" | Hardened, **cause not captured** (see below). |

### Bug 9: diagnosis and fix

Symptom: after a throttled reconnect a few hundred rows (blocks 3 to 10, rows about 300 to 1,000) kept old `filledQty` or quote fields, or sat 100 rows out of place, on V1 and V2, and stayed wrong after four seconds (`stillWrongAfter4s: yes`). The hypothesis in the prompt (a purge drops the tracker's blocks) was not it. A trace of the server's tracker (record, follow, reset, every update sent) next to the pages' skipped updates showed:

1. **The tracker stopped following rows the grid still held.** A reload of the top block keeps tracking rows that new orders pushed past its end, but only 200 of them, so it followed 300 rows in all. A refresh over a slow link answers after hundreds of new orders have arrived, and the grid keeps every row it loaded until a refresh reaches it (a refresh reloads only the blocks in view). The old top rows, now at positions 300 and beyond, were no longer tracked, so no update was ever sent for them. The first stale row was always the first row past 300. The trace showed no `record` of those blocks and no update to those orders after the reload. Fix: keep up to half of what the grid can hold (1,000 rows, `RETAINED_ROWS` in `tracker.ts`); the other half leaves room for new adds before the route is reloaded. Reproducing test: `tracker.spec.ts`, "still follows rows that a slow reload let more than a couple of hundred new orders push past its end (bug 9)".
2. **Adds held back by backpressure arrived after a reply that already contained them.** A client whose socket is above the soft cap keeps its changes pending. If it asks for a block meanwhile, the reply is built from the current view (adds included) and sent at once, and the held adds follow it, shifting that block a second time while the older blocks are shifted once: rows 100 out of place from the seam down (S6, V2). Fix: when a block is answered and adds are pending for the view, the delta carrying them goes out first (`session.ts`, `onGetRows`). Reproducing test: `session.live.spec.ts`, "sends held-back adds before a reply built after them, so the client does not shift the new block twice".

Neither cause needed a protocol change. Evidence: before the fix S6 failed in two of its first four instrumented attempts; after it, S6, S4 and S5 passed six times each in a row (18 runs), then the quick and full tiers passed.

### S8 harness failure

The full-tier S8 run at 12:40 (right after S7) failed with `driver: 12 publishes failed`, once; no log kept the error. It did not reproduce in five later S8 runs (four full, one quick; one full run came immediately after S7), so its cause is **not established**; the likely one is a JetStream ack that timed out while the bus was busy with the replay after S7's restarts. What changed, without weakening anything:

- The failure now says why: the driver keeps the first five distinct publish error messages and the harness prints them with the count.
- The driver retries a failed publish up to three times (250 ms, 500 ms apart). Events carry absolute values, so retries must not reorder: publishes for one order go out one after another, so a retry cannot land after a newer event for the same order. A publish that fails all three attempts still counts as a failure and still fails the run; retried successes are counted (`publishRetries`) and recorded in the result file. Tests: `driver.spec.ts` (a retried publish is a retry, not an error; a persistent failure is still an error with its message).
- One remaining risk: a publish that timed out but was in fact stored is sent again. Events are idempotent on the server (absolute values), so the result is unchanged.

### Results

| Run | Result |
|---|---|
| Bug 9 gate: S6 x6, S4 x6, S5 x6 | 18 of 18 green |
| S8 x2 (full tier) | green, 75 s each, no retries needed |
| Quick tier, final code | 9 of 9 green, 11.9 minutes (713 s) |
| Full tier, final code | 9 of 9 green, 23.6 minutes (1,417 s) |
| `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | green |
| `pnpm e2e` | 18 of 18 green |

Per-scenario figures are in `TESTING.md`, "Latest results". The seven-bug headline is now nine: bug 8 and bug 9 were found by the same suite after the review, both in the live path's handling of what the grid holds while the link is slow.
