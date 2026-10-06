# Phase 4: Grid (pharos)

Branch `phase-4-grid`. Scope: the web app only. Live updates (phase 5) are not started; the seams for them are listed below.

## What was built

`apps/pharos` (`@apeiron/pharos`): Vite 8, React 19, TypeScript 6 strict, AG Grid 36 Enterprise (SSRM), Zustand 5.

**Worker transport** (`src/transport/`)
- `connection-core.ts` is a pure module (no `Worker`, no `WebSocket`, no real timers; all injected). It owns the handshake (first frame is always a JSON `hello`, later frames use the negotiated codec), `reqId` matching, a 30 s request timeout, ping every 2 s (plus one immediately after `welcome`) for round-trip time, msgs/s in and out, and reconnect with exponential backoff (500 ms base, 10 s cap, 20% jitter) that re-sends `hello`.
- `worker-host.ts` wires the core to a worker scope; `worker.ts` is the only file that touches `self`, `WebSocket` and the real clock.
- `client.ts` is the typed main-thread API: `connect`, `hello(traderId, codec)`, `getRows(req)`, `setFilterValues(colId)`, `on('status' | 'message' | 'stats', ...)`, `dispose`. Failures reject with `RequestError` whose `code` is the server `ErrorCode` or a transport code (`DISCONNECTED`, `TIMEOUT`).
- Frames are decoded by their own type (text is JSON, binary is msgpack), so a frame already in flight during a codec switch still decodes.

**Grid** (`src/grid/`)
- `column-defs.ts`: pure builder from `COLUMNS`; filters (text, number, date, set with async `values` via `setFilterValues`), `inRangeInclusive: true` on number and date, `enableRowGroup`, `aggFunc` mapped from metadata (`wavg:notionalUsd` becomes `wavg`), `allowedAggFuncs` limited to the four wire names, default sort `createdAt desc`.
- `formatters.ts`: fixed decimals with thousands separators, price columns use `priceDecimals(row.currencyPair)` (5 on rows without a known pair), local-time datetimes, UTC `valueDate`, null shown empty.
- `cell-renderers.tsx`: status chips (five colours) and BUY/SELL colouring.
- `get-row-id.ts`: Appendix B ids (`orderId`, `"G:" + [...parentKeys, key].join("|")`).
- `datasource.ts`: passes only the `SsrmRequest` fields (undefined stripped so msgpack never sends `null` for an optional field); `success({rowData, rowCount})`; `fail()` plus a toast for real errors; `NOT_READY` and `DISCONNECTED` retry with backoff (the first also shows the "Loading orders..." overlay).
- `grid-options.ts`, `modules.ts`, `Blotter.tsx`: SSRM, `cacheBlockSize` 100, `maxBlocksInCache` 20, `rowGroupPanelShow: 'always'`, side bar (columns, filters), dark Quartz theme, custom `aggFuncs: { wavg }`, `getChildCount` so group rows show `(n)`.

**App shell** (`src/App.tsx`, `src/components/`, `src/state/`, `src/metrics/`)
- Header ("Apeiron", "Infinity Blotter"), trader selector (All traders + the 5 from `welcome`; change sends `hello` then `refreshServerSide({ purge: true })`), "Dev" menu with the codec toggle (re-sends `hello`), status bar (connection, codec, root row count, RTT, rAF FPS, msgs/s in and out, server CPU and RSS placeholders), toasts.

**Docker**
- `infra/docker/web.Dockerfile` (turbo prune, Vite build, `nginxinc/nginx-unprivileged:1.30-alpine`, uid 101), `infra/nginx/pharos.conf` (WebSocket proxy on `/ws` with 1 h read timeout, gzip, `immutable` cache on hashed assets, `no-cache` on `index.html`), compose service `pharos` in the `core` profile on `127.0.0.1:8080`, depends on antikythera healthy, with a healthcheck.

**Seams for phase 5**
- Message bus: every server message that is not a response to a request (delta, summary, welcome, stray errors) reaches the main thread as a `message` client event.
- Transactions: `grid/apply-delta.ts` (`applyDelta(api, delta)`, currently a no-op), called by `Blotter` for each `delta`; `AppController.setDeltaHandler` is the store-side hook. `summary` already feeds the status bar CPU and RSS.

## Deviations from the plan

