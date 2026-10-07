# Checkpoint CP-3: phases 4, 5a and 5b

Covers the grid (phase 4), the live server (phase 5a) and the live client (phase 5b, this PR "Phase 5b: live client", branch `phase-5b-live-client`, tag `cp-3`). Not merged.

Earlier reports: [PHASE-4](PHASE-4.md), [PHASE-4 review](PHASE-4-review.md), [PHASE-5A](PHASE-5A.md), [PHASE-5A review](PHASE-5A-review.md).

## What 5b built (apps/pharos only; no server changes)

- **`grid/apply-delta.ts`: `createDeltaApplier`.** Per delta, in order: adds (one synchronous `applyServerSideTransaction({route, add, addIndex})` per entry), updates (each partial merged into `{...getRowNode(id).data, ...partial}` immediately before one synchronous transaction per route; two partials for one row in a delta fold; rows not loaded are skipped and counted), group updates (merged by group row id on the parent route), dirty routes (`refreshServerSide({route, purge:false})`, leading-edge, at most once per second per route), root row count. The async transaction API is never used.
- **Row counts.** AG Grid 36 SSRM has no per-store count setter. `ServerSideTransaction.rowCount` only applies to removes. `api.setRowCount` sets the root store only, and AG Grid logs error 28 if it is called while grouped. So: root count via `setRowCount` when not grouped; every other count (and the grouped root) relies on the transactions plus the dirty-route refresh that accompanies a changed count. The status bar still follows the server's root count.
- **Cell flash and up/down colour.** `HighlightChangesModule`, `enableCellChangeFlash` in `defaultColDef`, `cellFlashDuration` 600ms / fade 400ms. Price columns (`ColumnMeta.priceColumn`) get `cellClassRules` `tick-up`/`tick-down` driven by `grid/tick-tracker.ts` (previous value, direction, 600ms hold, row node kept so expiry redraws only those cells with `refreshCells({force, suppressFlash})`). No whole-row re-render.
- **New rows on top and anchoring.** Adds at index 0 land through the transaction. Scrolled down, the applier reads the first visible row before inserting, then `ensureIndexVisible(top + newAbove, 'top')`, and adds to the badge (`NewOrdersBadge`, "N new orders ↑"; click scrolls to the top and clears; scrolling back to the top clears). At the top there is no scroll and no badge. If new rows arrive by refresh (non-`createdAt desc` sort) the anchor waits for `storeRefreshed` of the root route and moves by `newAbove` from wherever the viewport is by then.
- **Summary.** `SummaryStrip` under the header (LIVE, PENDING_START, PAUSED, FILLED, CANCELLED chips and live notional, `$4.21bn` style). Status bar: Rows (server `totalRows`) and Groups (root count) when grouped, server CPU/RSS/lag.
- **Dev menu load preset.** Medium/Stress sent as `control` (new `client.control()`, resolves on the server's `ack`), active preset shown.
- **Metrics.** Tick-to-screen latency p50/p95 over a rolling 10s (`metrics/latency.ts`), server clock offset estimated from ping/pong in the worker (NTP style, lowest-RTT sample of the last 8) and applied; delta messages/s (raw, before coalescing), rows updated/s, FPS.
- **Coalescing.** `transport/delta-coalescer.ts`, in the worker: above 20 deltas/s they merge once per animation frame (`requestAnimationFrame` where the worker has it, else a 16ms timeout). Rules: adds before updates, later adds on top for the same route, latest value per row and field, group rows concatenated in order, dirty routes unioned, latest `rowCounts`, `newAbove` summed, earliest `serverTs` (worst-case latency).
- **Slow consumer and reconnects.** `SLOW_CONSUMER` error or close code 1013 shows one toast; after any unexpected close, the reconnect welcome purges the grid (`refreshServerSide({purge:true})`) and resets live state. The worker now reports the close code (`closed` event).
- **Trader/codec switch** clears the delta state (previous values, badge, debouncers) through the registered purge.

## Deviations (and why)

1. **Codec switch now purges the grid.** The server drops everything it tracks on every `hello`, so after a codec switch deltas would silently stop for already loaded rows. (Phase 4's test asserted "without purging"; updated.)
2. **Every reconnect purges, not just slow consumers.** Same reason: a new session tracks nothing.
3. **`animateRows={false}`.** With the default row animation, rows inserted at 5/s left permanently overlapping "ghost" rows at the top of the grid (seen in the first live run). Explicit `rowBuffer={10}` is set so the anchor maths is stable.
4. **Top row is read from the DOM (`grid/viewport-probe.ts`).** `getFirstDisplayedRowIndex` includes the buffer, and with 1M rows AG Grid caps the scroll container at 16M px and scales the scroll position (observed: scrolling to 6400px landed on row 413), so `scrollTop / rowHeight` is wrong. Fallbacks (first rendered row + buffer; pixel maths near the top) remain for hosts without the DOM. `ensureIndexVisible` has no pixel precision, so the first anchor can move the view by under one row.
5. **Anchor shift** is the delta's `newAbove`, or the rows actually inserted at the top when the server says 0 (server last saw block 0 as the top).
6. **`setRowCount` is skipped while grouped** (AG Grid error 28; found in the live run, fixed, covered by a test).
7. **Merged-delta `serverTs` is the earliest**, so coalescing never hides latency.
8. **Group updates are not de-duplicated when coalesced**, only concatenated (group identity needs the grid's group columns); later rows are applied last so the result is the same.
9. **Active preset starts unknown.** The server does not report the preset, so the Dev menu shows none until one is chosen from the page.
10. Extra AG Grid community modules registered: `RowApiModule`, `ScrollApiModule`, `RenderApiModule`, `HighlightChangesModule` (no new dependencies).

## Appendix F fallback

**Not used for the primary path.** SSRM `add` at index 0 plus `ensureIndexVisible` anchoring was stable in the live run (same row held within 1px for 20s while the badge counted 5/s). The fallback behaviour (dirty-route refresh, anchor on `storeRefreshed`) is implemented as the path for views that are not `createdAt desc`; it is unit-tested but was not exercised live.

## Verification

`pnpm lint && pnpm typecheck && pnpm test && pnpm build` (exit 0). Test counts per package (pharos 319, up from 159):

```
 Tasks:    10 successful, 10 total
Cached:    9 cached, 10 total
  Time:    1.304s 
 Tasks:    10 successful, 10 total
Cached:    9 cached, 10 total
  Time:    1.178s 
@apeiron/logos:test:  Test Files  12 passed (12)
@apeiron/logos:test:       Tests  131 passed (131)
@apeiron/mnemosyne:test:  Test Files  4 passed (4)
@apeiron/mnemosyne:test:       Tests  35 passed (35)
@apeiron/iris:test:  Test Files  2 passed | 1 skipped (3)
@apeiron/iris:test:       Tests  9 passed | 2 skipped (11)
@apeiron/hermes:test:  Test Files  7 passed (7)
@apeiron/hermes:test:       Tests  43 passed (43)
@apeiron/gaia:test:  Test Files  5 passed (5)
@apeiron/gaia:test:       Tests  25 passed (25)
@apeiron/antikythera:test:  Test Files  36 passed (36)
@apeiron/antikythera:test:       Tests  352 passed (352)
@apeiron/pharos:test:  Test Files  32 passed (32)
@apeiron/pharos:test:       Tests  319 passed (319)
 Tasks:    10 successful, 10 total
Cached:    9 cached, 10 total
  Time:    2.404s 
 Tasks:    7 successful, 7 total
Cached:    6 cached, 7 total
  Time:    495ms ```

### Live verification (containerised stack, one Chrome tab driven with Playwright, this laptop, 1M+ rows)

| Check | Result |
|---|---|
| LIVE filter, medium: price cells changing | Cell text changes (value-changing ticks only) **median 1.1 per second per marketMid cell** (p10 0.2) over 10s, 33 cells. Server ticks are 3/s per pair, but many ticks round to the same displayed price, and AG Grid flashes only on a changed value. Over 100 samples at 10 Hz: 1,482 cell-samples with `tick-up`, 1,692 with `tick-down`, 3,270 with the flash class. See `live-ticking-flash.png`. |
| Default view at the top, new orders | Row 0 id advances **4 to 6 per second** (about 5/s), no badge, rows count follows. |
| Scrolled to about row 200 (index 419 after scaling), 20s | The same order (`ALG01030344`) stayed at the top of the viewport at pixel 148 to 149 for 20s; badge went 7, 27, 47, 67, 87, 107 (5/s). Clicking the badge returned to row index 0 and cleared it. `new-orders-badge-scrolled.png`. |
| Grouped by pair then status | Drilled EURUSD, LIVE: group cells mutate about **47/s across 27 visible aggregate cells**, leaf price cells tick (53 mutations/s over 24 cells). Status bar `Rows 1,031,585 · Groups 20`. `grouped-live-view.png`. |
| Stress, idle (8 samples over 20s) | FPS **116 to 118** (120 Hz display), tick-to-screen **p50 10 to 11 ms, p95 34 to 39 ms**, 9 to 10 deltas/s, **1,224 to 1,372 rows updated/s**, server CPU 5.9 to 9.4%, RSS 801 to 803 MB, event-loop lag 4.8 to 14.2 ms, LIVE about 3,800 to 4,350. |
| Stress, programmatic scrolling (8 samples) | FPS **81 to 111** (mostly 92 to 97, target 30), tick-to-screen **p50 14 to 18 ms, p95 85 to 108 ms** (target 300), 2,392 to 3,336 rows updated/s, CPU 6.8 to 11.7%, RSS 805 to 816 MB, lag 6.3 to 10.3 ms. `stress-status-bar.png`. |
| Back to Medium | Dev menu shows Medium active; LIVE drained from about 4,300 to about 300 over a minute, then new orders resumed (hermes holds off while LIVE is over target). |
| Trader switch (T2) while live | Rows 1,040,484 to 260,150 (scoped), LIVE and notional rescoped, only `T2` rows rendered, 4 to 7 deltas/s and about 260 rows updated/s, new T2 orders arrive at row 0 (260,196 to 260,212 over 14s). |
| Medium idle for reference | p50/p95 5 / 9 ms, FPS about 118, server CPU about 2 to 4%. |

Screenshots in `docs/screenshots/phase-5/`: `live-ticking-flash.png`, `new-orders-badge-scrolled.png`, `grouped-live-view.png`, `stress-status-bar.png`, `status-bar-medium.png`, `summary-strip.png`.

### Console errors

Only the AG Grid Enterprise licence banner (7 console errors, a boxed message, per page load). One extra, `AG Grid: error #28 setRowCount cannot be used while using row grouping`, appeared in the first grouped run; fixed (deviation 6) and absent in the re-run after the fix. No other errors or warnings.

## Versions and exceptions

Unchanged from phase 5a: React 19.3, Vite 8.3, AG Grid (community, enterprise, react) 36.2.0, Zustand 5.0.15, Vitest 5.0.3, TypeScript 6.0.x. No new dependencies (Appendix A). Exceptions: none new.

## Known weaknesses

- Scroll anchoring depends on rendered-row DOM (`.ag-header`, `.ag-row[row-index]`) because AG Grid has no public exact call; an AG Grid markup change would fall back to the less exact API maths.
- `getRowNode` is a linear scan of loaded nodes in SSRM; at about 1,300 updates/s over at most 2,000 cached rows it was cheap (client main thread stayed above 80 fps scrolling under stress), but it will not scale to a much larger cache.
- Non-root group counts are only corrected by the throttled (1/s) dirty-route refresh.
- The coalescing path (above 20 deltas/s) is unit-tested but never triggered live, because the server sends at most 10 per second.
- The slow-consumer path (SLOW_CONSUMER, close 1013) is unit-tested only; it was not provoked live.
- Latency is `serverTs` to the end of the synchronous transaction, not to paint.
- The preset is unknown until set from the page; another client changing it is not reflected.
- Live price-tick figure above is cell value changes, not server ticks, so it reads below the 3/s target by construction.
