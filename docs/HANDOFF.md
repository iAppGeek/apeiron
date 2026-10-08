# Apeiron: Session Handoff (2026-10-08)

This is the compact context for an agent taking over. **Read this file, then `docs/PLAN.md`** (especially its final section, "Status & handoff", and Appendices B–G). The plan is the source of truth for contracts and decisions; this file holds the current state and the prompt to carry on.

---

## 1. What we're building
**Apeiron** (ἄπειρον, "the infinite") is an "Infinity Blotter" POC. It's a React + AG Grid Enterprise 36 (SSRM) blotter showing **1M+ FX algo orders × 50 columns**, with live ticking prices (3×/s), new orders arriving on top, filter, sort, group, and Cancel/Pause/Resume actions. It's backed by a Node WebSocket server that holds all rows in memory and serves **50 concurrent clients**. It's a pnpm + Turborepo monorepo, and everything runs in Docker.

- **Repo:** `~/Development/apeiron`, GitHub **`iAppGeek/apeiron`** (public). The remote is HTTPS with a repo-local `gh` credential helper; `gh` is logged in as iAppGeek.
- **User:** Anthony Ladas. They want work to continue autonomously through the plan with PR → review → fix → merge loops, then a demo pack.

### Packages (codenames)
| Path | Role |
|---|---|
| `apps/pharos` | Web: Vite 8, React 19, AG Grid 36 SSRM, Web Worker WebSocket transport, live deltas, anchoring and badge, context-menu actions, nginx image |
| `apps/antikythera` | Server: Fastify 5 + `ws`, SharedArrayBuffer columnar store, query engine (filter/sort/group/agg), incremental views, budgeted flush loop, per-client tracking and deltas, metrics |
| `apps/hermes` | Mock middleware: NATS JetStream price feed and order lifecycle, presets medium/stress |
| `apps/gaia` | Seeder (1M deterministic orders) |
| `apps/talos` | 50-client load-test harness |
| `packages/logos` | Shared schema, 50 columns, protocol, codecs (json/msgpack), filter model, lifecycle maths |
| `packages/mnemosyne` | `OrderRepository` (Mongo plus in-memory) and its contract suite |
| `packages/iris` | NATS/JetStream adapter |
| `e2e/` | Playwright E2E (`tests/*.e2e.ts`) and the resilience suite (`tests/resilience/*.e2e.ts`, `support/` driver, model, oracle, faults, tiers) |
| `infra/` | Compose (profiles: core, seed, monitoring, loadtest, resilience), Dockerfiles, nginx, Prometheus/Grafana, `aws/` Terraform |
| `scripts/` | `loadtest-reset.sh`, `remote-*.sh` (AWS, paused) |

### Run it
```bash
docker compose --profile core --profile monitoring up -d   # web :8080, API :4000, Grafana :3001, Prometheus :9090
scripts/loadtest-reset.sh                                  # re-seed to 1M rows, empty JetStream, restart on Medium (~45s)
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm e2e                                                   # Playwright, against :8080
pnpm e2e:resilience:quick                                  # ~14 min, all 8 scenarios (standard)
pnpm e2e:resilience                                        # ~27 min, full suite (release/demo)
pnpm e2e:resilience:smoke                                  # CI tier
pnpm --filter @apeiron/talos start -- --clients 50 --duration 300 --codec json
```

**Before a demo, run `scripts/loadtest-reset.sh`:** test runs grow the table to about 1.5M rows. The Docker VM is about 6GB, and Mongo's cache is capped by `MONGO_CACHE_GB=1`.

---

## 2. Progress
| Phase | State | PR / tag | Review file |
|---|---|---|---|
| 1 Scaffold, 2 Data | ✅ merged | #1, #2 / cp-1 | CP-1-review |
| 3 Engine | ✅ merged | #3 / cp-2 | CP-2-review |
| 4 Grid, 5a Live server, 5b Live client | ✅ merged | #4–#6 / cp-3 | PHASE-4, PHASE-5A, CP-3 reviews |
| 6 Actions | ✅ merged | #7 | PHASE-6-review |
| 7 Observability + load | ✅ merged | #8 / cp-4 | CP-4-diagnosis, CP-4-review |
| 8 Ship (AWS) | ✅ merged; **AWS paused**, never deployed | #9 / cp-5 | CP-5-review |
| 9 Resilience suite | 🟡 **CP-6 fixes F1–F4 in progress** (Sonnet agent), then merge #10 | #10 / cp-6 | CP-6-review (on branch `phase-9-resilience`) |
| 10 Demo pack | ⏳ **next; done by Opus**, see §6 | (none) | (none) |

