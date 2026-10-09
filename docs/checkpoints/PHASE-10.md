# Phase 10: fresh evidence for the demo pack (2026-10-09)

Raw records of the runs made for [`TECHNICAL-OVERVIEW.md`](../TECHNICAL-OVERVIEW.md) §9.4, the
[`USER-GUIDE.md`](../USER-GUIDE.md) and the deck. Every fresh number in those documents comes from this file.

## Environment (read this before comparing numbers)

These runs were **not** on the laptop the CP-2 to CP-6 numbers came from. They ran in a cloud container:

| | This run | CP-4 reference runs |
|---|---|---|
| Host | KVM guest, 4 vCPU Intel Xeon @ 2.80 GHz, 1 thread per core, 15.7 GiB RAM, no GPU | Apple silicon laptop, Docker Desktop VM with 6 GB |
| Docker | Engine 29.8.2 directly on the host (no VM limit) | Docker Desktop VM |
| Load generator | talos on the same 4 vCPUs as the whole stack | talos on the host, stack in the VM |
| Browser | Chromium 141 (Playwright-driven, headless, software rendering, 60 Hz) | Chrome with DevTools, 120 Hz display, GPU |

How the stack was brought up here (no repo change):

- Containers in this session could not reach npm until the session's proxy CA was trusted, so the images were built from a
  local base image `node:24ca-slim` (`node:24-slim` plus the CA via `NODE_EXTRA_CA_CERTS`), selected with
  `docker compose build --build-arg NODE_VERSION=24ca`. The Dockerfiles and compose file were not changed.
- The **chrome-devtools MCP tools were not available** in this session. The browser pass used Playwright with a CDP
  session instead: `requestAnimationFrame` frame timings for FPS, a `longtask` `PerformanceObserver`, and
  `Performance.getMetrics` (plus `HeapProfiler.collectGarbage`) for the JS heap.
- Playwright 1.63 expects Chromium build 1243; the pre-installed build is 1194 (Chromium 141), linked in its place.
- **The resilience tier was not re-run.** Its Toxiproxy image (`ghcr.io/shopify/toxiproxy:2.12.0`) could not be
  downloaded: the session's network policy refused the GHCR blob host (403), and Docker Hub rate-limited the
  `pharos-e2e` base image lookup (429). The resilience results in the docs are the final ones recorded on the merged
  code in [`CP-6.md`](CP-6.md) and [`TESTING.md`](../TESTING.md).

## 1. State before the runs

`scripts/loadtest-reset.sh` then `docker compose --profile core --profile monitoring up -d`:

```
{"status":"ok","rows":1000429,"loadMs":48723,"heapMb":249.9,"rssMb":647.3,"live":{"attached":true,"clients":0,"liveRows":552,"pendingEvents":0}}
```

The store load took 44.8 to 51.4 s across the four resets in this session, against 9.4 to 9.5 s on the laptop
([`CP-2.md`](CP-2.md), "F4b before and after").

## 2. `pnpm e2e`: 18 of 18 passed (1.9 min)

