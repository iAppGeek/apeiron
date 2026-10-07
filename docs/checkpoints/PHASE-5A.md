# Phase 5a: live server (hermes, ingest, incremental views, deltas)

Branch `phase-5a-live-server`, PR "Phase 5a: live server". Server side only: pharos is unchanged (phase 5b applies the deltas,
adds the flash, anchoring and badge). Not merged.

## What was built

**`@apeiron/logos`**
- `lifecycle.ts`: pure `applyFill` (absolute post-fill fields, VWAP `avgFillPrice`, clamps to what remains, completes the order),
  `transition` (the Appendix E state machine, `INVALID_TRANSITION` otherwise, terminal transitions set `completedAt` and move open P&L to
  realised), `derivePriceFields` (market bid/ask/mid, spread, distance to limit, slippage, unrealised P&L for LIVE/PAUSED, `lastUpdateTime`),
  with the sign conventions of Appendix D.
- `events.ts`: `PriceTick`, `OrderEvent` (`NEW` | `UPDATE` | `REJECT`), `LoadControl`, `OrderCommand`, zod schemas and parsers, subject/stream/consumer names.
- `bus.ts` + `memory-bus.ts`: the small `Bus` abstraction (publish, subscribe, durable consume) and an in-process `MemoryBus` for tests.
- `generator.ts` now exports `OrderFactory`, `formatOrderId` and `parseOrderSeq`, so hermes builds new orders with the generator's own distributions.

**`@apeiron/mnemosyne`**: `loadCurrent()` (uses the `{status}` index) and `maxOrderId()` (`_id` sort) in the interface, Mongo adapter, in-memory fake and contract suite.

**`@apeiron/iris` (new)**: the NATS adapter. `streamSpecs`/`ensureStreams` (idempotent, updates config that differs), `ensureConsumer`, and `NatsBus`
(nats.js v3: `@nats-io/transport-node` + `@nats-io/jetstream`, APIs checked with context7).

**`@apeiron/hermes`**: price feed (20 pairs, random walk scaled from `dailyVol`, G10/EM spreads, rounded to pair decimals, 3 ticks/s per pair),
lifecycle simulator (fills via `applyFill` at mid plus slippage, PENDING_START to LIVE at `startTime`, end-of-life fill or cancel, occasional expiry cancel,
new orders 80% LIVE / 20% PENDING_START inside the LIVE band), startup reconciliation, starting mids from the DB, ids continuing from `maxOrderId()`,
`LOAD_PRESET` plus live switching on `control.load`, zod config, JSON logs, graceful shutdown, `/health` on :4100, compose service with healthcheck.
Hermes owns stream creation.

**`@apeiron/antikythera`**
- Store: `updateRow`, `upsert`, `orderAt`; no global version (a `layoutVersion` only changes when typed arrays are reallocated); dictionary growth tracked per column;
  `onAscendingBroken` warning; string ranks as in Appendix D item 3 (see deviations).
- `ChangeSet` (changed fields plus `prev`), `RowBuf` (growable row-index array with `copyWithin` removal/insertion), and a rewritten `View` that is patched per tick:
  structural vs value-only vs aggregate classification by 50-bit field masks, root membership, nested group buckets created/removed with counts and
  aggregates adjusted from `prev` (`wavg` as sum of w*x and sum of w, `count` = rows), group order re-sorted when needed, sorted leaf indexes patched by binary
  search (old keys for removal through a `prevOf` comparator, new keys for insertion), a rebuild above 5,000 structural changes, and a safety net that rebuilds a
  view (and counts it) if a patch ever disagrees with the store.
- `live/`: `LiveStore` (queue, event upsert, price join with `liveByPair`, status counters, write-behind batches), `WriteBehind`, `ClientTracker` (LRU of tracked
  blocks, `updates`/`groupUpdates`/`adds`/`dirtyRoutes`/`rowCounts`/`newAbove`, accumulation for held-back clients), `BackpressureGate`, `SystemStats`, `LiveRuntime` (flush loop,
  rank refresh, idle view sweep, bus attach with retry).
