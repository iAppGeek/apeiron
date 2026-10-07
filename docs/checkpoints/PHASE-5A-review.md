# Phase 5a Review: Live Server (the full review comes at CP-3, after 5b)

- **Reviewer:** Opus 5.5
- **Reviewed:** PR #5 (`phase-5a-live-server`) and `docs/checkpoints/PHASE-5A.md`
- **Verdict:** **APPROVE. No fixes needed.** I'm merging it and moving on to 5b.

## What I verified myself
- **Clean checkout:** on a clean worktree of the PR head, `pnpm turbo run lint typecheck test build --force` gives **28/28 green**.
- **Incremental views against fresh builds on live data:** this is the core risk of phase 5. With hermes running on `medium`, one client built and cached 5 views. After **45s of live flow** (442 deltas and 28,597 row updates received), I queried each cached view and a freshly built equivalent, forced fresh by adding a no-op filter, in the same flush window. Every cell matched.

| View | What it exercises | Result |
|---|---|---|
| Group by status: sum notional, sum filled, wavg slippage, count | Aggregate deltas from `prev`; LIVE→FILLED moving between buckets | **MATCH** (max relative error 7.8e-16) |
| LIVE filtered, grouped by pair | Filter membership flips plus group aggregates | **MATCH** |
| LIVE/PAUSED sorted by `unrealisedPnlUsd desc` | Sort key changing on every price tick | **MATCH**, 421 rows, top 300 identical |
| Default view, top 300 (1,024,033 rows) | Appends at the top, `createdAt desc` | **MATCH** |
| LIVE/PENDING sorted by `clientOrderId desc` | String sort while the ranks lag behind appends | **MATCH** |

## Accepted design decisions (now recorded in `docs/PLAN.md`)
- **New package `@apeiron/iris`** (NATS adapter). It's the right call, because logos is imported by the browser. Added to the repo layout.
- **Ack after persist:** `AckPolicy.All`, plus a consumer reset on attach. This gives at-least-once delivery, and the absolute, idempotent events make replays safe. The kill test showed it: down 5 minutes, 37,126 events replayed, server and Mongo identical.
- **Hermes pacing** (fills per order, 1–2 minute lifetimes). Recorded in Appendix E.
- **String ranks:** incremental merge, plus a hybrid radix/comparator sort while ranks lag.
- **Delta semantics:** adds before updates, `updates` may include structural rows, the `newAbove` definition, `SLOW_CONSUMER` with close code 1013, one view tracked per client. Recorded in Appendix C. They're binding for 5b.
- **`/debug/lag` endpoint**, and antikythera now depends on nats being healthy.

## Weaknesses accepted for the POC
- **Fill progress can go backwards briefly:** if hermes restarts while the server is behind, because hermes reads Mongo, which lags by up to about 500ms of write-behind.
- **No periodic recompute of incremental aggregates.** Floating-point drift after 45s was about 1e-15, so it's negligible.
- **Worst-case rebuild:** a rebuild with more than 5,000 structural changes in one tick costs about 118ms. Real stress ticks carry about 1,300 changed rows. CP-4 watches this under 50 clients.
- **Only one client measured so far.** The 50-client run is phase 7, judged at CP-4.

## Notes for 5b (pharos live client)
- Follow the Appendix C "Delta semantics" exactly: adds before updates, merge partials into `getRowNode(id).data` right before a **synchronous** `applyServerSideTransaction` per route, and debounce `refreshServerSide({route, purge:false})` for dirty routes.
- When the client receives `SLOW_CONSUMER`, or close code 1013, it reconnects and purges.