**CP-6 fixes, from `docs/checkpoints/CP-6-review.md` on the PR branch:**
- **F1:** keep the scroll position across a reconnect (S4 asserts V2 returns to its old depth).
- **F2:** one full-tier run and one quick-tier run on the final code.
- **F3:** find the flaky antikythera unit test, which failed once under parallel load.
- **F4:** `TESTING.md` additions: the independence caveat, the S7 `lastUpdateTime` relaxation, V3 grouped by status.
- **Then:** merge PR #10 and run `loadtest-reset.sh`.

**If PR #10 isn't merged when you pick this up,** check its state with `gh pr view 10 --repo iAppGeek/apeiron`. Look at the branch for uncommitted work and at `e2e/results/*.json`, finish F1–F4, verify, then squash-merge.

---

## 3. Working process
- **Sonnet subagents** (Agent tool, `model: sonnet`) implement one phase per branch `phase-N-<name>` and open a PR without merging. At a checkpoint they tag `cp-N` and write `docs/checkpoints/CP-N.md`, then stop.
- **Opus reviews** each one:
  - runs the checks in a clean worktree (`git worktree add /tmp/x cp-N`);
  - verifies independently: live WebSocket scripts against Mongo, DevTools, profiling;
  - writes `docs/checkpoints/CP-N-review.md` (APPROVE / APPROVE WITH FIXES / REWORK);
  - records any contract change in `docs/PLAN.md`.
