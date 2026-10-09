# Demo screenshots (2026-10-09)

Captured for the phase 10 demo pack at 1600×900 against the local stack (1M rows, Medium preset unless noted), with
Playwright and a CDP session (headless Chromium 141). Method, environment and the measurements taken alongside them:
[`../../checkpoints/PHASE-10.md`](../../checkpoints/PHASE-10.md).

| File | Shows |
|---|---|
| `01-hero-default-view.png` | default view: newest first, summary chips, status bar (1,000,586 rows, tick-to-screen p50/p95 22/63 ms) |
| `02-deep-scroll-row-300k.png` | after a fast scripted scroll to row ~300,000 |
| `03-anchor-new-orders-badge.png` | anchored at row ~300,268: the same order held at the top for 15 s, badge "109 new orders ↑" |
| `04-grouped-by-pair-aggregates.png` | grouped by Pair, AUDJPY (23,520) drilled open |
| `04b-grouped-aggregate-columns.png` | the same, scrolled to the aggregate columns (sum quantities and notional, weighted % complete) |
| `04c-grouped-two-levels-status-pair.png` | two levels: Status, then Pair, LIVE drilled open |
| `05-filtered-set-number-date.png` | set (Pair = EURUSD), number (Notional USD > 10M) and date (Value Date = 2026-11-09) filters: 43 rows |
| `06-context-menu-actions.png` | right-click on a LIVE order: Cancel / Pause / Resume |
| `06b-order-paused.png` | the order paused (isolated by an Order ID filter) |
| `06c-cancel-confirm-submenu.png` | Cancel's confirmation submenu |
| `07-dev-menu-msgpack.png` | after switching the codec to MessagePack from the Dev menu |
| `07b-dev-menu-open.png` | the Dev menu: wire codec and load preset |
| `08-stress-status-bar.png` | Stress preset: STRESS pill, ~3,800 LIVE, ~4,000 rows updated/s |
| `08b-stress-status-bar-closeup.png` | the status bar alone, under Stress |
| `09-live-prices-ticking.png` | LIVE orders: price cells coloured up (green) and down (red) as they tick |
| `grafana-talos-50-clients-medium.png` | Grafana "Apeiron: Blotter Server" during the fresh 50-client talos run, Medium phase |
| `grafana-talos-50-clients-stress.png` | the same run in the stress window (3,220 LIVE, 2,060 order events/s) |

Earlier screenshots from the phases are in `../phase-4` to `../phase-7`.