| Deviation | Reason |
|---|---|
| AG Grid `StatusBarModule` is not registered, and the status bar is a React component under the grid | The status bar shows connection, codec, RTT and FPS, which are app state, not grid state. A grid status panel would need a custom panel component per item for no benefit. |
| `ContextMenuModule` and `HighlightChangesModule` are not registered yet | Needed only by phases 6 and 5. Registered modules are listed below. |
| Extra modules beyond Appendix A: `RowGroupingPanelModule`, `SideBarModule`, `ColumnsToolPanelModule`, `FiltersToolPanelModule`, `ColumnMenuModule`, `ColumnApiModule` | Strictly required by the group panel, the side bar with its two panels, and the header menu (the filter button and "Group by"). |
| `ag-grid-community` is a direct dependency | Needed for `themeQuartz`, `colorSchemeDark` and types; pnpm does not hoist it from `ag-grid-enterprise`. Same version (36.2.0). |
| The date filter sends `dateFrom: "2026-10-01"` (date only), not `"YYYY-MM-DD HH:mm:ss"` | That is what AG Grid 36 sends. The server's parser accepts both shapes, so no change was needed. |
| The group column is pinned left | Without it the group labels scroll away from the aggregates in a 50-column grid. |
| The status column is 160 px wide (metadata says 130) | `PENDING_START` as a chip did not fit in 130. Done in the builder, not in `logos`. |
| `main.tsx` and `worker.ts` have no spec file | They are the two entry points (DOM bootstrap and `self`/`WebSocket`/real timers); all their logic lives in tested modules. `messages.ts` is types only. |

## AG Grid version and modules

`ag-grid-react`, `ag-grid-enterprise`, `ag-grid-community` all **36.2.0**. Registered through `AgGridProvider`:
`ServerSideRowModelModule`, `ServerSideRowModelApiModule`, `RowGroupingModule`, `RowGroupingPanelModule`, `SetFilterModule`, `TextFilterModule`, `NumberFilterModule`, `DateFilterModule`, `CellStyleModule`, `ColumnApiModule`, `ColumnMenuModule`, `SideBarModule`, `ColumnsToolPanelModule`, `FiltersToolPanelModule`.

## SSRM request shapes AG Grid 36 sent

Captured in the browser against the containerised stack, by logging what the client posts to the worker (so they are exactly what goes on the wire). The server accepted every one. `valueCols` is abbreviated where noted; flat requests carry all 11 aggregate columns (the server ignores them for flat views).

All requests have this common shape (fields in the order sent):

```jsonc
{ "startRow": 0, "endRow": 100, "rowGroupCols": [], "valueCols": [ /* 11 entries, see below */ ],
  "groupKeys": [], "sortModel": [...], "pivotMode": false, "filterModel": {} }
```

`valueCols` (every request, flat or grouped):
`sum` on orderQty, filledQty, notionalUsd, filledNotionalUsd, slippageUsd, unrealisedPnlUsd, realisedPnlUsd, numFills; `wavg` on pctComplete, slippageBps, perfVsVwapBps. Each entry is `{ "id": "orderQty", "field": "orderQty", "displayName": "Order Qty", "aggFunc": "sum" }`.

**Flat (initial)**
```json
{"startRow":0,"endRow":100,"rowGroupCols":[],"valueCols":[...],"groupKeys":[],"sortModel":[{"colId":"createdAt","sort":"desc"}],"pivotMode":false,"filterModel":{}}
```

**Sorted** (Account ascending; the header click replaces the default sort). Clearing the sort sends `"sortModel":[]`, which the server treats as `createdAt desc`.
```json
{"startRow":0,"endRow":100,"rowGroupCols":[],"valueCols":[...],"groupKeys":[],"sortModel":[{"colId":"account","sort":"asc"}],"pivotMode":false,"filterModel":{}}
```

**Deep scroll** (row 500,000): blocks `startRow 499900 / endRow 500000` and `500000 / 500100`, otherwise identical to the flat shape.

**Set filter** (status = LIVE; sort cleared)
```json
{"startRow":0,"endRow":100,"rowGroupCols":[],"valueCols":[...],"groupKeys":[],"sortModel":[],"pivotMode":false,"filterModel":{"status":{"values":["LIVE"],"filterType":"set"}}}
```