- Session: `control` publishes `control.load` and acks; deltas and a 1s `summary` (byStatus and liveNotionalUsd scoped to the trader, `totalRows` = leaf rows of the client's
  current view, server cpu/rssMb/elLagMs); `SLOW_CONSUMER`. `command` stays `NOT_IMPLEMENTED` (phase 6).
- The server consumes the stream only after the store has loaded.

## Deviations (and why)

1. **New package `@apeiron/iris`.** The NATS code is needed by both hermes and antikythera and cannot live in `logos` (the browser imports it). Appendix A names the same libraries.
2. **Ack after persist.** Durable consumer `blotter-server` uses `AckPolicy.All`; the ack for a batch is sent only after write-behind has written it, so a crash replays exactly the unpersisted events (idempotent).
   On attach the consumer is reset (`jsm.consumers.reset`, server 2.14+) because messages delivered-but-unacked before a crash would otherwise wait out `ack_wait` (30s) before redelivery.
3. **Stream limits.** ORDERS adds `max_bytes` 1 GiB on top of the 24h age limit (stress produces about 1 MB/s); PRICES uses memory storage.
4. **String ranks (Appendix D item 3).** Stale marking, comparator path while stale, and a background refresh at most every 30s are implemented, but the refresh merges only the new
   values into the sorted distinct list instead of re-sorting a million strings (which would stall the loop), and a sort over ranks that lag by up to 50,000 rows radix-sorts the
   covered rows, comparator-sorts the newer ones and merges, so a string sort stays fast under live appends instead of falling back to the 800ms comparator path.
5. **Dictionary growth (item 5)** invalidates no view: existing values keep their relative order, so views are patched; only compiled set-filter predicates are recompiled for views that filter on the grown column.
6. **`updates` also covers structurally changed tracked rows.** The appendix says value-only; sending the changed fields for every tracked row as well keeps cells ticking until the throttled refresh reorders them (those routes are also in `dirtyRoutes`).
7. **`newAbove`** = rows inserted into an ungrouped root route at a position above the start row of the client's last root block request. Group routes do not use it.
8. **`adds` rows join the tracked top block** (capped at 500 rows) so later changes to them are sent as updates. Clients must apply `adds` before `updates` within a delta.
9. **Views with subscribers are never evicted**; untracked views idle for 60s are swept (Appendix D), on top of the existing count and byte caps.
10. **Hermes fill pacing.** The plan's fill size `orderQty / (durationMins * 6)` cannot sustain 2,000 updates/s over a bounded LIVE population (it drained to about 150 LIVE rows). Fills are `orderQty / fillsPerOrder` (32 medium, 64 stress, about
    `updatesPerSec / (0.8 * newOrdersPerSec)`), new orders live 1 to 2 minutes (arrivals x lifetime is about 450 LIVE on medium and 4,500 on stress), PENDING_START orders start 10s to 2 min ahead (the seeded ones keep 1 to 120 min). Stress target/min/cap are 3,000/2,000/5,000.
11. **Price walk** is 5x the volatility a literal per-tick scaling of `dailyVol` gives (so moves are visible) with weak mean reversion to the start level.
12. `/debug/lag` (flush, lag, write-behind figures; `?reset=1`) added for the live verification; phase 7's `/metrics` supersedes it.
13. Compose: `antikythera` now also depends on `nats` being healthy.

## Property test design (the most important test)

