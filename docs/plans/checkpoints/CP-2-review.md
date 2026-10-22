# CP-2 Review: Engine (Phase 3)

- **Reviewer:** Opus 5.5
- **Reviewed:** tag `cp-2` (`ab2eda6`), PR #3 (`phase-3-engine`), plus `docs/checkpoints/CP-2.md`
- **Date:** 2026-10-06

## Verdict: APPROVE WITH FIXES
This is a strong phase. Every target is met with about 10× headroom, and the engine is correct against an **independent** oracle (MongoDB itself, below), not only against the author's own reference implementation. There is one real (latent) bug, three contract decisions, and some memory housekeeping. No Appendix F fallback is needed. Apply the fixes on `phase-3-engine`, get CI green, and merge. A second review is not needed.

## What I verified myself
- **Clean checkout:** on a worktree of `cp-2`, `pnpm install --frozen-lockfile`, then `pnpm turbo run lint typecheck test build --force`, gives **16/16 green** (196 antikythera tests).
- **Independent oracle:** a WebSocket client against the running container (trader `T1`, 350,532 rows), comparing every answer with a direct MongoDB query or aggregation. I ran it over **both codecs**.

| Check | Engine vs Mongo |
|---|---|
| Default view: count, and the first 100 ids (`createdAt desc`, `orderId` tiebreak) | identical |
| Set + number filter (LIVE, BUY, notional ≥ 10M) sorted by `slippageBps asc` with nulls first: count and full order | identical (22 rows) |
| Group by pair: `sum notionalUsd`, `wavg slippageBps`, `count`, sorted by aggregate desc: order and `childCount` | identical; max relative error 1.0e-14 |
| Two-level drill (EURUSD → TWAP), leaves 100–200, sorted by `clientOrderId desc` | identical |
| `createdAt equals 2026-09-15` | identical (2,698) |
| `pivotMode`, `aggFunc: median`, `command` | `UNSUPPORTED_PIVOT`, `UNSUPPORTED_AGG`, `NOT_IMPLEMENTED` |

- **Latency (first pass):** about 15–31ms for cold views, measured end to end. Repeat requests take under 1ms, because views are shared and cached.
- **Container:** 882 MiB after settling. `/health` reports `loadMs 16047`, `heapMb 224`.

## Assessment
| Area | Verdict | Notes |
|---|---|---|
| Columnar store | Very good | SAB-backed, `NaN` for null, dictionary codes with ranks, 1.5M headroom. One latent bug (F1). No update path yet, which is expected; see the phase 5 notes. |
| Filter compiler | Good | Cheap predicates first, set filters as a lookup table, null semantics right. Date operators need the CP-2 decision (F2). |
| Sort | Excellent | The LSD radix over the Float64 bit patterns is correct: NaN smallest, -0 equal to 0, and descending by bit inversion. Using row order as the free `orderId` tiebreak is clever and safely guarded by `idsAscending`, with a tested comparator fallback. |
| Group and aggregate | Good | Exact aggregates (summed in row order); route resolution is lazy and cached. `count` needs a fix (F3). |
| View cache | Good | LRU capped by views and bytes; flat views share across `valueCols`. Defaults: 64 views, 384MB. |
| Session and transport | Good | Nothing the client sends can crash it; codec renegotiation works; `maxPayload` is 1 MiB; the transport sits behind an interface. |
| Loader | Good, with notes | 16s, streaming, yields between batches. The startup stalls (up to about 1.3s) happen while `/health` is still 503, so that's acceptable. The transient RSS peak is addressed in F4. |
| Tests | Very good | The property tests against a naive reference, the hand-run mutation testing, and the real-socket WS tests are exactly what CP-2 asked for. My Mongo oracle check answers the "same author" weakness. |

## Required fixes (Sonnet applies these on `phase-3-engine`)
- **F1. Bug: enum dictionary widening loses rows in the same batch.** `ColumnarStore.widen()` copies `codes.subarray(0, this.count)`, but inside `appendBatch` the count hasn't been increased yet. So the rows `base..base+i-1` already written in that batch are dropped when a dictionary passes 256 values partway through a batch.
  - **Reproduction:** 300 orders with venues `V0…V299` in one batch; `rowAt(10).venue` returns `'V0'`.
  - **Fix:** copy the written extent (`base + i`).
  - **Test:** add this reproduction as a regression test. Also cover widening across batches, and growth (`ensureCapacity`) combined with widening.
  - Real data never triggers it (the largest dictionary has 20 values), but phase 5 appends live.