```
  ✓   1 [chromium] › tests/actions.e2e.ts:31:3 › order actions › Pause and Resume round trip (7.6s)
  ✓   2 [chromium] › tests/actions.e2e.ts:48:3 › order actions › Cancel asks for confirmation and then cancels (6.3s)
  ✓   3 [chromium] › tests/actions.e2e.ts:80:3 › order actions › a finished order offers no actions (4.0s)
  ✓   4 [chromium] › tests/dev-menu.e2e.ts:12:3 › dev menu › switches the wire codec to msgpack and back, and live updates keep flowing (2.8s)
  ✓   5 [chromium] › tests/dev-menu.e2e.ts:36:3 › dev menu › the stress preset shows a STRESS pill and Medium takes it away (8.9s)
  ✓   6 [chromium] › tests/grid.e2e.ts:6:3 › grid › loads with the row count, the summary and the column headers (6.7s)
  ✓   7 [chromium] › tests/grid.e2e.ts:33:3 › grid › sorts numbers and text, ascending and descending (6.6s)
  ✓   8 [chromium] › tests/grid.e2e.ts:51:3 › grid › clicking a header cycles ascending, descending, then back to unsorted (7.6s)
  ✓   9 [chromium] › tests/grid.e2e.ts:67:3 › grid › set filter keeps only the chosen value and shrinks the row count (3.5s)
  ✓  10 [chromium] › tests/grid.e2e.ts:85:3 › grid › number filter: greater than a threshold (4.8s)
  ✓  11 [chromium] › tests/grid.e2e.ts:103:3 › grid › date filter: equals the value date of the first row (3.6s)
  ✓  12 [chromium] › tests/grid.e2e.ts:120:3 › grid › switching trader narrows the grid to that trader and back again (3.0s)
  ✓  13 [chromium] › tests/grouping.e2e.ts:8:3 › grouping › group by pair, aggregate, and drill down into a group (7.0s)
  ✓  14 [chromium] › tests/grouping.e2e.ts:53:3 › grouping › group rows offer no order actions; their orders do (4.0s)
  ✓  15 [chromium] › tests/live.e2e.ts:5:3 › live updates › a LIVE row ticks: its price cells flash and change value (6.4s)
  ✓  16 [chromium] › tests/live.e2e.ts:29:3 › live updates › a new order arrives at the top of the default view (1.9s)
  ✓  17 [chromium] › tests/live.e2e.ts:44:3 › live updates › scrolled down: the same orders stay in place while the badge counts new ones (9.4s)
  ✓  18 [chromium] › tests/live.e2e.ts:70:3 › live updates › anchoring also holds under a non-default sort (the storeRefreshed path) (18.1s)
  18 passed (1.9m)
```

## 3. talos: 50 clients, 300 s, both codecs (25 each)

`pnpm --filter @apeiron/talos start -- --clients 50 --duration 300 --codec both`, after `scripts/loadtest-reset.sh`.
Codec-switch event lines are left out. Result files `loadtest/results/20261009-043303-both.{json,md}` are gitignored.