`apps/antikythera/src/query/view.incremental.property.spec.ts`. A 1,200-row store of mutated generator data, 26 cached views (5 fixed shapes and 21 from the seeded random request generator: flat
and 1-3 level grouped, many sorts including string sorts, set/text/number/date filters, trader scopes, aggregates sum/avg/wavg/count) and, for grouped views, up to three nested routes each materialised so group
states and leaves exist. Each of 45 ticks per seed (4 seeds, plus a fifth with the rebuild threshold forced to 4) applies a random ChangeSet through the same store API the flush uses:
value-only updates, sort-key changes (numbers, nulls, enums, strings), filter-membership flips (status, side, venue, trader), group-key changes (venue, status, algo, valueDate including null), appends of new
rows, new dictionary values (new venues, statuses, traders), two updates to one row in a tick, occasional 150-row ticks, and a string-rank refresh now and then. After every tick every probe (about 90 routes) is compared with a fresh `QueryEngine` on the same store: row counts, leaf rows
exactly, group keys, `childCount` and order exactly, aggregates within `1e-6 + 1e-9 * |x|`. The test also asserts no view needed the fallback rebuild. I checked the test has teeth by mutating the implementation three ways
(wrong sign when adjusting an aggregate, ignoring sort-key moves, not recompiling predicates): each made every seed fail.

## Verification

Commands: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green locally (logos 131 tests, mnemosyne 35, iris 9 plus 2 integration tests that need `NATS_URL` and passed against the compose NATS,
hermes 43, antikythera 36 files and over 350 tests, gaia 25, pharos 159).

### Live figures (full `core` stack incl. hermes, one client, this laptop under Docker)

| Check | Result |
|---|---|
| LIVE row price ticks, medium preset | **2.75/s median per LIVE row** (p10 2.6; hermes ticks 3/s per pair on a 100ms grid, the flush is 100ms) |
| New orders as `adds` | **5.0/s, every one `addIndex: 0`**, `rowCounts` for the root route in the same delta |
| Delta latency (`serverTs` to receipt) | p50 3ms, p99 6ms (medium); p50 4ms, p99 15ms (stress) |
| Grouped view | `groupUpdates` about 9.7 messages/s, `rowCounts` for the tracked LIVE leaf route, `dirtyRoutes` for orders leaving it |
| Stress preset event-loop lag, one client | **p99 9.9ms, max 18ms** over 30s (target < 50ms); per-second p99 max 12.5ms |
| Stress CPU / RSS | CPU median 8.3% (max 33%) of one core; RSS median 853MB, max 961MB |
| Stress flush | 4,193 flushes, mean 1.06ms, max 13.8ms, 1.1M row changes applied, 1.09M price recomputes, 0 unknown orders |
| Stress population | LIVE about 4,000 (cap 5,000), about 2,000 events/s in, 50 new orders/s out as `adds` |
| Write-behind latency (delta seen to row in Mongo) | p50 348ms, p95 449ms, max 450ms over 25 filled orders (interval 500ms) |
| antikythera `docker compose restart` (SIGTERM, hermes publishing) | healthy again in about 10s, replayed 1,457 events, 65 appended, 0 unknown orders, no warnings |
| antikythera SIGKILL, down 5 minutes while hermes kept publishing | caught up 37,126 events, 1,683 rows appended, 0 unknown orders; **server and Mongo identical on 487 compared rows, row counts equal (1,014,590)** |
| hermes restart | reconciled 51 stale LIVE orders (54 status changes), topped LIVE back up to 500 with 172 new ones, ids continued at ALG01014591, 273 new ids strictly ascending and contiguous, no ascending-order warning |

Note on the stress "ticks per row" figure in the raw output (0.83/s): at 50 new orders/s the rows in the first block are replaced within a couple of seconds and rows that were in the initial block stop being tracked once 500 added rows
have joined it, so a per-row rate over the initial block under-reads; the medium run (2.75/s) is the rate that matters. The stress run shows the throughput instead: about 1,170 row updates/s and 50 adds/s to one client.

Patch cost, `live-bench.ts` (1M-row store, 8 cached views including a ticking sort key, a string sort, two group views with aggregates):