**Number filter** ("Between" with `inRangeInclusive`, notionalUsd 5,000,000 to 10,000,000, combined with the set filter above, so filters are ANDed across columns)
```json
"filterModel":{"status":{"values":["LIVE"],"filterType":"set"},"notionalUsd":{"filterType":"number","type":"inRange","filter":5000000,"filterTo":10000000}}
```

**Date filter** ("Between", createdAt 2026-10-01 to 2026-10-06, same combination). AG Grid sends date-only strings.
```json
"filterModel":{"status":{...},"notionalUsd":{...},"createdAt":{"dateFrom":"2026-10-01","dateTo":"2026-10-06","filterType":"date","type":"inRange"}}
```
With dates 2026-09-01 to 2026-09-30 the same filter returned 0 rows, with 2026-10-01 to 2026-10-06 it returned 116, so the filter is applied, not ignored.

**Grouped** (group by Pair; root level)
```json
{"startRow":0,"endRow":100,"rowGroupCols":[{"id":"currencyPair","field":"currencyPair","displayName":"Pair"}],"valueCols":[...],"groupKeys":[],"sortModel":[{"colId":"createdAt","sort":"desc"}],"pivotMode":false,"filterModel":{}}
```

**Grouped, drilled into EURUSD** (same, with `"groupKeys":["EURUSD"]`).

