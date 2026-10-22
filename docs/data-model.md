# Data model

The order record, its 50 columns, and the rules every component applies to them. The code is the authority:
[`packages/logos/src/columns.ts`](../packages/logos/src/columns.ts) (column metadata),
[`order.ts`](../packages/logos/src/order.ts) (the `Order` type) and
[`generator.ts`](../packages/logos/src/generator.ts) (the seeded dataset).

- [The 50 columns](#the-50-columns)
- [Null semantics](#null-semantics)
- [Pair decimals](#pair-decimals)
- [Ordering, dates, group keys and row ids](#ordering-dates-group-keys-and-row-ids)
- [The seeded dataset](#the-seeded-dataset)

## The 50 columns

One metadata file drives both the server engine and the client's column definitions
([`apps/pharos/src/grid/column-defs.ts`](../apps/pharos/src/grid/column-defs.ts)).

```ts
type ColumnMeta = {
  field: OrderField; header: string;
  type: 'string' | 'enum' | 'number' | 'datetime' | 'date';
  filter: 'text' | 'set' | 'number' | 'date';
  groupable: boolean;
  aggFunc?: 'sum' | 'avg' | 'wavg:notionalUsd' | 'count';
  decimals?: number;        // fixed decimals for non-price numbers
  pairDecimals?: boolean;   // price columns: decimals follow the row's pair
  nullable?: boolean;
  width?: number;
  priceColumn?: boolean;    // drives the up/down flash
};
```

| Group | Columns |
|---|---|
| Identity (6) | orderId, parentOrderId, clientOrderId, traderId, traderName, account |
| Instrument (5) | currencyPair, baseCcy, quoteCcy, tenor, valueDate |
| Order (8) | side, algoType, status, orderType, timeInForce, urgency, venue, strategyParams |
| Quantity (6) | orderQty, filledQty, remainingQty, pctComplete, notionalUsd, filledNotionalUsd |
| Price (9) | limitPrice, arrivalPrice, avgFillPrice, marketBid, marketAsk, marketMid, lastFillPrice, distanceToLimitBps, spreadBps |
| Performance (6) | slippageBps, slippageUsd, unrealisedPnlUsd, realisedPnlUsd, vwapBenchmark, perfVsVwapBps |
| Execution (4) | numFills, numChildOrders, participationRate, lastFillQty |
| Time (6) | createdAt, startTime, endTime, lastUpdateTime, completedAt, durationMins |

- **Groupable (14):** traderName, account, currencyPair, baseCcy, quoteCcy, tenor, side, algoType, status, orderType,
  timeInForce, urgency, venue, valueDate.
- **Default aggregates:** `sum` for orderQty, filledQty, notionalUsd, filledNotionalUsd, slippageUsd, unrealisedPnlUsd,
  realisedPnlUsd, numFills; notional-weighted average (`wavg`) for slippageBps, perfVsVwapBps, pctComplete; `count` is
  always the group's row count (= `childCount`).
- **Statuses:** `PENDING_START`, `LIVE`, `PAUSED`, `FILLED`, `CANCELLED`. The transitions are in
  [architecture.md](architecture.md#the-order-lifecycle).
- **Who writes what.** `themis` owns the order: every field except the market overlay (marketBid, marketAsk, marketMid,
  spreadBps, distanceToLimitBps, unrealisedPnlUsd), which the blotter derives from the latest price of the pair for open
  orders. The blotter never writes `lastUpdateTime`.

## Null semantics

The same everywhere (server, client, database):

- **Storage:** a null number or date is `NaN` in its `Float64Array`; it becomes `null` at the boundary (wire, database).
- **Sort:** null is the *smallest* value: first ascending, last descending (AG Grid's own client-side behaviour).
- **Filter:** only `blank` / `notBlank` match null; every other number or date operator never matches it.
- **Aggregates:** nulls are skipped (with their weight in `wavg`); all-null gives null, except `count`.
- Nullable columns: limitPrice, avgFillPrice, lastFillPrice, distanceToLimitBps, slippageBps, vwapBenchmark,
  perfVsVwapBps, completedAt.

## Pair decimals

Price columns have no fixed `decimals`; they format with the row's pair (`PAIR_BY_NAME`): JPY pairs 3,
SEK/NOK/MXN/ZAR/CNH/TRY 4, all others 5.

## Ordering, dates, group keys and row ids

- **Default ordering:** an empty `sortModel` means `createdAt desc`; every sort ends with an `orderId` tiebreaker in the
  direction of the last key, so blocks never overlap or skip rows.
- **Dates:** every date filter operator is UTC-day granular; `inRange` is inclusive for numbers and dates.
- **Group keys:** strings on the wire; `valueDate` as `YYYY-MM-DD` (UTC); null as `"(blank)"`.
- **Row ids:** leaf `orderId`; group `"G:" + [...parentKeys, key].join("|")`.
- **Versions:** every stored order carries `v`, raised by one on each change `themis` makes; a consumer applies a record
  only if its `v` is above the one it holds.

## The seeded dataset

[`gaia`](../apps/gaia) generates orders with a seeded PRNG (`mulberry32(SEED=42)`): the same seed gives the same dataset.

- 1,000,000 orders (`SEED_ROWS`) over the last 182 days (weekdays, weighted to 07:00–17:00 London), 5 fictional traders
  (35/25/20/12/8%), 3 accounts each, 20 pairs (EURUSD 25%, USDJPY 15%, GBPUSD 12% …).
- Quantity log-normal 1M–100M; algos TWAP 30, VWAP 25, POV 15, ICEBERG 12, IS 10, SNIPER 8; historical status FILLED 92%
  / CANCELLED 8%; prices consistent with a per-pair random walk.
- About 400 LIVE and 200 PENDING_START current orders with the highest ids (`'ALG' + zero-padded sequence`).
- Inserted in batches of 10,000; a second run is a no-op; `SEED_RESET=true` re-seeds a fresh window anchored to today;
  `SEED_NOW` pins the dataset's "now" for exact reproducibility. `pnpm --filter @apeiron/gaia stats` prints sample
  statistics.