```
LIVE rows: 400, statuses: 5
per tick: 895 price-style row updates + 5 new orders against 8 cached views
applyChanges ms: p50 2.59 p95 6.63 max 31.77
store writes ms (incl. price maths): p50 0.80 max 1.88
view memory: 34 MB, fallback rebuilds: 0
LIVE rows: 4991, statuses: 5
per tick: 5000 price-style row updates + 5 new orders against 8 cached views
applyChanges ms: p50 17.66 p95 20.62 max 118.53
store writes ms (incl. price maths): p50 11.70 max 20.43
view memory: 34 MB, fallback rebuilds: 0
```

With 5,000 LIVE rows all repricing in one tick (worst case: every pair ticks in the same flush) the 5,005 structural changes exceed the 5,000 threshold, so the two views sorted by a ticking column rebuild (the 118ms max). A real stress flush carries about 30% of
the pairs, around 1,300 changed rows. The Appendix F fallbacks were not needed at the measured figures.

### Raw output

default view, medium preset:
```json
{
  "scenario": "default",
  "seconds": 20,
  "trackedLiveRows": 79,
  "deltas": 190,
  "deltasPerSec": 9.5,
  "avgDeltaBytes": 7968,
  "rowUpdatesPerSec": 385.76,
  "liveRowTicksPerSecMedian": 2.75,
  "liveRowTicksPerSecP10": 2.6,
  "adds": 100,
  "addsPerSec": 5,
  "allAddsAtIndexZero": true,
  "newAboveTotal": 0,
  "dirtyRoutes": 0,
  "deltaLatencyMs": {
    "p50": 2,
    "p99": 5
  },
  "summary": {
    "t": "summary",
    "byStatus": {
      "PENDING_START": 54,
      "LIVE": 426,
      "PAUSED": 0,
      "FILLED": 934220,
      "CANCELLED": 81791
    },
    "liveNotionalUsd": 3902652376.440006,
    "totalRows": 1016491,
    "server": {
      "cpu": 2.9,
      "rssMb": 801,
      "elLagMs": 4.8
    }
  }
}
```

grouped view:
```json
{
  "scenario": "grouped",
  "seconds": 20,
  "rootGroups": 4,
  "groupUpdateMessages": 193,
  "groupUpdatesPerSec": 9.65,
  "groupUpdateRowsPerSec": 15.55,
  "sampleGroupUpdate": {
    "status": "LIVE",
    "childCount": 428,
    "notionalUsd": 3881305484.290001,
    "slippageBps": 0.4942883675153361,
    "unrealisedPnlUsd": -126988.74000000008
  },
  "rowCountMessages": 127,
  "rowCountRoutes": [
    "[\"LIVE\"]"
  ],
  "dirtyRoutes": 91,
  "childRowUpdatesPerSec": 438.05,
  "childAdds": 82
}
```

write-behind:
```json
{
  "scenario": "writebehind",
  "samples": 26,
  "latencyMs": {
    "p50": 348,
    "p95": 449,
    "max": 450
  },
  "notPersistedWithin5s": 0,
  "sample": [
    {
      "orderId": "ALG01016594",
      "filledQty": 123000,
      "status": "",
      "latencyMs": 124,
      "viaDelta": 0
    },
    {
      "orderId": "ALG01016549",
      "filledQty": 2462000,
      "status": "",
      "latencyMs": 124,
      "viaDelta": 0
    },
    {
      "orderId": "ALG01016543",
      "filledQty": 536000,
      "status": "",
      "latencyMs": 125,
      "viaDelta": 0
    },
    {
      "orderId": "ALG01016524",
      "filledQty": 1360000,
      "status": "",
      "latencyMs": 126,
      "viaDelta": 0
    },
    {
      "orderId": "ALG01016523",
      "filledQty": 4021000,
      "status": "",
      "latencyMs": 126,
      "viaDelta": 0
    }
  ]
}
```