- **F2. Date operators are UTC-day granular (Appendix B, updated).** Today only `equals`/`notEqual` are day-based. Implement the table now in Appendix B: `lessThan < D0`, `lessThanOrEqual < D0+1d`, `greaterThan ≥ D0+1d`, `greaterThanOrEqual ≥ D0`, `inRange [D0, D1+1d)`.
  - Update the reference implementation and the unit tests.
  - Number `inRange` stays inclusive. The client sets `inRangeInclusive: true` in phase 4.

- **F3. `count` is always the group's row count (Appendix B, updated).** It equals `childCount` and is never null, even when every value is null. Update the reference implementation and the tests.

- **F4. Memory housekeeping: transient load peak.**
  - **(a)** Add `mem_limit: 3g` to the `antikythera` compose service, so memory behaviour is defined and matches the remote box budget, rather than swapping the Docker VM. Record this in the README.
  - **(b)** Time-box 30 minutes to try lowering the end-of-stream RSS peak (about 1.8GB). Ideas:
    - smaller cursor and loader batches (for example 2k);
    - dropping the batch reference before `await yieldToLoop()`;
    - building the string ranks one field at a time with a GC between them, or calling `global.gc` after the stream ends.
    - Keep whatever cuts the peak without slowing loading by more than 20%. Report before/after figures in `CP-2.md` either way.

- **F5. Housekeeping.**
  - Use the full error-code list from Appendix C, and export the codes as a union type from logos (`ErrorCode`) so the client in phase 4 can switch on them.
  - Make sure `CP-2.md` points to this review's decisions.

Then:
1. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
2. Rebuild the container and check that it comes up healthy under `mem_limit`.
3. Append a "CP-2 fixes" section to `CP-2.md` with raw output and the F4 figures.
4. Push, wait for green CI, and squash-merge PR #3. The `cp-2` tag stays on the reviewed commit.

## Plan and contract changes made in this review (already in `docs/PLAN.md`)
1. **Appendix B:** every date operator is UTC-day granular (table); `inRange` is inclusive for numbers and dates, and the client sets `inRangeInclusive: true`; `count` equals `childCount` and is never null.
2. **Appendix C:** the complete error-code list, including the codes phases 5 and 6 will use (`INVALID_TRANSITION`, `UNKNOWN_ORDER`, `SLOW_CONSUMER`).
3. **Appendix D:** "Phase 5 requirements from CP-2":
   - in-place `updateRow` producing the ChangeSet, with no global invalidation;
   - the engine applies ChangeSets to views instead of clearing them;
   - string ranks are rebuilt off the hot path, with the comparator used while they're stale;
   - hermes keeps order IDs ascending;
   - a dictionary that grows only invalidates the views on that column.

## Decisions on the agent's open questions
| Question | Decision |
|---|---|
| Date `lessThan`/`greaterThan`/`inRange` semantics | Day granular (F2) |
| `inRange` inclusive or exclusive | Inclusive for numbers and dates; the client UI is configured to match |
| All-null `count` | Row count, never null (F3) |
| Group-row tiebreak direction | **Accepted as built:** ties end with the key, in the direction of the last applicable sort entry, ascending when there's none. It's deterministic, and nobody will notice. |
| Extra error codes | **Accepted.** Added to Appendix C and exported as a type (F5). |
| String sort ranks (not in the plan) | **Accepted.** A good call (800ms down to radix speed). The phase 5 behaviour is now specified in Appendix D, item 3. |
| `idsAscending` fast path | **Accepted.** Hermes must keep IDs ascending (Appendix D, item 4). |
| Startup stall of up to about 1.3s while loading | **Accepted:** the server isn't ready (`/health` 503) and no client is affected. Watch for it at CP-4 only if a reload path is ever added. |
| No worker pool | **Correct:** a cold view build takes 12–47ms, well inside budget. Appendix F stays a fallback. |

## Notes for phase 4 (pharos)
- **Aggregates:** register the custom `wavg` aggregate in AG Grid (`aggFuncs`) and set `aggFunc` on the columns from `ColumnMeta`. Map the logos `wavg:notionalUsd` to the wire name `wavg`.
- **Filters:** set `filterParams.inRangeInclusive: true` on number and date filters. Use `ColumnMeta.pairDecimals` for price formatting through `priceDecimals(row.currencyPair)`.
- **Sorting the group column:** the server already accepts `ag-Grid-AutoColumn` in `sortModel` for group rows.
- **Error handling:** switch on the exported `ErrorCode` type, show `NOT_READY` as a "loading orders…" overlay, and retry.
