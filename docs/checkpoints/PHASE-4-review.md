# Phase 4 Review: Grid (light review; the full review comes at CP-3)

- **Reviewer:** Opus 5.5
- **Reviewed:** PR #4 (`phase-4-grid`), `docs/checkpoints/PHASE-4.md`, the screenshots, and the datasource, transport and column-definition code
- **Verdict:** **APPROVE WITH FIXES.** Apply the fixes, get CI green, merge, then go on to phase 5.

## Assessment
This is a clean, well-structured client.
- **Transport:** the pure connection core and worker host are tested without a real socket.
- **Datasource:** it reduces AG Grid's request to exactly `SsrmRequest`, strips `undefined` so msgpack's `null` doesn't trip zod, and retries `NOT_READY` behind an overlay.
- **Contracts:** AG Grid 36's request shapes match the server's, with no changes needed.
- **Browser checks:** done against the real containers, including restart and reconnect behaviour.
- **Look:** the screenshots look professional.

## Fixes
- **P4-1. Show times in UTC.** Filters work on UTC days (CP-2 decision), so display datetimes in UTC too, so that what you see is what you filter. Format: `YYYY-MM-DD HH:mm:ss`, and add " (UTC)" to the date column headers ("Created (UTC)" and so on), or show a "Times in UTC" hint in the status bar. This closes known weakness 1.
- **P4-2. Show the trader the server confirmed.** The trader selector should show the trader the **server confirmed** in `welcome`, not the last one picked.
  - Keep `requestedTrader` and `confirmedTrader` in the store.
  - Reconnects use `requestedTrader`.
  - A small "switching…" state shows while they differ.
  - Test it. This closes known weakness 2.
- **P4-3. Readable headers, and a visible order ID.**
  - Several headers are cut off ("Trad…", "B…", "Q…", "T…", "Si…"). Set each column's width or `minWidth` so its full header fits alongside the menu and filter icons, and add `headerTooltip`.
  - **Pin `Order ID` to the left**, after the group column, so leaf rows stay identifiable when scrolled sideways.
- **P4-4. Group row counts get thousands separators:** `EURUSD (250,546)`, not `(250546)`.
- **P4-5. Status bar "Rows" when grouped.** Grouped, it currently shows the number of root groups (20). Until phase 5's `summary.totalRows` arrives:
  - label it **"Groups 20"** when grouped and **"Rows 1,000,000"** when flat;
  - phase 5 then shows both: "Rows {totalRows} · Groups {n}".

## Accepted as-is
- **Modules:** the module set differs from the plan's list, which is fine. Context menu and change highlighting arrive in phases 6 and 5. The app's own status bar replaces AG Grid's.
- **Bundle size:** 1.69MB (479kB gzip), almost all AG Grid. Acceptable for an internal tool; code-splitting the AG Grid modules isn't worth it now.
- **Date filter format:** sends `YYYY-MM-DD` with no time part, which the server already parses.
- **Entry points:** no spec for `main.tsx` or `worker.ts`, consistent with earlier phases.

## Checked again at CP-3
- **Browser check:** I'll run a Chrome DevTools pass covering scrolling FPS, memory, worker message rates and network frames.
- **Grid behaviour:** the component tests mock `ag-grid-react`, so real grid behaviour is covered by the CP-3 browser checks and the phase 8 Playwright E2E.