stress preset (control message, 8s warm-up, 30s measurement):
```json
{
  "scenario": "stress",
  "preset": "stress",
  "lagCumulative": {
    "p50": 1.6,
    "p99": 9.9,
    "max": 18,
    "samples": 3279
  },
  "perSecondLagP99": {
    "p50": 6.9,
    "p99": 12.5,
    "max": 12.5
  },
  "cpuPercent": {
    "median": 8.3,
    "max": 33.4
  },
  "rssMb": {
    "median": 853,
    "max": 961
  },
  "flush": {
    "flushes": 4193,
    "lastMs": 13.753374999971129,
    "maxMs": 13.753374999971129,
    "totalMs": 4447.626304999376,
    "lastChanges": 4279,
    "totalChanges": 1098923,
    "lastViews": 2,
    "avgMs": 1.060726521583443
  },
  "writeBehind": {
    "passes": 798,
    "ordersWritten": 126887,
    "failures": 0,
    "lastMs": 30.432501000002958
  },
  "liveStats": {
    "eventsApplied": 176955,
    "ticksApplied": 24360,
    "priceRecomputes": 1093404,
    "unknownOrders": 0,
    "rowsAppended": 8668
  },
  "defaultView": {
    "seconds": 30,
    "trackedLiveRows": 75,
    "deltas": 292,
    "deltasPerSec": 9.73,
    "avgDeltaBytes": 28630,
    "rowUpdatesPerSec": 1167.62,
    "liveRowTicksPerSecMedian": 0.83,
    "liveRowTicksPerSecP10": 0.73,
    "adds": 1494,
    "addsPerSec": 49.8,
    "allAddsAtIndexZero": true,
    "newAboveTotal": 0,
    "dirtyRoutes": 0,
    "deltaLatencyMs": {
      "p50": 4,
      "p99": 15
    },
    "summary": {
      "t": "summary",
      "byStatus": {
        "PENDING_START": 360,
        "LIVE": 3995,
        "PAUSED": 0,
        "FILLED": 934486,
        "CANCELLED": 82209
      },
      "liveNotionalUsd": 34582057615.65006,
      "totalRows": 1021050,
      "server": {
        "cpu": 7.7,
        "rssMb": 888,
        "elLagMs": 8.6
      }
    }
  },
  "groupedView": {
    "seconds": 10,
    "rootGroups": 4,
    "groupUpdateMessages": 98,
    "groupUpdatesPerSec": 9.8,
    "groupUpdateRowsPerSec": 27,
    "sampleGroupUpdate": {
      "status": "LIVE",
      "childCount": 4009,
      "notionalUsd": 34638646218.03005,
      "slippageBps": 0.5109543601587198,
      "unrealisedPnlUsd": -275810.9899999932
    },
    "rowCountMessages": 88,
    "rowCountRoutes": [
      "[\"LIVE\"]"
    ],
    "dirtyRoutes": 85,
    "childRowUpdatesPerSec": 959.7,
    "childAdds": 406
  },
  "health": {
    "status": "ok",
    "rows": 1021574,
    "loadMs": 8999,
    "heapMb": 429.7,
    "rssMb": 967.4,
    "live": {
      "attached": true,
      "clients": 1,
      "liveRows": 4277,
      "pendingEvents": 211
    }
  }
}
```

