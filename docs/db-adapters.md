# Database adapters

Orders are stored behind one port, `OrderRepository` (`packages/mnemosyne/src/order-repository.ts`). MongoDB is the
only shipped database adapter, next to an in-memory fake that the tests use. This page is the contract a new adapter
must meet, how to prove it with the shared contract suite, and design sketches for Oracle and KDB. The sketches are
untested starting points: nothing here has been run against those databases.

- [The contract](#the-contract)
- [Running the contract suite against a new adapter](#running-the-contract-suite-against-a-new-adapter)
- [Wiring an adapter in](#wiring-an-adapter-in)
- [Oracle sketch](#oracle-sketch)
- [KDB sketch](#kdb-sketch)
- [Mapping notes](#mapping-notes)

## The contract

```ts
type OrderRepository = {
  loadAll(batchSize?: number): AsyncIterable<Order[]>;
  upsertMany(orders: readonly Order[]): Promise<void>;
  count(): Promise<number>;
  isSeeded(): Promise<boolean>;
  loadCurrent(): Promise<Order[]>;
  maxOrderId(): Promise<string | null>;
  clear(): Promise<void>;
};
```

| Method | Used by | Contract |
|---|---|---|
| `loadAll(batchSize = 10_000)` | antikythera at startup | **Stream** every order in ascending `orderId`, in batches of at most `batchSize` (the last may be shorter). Must not materialise the full set: the server loads 1M rows into a columnar store with a heap budget of under 800 MB. Early termination (`break`) must release the cursor. Ascending order matters: the store assumes ids ascend so radix sorts keep a free tiebreak |
| `upsertMany(orders)` | gaia (seed), antikythera (write-behind) | Insert or **fully replace** by `orderId`; idempotent; unordered batch writes are fine; an empty list is a no-op. Every one of the 50 fields is stored, nulls included |
| `count()` | gaia, tests | exact number of stored orders |
| `isSeeded()` | gaia | true when at least one order exists. Must be cheap (no full count) |
| `loadCurrent()` | hermes at startup | only `PENDING_START`, `LIVE` and `PAUSED` orders, ascending by `orderId`. This is a few hundred rows out of a million, so the adapter needs an index (or partition) on status |
| `maxOrderId()` | hermes, gaia | the highest `orderId`, or `null` when empty, so new ids can keep ascending (`ALG` + a zero-padded sequence, so string order equals numeric order) |
| `clear()` | gaia (`SEED_RESET=true`), tests | remove every order; idempotent on an empty repository; the repository stays usable afterwards (recreate indexes if the drop removed them) |

Write patterns to design for: a one-off bulk load of 1M rows (gaia, batches of 10,000), then a steady trickle of small
batches (write-behind, every 500 ms, tens to hundreds of rows). Reads are one sequential scan at startup. Nothing reads
by key at runtime, because the server serves queries from memory.

## Running the contract suite against a new adapter

`packages/mnemosyne/src/repository.contract.ts` exports `runOrderRepositoryContract(name, create)`. `create` returns a
fresh, empty repository and a `cleanup` function for each test. The suite covers: empty state, count and `isSeeded`,
empty upserts, idempotency, replacement by `orderId`, an exact round trip of all 50 fields on 300 generated orders
(including nulls), ascending streaming regardless of insertion order, batch sizes (including a remainder batch), early
termination, `clear()` (idempotent and reusable), several upserts in a row, `loadCurrent` and `maxOrderId`.

Add a spec next to the adapter, exactly as the Mongo one does:

```ts
// packages/mnemosyne/src/oracle-order-repository.spec.ts
import { afterAll, beforeAll } from 'vitest';
import { OracleOrderRepository } from './oracle-order-repository.js';
import { runOrderRepositoryContract } from './repository.contract.js';

let counter = 0;

runOrderRepositoryContract('OracleOrderRepository', async () => {
  counter += 1;
  const repo = await OracleOrderRepository.connect({
    connectString: process.env['ORACLE_TEST_URL'] ?? 'localhost:1521/FREEPDB1',
    user: 'apeiron',
    password: process.env['ORACLE_TEST_PASSWORD'] ?? '',
    table: `ORDERS_CONTRACT_${String(counter)}`,
  });
  return { repo, cleanup: async () => { await repo.dropTable(); await repo.close(); } };
});
```

The Mongo spec uses `mongodb-memory-server`; a database without an in-memory mode needs a container for its test run
(Testcontainers, or a service container in CI). Use one table or database per test, as above, so tests do not see each
other's rows. Run it with `pnpm --filter @apeiron/mnemosyne test`. An adapter is acceptable when the suite passes
unchanged; do not weaken the suite to fit a database.

Beyond the suite, also check a 1M-row load: `loadAll` should hold memory flat (watch RSS), and the full load through
antikythera should stay close to the Mongo figure (about 10 s on a laptop).

## Wiring an adapter in

The adapter is constructed in each app's `src/index.ts` (`antikythera`, `gaia`, `hermes`), which today call
`MongoOrderRepository.connect` directly, and antikythera's `DB_ADAPTER` setting only accepts `mongo`. To add one:
export it from `packages/mnemosyne/src/index.ts`, add the value to the `DB_ADAPTER` enum in
`apps/antikythera/src/config.ts`, and replace the direct call with a small factory `createRepository(config)` shared by
the three apps. The engine, the protocol and the web app do not change.

## Oracle sketch

A natural fit for a bank that runs Oracle: the same port, a relational table, and a streaming cursor.

**Container and driver.** `gvenzl/oracle-free` (Oracle Database Free; the `-slim` and `-faststart` tags start fastest)
for development and the contract suite, and [`node-oracledb`](https://node-oracledb.readthedocs.io) in Thin mode, which
needs no Oracle client libraries. Compose service sketch:

```yaml
oracle:
  image: gvenzl/oracle-free:23-slim-faststart
  profiles: [oracle]
  environment:
    ORACLE_PASSWORD: ${ORACLE_PASSWORD}      # from .env, never committed
    APP_USER: apeiron
    APP_USER_PASSWORD: ${ORACLE_APP_PASSWORD}
  ports: ["127.0.0.1:1521:1521"]
  volumes: [oracle-data:/opt/oracle/oradata]
  healthcheck:
    test: ["CMD", "healthcheck.sh"]
    interval: 10s
    retries: 30
```

**DDL.** One row per order, 50 columns. `VARCHAR2` for strings and enums (check constraints or lookup tables are
optional: the server validates), `BINARY_DOUBLE` for prices and other floating-point values, and `NUMBER(15)` epoch
milliseconds for timestamps, which is exactly what the domain model holds (see the mapping notes).

```sql
CREATE TABLE orders (
  order_id              VARCHAR2(16)  NOT NULL,
  parent_order_id       VARCHAR2(16)  NOT NULL,
  client_order_id       VARCHAR2(32)  NOT NULL,
  trader_id             VARCHAR2(8)   NOT NULL,
  trader_name           VARCHAR2(64)  NOT NULL,
  account               VARCHAR2(16)  NOT NULL,
  currency_pair         VARCHAR2(6)   NOT NULL,
  base_ccy              VARCHAR2(3)   NOT NULL,
  quote_ccy             VARCHAR2(3)   NOT NULL,
  tenor                 VARCHAR2(4)   NOT NULL,
  value_date            NUMBER(15)    NOT NULL,   -- UTC midnight, epoch ms
  side                  VARCHAR2(4)   NOT NULL,
  algo_type             VARCHAR2(8)   NOT NULL,
  status                VARCHAR2(13)  NOT NULL,
  order_type            VARCHAR2(8)   NOT NULL,
  time_in_force         VARCHAR2(3)   NOT NULL,
  urgency               VARCHAR2(6)   NOT NULL,
  venue                 VARCHAR2(10)  NOT NULL,
  strategy_params       VARCHAR2(512) NOT NULL,
  order_qty             NUMBER(20,2)  NOT NULL,
  filled_qty            NUMBER(20,2)  NOT NULL,
  remaining_qty         NUMBER(20,2)  NOT NULL,
  pct_complete          BINARY_DOUBLE NOT NULL,
  notional_usd          BINARY_DOUBLE NOT NULL,
  filled_notional_usd   BINARY_DOUBLE NOT NULL,
  limit_price           BINARY_DOUBLE,            -- null for MARKET orders
  arrival_price         BINARY_DOUBLE NOT NULL,
  avg_fill_price        BINARY_DOUBLE,
  market_bid            BINARY_DOUBLE NOT NULL,
  market_ask            BINARY_DOUBLE NOT NULL,
  market_mid            BINARY_DOUBLE NOT NULL,
  last_fill_price       BINARY_DOUBLE,
  distance_to_limit_bps BINARY_DOUBLE,
  spread_bps            BINARY_DOUBLE NOT NULL,
  slippage_bps          BINARY_DOUBLE,
  slippage_usd          BINARY_DOUBLE NOT NULL,
  unrealised_pnl_usd    BINARY_DOUBLE NOT NULL,
  realised_pnl_usd      BINARY_DOUBLE NOT NULL,
  vwap_benchmark        BINARY_DOUBLE,
  perf_vs_vwap_bps      BINARY_DOUBLE,
  num_fills             NUMBER(10)    NOT NULL,
  num_child_orders      NUMBER(10)    NOT NULL,
  participation_rate    BINARY_DOUBLE NOT NULL,
  last_fill_qty         NUMBER(20,2)  NOT NULL,
  created_at            NUMBER(15)    NOT NULL,
  start_time            NUMBER(15)    NOT NULL,
  end_time              NUMBER(15)    NOT NULL,
  last_update_time      NUMBER(15)    NOT NULL,
  completed_at          NUMBER(15),
  duration_mins         NUMBER(10)    NOT NULL,
  CONSTRAINT orders_pk PRIMARY KEY (order_id)
);

-- loadCurrent(): a few hundred rows out of a million, so an index on the three open statuses.
CREATE INDEX orders_open_ix ON orders (CASE WHEN status IN ('PENDING_START','LIVE','PAUSED') THEN status END);
```

`BINARY_DOUBLE` keeps IEEE doubles exactly (the contract requires an exact round trip of what JavaScript holds);
`NUMBER` with a scale would round. Use it for every value the generator produces as a float. The function-based index
above only indexes open orders (the `CASE` yields `NULL`, which a B-tree index skips), so `loadCurrent()` -
`WHERE CASE WHEN status IN ('PENDING_START','LIVE','PAUSED') THEN status END IS NOT NULL ORDER BY order_id` - reads a
handful of index entries instead of scanning a million rows. The query must repeat the exact expression. The primary key is an index organised on `order_id`, which also serves `maxOrderId()`
(`SELECT MAX(order_id)`) and the ordered scan.

**Batch upserts.** `executeMany` with `MERGE`, binding arrays of rows (one round trip per batch of 1,000 to 10,000):

```ts
const sql = `
  MERGE INTO orders t USING (SELECT :order_id AS order_id FROM dual) s ON (t.order_id = s.order_id)
  WHEN MATCHED THEN UPDATE SET t.status = :status, t.filled_qty = :filled_qty /* ...every non-key column... */
  WHEN NOT MATCHED THEN INSERT (order_id, status, /* ...all 50... */) VALUES (:order_id, :status, /* ... */)`;
await connection.executeMany(sql, rows, { autoCommit: true, bindDefs });
```

Declare `bindDefs` (types and `maxSize`) so the driver does not scan the data to infer them. For the one-off seed, plain
`INSERT /*+ APPEND */` with `executeMany` is several times faster than `MERGE`; the adapter can use it when the table is
empty. Commit once per batch. Generate the column list and the binds from the `COLUMNS` metadata in `@apeiron/logos`
rather than writing 50 names by hand twice.

**Streaming `loadAll`.** Use `connection.queryStream('SELECT ... FROM orders ORDER BY order_id', [], { fetchArraySize })`
and chunk the rows into batches of `batchSize`; `queryStream` applies backpressure through Node streams, so memory stays
flat. Set `fetchArraySize` to about the batch size (the default of 100 is far too small for a million rows). Close the
stream in a `finally` block so an early `break` releases the cursor and the connection. Rows are mapped back to the
`Order` shape (snake_case to camelCase, `null` kept as `null`); with `outFormat: oracledb.OUT_FORMAT_OBJECT` and a
`fetchAsString` of none, the numbers arrive as JavaScript numbers.

**`clear()`.** `TRUNCATE TABLE orders` (DDL, instant, idempotent); there is nothing to recreate.

**Operational notes.** Use a connection pool (`oracledb.createPool`) sized small: the server needs one connection for the
startup scan and one for write-behind. Oracle Free is limited to 2 CPUs, 2 GB of RAM and 12 GB of user data, which holds
this dataset (a million 50-column rows is a few hundred MB).

## KDB sketch

kdb+ is a natural home for tick data and a very different shape from a document or row store: columnar, in memory, with
q as the query language.

**Container.** KDB-X or kdb+ from KX. Check KX's current licence terms: a licence file or key is normally required, and
it must be neither baked into an image nor committed to this public repository. Mount it as a secret:

```yaml
kdb:
  image: ${KDB_IMAGE}            # the image you built or pulled under your licence
  profiles: [kdb]
  command: ["q", "/app/orders.q", "-p", "5010"]
  volumes: [kdb-data:/data, ./infra/kdb:/app:ro, ./kc.lic:/licence/kc.lic:ro]
  ports: ["127.0.0.1:5010:5010"]
```

**Schema, date-partitioned and splayed.** A historical database partitioned by the date of `createdAt`, with every
column in its own file, which is what makes a million-row scan cheap:

```q
/ one row per order; nulls are typed nulls (0n for floats, 0Nj for longs), which round-trip as JSON null
orders:([] orderId:`$(); parentOrderId:`$(); clientOrderId:`$(); traderId:`$(); traderName:`$(); account:`$();
  currencyPair:`$(); baseCcy:`$(); quoteCcy:`$(); tenor:`$(); valueDate:`timestamp$();
  side:`$(); algoType:`$(); status:`$(); orderType:`$(); timeInForce:`$(); urgency:`$(); venue:`$(); strategyParams:();
  orderQty:`float$(); filledQty:`float$(); remainingQty:`float$(); pctComplete:`float$(); notionalUsd:`float$();
  filledNotionalUsd:`float$(); limitPrice:`float$(); arrivalPrice:`float$(); avgFillPrice:`float$();
  marketBid:`float$(); marketAsk:`float$(); marketMid:`float$(); lastFillPrice:`float$();
  distanceToLimitBps:`float$(); spreadBps:`float$(); slippageBps:`float$(); slippageUsd:`float$();
  unrealisedPnlUsd:`float$(); realisedPnlUsd:`float$(); vwapBenchmark:`float$(); perfVsVwapBps:`float$();
  numFills:`long$(); numChildOrders:`long$(); participationRate:`float$(); lastFillQty:`float$();
  createdAt:`timestamp$(); startTime:`timestamp$(); endTime:`timestamp$(); lastUpdateTime:`timestamp$();
  completedAt:`timestamp$(); durationMins:`long$())
```

Enum-like columns are symbols (interned, 4-8 bytes, fast to group and filter); free text (`strategyParams`) stays a
list of strings. Write a day's rows with `.Q.dpft[`:/data;2026.10.06;`orderId;`orders]`, which splays the table into that date's
partition sorted by `orderId` (and puts the `p` attribute on that column, harmless on a unique key). Order ids ascend with
`createdAt`, so reading the partitions in date order yields ascending `orderId` overall, which is what `loadAll`
promises. A historical database has no update in place, so **open orders live in a small in-memory table** (with the `g`
attribute on `status`) that write-behind updates by key (`upsert`), and a job flushes finished orders into the
partitions. `loadCurrent()` then reads only the realtime table.

**IPC client.** Node has no first-party kdb+ client; options are the community `node-q` package, or speaking the IPC
protocol over a small adapter. An adapter would: connect to `5010`, send `(`.api.loadAll;1000;offset)` style requests
that return a batch of rows already ordered by `orderId` (kdb+ IPC is request/response, so stream by paging with
`offset`/`limit` keyset on `orderId` rather than holding a cursor), and send `(`.api.upsert;rows)` where `rows` is a
list of column lists (one list per column is the efficient shape in q; build it from the `COLUMNS` metadata). Convert
epoch milliseconds to q timestamps (`timestamp$ 1000000*ms` plus the `2000.01.01` epoch offset of 946684800000 ms) and
back. `count[]` is `count orders` over the partitions, `maxOrderId[]` is `max` of the last partition's `orderId`, and
`clear[]` unlinks the partition directories and empties the realtime table.

**Tickerplant as an alternative to NATS.** In a kdb shop the order events and price ticks arrive through a tickerplant
(`tick.q`) instead of NATS: hermes' publisher would write to the tickerplant (`.u.upd[`orderEvents; data]`), and
antikythera would **subscribe** with `.u.sub[`orderEvents;`]`, receiving each update as a callback on its IPC handle,
with the tickerplant's log file providing replay from a point (the equivalent of JetStream's durable consumer). The `Bus`
port in `packages/logos/src/bus.ts` is the seam: a `TickerplantBus` implementing it replaces `NatsBus` (`@apeiron/iris`)
and nothing above it changes. The `prices.*` and `orders.events` subjects map to two tickerplant tables, and
`orders.commands` to a synchronous call on the gateway.

**Operational notes.** kdb+ is single threaded per process unless started with `-s`; keep the historical database and
the realtime table in separate processes behind a gateway if queries ever land on it directly. Here, the server reads
once at startup, so a single process is enough.

## Mapping notes

| Concern | Domain model | Mongo | Oracle | KDB |
|---|---|---|---|---|
| Missing value | `null` (never `undefined`, never `NaN`) | BSON `null` | SQL `NULL` (nullable columns only: the 8 columns the `COLUMNS` metadata marks `nullable`) | typed null (`0n`, `0Nj`, `0Np`); convert to `null` on read |
| Timestamps | epoch **milliseconds**, UTC, integer | number | `NUMBER(15)`, or `TIMESTAMP(3)` with explicit UTC conversion | `timestamp` (nanoseconds since 2000-01-01): convert both ways |
| `valueDate` | UTC midnight in epoch ms | number | same as timestamps (a `DATE` is fine if converted at UTC) | `timestamp` at midnight, or `date` |
| Enums (status, side, ...) | string literals | strings | `VARCHAR2`; keep the exact upper-case spelling | symbols |
| Prices and money | IEEE double | double | `BINARY_DOUBLE`, not `NUMBER(p,s)`, or the round trip is not exact | `float` |
| Counts | integer-valued number | number | `NUMBER(10)` | `long` |
| Field count | exactly 50 keys on every order, no extras | `_id` is projected out | map by `COLUMNS` metadata | map by `COLUMNS` metadata |
| Order of `loadAll` | ascending `orderId`, plain string comparison | `_id` index | `ORDER BY order_id` with a **binary** collation (`NLS_SORT=BINARY`), not a linguistic one | sorted by `orderId` as symbol text: sort the strings, not the symbol numbers |

Two traps worth naming. **String ordering**: `ALG01009892` style ids compare equal under binary and most linguistic
collations because they are fixed-width digits after a constant prefix, but make the database sort explicitly the way
JavaScript's `<` does. **Floating point**: the contract's round-trip test compares with `toEqual`, so a database that
stores prices as decimals will fail it; that is the suite doing its job.
