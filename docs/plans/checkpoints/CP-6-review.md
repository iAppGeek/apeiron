# CP-6 Review: Resilience (Phase 9)

- **Reviewer:** Opus 5.5
- **Reviewed:** tag `cp-6`, PR #10 (`phase-9-resilience`), `docs/checkpoints/CP-6.md`, `docs/TESTING.md`, and the `e2e/support` harness (driver, model, oracle, tiers)
- **Date:** 2026-10-08

## Verdict: APPROVE WITH FIXES
The suite does what the user asked: across drops, flapping, stalls, latency, low bandwidth and restarts, it **proves** the grid ends up complete and current, and it has already paid for itself with **7 real product bugs fixed**, each with a reproducing unit test. CI is green, including the resilience smoke run. One UX defect, losing the scroll position on reconnect, should be fixed before the demo, and the full tier needs a second green run on the final code.

## What I checked
- **Independence of the checks (the CP-6 focus).**
  - The model starts from the agreed initial image (`loadCurrent`, `maxOrderId` from the DB), then evolves **only from the events the driver publishes** (`model.applyEvent`/`applyTick`). It is never read back from the server. ✅
  - Server-vs-screen compares every loaded row field for field against a **fresh** read from the server, plus row order, counts, aggregates and the summary. ✅
  - **Caveat (accepted, must be documented):** the model derives price fields with the same logos `derivePriceFields` the server uses, so a bug in that one shared function would be invisible to check 1. The lifecycle fields carry the driver's published absolute values, so they are independent.
- **No vacuous passes.** `checkMinimums` enforces reconnects and deltas per scenario, scaled per tier (for example, S2 needs at least 15 reconnects in the full tier and at least 6 in quick). ✅
- **Exclusions are narrow and justified:** `lastUpdateTime` (the server's clock) everywhere, and the 5 quote fields of orders that closed within a flush window, where the tick ordering isn't knowable. ✅
- **Results:**
  - quick tier 3/3 green on the final code (834–875s, about 14 minutes);
  - about 6 consecutive green quick passes overnight;
  - full tier green on the final code once (1,619s), plus once on earlier code;
  - smoke tier green in CI.

## Bugs found by the suite (all fixed, all with unit tests)
1. Stale rows after many adds: the tracker capped added rows (S4).
2. Late-registered sessions froze after a server restart (S7).
3. `lastUpdateTime` stepped backwards because of clock skew (S5).
4. A timed-out `getRows` left the grid empty for good (S6).
5. The root-refresh seam: rows added between block answers left displaced rows (S6).
6. The same seam after a purge reload: adds were lost (S6 quick).
7. Rows pushed past a reloaded block's end went stale (S2, about 1 in 4 before the fix).

None would have been caught by the unit, property or E2E layers. This is the strongest result of the POC after CP-4.

## Rulings on the open questions
- **S7 tolerates `lastUpdateTime` stepping back after a server restart. Accepted.** Price-only changes are deliberately not persisted (Appendix D, write-behind), so a restarted server shows an open order's last durable update time until the next tick, under a second later. Persisting every tick would cost far more than it's worth. The relaxation covers only that field and only from the restart until 5s after reconnect. Document it in `TESTING.md` and the user guide's limitations.
- **V3 grouped by status, not pair. Accepted;** the plan's wording was inconsistent. Appendix G is updated.
- **S6 asserts "cut off" rather than strictly close code 1013. Accepted:** 1013 queues behind throttled data, and the server's `slow_consumer` counter is asserted separately.
- **Quick tier at about 14 minutes, not 10–12. Accepted:** verification stays at full strength by design.

## Required fixes (Sonnet applies them on `phase-9-resilience`)
- **F1. Keep the scroll position across a reconnect (UX defect found by S4).** Today a reconnect purges the grid and the user lands back at row 0, losing their place, for example at row 430,000.
  - **Fix:**
    1. Before the purge, record the first visible row index and its `orderId`.
    2. When the root reload completes (`storeRefreshed` after the purge), `ensureIndexVisible(savedIndex, 'top')`.
    3. Then, if the saved order is loaded within ±(rows added since, plus slack), anchor on its actual index, reusing the anchoring logic in `apply-delta.ts`.
    4. Keep the badge count for orders that arrived above during the outage.
  - **Tests:** unit tests, and **S4 asserts V2 returns to its old depth** (the same order at the top if it still passes the view's filter; otherwise within the tolerance of the saved index). Remove the deviation "S4 expects V2 back at the top".
- **F2. Full tier on the final code.** After F1, run the **full tier once** and the **quick tier once**, both green on the final code. That gives 2 green full runs on the final code. Update `CP-6.md` §4 and the `TESTING.md` results tables.
- **F3. Flaky unit test.** Time-box 30 minutes to find the antikythera unit test that failed once under turbo's parallel load: run the antikythera suite about 20 times under parallel load, or with `--sequence.shuffle`. Fix it if found (make the assertion load-tolerant). Otherwise record it as a known issue with what was tried.
- **F4. Docs.** `TESTING.md` gets:
  - the independence caveat (shared `derivePriceFields`);
  - the S7 relaxation with its user-visible effect;
  - V3 described as grouped by status.

Then: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`, `pnpm e2e`, CI green, then squash-merge PR #10. The `cp-6` tag stays where it is.

## For phase 10 (demo pack, Opus)
- The dataset grew to about 1.5M rows during the runs. Run `scripts/loadtest-reset.sh` before taking screenshots or benchmarks for the demo.
- Headline for the deck: **"the resilience suite found 7 real sync bugs that every other layer missed"**, plus the three-check method.
