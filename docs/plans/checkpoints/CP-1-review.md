# CP-1 Review: Foundations (Phases 1 and 2)

- **Reviewer:** Opus 5.5
- **Reviewed:** tag `cp-1` (`9bc7d87`), PR #2 (`phase-2-data`), plus `docs/checkpoints/CP-1.md`
- **Date:** 2026-10-06

## Verdict: APPROVE WITH FIXES
The foundations are solid, and every Phase 1 and Phase 2 done criterion is met. The fixes below are small. Most come from contract gaps in the plan, not from implementation mistakes. Apply them on `phase-2-data`, get CI green, then merge PR #2. A second review is not needed.

## What I verified myself
- **Clean checkout:** on a clean worktree of `cp-1`, `pnpm install --frozen-lockfile`, then `pnpm turbo run lint typecheck test build --force`, gives **12/12 tasks green**.
- **TypeScript 6.0.3 trial:** I bumped TypeScript to 6.0.3 in a throwaway worktree. All 12 tasks are still green, with no code changes and no peer warnings. `typescript-eslint` 8.71.1 accepts `>=4.8.4 <6.1.0`.
- **Seeded Mongo:** 1,000,000 docs; status split matches the report; a sample LIVE row is internally consistent.
- **Latest image tags:** checked on Docker Hub. `mongo` has 9.0.2 (major release) and 8.0.32 (LTS); 8.3 is a rapid release. `nats` has 2.15.0.

## Assessment
| Area | Verdict | Notes |
|---|---|---|
| Monorepo, tooling | Good | Strict TS with `noUncheckedIndexedAccess`; ESLint enforces the user conventions (no `any`, explicit return types, `type` over `interface`, no TODO). The turbo task graph is right. |
| `logos` schema and columns | Good, with gaps | All 50 fields match the plan. Missing: null semantics and per-pair price decimals (F5). |
| Generator | Very good | Deterministic, streaming, internally consistent (signs on slippage, P&L and distance-to-limit are correct; the USD conversion is right). The distributions match Appendix E closely. One consequence was missed (F7): the walk drifts, so the seeded mids differ from `PAIRS.mid`. |
| Protocol and codecs | Good, with gaps | They match Appendix C, but Appendix C itself had gaps: one `rowCount` doesn't work with grouping, and there was no client→server message for the load preset (F6). |
| `mnemosyne` | Good | The interface streams and isn't Mongo-specific, which suits Oracle and KDB. The contract suite is meaningful and exported for future adapters. `clear()` should be part of the interface (F4). |
| `gaia` | Good | Idempotent, concurrent writes, 87k rows/s. Needs `SEED_RESET` (F4). |
| Docker, compose | Good, with fixes | Multi-stage `turbo prune`, non-root, cached store. Problems: floating image tags, and DB ports bound to every interface (F2, F3). |
| CI | Good | Caches the mongod binary. |

## Required fixes (Sonnet applies these on `phase-2-data`)
- **F1. TypeScript 6.0.3.** Set `"typescript": "~6.0.3"` in every package. The user wants the latest versions where possible; 7.x is blocked by the `typescript-eslint` peer range, so record that as the one exception in the report.

- **F2. Pin images to minors, latest stable.**
  - Use `mongo:9.0` and `nats:2.15-alpine`.
  - Pin mongodb-memory-server to the same Mongo minor (9.0.x) through the package `config.mongodbMemoryServer.version`, and make the CI cache key include that version.
  - Verify that the `mongodb` 7.x driver and mongodb-memory-server 11.x work against 9.0, using the contract tests and a real seed. If either can't, use `mongo:8.0` everywhere and record why.
  - A volume written by 8.3 can't be opened by an older server, and 9.0 may refuse it too. Drop the `mongo-data` volume, re-seed, and record the new timings.

- **F3. Compose hardening.**
  - Publish the mongo and nats ports on `127.0.0.1` only (for example `"127.0.0.1:27017:27017"`). Every later service copies this pattern, and the remote box must never expose the DB.
  - Pass `SEED_NOW`, `BATCH_SIZE` and `SEED_RESET` through to `gaia`.
  - Add the new variables to `.env.example`.

- **F4. `clear()` on `OrderRepository`, plus `SEED_RESET`.**
  - Add `clear(): Promise<void>` to the interface. Implement it in the Mongo and in-memory repositories and add it to the contract suite; Oracle and KDB will need it too.
  - In gaia, `SEED_RESET=true` calls `clear()` and then seeds. Test it.