**Grouped, sorted by the group column** (header clicked twice; AG Grid also appends the group column's own sort)
```json
"sortModel":[{"colId":"ag-Grid-AutoColumn","sort":"desc"},{"colId":"currencyPair","sort":"desc"}]
```
The server accepted it and returned groups in descending key order (USDZAR first).

Other wire notes: `pivotMode` is always sent (`false`); `setFilterValues` is `{ "t": "setFilterValues", "reqId": n, "colId": "status" }` and returned `CANCELLED, FILLED, LIVE, PENDING_START`.

## Manual verification (containerised stack, `http://localhost:8080`, Playwright MCP)

Stack started with `docker compose --profile core up -d --build`; all four services healthy. Browser: Playwright Chromium, 1600x900.

| Check | Result |
|---|---|
| Rows, All traders | Status bar shows **1,000,000**. |
| Deep scroll to the middle of the scrollbar (about row 500,000) | Blocks 499,900 to 500,100 requested and rendered, rows ALG00500012 down to ALG00499989 (descending by `createdAt`, so the ids match the position). No loading rows left behind. |
| Sort | Account asc and Order ID asc: first row `ALG00000001`; request shape above. Sorting also works after switching to msgpack. |
| Set filter | Status = LIVE gives **400** rows; list is CANCELLED, FILLED, LIVE, PENDING_START (from `setFilterValues`). |
| Number filter | notionalUsd between 5M and 10M plus LIVE gives **116** rows. |
| Date filter | createdAt between 2026-10-01 and 2026-10-06 gives 116; September gives 0. |
| Group by Pair, drill in | 20 groups, each labelled with its count (AUDJPY (23496) and so on) and with aggregates (sum, `wavg` as % Complete 96.18); expanding EURUSD (250,546) loaded 100-row leaf blocks with pair-correct price decimals (5 for EURUSD). |
| Group column sort | Desc puts USDZAR first. |
| Trader switch | T3 (flat) gives **199,302** rows; back to All gives 1,000,000. Grouped view re-queried per trader (USDZAR 4,576 for T3). |
| Codec switch | Dev menu, MessagePack: status bar shows `msgpack`; rows, sort and filters keep working with no errors and RTT still reports. |
| Server not ready | `docker restart` of antikythera, then reload: overlay went "Connecting to server" then "Loading orders" and the grid filled in on its own after about 10 s, no toast. |
| Server restart with the page open | Status bar went "Reconnecting (#1)" then "Connected"; a sort afterwards loaded normally. |
| Prices and nulls | JPY pairs show 3 decimals (134.447), SEK/NOK 4, others 5; null limit and fill prices show empty. |

Screenshots in `docs/screenshots/phase-4/`:
- `01-flat.png` flat view (1,000,000 rows, status bar, trader selector, Dev button)
- `02-grouped.png` grouped by Pair with EURUSD expanded and aggregates
- `03-filtered.png` set filter plus number filter (116 rows)
- `04-dev-menu-status-bar.png` Dev menu with MessagePack selected, trader T3 (199,302 rows), status bar

## Console errors

Apart from the AG Grid Enterprise licence banner (7 `console.error` lines per page load, "License Key Not Found", expected with no key), there were **no console errors or warnings** over the whole session, including reconnects and codec switches. The log is `docs/screenshots/phase-4/console-log.txt` (56 error-level entries across 8 loads, all lines of the licence box). React DevTools info line aside, nothing else was logged.

## Raw verification output

```
$ pnpm lint && pnpm typecheck && pnpm test && pnpm build
 Tasks:    7 successful, 7 total   (lint)
 Tasks:    7 successful, 7 total   (typecheck)
 Tasks:    7 successful, 7 total   (test)
   @apeiron/pharos     Test Files 24 passed (24), Tests 148 passed (148)
   @apeiron/antikythera Test Files 21 passed (21)
   @apeiron/logos      Test Files  9 passed (9)
   @apeiron/mnemosyne  Test Files  4 passed (4)
   @apeiron/gaia       Test Files  5 passed (5)
 Tasks:    5 successful, 5 total   (build)
   dist/assets/worker-*.js   129 kB
   dist/assets/index-*.js    1,690 kB (gzip 479 kB)

$ docker compose --profile core ps
apeiron-antikythera-1  Up (healthy)
apeiron-mongo-1        mongo:9.0            Up (healthy)
apeiron-nats-1         nats:2.15-alpine     Up (healthy)
apeiron-pharos-1       local/apeiron/pharos:dev  Up (healthy)

$ docker exec apeiron-pharos-1 id
uid=101(nginx) gid=101(nginx) groups=101(nginx)

$ curl -sI http://127.0.0.1:8080/assets/index-*.js      # hashed asset
Cache-Control: public, max-age=31536000, immutable      (Content-Encoding: gzip when requested)
$ curl -sI http://127.0.0.1:8080/                        # entry point
Cache-Control: no-cache
$ curl -H 'Upgrade: websocket' ... http://127.0.0.1:8080/ws
HTTP 101 (switching protocols through nginx)
```

## Versions and exceptions

| Item | Version | Note |
|---|---|---|
| ag-grid-react / ag-grid-enterprise / ag-grid-community | 36.2.0 | latest |
| react / react-dom | 19.3.0 | latest |
| vite | 8.3.3 | latest |
| @vitejs/plugin-react | 6.1.2 | latest |
| zustand | 5.0.15 | latest |
| typescript | 6.0.3 | exception carried from CP-1: 7.x blocked because `typescript-eslint` 8.x peers `<6.1.0` |
| vitest | 5.0.3 | latest |
| jsdom / @testing-library/react / user-event / jest-dom | 30.1.2 / 16.3.3 / 14.6.7 / 7.0.1 | latest (small dev tooling) |
| eslint-plugin-react-hooks | 7.1.1 | latest (small dev tooling) |
| nginx image | `nginxinc/nginx-unprivileged:1.30-alpine` | latest stable minor; 1.31 is the mainline branch |

No version exceptions were added in this phase.

## Known weaknesses

- **Bundle size.** The main chunk is 1.69 MB (479 kB gzip), almost all AG Grid. The warning limit is raised to 2 MB. The worker is 129 kB because it imports the whole `@apeiron/logos` barrel (generator and zod come with it); a narrower export for the browser would shrink it.
- **Date filter time zones.** Datetimes display in local time but the server filters on UTC days (CP-2 decision), so near midnight a non-UTC user can see a row on a different day than the filter treats it as. `valueDate` is shown in UTC to avoid this.
- **Root row count with grouping.** The status bar "Rows" is the root level count: the number of groups when grouped (20 for Pair), the filtered row count when flat.
- **Failed `hello` race.** If the link drops after the user picks a trader but before `welcome`, the worker has already adopted the new trader for the reconnect hello while the UI keeps the old one until the next change. The window is small and the next selection resyncs.
- **No overlay on `fail()`.** Non-retryable errors show a toast and AG Grid's failed-block state; there is no "retry" button yet (`retryServerSideLoads` is available).
- **Datasource retries are unbounded** for `NOT_READY` and `DISCONNECTED` by design (the grid just keeps loading); abandoned requests stop when the grid replaces the datasource.
- **No live updates**: `applyDelta` is a no-op until phase 5, and the status bar CPU and RSS show a dash until `summary` messages exist.
- **Grid in jsdom is not exercised**: component tests mock `ag-grid-react` and check the configuration and wiring; real grid behaviour was verified in the browser only (and phase 8 adds Playwright E2E).
