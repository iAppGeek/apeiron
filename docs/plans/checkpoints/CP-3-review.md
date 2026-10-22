# CP-3 Review: Live Updates (Phases 4, 5a, 5b)

- **Reviewer:** Opus 5.5
- **Reviewed:** tag `cp-3`, PR #6 (`phase-5b-live-client`), `docs/checkpoints/CP-3.md`, and the earlier PHASE-4 and PHASE-5A reports and reviews
- **Date:** 2026-10-07

## Verdict: APPROVE WITH FIXES
The live blotter works end to end and the numbers are excellent. I found **one real bug**: switching the codec from msgpack back to JSON fails. There is also one UX gap: the load preset is unknown at start. No Appendix F fallback was needed. Apply the fixes on `phase-5b-live-client`, get CI green, and merge. A second review is not needed.

## What I verified myself
- **Clean checkout:** on a worktree of `cp-3`, `pnpm turbo run lint typecheck test build --force` gives **28/28 green**.
- **Incremental views, rechecked on live data** (in the phase 5a review): after 45s of live flow, 5 cached views matched fresh builds cell for cell.
- **Chrome DevTools pass** against the containerised stack, at 1600×900 and DPR 2:

| Check | Result |
|---|---|
| Default view, Medium | Status chips add up to the total (411 + 66 + 0 + 955,224 + 86,476 = 1,042,177 rows); tick-to-screen p50/p95 **5/10ms**; **120 FPS** |
| Fast scripted scroll down to about row 300,000 (40 steps in 2s) | **103 FPS average**, p95 frame 10.1ms, one 142ms frame (a block fetch), **no long tasks** |
| Anchoring at row **312,710**, held for 15s | **The same order (`ALG00729655`) stayed at the top** while 75 new orders arrived above it (index 312,710 → 312,785); the badge counted 20 → 95 |
| Stress preset (LIVE about 3,980, about 51 new orders/s) | **112–114 FPS**, tick-to-screen **15/35ms**, server CPU 6–9%, RSS 844MB, server lag 5–10ms |
| Stress, msgpack codec, top of the grid (about 950–1,300 rows updated/s) | **115–120 FPS**, tick-to-screen 9–13 / 33–43ms |
| JS heap (page) | 27MB on Medium, 48MB after Stress |
| Console | AG Grid licence banner only |
| Codec switch **msgpack → JSON** | **FAILS**: the grid stays on msgpack (F1) |

## Code review highlights
- **`apply-delta.ts`:** correct and careful. Adds before updates. Partials are folded per order *within* a delta, then merged into the node data right before one synchronous transaction per route. Group updates go on the parent route. Dirty-route refreshes are debounced per route. Up/down colouring uses a tracked previous value and a timed sweep that refreshes only the expired cells.
- **`anchor.ts` and `viewport-probe.ts`:** reading the first visible row from the rendered DOM is the right call, because AG Grid scales `scrollTop` with 1M+ rows. There's an API fallback, and the logic sits in a pure, tested function (`planAnchor`).
- **`delta-coalescer.ts`:** the merge rules match Appendix C. It's unit-tested only, since the server sends at most 10 deltas/s. CP-4 should exercise it with a slow client.
- **Purging on every `hello` (codec switch, reconnect):** correct, because the server resets tracking on `hello`.

## Required fixes (Sonnet applies these on `phase-5b-live-client`)
- **F1. Bug: msgpack → JSON codec switch is rejected.**
  - **Repro:** over a raw socket, send `hello{codec:'msgpack'}` (JSON text), get a binary `welcome`, then send `hello{codec:'json'}` as JSON text. The server replies `error BAD_FRAME`. In pharos, the Dev menu stays on MessagePack.
  - **Cause:** after the first `hello`, `ClientSession.process` decodes every frame with the *negotiated* codec, while the client (correctly, per its own comment) sends every `hello` as JSON text.
  - **Fix:** frames are self-describing. The server decodes text frames as JSON and binary frames as msgpack, whatever was negotiated (Appendix C, updated). Keep "the first frame must be a JSON text hello".
  - **Tests:**
    - a session unit test;
    - a **real-socket integration test** switching json → msgpack → json → msgpack and checking `getRows` works after each switch;
    - a pharos test for the round trip.
  - **Browser check:** use Playwright or DevTools real clicks to confirm the Dev menu toggles both ways.
- **F2. Show the load preset (Appendix C, updated).**
  - Hermes publishes `control.state {preset}` at startup, on change, and every 5s.
  - Antikythera caches it and sends `welcome.preset` and `summary.preset`.
  - Pharos shows the active preset in the Dev menu straight away, plus a small **"STRESS"** pill in the status bar while stress is on.
  - Add the types to logos and test each part.
- **F3. Report.** Add a "CP-3 fixes" section to `CP-3.md` with:
  - raw output;
  - the browser-check result for F1;
  - a screenshot of the status bar showing the preset.

Then push, wait for green CI, and squash-merge PR #6. The `cp-3` tag stays where it is.

## Accepted as-is
- **Row animation:** `animateRows={false}`, because rows inserted at 5/s leave ghost rows. That's the right trade-off for a trading blotter.
- **Grouped row counts:** `setRowCount` is skipped while grouped (AG Grid error 28). Non-root counts follow transactions plus the dirty-route refresh. Documented.
- **Tick rate as seen:** the median *visible* tick rate is about 1.1/s per cell, because many 3/s ticks round to the same displayed price. The server tick rate is correct (2.75/s per LIVE row, measured in 5a).
- **Anchor fallback not run live:** the `storeRefreshed` anchor path for sorts other than `createdAt desc` is unit-tested but wasn't exercised live. The E2E suite in phase 8 should cover one case.

## For phase 6 (actions) and phase 7 (observability)
- **Phase 6:** commands follow the Appendix C command correlation (`commandId`, `UPDATE`/`REJECT`, then `ack`/`error`). Register `ContextMenuModule`.
- **Phase 7 (talos) must include:**
  - a **slow-consumer client**: one that reads slowly, to trigger conflation and then `SLOW_CONSUMER`;
  - a **codec-switching client**;
  - the coalescer exercised through a burst. Use the stress preset briefly while the server has 50 clients connected.