- **F5. Column metadata (Appendix B, updated).**
  - Add `pairDecimals?: boolean` to `ColumnMeta` and set it on every price column: limit, arrival, avgFill, bid, ask, mid, lastFill, vwapBenchmark. Remove their fixed `decimals: 5`.
  - Add `nullable?: boolean` to the 8 nullable fields.
  - Add a spec asserting that `nullable` columns are exactly the `number | null` fields of `Order`, using a type-level or fixture-driven check, and that `pairDecimals` columns are exactly the `priceColumn` set.
  - Export a helper `priceDecimals(pair): number`.

- **F6. Protocol (Appendix C, updated).**
  - Add the client message `{ t: 'control'; reqId; preset: 'medium' | 'stress' }` with its zod schema.
  - Replace `delta.rowCount` with `rowCounts: { route: string[]; rowCount: number }[]`.
  - Add `summary.totalRows`.
  - Update the fixtures so the codec round-trip test still covers every message type.

- **F7. Final mids.** Export `finalMids(seed, n, now): Record<CurrencyPair, number>`, the walk's levels at the end of generation. Add a spec asserting that every generated LIVE and PENDING_START order's `marketMid` equals `roundTo(finalMids[pair], decimals)`. Phase 5 depends on this; see Appendix E, "Price-feed start levels".

- **F8. Test timeouts.** Remove the package-wide `testTimeout: 60_000` from logos. Put an explicit timeout on the one or two heavy generator tests only, so any other slow test still fails fast.

- **F9. msgpack codec.** Reuse module-level `Encoder` and `Decoder` instances instead of the per-call `encode`/`decode` helpers; check the `@msgpack/msgpack` v3 docs with context7. Keep the round-trip tests. This is cheap now, and CP-4 will measure the codec.

Then:
1. Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
2. Re-seed.
3. Append a short "CP-1 fixes" section to `CP-1.md` with raw output, new seed timings and versions.
4. Push, wait for green CI, then squash-merge PR #2. The `cp-1` tag stays on the reviewed commit.

## Plan and contract changes made in this review (already in `docs/PLAN.md`)
1. **Appendix A, versions:** use the latest stable release, and document any exception. TypeScript 6.0.x, with 7.x blocked by typescript-eslint. Library majors listed. Images pinned to minors: `mongo:9.0` (fallback `8.0`), `nats:2.15-alpine`. New gaia variables `SEED_NOW`, `BATCH_SIZE`, `SEED_RESET`.
2. **Appendix B:** `pairDecimals` and `nullable` column fields. **Null semantics:** `NaN` in typed arrays and `null` everywhere else; nulls sort smallest; only `blank`/`notBlank` match null; nulls are skipped by aggregates.
3. **Appendix C:** the `control` client message, per-route `rowCounts` in `delta`, `summary.totalRows`, and summaries scoped to the client's trader. The ORDERS stream has two filtered durable consumers (`blotter-server` on `orders.events`, `hermes-commands` on `orders.commands`).
4. **Appendix E:** hermes starts each pair's walk from the seeded current mids, and reconciles stale current orders at startup. `SEED_RESET` gives a fresh 6-month window.

## Accepted as-is (no action)
- USDSEK and USDNOK use G10 spreads, as the plan says literally. Acceptable for a POC.
- `isSeeded()` is `count > 0`, with the seeder comparing against `SEED_ROWS`. Fine.
- London hours approximated in UTC, even day volumes, 1:1 parent orders. Fine for the POC.
- The remote is HTTPS with a repo-local `gh` credential helper, and `turbo.json` has `agentGuidance: false`. Fine.
- One- to three-line entry points (`index.ts`, `stats-cli.ts`) have no spec, because their logic is tested elsewhere. Accepted as an exception to the one-spec-per-file convention.

## Notes for Phase 3 (antikythera)
- Load with `loadAll()`. It takes about 9s on the host for 1M rows, against a 30s target.
- Map nulls to `NaN` as above. Dictionary-encode the enum columns, the string IDs into a single `string[]`, and `strategyParams` (high cardinality, so as a string array, not a dictionary).
- Build the filter-model parser as zod schemas in logos (`filter-model.ts`, following Appendix B), so `antikythera` and `talos` share it.
- Benchmarks must use the real generator data, not uniform random data, so dictionary sizes and sort distributions are realistic.