```

running 50 clients for 300s
talos: 50 clients, 300s, codec both, seed 1, 2026-10-09T04:33:03.914Z
server at start: 1000451 rows, 550 LIVE

Latency, json (25 clients), ms
                                                   p50     p95     p99     max      n
getRows warm                                       9.1   260.4   442.2  1584.1  14643
getRows cold (view change, after 10 s)            43.0   352.5   671.1   733.3    167
tick-to-screen (srcTs to receipt)                 56.0   420.0   643.0  1925.5  38549
  last hop (serverTs to receipt)                  15.5   153.0   251.0   415.5  38549
getRows startup burst (first view, all at once)  480.0  1723.0  1797.0  1797.0     25
command ack                                       61.4   772.7   964.2  1110.1    457

Tick-to-screen by phase, json, ms
            p50    p95     p99     max      n
baseline   43.0  103.0   202.0  1925.5  17832
stress    349.5  692.0  1016.5  1261.0   4695
after      64.5  235.0   474.5   765.0  16022

Traffic per client, json
     msgs/s   KB/s
in      8.3  159.1
out     2.3    0.7
errors by code: {"INVALID_TRANSITION":181,"UNKNOWN_ORDER":2}

Latency, msgpack (25 clients), ms
                                                   p50     p95     p99     max      n
getRows warm                                       9.9   257.5   431.8  1472.2  14608
getRows cold (view change, after 10 s)            46.2   226.8   581.2   857.8    169
tick-to-screen (srcTs to receipt)                 57.0   401.5   626.0  1929.0  35120
  last hop (serverTs to receipt)                  15.0   145.0   249.0   427.5  35120
getRows startup burst (first view, all at once)  455.0  1604.0  1697.0  1697.0     24
command ack                                       60.5   843.3  1174.8  1809.2    403

Tick-to-screen by phase, msgpack, ms
            p50    p95    p99     max      n
baseline   42.5  103.0  193.5  1929.0  14061
stress    342.0  672.0  882.0  1243.0   3946
after      63.0  220.5  466.5   763.0  17113

Traffic per client, msgpack
     msgs/s   KB/s
in      8.0  134.0
out     2.2    0.5
errors by code: {"INVALID_TRANSITION":175,"SLOW_CONSUMER":1,"UNKNOWN_ORDER":1}

Server (/metrics every 2s, 147 scrapes, 0 failed)
                                     min  median     max
CPU % of one core                   27.6    65.3   215.4
RSS MB                               653    1301    1503
heap used MB                         253     314     694
event-loop lag p99 ms (1s windows)   2.0    63.4  1362.6
event-loop lag max ms (1s windows)   2.0    83.6  1362.6
event-loop lag over the whole run (server histogram): p50 0.3 ms, p99 193.3 ms, p99.9 441.7 ms, longest stall 1362.6 ms

Server-side histograms over the run
                                                                  value
getRows warm p95 ms                                                2.51
getRows cold p95 ms                                               87.56
getRows cold / warm count                                   384 / 29278
flush p50 / p99 ms                                        6.42 / 238.07
event age at flush p95 ms                                         265.1
event age at send p95 ms (server side of tick-to-screen)          426.7
delta size p95 bytes                                              59211
command p95 ms                                                    719.2
soft_conflate / slow_consumer events                             76 / 1

Targets
                                                         target                   measured  verdict
getRows p95 (warm, client-measured)                     < 50 ms  json 260.4, msgpack 257.5     FAIL
View change: cold getRows p95 (after the first 10 s)   < 300 ms  json 352.5, msgpack 226.8     FAIL
Tick-to-screen p95 (source event to receipt)           < 150 ms  json 420.0, msgpack 401.5     FAIL
Event-loop lag p99 (server, whole run)                  < 50 ms                  all 193.3     FAIL
Server RSS max                                        < 2048 MB                 all 1502.8     PASS

Events (seconds into the run)
      0.1s  preset.seen {"preset":"medium"}
     60.0s  slow.paused 
     60.8s  server.soft_conflate_first_seen {"note":"first /metrics scrape after the pause that shows deltas being held back"}
     76.8s  server.slow_consumer_first_seen {"note":"first /metrics scrape that shows the client closed with SLOW_CONSUMER"}
     77.0s  slow.server_closed_seen {"serverClosedIt":true,"fills":17}
     77.0s  slow.resumed {"pausedMs":17008}
     77.8s  slow.error_received 
     78.1s  slow.after_resume {"slowConsumerError":true,"closed":true,"closeCode":1013}
     78.1s  slow.reconnect {"ok":true,"ms":25}
    120.0s  stress.stress {"acked":true,"ackMs":2}
    120.5s  preset.seen {"preset":"stress"}
    180.0s  stress.medium {"acked":true,"ackMs":63}
    180.7s  preset.seen {"preset":"medium"}

generator: send lag p99 7.8 ms, max 97.5 ms; own event-loop lag p99 5.0 ms, max 100.0 ms; counters {"scrolls":29251,"viewChanges":330,"commandsSent":1219,"commandsSkipped":244,"unexpectedCloses":0,"connectFailures":0}

results: /home/user/apeiron/loadtest/results/20261009-043303-both.json
summary: /home/user/apeiron/loadtest/results/20261009-043303-both.md
```

**Verdict: four of five targets missed on this host** (RSS passed). The run did not collapse: no request timed out,
the slow consumer was cut off and reconnected, and the stress window was entered and left on time. The misses track the
host's speed (section 4): server CPU median 65% of a core here against 22 to 24% on the laptop, flush p99 238 ms
against 36 to 44 ms. The laptop runs in [`CP-4.md`](CP-4.md) §12 remain the reference results; a talos run on the
target host (AWS Graviton, paused) has not been made.

Grafana during this run: [`grafana-talos-50-clients-medium.png`](../screenshots/demo/grafana-talos-50-clients-medium.png)
(about 110 s in) and [`grafana-talos-50-clients-stress.png`](../screenshots/demo/grafana-talos-50-clients-stress.png)
(stress window, 3,220 LIVE orders, 2,060 order events/s).

## 4. Engine benchmark on this host

`pnpm --filter @apeiron/antikythera bench` (1M generator rows, in-process; the stack was running at Medium, hermes
stopped). Columns: hz, min, max, mean, p75, p99, p995, p999, rme, samples (ms).

