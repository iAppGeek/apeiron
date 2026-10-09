# Apeiron: Demo Script

Speaker notes for the engineering-team deck, plus a run-sheet for the live demo: exact commands, what to click, what to
point out, the numbers to expect, and what to do when something misbehaves.

- **Deck:** "Apeiron: Infinity Blotter" (Slides artifact, link in the README's documentation table).
- **Length:** 18 slides, about 35 minutes plus Q&A; the live demo (slide 15) takes about 8 minutes.
- **Sources:** every number below is cited in [`TECHNICAL-OVERVIEW.md`](TECHNICAL-OVERVIEW.md); "CP-4" etc. refer to
  [`checkpoints/`](checkpoints); "fresh" means [`checkpoints/PHASE-10.md`](checkpoints/PHASE-10.md) (2026-10-09).

---

## Part 1: speaker notes

### 1. Title: Apeiron, the Infinity Blotter
One million FX algo orders, fifty columns, ticking live, for fifty traders at once, from one Node process. Apeiron is Greek
for "the infinite". This talk covers what we built, how it works, why it's shaped this way, and what it proved, so you can
maintain or extend it. Everything is in the repo: code, checkpoint reports with raw output, and this deck's sources.

### 2. The problem and the targets
A blotter has to show every order, not a page of them: 1M+ rows × 50 columns, prices ticking 3 times a second on 20 pairs,
about 100 order updates and 5 new orders a second (2,000 and 50 under stress), new orders on top without moving the user's
view, server-side filter, sort and group, and Cancel/Pause/Resume. Targets: block fetch p95 under 50 ms, a view change
under 300 ms, tick-to-screen p95 under 150 ms end to end, event-loop lag p99 under 50 ms, RSS under 2 GB, 60 fps, all with
50 clients.

### 3. Architecture overview
Five apps and three packages, each with a codename. pharos is the browser app; its socket lives in a Web Worker.
antikythera is the server: columnar store, query engine, flush loop. hermes simulates the order management system on NATS
JetStream. gaia seeds Mongo. talos is the load harness. logos is the shared contract: columns, protocol, codecs. Two
ports, `OrderRepository` and `Bus`, keep Mongo and NATS replaceable. Everything runs in Docker Compose with profiles.

### 4. Why server-side SSRM
Client-side would mean 1M × 50 objects in every browser, about 1.5 GB each, and grouping with aggregates over all of it.
Server-side: the server holds the rows once and shares query results between clients with the same view; the grid lazily
loads 100-row blocks. AG Grid's server-side row model gives us grouping, set filters and block caching; we accepted the
Enterprise watermark. The cost: we own the query engine and the live-update protocol.

### 5. The columnar store and query engine
No order objects: 50 typed arrays on a SharedArrayBuffer. Numbers are Float64 with NaN as null; enums are one-byte
dictionary codes. 257 MB of typed arrays for 1M rows. Sorting is an LSD radix sort over the Float64 bit patterns, made
order-preserving; enums sort by dictionary rank, strings by a cached rank. Because order ids ascend with row order, the
`orderId` tiebreak is free. Cold builds take 11 to 30 ms on the laptop; a warm block fetch about 0.1 ms. Clients with the
same view share it.

### 6. How a price tick reaches the screen
hermes publishes a tick to NATS. antikythera queues it; every 50 ms the flush reprices the LIVE rows on that pair, records
a ChangeSet, patches the views and asks each client session what it holds. The session builds a delta, the worker decodes
it, the grid applies it synchronously and flashes the cells. End to end, from hermes's timestamp to the client:
p50 38 ms, p95 65 ms with JSON, 62.5 with msgpack, 50 clients, stress included. Most of it is waiting for the next flush;
the last hop is about 25 ms.

### 7. Incremental views and the flush loop
Rebuilding views every tick is impossible, so views patch themselves. A change to a field the view doesn't sort, filter or
group on is value-only: nothing moves. Otherwise it's structural: remove, re-test, merge back in O(n). The flush has rules
learned the hard way: views nobody watches go stale and cost nothing; rebuilds never run inside a flush; patching stops
after 40 ms and the rest catch up from a shared tick log; flush every 50 ms. Property tests prove a patched view equals a
fresh build.

### 8. The client: worker transport, deltas, anchoring
The worker owns the socket: heartbeat every 2 s, half-open detection at 6 s, reconnect with backoff, self-describing
frames. Deltas are applied synchronously, adds before updates, partials merged into current row data right before the
transaction (the async API loses fields). Anchoring: read the top row from the DOM, because AG Grid scales the scroll
position past 16M pixels, apply the adds, scroll by the number inserted, count the badge. Measured: anchored at row
312,710 for 15 s while 75 orders arrived above.

### 9. Scaling to 50 clients: the results
talos runs 50 open-loop clients for 300 s: scrolling, view changes, commands, a slow consumer, a codec switcher and a
60 s stress window. On the laptop every target passed with both codecs: block fetch p95 18 ms, view change 38 ms,
tick-to-screen 62.5 to 65 ms, event-loop p99 19 to 23 ms, RSS about 1.1 GB, CPU median about a quarter of a core.
Honest footnote: a fresh run on a cloud container 4 to 7 times slower per operation missed four of five targets, without
collapsing. Capacity is one CPU thread.

### 10. The death spiral and how profiling found it
The first 50-client run collapsed: stalls of 13 s, 13,272 timeouts, wedged for two minutes after stress ended, at only
25% average CPU. A CPU profile showed the flush patching views, 60% of busy time. The loop: orphaned views still patched,
a slow tick made the next ChangeSet bigger, over 5,000 structural changes triggered synchronous rebuilds, which made the
tick slower still. The fix bounded the work: stale views, deferred rebuilds, a 40 ms budget, a shared log. Then a second
cause: Mongo's cache swapping the VM. Lesson: bound work by time, and measure from intended send time.

### 11. JSON vs msgpack
Frames are self-describing: text is JSON, binary is msgpack, so switching codecs mid-session works both ways; that fixed
a real bug. msgpack carries about 11% fewer bytes per client (131 vs 147 KB/s), slightly more server CPU, and the same
latency. We default to JSON for debuggability; msgpack is a toggle for constrained links.

### 12. The testing pyramid
Six layers, each answering a different question. About 1,220 unit tests beside the code; property tests that pit the
incremental engine against a naive reference; integration tests over real sockets, bus and an in-process Mongo; 18
Playwright E2E tests against the containerised stack; the resilience suite; and talos for load. Cheap layers run on every
change; the smoke resilience tier runs in CI.

### 13. The resilience suite: how sync is proven
Five browser pages with different views, Toxiproxy between them and the server, and a deterministic driver replacing
hermes. Every event goes through a tee into an independent model. Three checks after the faults stop: the model equals
the server, the screen equals a fresh server read field for field, and invariants held throughout (nothing went
backwards). Minimum reconnects and deltas mean it can't pass vacuously, and a canary proves it can fail. Final: full tier
9 of 9, quick 9 of 9.

### 14. Bugs the suite found
Nine real sync bugs, none caught by any other layer, each fixed with a reproducing unit test. Highlights: rows still on
screen stopped ticking after 500 adds; a client that reconnected during a restart got no deltas, ever; a timed-out request
left the grid empty for good; deltas overtaken by a later reply got applied twice. The common cause: the server mirrors a
client cache it can't see. The fixes make it self-healing.

### 15. Live demo
Switch to the browser (run-sheet below). If anything misbehaves, the screenshots on this slide are the backup: hero view,
anchoring with the badge, grouping with aggregates, Grafana under load.

### 16. Limitations
Under a non-default sort, anchoring can drift a row on the first refresh. 50 cold views opened at the same instant queue
for up to 0.45 s. Rare single stalls of 200 to 350 ms. After a server restart an update time can step back for under a
second, because price-only changes aren't persisted. One thread is the capacity limit, as the slower host showed. AWS is
designed and validated, never deployed.

### 17. Next steps
Deploy to the AWS Graviton box (about $0.16 an hour) and rerun talos there. Oracle and KDB adapters against the existing
contract suite. A worker-thread pool for view builds; the store is already on SharedArrayBuffer. Server-side positions for
non-default-sort anchoring. Then production concerns: auth and entitlements, horizontal scale, persisting last prices.

### 18. Q&A
Links on the slide: the repo, the technical overview, the user guide, testing, and the checkpoint reports with raw output.
Good questions to expect: why not a client-side grid (slide 4); why not worker threads now (one thread met the targets on
the laptop); how independent is the model (it shares one pure price function with the server, documented).

---

## Part 2: live-demo run-sheet

### T−30 min: prepare

```bash
cd apeiron
docker compose --profile core --profile monitoring up -d --build   # if not already running
scripts/loadtest-reset.sh                                          # 1M rows, empty JetStream, Medium (~45 s on a laptop)
curl -s localhost:4000/health                                      # expect "status":"ok", rows ≈ 1,000,000, liveRows ≈ 550
pnpm e2e                                                           # optional smoke: 18 passed (~2 min); it mutates a few orders
scripts/loadtest-reset.sh                                          # reset again after the E2E run
```

- Browser: Chrome at 1600×900 or larger, zoom 100%, one tab on <http://localhost:8080>, a second on
  <http://localhost:3001/d/apeiron-blotter-server> (Grafana, "Last 5 minutes", refresh 5 s).
- Close other heavy apps; Docker VM ≥ 6 GB.
- Open DevTools once to confirm the console shows only the AG Grid licence banner, then close it.
- Have [`screenshots/demo/`](screenshots/demo) open in a file viewer as the fallback.

### The demo (about 8 minutes)

| # | Do | Point out | Expect |
|---|---|---|---|
| 1 | Show the default view | 1M rows in the status bar; summary chips; newest orders on top; Connected, json | Rows ≈ 1,000,xxx; LIVE ≈ 550; tick-to-screen p50/p95 ≈ 20–40 / 60–70 ms on the laptop (22/63 ms fresh) |
| 2 | Watch the top rows for 5 s | New orders arrive at row 0, about 5 a second | Row 0's Order ID keeps increasing |
| 3 | Filter Status = LIVE (Status column ☰ → Filter → untick Select All → LIVE) and scroll right to Bid/Ask/Mid | Price cells flash and turn green/red as they tick | ~400–600 rows; cells change about once a second each |
| 4 | Clear the filter (Filters panel → reset), then drag the scrollbar to about a third of the way down | Smooth deep scroll, blocks load from the server | Row index ≈ 300,000; blank rows fill within a fraction of a second |
| 5 | Leave it 15 s | The same order stays at the top; the badge counts | "N new orders ↑", rising ~5/s |
| 6 | Click the badge | Back to the top, badge gone | Row 0 |
| 7 | Drag **Pair** into the row-group panel; then drag **Status** beside it | Group counts and aggregates (sums, weighted averages) computed on the server, still ticking | 20 pair groups; ~38 ms view change on the laptop |
| 8 | Expand EURUSD → LIVE | Leaf orders inside, aggregates updating | |
| 9 | Remove the groups (✕ on the chips); add a set filter Pair = EURUSD, a number filter Notional USD > 10,000,000, a date filter Value Date = the first row's date | Each filter answers immediately; row count shrinks | e.g. 1,000,923 → 250,782 → 76,410 → 43 (fresh run) |
| 10 | Clear filters; right-click a LIVE order's Status → **Pause order** | Status changes in well under a second; the ack follows the status change | PAUSED; p50 58 ms on the laptop (87 ms fresh) |
| 11 | Right-click it → **Resume order**; right-click a FILLED order | Resume works; a finished order offers no actions | LIVE again; actions greyed out |
| 12 | Right-click a LIVE order → **Cancel order** → show the "Confirm: cancel …" submenu, then Escape | Cancel needs confirmation | |
| 13 | **Dev** → Wire codec → MessagePack | Grid reloads in place, codec shows msgpack, deltas keep flowing | Status bar "Codec msgpack" |
| 14 | **Dev** → JSON | Switching back works (that was a real bug, fixed in CP-3) | "Codec json" |
| 15 | **Dev** → Load preset → **Stress**; switch to Grafana | STRESS pill; LIVE climbs to thousands; Grafana shows order events ~2,000/s, CPU, flush, lag | LIVE ≈ 3,000–4,000 within ~30 s; rows updated ~1,300–4,000/s |
| 16 | Back in the blotter: scroll a little | Still responsive under stress | Laptop: 112–120 FPS (CP-3) |
| 17 | **Dev** → **Medium** | STRESS pill disappears; LIVE drains over a minute or two | |

Optional, if there's time (5 min, run it before the talk and show the result): the 50-client load test.

```bash
scripts/loadtest-reset.sh
pnpm --filter @apeiron/talos start -- --clients 50 --duration 300 --codec both
```

Point at the PASS/FAIL table at the end and at Grafana during 120–180 s (the stress window). Laptop reference: every
target PASS (CP-4 §12). On slower hardware expect misses (fresh run on a 4-vCPU cloud VM: 4 of 5 missed).

### Fallbacks

| Problem | Do this |
|---|---|
| Grid empty / row count 0 | `docker compose --profile core restart antikythera`; wait for `/health` ok (10–20 s); reload the page |
| "Reconnecting" doesn't clear | `docker compose --profile core ps`; restart antikythera; the client reconnects on its own and keeps its place |
| Nothing ticks, LIVE flat | `docker compose --profile core start hermes`; if a resilience run was killed: `curl -s -X POST localhost:8474/reset` |
| Rows ≫ 1M or LIVE in the thousands at the start | `scripts/loadtest-reset.sh` (~45 s); talk through slide 7 meanwhile |
| STRESS left on | Dev → Medium (it's global to the stack) |
| Everything sluggish, write-behind slow | Docker VM memory: check `docker stats`; `MONGO_CACHE_GB=1`; close other stacks |
| Grafana panels empty | `docker compose --profile core --profile monitoring up -d`; give Prometheus 10 s |
| Anything else | Switch to the backup slide's screenshots and [`screenshots/demo/`](screenshots/demo); every step above has a picture |

### Afterwards

```bash
scripts/loadtest-reset.sh                                        # leave the stack clean
docker compose --profile core --profile monitoring down          # or stop it (keeps the data)
```