antikythera `docker compose restart`:
```
=== BEFORE (hermes running, medium) ===
{"status":"ok","rows":1012796,"loadMs":9428,"heapMb":290.8,"rssMb":861.5,"live":{"attached":true,"clients":0,"liveRows":487,"pendingEvents":11}}
{"count":1012798,"max":"ALG01012798","live":488}
=== docker compose restart antikythera (SIGTERM, hermes still publishing) ===
01:18:11.474750000
 Container apeiron-antikythera-1 Restarting 
 Container apeiron-antikythera-1 Started 
01:18:11.733554000
01:18:21.435564000
{"status":"ok","rows":1012850,"loadMs":8927,"heapMb":249.6,"rssMb":806.6,"live":{"attached":true,"clients":0,"liveRows":518,"pendingEvents":0}}
{"status":"ok","rows":1012865,"loadMs":8927,"heapMb":272.9,"rssMb":807.9,"live":{"attached":true,"clients":0,"liveRows":530,"pendingEvents":0}}
{"lag":{"p50":1.7,"p99":5,"max":13.4,"samples":286},"server":{"cpu":2.4,"rssMb":808,"elLagMs":5},"flush":{"flushes":34,"lastMs":1.9927090000001044,"maxMs":5.92633399999977,"totalMs":27.383376000007047,"lastChanges":530,"totalChanges":6067,"lastViews":0,"avgMs":0.8053934117649132},"writeBehind":{"passes":6,"ordersWritten":791,"failures":0,"lastMs":1.7934580000001006},"live":{"eventsApplied":1457,"ticksApplied":220,"priceRecomputes":5991,"unknownOrders":0,"rowsAppended":65},"clients":0}
=== antikythera logs (warn/error) ===
antikythera-1  | {"level":30,"time":1791332301026,"pid":1,"hostname":"aa38102aca41","rows":1012800,"loadMs":8927,"rankMs":669,"streamedRssMb":807.1,"peakRssMb":952.2,"heapMb":438.1,"rssMb":951.8,"heapAfterGcMb":245.3,"rssAfterGcMb":777.2,"arrayBuffersMb":415.6,"typedArrayMb":261,"lag":{"p50":0.5,"p9
antikythera-1  | {"level":30,"time":1791332301029,"pid":1,"hostname":"aa38102aca41","stream":"ORDERS","durable":"blotter-server","msg":"attached to the message bus"}
```

antikythera SIGKILL, 5 minutes down (the `docker kill` did not auto-restart the container, so it was started again by hand at 01:23:51; hermes kept publishing the whole time), then hermes stopped and server vs Mongo compared:
```
=== (antikythera was SIGKILLed at 01:18:33 and started again at 01:23:51; hermes published throughout) ===
01:24:01.147025000
{"status":"ok","rows":1014589,"loadMs":8999,"heapMb":276.9,"rssMb":862.1,"live":{"attached":true,"clients":0,"liveRows":379,"pendingEvents":0}}
{"lag":{"p50":1.3,"p99":7.7,"max":37.5,"samples":694},"server":{"cpu":2.1,"rssMb":862,"elLagMs":4.8},"flush":{"flushes":82,"lastMs":2.0716250000004948,"maxMs":20.328958000000057,"totalMs":79.68086700001368,"lastChanges":379,"totalChanges":12621,"lastViews":0,"avgMs":0.9717178902440692},"writeBehind":{"passes":16,"ordersWritten":3544,"failures":0,"lastMs":9.534916000000521},"live":{"eventsApplied":37126,"ticksApplied":520,"priceRecomputes":10535,"unknownOrders":0,"rowsAppended":1683},"clients":0}
=== stop hermes, let everything settle ===
 Container apeiron-hermes-1 Stopped 
{"status":"ok","rows":1014590,"loadMs":8999,"heapMb":244.8,"rssMb":686,"live":{"attached":true,"clients":0,"liveRows":380,"pendingEvents":0}}
{
  "scenario": "consistency",
  "rowsChecked": 487,
  "mismatches": 0,
  "firstMismatches": [],
  "serverRows": 1014590,
  "mongoRows": 1014590,
  "rowCountsEqual": true
}
=== antikythera warn/error log lines since start ===
(end)
```