- **Sonnet then applies the fixes and squash-merges.** Small fixes can be made by Opus directly.
- **Usage limits** often interrupt agents. Resume with SendMessage to the agent: state the branch, the last commit and the uncommitted files, and say "resume where you stopped".
- **While an agent uses the main checkout,** edit the plan or docs in a separate worktree of `main` to avoid touching its uncommitted work.
- **Mandatory conventions:** from the user's `~/.claude/CLAUDE.md`, TypeScript strict, explicit return types, no `any`, `type` over `interface`, a `*.spec.ts(x)` beside every new module, `vi.*` mocks only, Playwright under `e2e/tests/*.e2e.ts`, no TODO comments. Also: **always use the latest stable versions** (exceptions recorded: TypeScript 6.0.x, because typescript-eslint blocks 7; `@types/node` ^24 to match the Node 24 runtime). Check library APIs with context7.
- **Commit trailer:** `Co-Authored-By: Claude <Model> <noreply@anthropic.com>`. **PR trailer:** `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **AWS is PAUSED by the user.** Never run `terraform apply`, `remote-up` or any AWS write. GHCR package visibility and the GitHub `release` environment are the user's decisions.

---

## 4. Key decisions (binding; full log in PLAN.md "Status & handoff")
- **Architecture:** server-side SSRM (grouping needed); the AG Grid watermark is accepted; frames are self-describing (text = JSON, binary = msgpack); NATS events carry absolute values and are idempotent; the server acks after persisting; one tracked view per client; adds are applied before updates.
- **Data:** nulls are NaN in typed arrays and sort smallest; date filters are UTC-day granular; `inRange` is inclusive; `count` = `childCount`; price decimals follow the pair.
- **Performance (CP-4):**
  - untracked views go stale, rebuilds are deferred, and the flush has a 40ms budget with a shared tick log;
  - `FLUSH_MS` is 50;
  - **tick-to-screen is end to end**, measured via `delta.srcTs`;
  - Mongo's cache is capped at 1GB.
- **Resilience (CP-6):**
  - three checks: model vs server, server vs screen, invariants plus minimums;
  - Toxiproxy faults;
  - three tiers (quick, full, smoke);
  - S7 lets `lastUpdateTime` step back after a server restart, because price-only changes aren't persisted;
  - V3 is grouped by status.

---

## 5. Headline results (for the demo)
- **Load (50 clients × 300s, stress 120–180s; CP-4 final):**

| Measure | Result |
|---|---|
| Tick-to-screen p95, end to end | **65ms** (json) / 62.5ms (msgpack) |
| getRows warm p95 | 18ms |
| View change p95 | 38ms |
| Event-loop lag p99 | 19–23ms |
| RSS | about 1.1GB |
| Command ack p95 | 66ms |
| Server CPU median | 22–24% of one core |
| msgpack vs json | about 11% fewer bytes, same latency |

- **Before the CP-4 fix,** the server collapsed (15s timeouts); a CPU profile found a flush-loop death spiral.
- **Browser (CP-3 DevTools):** 103–120 FPS during deep scroll and under stress; the anchor holds at row 312k for 15s while 75 orders arrive above; JS heap 27–48MB.
- **Actions:** click to status on screen p50 58ms / p95 89ms.
- **E2E:** 18/18.
- **Resilience:** all 8 scenarios green across the quick and full tiers. **7 real sync bugs found and fixed:** stale rows after many adds, a page frozen after restart, `lastUpdateTime` going backwards, `getRows` timeout never retried, the root-refresh seam, the seam after a purge, and rows past a reloaded block's end going stale.
- **Known limitations:**
  - non-default-sort anchoring can drift about 1 row on the first refresh;
  - a connect storm of 50 cold views takes about 0.2–0.4s;
  - rare single event-loop stalls of 200–350ms;
  - `lastUpdateTime` steps back briefly after a server restart;
  - AWS is untested.

---

## 6. CONTINUATION PROMPT (paste this to the next agent, Opus recommended)

> You are continuing the **Apeiron** Infinity Blotter POC in `/Users/anthonyladas/Development/apeiron` (GitHub `iAppGeek/apeiron`). Read `docs/HANDOFF.md` and `docs/PLAN.md` (final section "Status & handoff", plus Appendices B–G) first. Follow the working process in HANDOFF §3, including the user's CLAUDE.md conventions, latest-stable versions, commit trailers, and **no AWS actions**.
>
> **Step 1: finish phase 9.**
> - Check PR #10 (`gh pr view 10 --repo iAppGeek/apeiron`) and the `phase-9-resilience` branch.
> - If the CP-6 fixes F1–F4 (`docs/checkpoints/CP-6-review.md`) aren't complete, finish them: delegate to a Sonnet subagent, or do it yourself.
> - Verify: lint, typecheck, test, build, `pnpm e2e`, CI green.
> - Squash-merge #10.
> - Run `scripts/loadtest-reset.sh` so the dataset is 1M rows.
> - Update the progress table in PLAN.md "Status & handoff".
>
> **Step 2: phase 10, the demo pack. Do this yourself, as Opus.**
> 1. Bring up `core` + `monitoring` from a clean state. Run `pnpm e2e`, `pnpm e2e:resilience:quick`, and one 50-client talos run (300s, both codecs). Record the outputs.
> 2. **Chrome DevTools validation** of the UI at `http://localhost:8080` (use the chrome-devtools MCP tools):
>    - flat view, deep scroll FPS and long tasks, the anchor and badge, grouping with aggregates, filters, the context-menu actions, the stress preset with the STRESS pill, the codec switch both ways;
>    - console errors (expect only the AG Grid licence banner) and JS heap;
>    - **screenshots** into `docs/screenshots/demo/`: hero, grouped, filtered, actions, stress status bar, the Grafana dashboard during load, and a resilience result.
> 3. Write **`docs/USER-GUIDE.md`**:
>    - prerequisites; starting everything (compose profiles, seeding, ports); using the blotter (traders, filters, grouping, actions, Dev menu, status bar);
>    - running the load test and the resilience tiers; Grafana; troubleshooting (Docker memory, re-seed, reset);
>    - known limitations.
> 4. Write **`docs/TECHNICAL-OVERVIEW.md`**: architecture with diagrams (reuse `docs/architecture.md`); the data flow from seed to load to live events to flush to deltas to the grid; the key algorithms; **benchmarks and timings** (tables from §5 plus your fresh runs); the resilience method and the 7 bugs; JSON vs msgpack; the CP-4 death-spiral story; the limits found; and next steps (AWS deploy, Oracle/KDB adapters, worker threads if needed).
> 5. Build the **presentation for the development team** as a slide deck. Use the Artifact tool's quickstart with `intent: "slides"`, or a `.pptx` if the user prefers. About 12–16 slides:
>    - the problem and goals; the architecture; how live updates work; scaling to 50 clients;
>    - the benchmarks with charts; the resilience suite and the bugs it found; a live demo script;
>    - lessons learned (the death spiral, end-to-end latency, testing pyramid); limitations and next steps.
>    - Put the speaker notes and a **live demo run-sheet** in `docs/DEMO-SCRIPT.md`.
> 6. Link everything from `README.md`. Commit on branch `phase-10-demo`, open a PR, and merge once CI is green.
> 7. Report to the user with links to the guide, the overview, the deck and the screenshots.
>
> **Do not:** deploy to AWS; change GHCR or GitHub settings; or weaken any test or target to make it pass.