```
     cold default view  9.2952  81.5079  245.70  116.55  121.73  235.41  240.55  244.67  ±20.14%       15
     cold selective filter + sort  25.0676  32.3796  181.77  46.2233  44.2615  157.13  169.45  179.30  ±30.08%       22
     cold multi-column sort  5.2175  123.49  306.29  207.44  234.78  304.35  305.32  306.10  ±15.38%       15
     cold one-level group  23.5398  25.2361  246.93  62.9641  45.1953  234.84  240.89  245.73  ±51.25%       16
     cold two-level group  21.3486  32.9747  80.2316  49.2904  53.7705  78.1912  79.2114  80.0275  ±11.07%       21
     cold setFilterValues  193.29  4.8251  9.4186  5.2030  5.2426  6.8037  6.9772  8.9303  ±1.25%      193
     warm block fetch (100 rows, scrolling)  1,556.81  0.4811  4.6398  0.6823  0.6648  2.0258  2.2266  4.0347  ±1.78%     2000
     warm one-level group block  51,662.76  0.0156  3.4511  0.0221  0.0249  0.0691  0.0786  0.1707  ±1.25%    45328
     warm two-level group block  113,844.92  0.0070  60.8546  0.0111  0.0102  0.0419  0.0541  0.1379  ±12.08%    90225
     warm selective filter + sort block  1,029.68  0.8105  6.4773  1.0100  0.9945  2.6372  2.8877  3.9494  ±1.36%     2000
     warm setFilterValues  2,405,685.86  0.0004  2.0819  0.0005  0.0004  0.0009  0.0011  0.0074  ±0.90%  2117707
```

| Operation (mean) | This host | CP-2 laptop | Ratio |
|---|---|---|---|
| Cold default view | 116.6 ms | 24.5 ms | 4.8× |
| Cold selective filter + sort | 46.2 ms | 11.7 ms | 3.9× |
| Cold three-column sort | 207.4 ms | 29.6 ms | 7.0× |
| Cold one-level group | 63.0 ms | 11.1 ms | 5.7× |
| Warm block fetch (100 rows) | 0.68 ms | 0.109 ms | 6.3× |

## 5. Browser pass (Playwright + CDP, 1600×900)