hermes start after a 1.5 minute stop:
```
=== BEFORE hermes start (it was stopped ~1.5 min) ===
{"count":1014590,"maxId":"ALG01014590","live":380,"pending":7,"staleLive":51}
=== docker compose up -d hermes ===
 Container apeiron-hermes-1 Started 
hermes-1  | {"level":"info","time":1791331980034,"name":"hermes","msg":"hermes started","preset":"medium"}
hermes-1  | {"level":"info","time":1791332105118,"name":"hermes","msg":"load preset changed","preset":"stress","live":3000}
hermes-1  | {"level":"info","time":1791332153160,"name":"hermes","msg":"load preset changed","preset":"medium","live":4266}
hermes-1  | {"level":"info","time":1791332649361,"name":"hermes","msg":"shutting down","signal":"SIGTERM"}
hermes-1  | {"level":"info","time":1791332667823,"name":"hermes","msg":"streams ready","streams":[{"name":"ORDERS","action":"unchanged"},{"name":"PRICES","action":"unchanged"}]}
hermes-1  | {"level":"info","time":1791332667837,"name":"hermes","msg":"loaded current orders","current":387,"maxOrderId":"ALG01014590"}
hermes-1  | {"level":"info","time":1791332667845,"name":"hermes","msg":"reconciled current orders","fills":0,"statusChanges":54,"created":172,"live":500,"pending":6,"preset":"medium"}
hermes-1  | {"level":"info","time":1791332667845,"name":"hermes","msg":"hermes started","preset":"medium"}
=== AFTER (20s later) ===
{"count":1014861,"maxId":"ALG01014861","live":492,"pending":23,"staleLive":3}
=== ids created since restart: first/last and strictly ascending? ===
{"firstNewId":"ALG01014591","lastNewId":"ALG01014863","n":273,"strictlyAscending":true,"contiguous":true}
{"status":"ok","rows":1014864,"loadMs":8999,"heapMb":261.2,"rssMb":742,"live":{"attached":true,"clients":0,"liveRows":490,"pendingEvents":0}}
=== antikythera warnings since hermes restart ===
(end)
```

## Versions and exceptions

New runtime dependencies, both at the latest stable release: `@nats-io/transport-node` 3.4.0 and `@nats-io/jetstream` 3.4.0 (nats.js v3). `ws` 8.22.0 (already a dev dependency) is used by the verification client.
Existing exception unchanged: TypeScript stays on 6.0.x because `typescript-eslint` 8.x requires `<6.1.0`. Images unchanged: `mongo:9.0`, `nats:2.15-alpine`, `node:24-slim`. The server must be NATS 2.14+ for `consumers.reset` (2.15 is pinned).

## Contract notes for phase 5b (pharos)

- Within one `delta`, apply `adds` first, then `updates`, `groupUpdates`, `rowCounts`; schedule `dirtyRoutes` as throttled `refreshServerSide({route, purge: false})`.
- `adds[i].rows` is newest first for `addIndex: 0`; several `adds` entries in one delta are chronological (apply in order).
- A route can appear in both `updates` and `dirtyRoutes`: the refresh will reorder, the update keeps cells current meanwhile.
- `newAbove` counts rows inserted above the last root block the client requested (so the client should keep requesting by block as the grid does).
- `SLOW_CONSUMER` is sent just before the server closes the socket (close code 1013); the client should reconnect and reload.

## Known weaknesses

- **Hermes restarted while the server is behind** rebuilds its state from Mongo, which lags the stream by the unpersisted tail. Hermes then publishes absolute values from that older state and the server can briefly move an order's fill progress backwards. Restart hermes only when the server is caught up.
- **Aggregate drift.** Incremental sums are exact in the tests to `1e-9` relative but nothing recomputes a bucket periodically; very long runs with cancelling large and small values could drift.
- **Tracking is a heuristic.** The server does not know the viewport: it tracks the rows of requested blocks plus up to 500 added rows, so under stress a client is sent updates for rows that scrolled away.
- **Rebuild threshold.** More than 5,000 structural changes in one tick rebuilds a view (about 100ms for a 1M-row ticking-key sort); only reachable with about 5,000 repricing LIVE rows in one flush and a view sorted or filtered on a price-derived column.
- **Fallback rebuild counter** (`rebuiltAfterInconsistency`) is only visible in tests; phase 7 should export it as a metric.
- One client only was measured; the 50-client load test is phase 7.
- `docker kill` leaves the container down under `restart: unless-stopped` (Docker treats it as a manual stop); a real crash (OOM, exit code) does restart it.
- The delta `updates` payload repeats `lastUpdateTime` on every price tick for every tracked LIVE row; dropping it from the wire (clients can derive it) would cut bytes by a few percent.
