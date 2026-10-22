# CP-4 Diagnosis: Server Collapse Under 50 Clients and Stress (Opus)

- **Trigger:** the phase 7 agent stopped under the stop rules. In the 50-client × 300s json run, with stress at 120–180s, the server **stopped responding**: event-loop stalls of 2.7s and then 13s, then 15s client timeouts. It stayed wedged for about 2 minutes *after* the stress window ended.
- **Verdict:** **REWORK** of antikythera's flush and view maintenance, done before the CP-4 deliverables. This is a design flaw in how views are maintained, not a capacity limit. **No worker-thread fallback is needed yet.**

## What I measured
I ran antikythera on the host under `--cpu-prof` and drove it with talos: 50 clients, 100s, json, specials on, stress from 40s for 30s.
- **This shorter run did not collapse**, but it showed the pressure building:
  - flush p99 was **89ms**;
  - cold `getRows` p95 was **599ms measured by the client**, against **44ms measured by the server**. Requests queue behind flush work;
  - event age at flush p95 was 162ms.
- **Average CPU was modest:** 18% of one core during the medium phase and **29% during stress**. The server is **not** saturated on average.
- **Stress-window profile, as a share of busy time:**
  - `flush` → `View.applyChanges` → `patch`/`applyLeaf`: **60% inclusive**;
  - the sort comparator `rank` (`query/sort.js:231`): **15% self**;
  - `getRows`: 13%;
  - encoding: 5%.
- **Conclusion:** steady-state cost is fine. The collapse is a **feedback loop**, not overload.

## Root cause: a death spiral in the flush loop
1. **Views that no client uses are still maintained.** `ViewCache.sweep` evicts a view only after `refs === 0` **and** 60s idle. Until then, every flush tick patches it. talos clients change view every 45s, so the cache fills towards its 64-view cap with orphaned views, and every tick patches about 60 views where only about 50 or fewer are in use.
2. **Full rebuilds run synchronously.** `View.patch` rebuilds the view synchronously once one tick carries more than `STRUCTURAL_REBUILD_THRESHOLD` (5,000) structural changes. Under stress there are about 5,000 LIVE rows, each ticking 3×/s and each tick changing price fields, P&L, distance-to-limit and `lastUpdateTime`. Views sorted or filtered on those fields therefore see about 1,500 structural changes per 100ms tick.
3. **Each slow tick makes the next one bigger.** If one tick takes about 350ms, the next ChangeSet holds the *distinct* rows changed over 350ms, more than 5,000. **Every** affected view then rebuilds in the same tick, at about 25–100ms each, longer for string sorts while ranks are stale. That makes the tick take seconds, so the next ChangeSet is larger still. The 13s stall is this loop running away.
4. **It continues after the stress ends.** The JetStream backlog that built up during the stall keeps the ticks large, and the ack-after-persist path (write-behind latency about 5s) adds pressure. That's why the server stayed wedged after hermes returned to medium.

## Required changes (antikythera; Sonnet implements them on `phase-7-observability`)
- **R1. Only views in use are maintained.**
  - A view with `refs === 0` is **not patched**. On its first tick without subscribers, drop its derived state (sorted leaves, group levels) and mark it `stale`. The next `getRows` rebuilds it cold, which is 12–47ms per CP-2.
  - Keep the 60s idle eviction for memory.
  - **Effect:** the number of maintained views equals the number of distinct views clients currently have open.
- **R2. No synchronous rebuild inside a flush** (Appendix F, second item, now mandatory).
  - When a view's structural changes exceed the threshold, mark it `rebuildPending` and skip the patch.
  - Rebuild pending views **after** the deltas for that tick are sent, at most once per second per view, and at most one rebuild per event-loop turn (`setImmediate` between rebuilds), so the loop stays responsive.
  - After a rebuild, the view's subscribers get `dirtyRoutes` for every route they track, so their grids refresh in the background.
- **R3. Time-budgeted flush.**
  - Patch views in descending subscriber count, within a budget (`FLUSH_BUDGET_MS`, default 40ms).
  - Views not reached carry their **pending changed-row set** into the next tick, as a union of row indexes. That's exact, because the patch re-reads current values plus the `prev` captured when each row first changed. Alternatively, mark them `rebuildPending` if the carried set passes the threshold.
  - Clients of those views get their deltas a tick later instead of the loop stalling. Add metrics: views patched, deferred, and rebuilt per tick.
- **R4. Cheaper comparator.** The `rank`-based comparator is 15% of busy time under stress.
  - For single-column numeric sorts (the common case with ticking columns), compare `Float64Array` values directly, with nulls smallest and the `orderId` tiebreak.
  - Keep `rank` for string and multi-key sorts.
  - Only take this if profiling after R1–R3 still shows it hot.
- **R5. Ingest backpressure sanity.** Make sure a slow loop can't cause redelivery or timeout storms:
  - `ack_wait` 60s, keeping `max_ack_pending` at 20k;
  - bounded pull batches;
  - write-behind flushes are bounded per call and yield.
  - Log the NATS `TimeoutError` source seen in the failing run, and fix it if it comes from a request on the hot path.

**Tests:** units for R1–R3:
- orphaned views aren't patched and are rebuilt correctly on access;
- a rebuild is deferred and runs afterwards, and subscribers get dirty routes;
- the budget carries changes over correctly.

Extend the existing **incremental vs full-rebuild property test** to cover the deferred and carried paths, which must still produce exactly the same views.

## Re-verification (required before CP-4)
1. **The exact failing scenario again:** 50 clients × 300s, json, specials, stress at 120–180s. **All targets must be met**, including cold `getRows` p95 under 300ms *measured by the client*, with no wedge after the window.
2. The same run with msgpack.
3. A **soak**: 50 clients × 600s with stress for 240s, to show no death spiral even under sustained stress. Its p95/p99 are reported, not gated, apart from "no wedge" and "lag p99 under 50ms after the stress window ends".
4. A CPU profile of the stress window after the changes, compared with the one above.

Then complete the CP-4 deliverables as originally specified: the PR (not merged), the `cp-4` tag, `CP-4.md` including this diagnosis and the before/after numbers, and the README Benchmarks section with the JSON vs msgpack comparison.
