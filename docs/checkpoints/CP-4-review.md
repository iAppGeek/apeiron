# CP-4 Review: Performance Verdict (Phases 6 and 7)

- **Reviewer:** Opus 5.5
- **Reviewed:** tag `cp-4` (`cdd7301`), PR #8 (`phase-7-observability`), `docs/checkpoints/CP-4.md`, and my own `CP-4-diagnosis.md`
- **Date:** 2026-10-07

## Verdict: APPROVE WITH FIXES
The rework fixed the collapse. With 50 clients over 300s, every gated target is met with both codecs, and a 600s soak with 240s of stress runs without a stall. One ruling follows: **tick-to-screen is end to end**. Meeting it end to end needs a 50ms flush. The remaining fixes are small. Apply them on `phase-7-observability`, re-run the two 300s runs, get CI green, and merge. A second review is not needed.

## What I verified myself
- **Clean checkout:** on a worktree of `cp-4`, `pnpm turbo run lint typecheck test build --force` gives **32/32 green**.
- **Two independent runs.** Each started from a clean slate with `scripts/loadtest-reset.sh`: 50 clients, 150s, json, special clients on, default stress window at 45–105s.

| | Run A: `FLUSH_MS=100` (current) | Run B: `FLUSH_MS=50` |
|---|---|---|
| **Event age at flush p95** (source event to flush) | **191.7ms** | **77.7ms** |
| Delta p95 (`serverTs` to receipt) | 28.0ms | 27.5ms |
| ⇒ approximate end-to-end p95 | about 220ms ❌ | **about 105ms ✅** |
| getRows warm p95 (client) | 20.0ms | 19.0ms |
| getRows cold p95 (client), including the startup burst | 455ms | 374ms |
| getRows cold p95 (server) | 39.4ms | 32.6ms |
| Command ack p50 / p95 | 65 / 115ms | **39 / 68ms** |
| Server CPU median / max (% of one core) | 23.6 / 111 | 27.4 / 95 |
| Event-loop lag p99 (whole run) | 26.8ms | 24.8ms |
| RSS max | 1,016MB | 1,065MB |

**Conclusion:** most of the end-to-end latency was the 100ms batching interval itself. A 50ms flush halves it for about 4 points of median CPU, with no extra event-loop lag.

## Rulings
1. **Tick-to-screen p95 under 150ms means end to end:** from the source event's `ts` to the client receiving the delta. That's what a trader experiences. It's gated with 50 clients over the whole run, including stress. Browser render time (about 5–10ms, measured in CP-3) is reported separately.
2. **`FLUSH_MS` default becomes 50.**
3. **Cold "view change" excludes the connect storm.** At t=0, all 50 clients open a cold view at the same moment. Their builds queue on one thread (about 30ms each), so a 150s run reports cold p95 at about 400ms even though each build takes 30–40ms on the server. That's a separate scenario, "50 traders open the blotter at once". Report it as its own **startup-burst** figure: not gated, but expected under 2s. Exclude the first 10s from the view-change statistics.

## Assessment of the rework
| Area | Verdict |
|---|---|
| R1 untracked views go stale | Correct; it removes most of the wasted work |
| R2 deferred rebuilds | Correct; no synchronous rebuild in the flush. Property-tested, though not triggered in the load runs, which is acceptable |
| R3 time budget, and the shared tick log | **Good engineering:** the agent profiled its own first version, found that copying ticks into every deferred view was the next spiral, and replaced it with a shared log |
| R4 comparator | Correctly skipped: `rank` is now about 2% of a core |
| R5 ingest | ack_wait 60s, 500-message pulls, write-behind chunked at 1,000. The NATS timeouts were a symptom of the stall, not a cause |
| Mongo cache capped at 1GB | A correct environmental diagnosis (the VM was swapping). Make it configurable (F4) |
| talos | Measures from the intended send time, so no coordinated omission; slow consumer, codec switcher and stress window all work. Methodology is sound |
| Metrics and Grafana | A complete catalogue with sensible cardinality; the dashboard tells the story |

## Required fixes (Sonnet applies these on `phase-7-observability`)
- **F1.** `FLUSH_MS` default **50** in config, compose and `.env.example`. Done in `docs/PLAN.md` Appendix A.
- **F2. True end-to-end latency.**
  - Add `srcTs` to `delta`: the earliest source-event `ts` (hermes price tick or order event) among the events folded into that tick. See Appendix C.
  - talos reports **end-to-end p50/p95/p99** (receipt minus `srcTs`) as the gated tick-to-screen target, and keeps `serverTs`→receipt as "last hop".
  - Pharos's status-bar tick-to-screen uses `srcTs` too, still corrected for clock offset.
  - Add an antikythera histogram "event age at send" (now minus `srcTs` at send time).
  - Test it.
- **F3. talos reporting.**
  - Exclude the first 10s from the view-change cold statistics, and report a separate **startup burst** figure: cold p50/p95/max for the initial view of every client.
  - Record the **LIVE count and total rows at the start** of the run.
  - Add **p99.9 and the maximum** event-loop stall to the summary.
- **F4.** `MONGO_CACHE_GB` env (default 1), wired to `--wiredTigerCacheSizeGB` in compose and documented, including a note to raise it on the remote box.
- **F5. Final runs and docs.**
  - Re-run **50 clients × 300s, json and msgpack** with the new defaults, each after `scripts/loadtest-reset.sh`.
  - Update the `CP-4.md` "final results" table and the README **Benchmarks** table (JSON vs msgpack, with end-to-end tick-to-screen).
  - Add a short README section **"What the POC proved"**, written to the outline below, using the final numbers.

### Outline for "What the POC proved"
- **Grid:** a single Node server process holds 1M+ orders × 50 columns in memory (about 1GB RSS) and serves 50 concurrent blotters. Each client can have its own sort, filter or grouping, and live updates keep coming.
- **Latency:** warm block fetch about 20ms p95 (client-measured), view change about Xms p95, end-to-end tick-to-screen about Xms p95, order action round trip about 70ms p95.
- **Load:** under stress (about 5,000 LIVE orders ticking 3×/s, about 15k row updates/s), event-loop p99 stays under 30ms, and median CPU is about 25–30% of one core.
- **Correctness under load:** incremental views are proven identical to full rebuilds (property tests, plus live cross-checks against fresh builds); slow consumers are conflated and then disconnected without hurting anyone else.
- **Limits found:**
  - Synchronous rebuilds and maintaining views nobody uses caused a death spiral (fixed).
  - A connect storm of 50 cold views queues for about 1–2s on one thread.
  - Mongo needs its cache capped on small hosts.
  - Rare single stalls of 200–360ms are still visible in the max figure.
- **JSON vs msgpack:** msgpack is about 14% fewer bytes, uses slightly more server CPU, and latency is the same. Either is fine. Default to JSON for debuggability, and use msgpack on constrained links.

## Accepted as-is
- **talos dependencies:** `ws` as a runtime dependency, needed for the slow consumer; `FLUSH_BUDGET_MS`; and the `--no-slow`/`--no-switcher` flags.
- **Stale views:** a view whose last client leaves goes stale and is rebuilt cold on its next request. That's the right trade-off.
- **talos entry point:** `apps/talos/src/index.ts` has no spec, consistent with the earlier entry points.