Screenshots in [`docs/screenshots/demo/`](../screenshots/demo). Steps: flat view; scripted deep scroll (40 steps in about
2 s to 30% of the table); anchoring for 15 s; grouping by pair with aggregates; set (pair = EURUSD), number
(notional > 10M) and date (value date = first row's) filters; Pause/Resume on an isolated LIVE order (10 timed actions)
and the Cancel confirmation; the Dev menu codec switch both ways; the Stress preset with the STRESS pill; console and heap.

```json
{
  "load": {
    "msToReady": 2639,
    "rows": 1000540
  },
  "flatIdle": {
    "fps": 60,
    "p95FrameMs": 16.8,
    "maxFrameMs": 16.8,
    "frames": 301,
    "heap": {
      "usedMb": 25.6,
      "totalMb": 51.9
    },
    "statusBar": "Connected Codec json Rows 1,000,586 RTT 14 ms FPS 60 Tick-to-screen p50/p95 22 / 63 ms Deltas 10.0/s Rows upd 384/s In 12.0 msg/s Out 0.0 msg/s Server CPU 5.5% Server RSS 794 MB Server lag 1.7 ms",
    "summary": "LIVE585 PENDING_START284 PAUSED0 FILLED920,070 CANCELLED79,647 Live notional $5.03bn"
  },
  "deepScroll": {
    "fps": 31.6,
    "p95FrameMs": 83.4,
    "maxFrameMs": 166.7,
    "frames": 142,
    "longTasks": 10,
    "longestTaskMs": 111,
    "top": {
      "rowId": "ALG00700432",
      "index": 300187,
      "offset": 1
    }
  },
  "anchor": {
    "before": {
      "rowId": "ALG00700432",
      "index": 300193,
      "offset": 0
    },
    "after": {
      "rowId": "ALG00700432",
      "index": 300268,
      "offset": 0
    },
    "sameOrderAtTop": true,
    "badgeBefore": "34 new orders \u2191",
    "badgeAfter": "109 new orders \u2191",
    "afterBadgeClick": {
      "top": {
        "rowId": "ALG01000710",
        "index": 0,
        "offset": 0
      },
      "badge": ""
    }
  },
  "grouped": {
    "groups": "20",
    "rows": "1,000,888",
    "firstGroup": "AUDJPY (23,520) 214,115,800,000 205,898,057,000 96.16 148,354,264,753.97 142,661,172,000.89",
    "fps": 60,
    "p95FrameMs": 16.7,
    "maxFrameMs": 16.8,
    "frames": 180
  },
  "filters": {
    "all": 1000923,
    "afterSetEURUSD": 250782,
    "afterNotionalGt10M": 76410,
    "valueDate": "2026-11-09",
    "afterValueDate": 43
  },
  "actions": {
    "orderId": "ALG01001304",
    "clickToStatusOnScreenMs": [
      63,
      78,
      80,
      81,
      84,
      87,
      89,
      97,
      101,
      118
    ],
    "p50": 87,
    "max": 118
  },
  "devMenu": {
    "msgpackBar": "Connected STRESS Codec msgpack Rows 1,010,714 RTT 3 ms FPS 56 Tick-to-screen p50/p95 58 / 195 ms Deltas 11.0/s Rows upd 569/s In 13.0 msg/s Out 0.0 msg/s Server CPU 26.8% Server RSS 1,359 MB Server lag 27.2 ms",
    "jsonBar": "Connected STRESS Codec json Rows 1,010,879 RTT 3 ms FPS 58 Tick-to-screen p50/p95 58 / 164 ms Deltas 11.0/s Rows upd 516/s In 12.0 msg/s Out 1.0 msg/s Server CPU 23.0% Server RSS 1,363 MB Server lag 21.6 ms"
  },
  "stress": {
    "idle": {
      "fps": 37.4,
      "p95FrameMs": 83.3,
      "maxFrameMs": 133.3,
      "frames": 188
    },
    "scroll": {
      "fps": 5.5,
      "p95FrameMs": 299.9,
      "maxFrameMs": 316.6,
      "frames": 25,
      "longTasks": 369,
      "longestTaskMs": 278
    },
    "statusBar": "Connected STRESS Codec json Rows 1,012,103 RTT 2 ms FPS 39 Tick-to-screen p50/p95 92 / 180 ms Deltas 13.0/s Rows upd 4,020/s In 15.0 msg/s Out 0.0 msg/s Server CPU 38.9% Server RSS 1,345 MB Server lag 23.1 ms",
    "heap": {
      "usedMb": 101.7,
      "totalMb": 151.8
    },
    "heapAfterGc": {
      "usedMb": 25.3,
      "totalMb": 26.5
    }
  },
  "backToMedium": true,
  "ticking": {
    "cellsColoured": 101
  }
}
```

Notes:

- **Console:** only the AG Grid Enterprise licence banner (7 lines per page load); no other error or warning.
- **Anchoring:** the same order (`ALG00700432`) stayed at the top of the viewport for 15 s while 75 orders arrived above
  it (row index 300,193 → 300,268); the badge went from 34 to 109; clicking it returned to row 0 and cleared it.
- **Actions:** click to status on screen, 10 samples: p50 87 ms, max 118 ms (phase 6 on the laptop: p50 58 ms, p95 89 ms).
- **FPS** is capped at 60 here (headless, 60 Hz) and rendering is software-only: 60 FPS idle and grouped, 31.6 FPS during the
  deep scroll (10 long tasks, longest 111 ms), 37 FPS idle under Stress and 5.5 FPS while scrolling under Stress (about 4,000
  rows updated/s). The laptop figures in [`CP-3-review.md`](CP-3-review.md) (103 to 120 FPS) remain the reference.
- **JS heap:** 25.6 MB on Medium; 101.7 MB used under Stress before a GC and 25.3 MB after it (laptop: 27 MB and 48 MB).
- The Stress status line in the Dev-menu step already shows STRESS because an earlier, aborted attempt of the actions step
  had switched it on; every attempt ended with the preset back on Medium.
