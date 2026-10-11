# PLAN2.5: Node vs Java performance comparison

Status: **agreed draft** (2026-10-11), revised after review. **Starts after PLAN2 CP-10.** It runs again after the optional PLAN2 phase 2.8.

## Goal

A fair, repeatable comparison of the Node and Java blotters under identical load. You can watch it live in Grafana,
and each run ends with a recorded report whose figures are good enough for the README.

## Fairness rules (enforced by config and the comparison script)

- **Identical limits.** Both blotter containers get the same `cpus` (default `2.0`) and `mem_limit` (`3g`) in compose.
- **Same input.**
  - Both blotters always ingest the same feed (hermes, helios, themis), so feed processing costs both the same.
  - Each run starts from `scripts/loadtest-reset.sh` with the same seed, the same preset and the same stress window.
- **Warm before measuring.** talos starts only after both blotters report ready, plus a 60 s soak, so JIT warm-up and
  snapshot load are excluded from steady-state figures. Startup is reported separately.
- **One at a time for latency.** A/B runs (talos against Node, reset, talos against Java) produce the headline
  figures. A simultaneous mode (25 clients on each) exists for live side-by-side viewing, but it shares host CPU, so
  its figures are labelled as such.
- **Host recorded.** Each report records the host: CPU model, cores, Docker VM memory, OS, and image tags.

## Build phases and done criteria

| # | Phase (PR) | Scope | Done when |
|---|---|---|---|
| 2.5.1 | **Metrics parity and scraping** | Prometheus scrapes `antikythera-java`. Relabelling adds `impl="node"` or `impl="java"` to both blotter jobs. The startup gauge `apeiron_startup_seconds{stage="snapshot\|catchup\|prices\|warmup"}` (PLAN1 Appendix 1I) is charted for both. Recording rules for p50/p95/p99 of `getrows_duration`, `flush_duration`, `event_age_at_send`, `command_duration` and `delta_bytes`. Runtime metrics are kept as they are (Node: `nodejs_*`; Java: `jvm_*` from `client_java`) and are compared only in their own panels | `curl :9090/api/v1/query` returns every `apeiron_*` series for both `impl` values; a test in each blotter lists the exported metric names and the two lists match |
| 2.5.2 | **Comparison dashboard** | A provisioned Grafana dashboard, "Apeiron: Blotter comparison", where every panel shows Node and Java in fixed colours, with a ratio stat (Java ÷ Node) where it makes sense. Rows: **Overview** (connections, clients, rows, ready time per stage); **Latency** (getRows p50/p95/p99, view-change cold builds, server-side tick-to-send from `event_age_at_send`, flush duration against the 40 ms budget, command round trip); **Throughput** (WS messages and bytes by type and codec, delta size); **Resources** (CPU cores from `process_cpu_seconds_total`, RSS, against the container limits); **Runtime** (Node heap, GC and event-loop lag beside JVM heap used/committed, GC pause time and writer-thread lag); **Backpressure and errors** (conflation, `SLOW_CONSUMER`, error codes). Template variables: time range presets for a run, and the codec | The dashboard loads with no empty panels while both blotters run; a screenshot is attached to the PR |
| 2.5.3 | **Load runs and report** | talos: `--server node\|java` (already added in PLAN2 2.7), `--split` for 25 + 25 simultaneous clients, and results JSON tagged with `impl`, the host and image tags. `scripts/compare-blotters.sh`: reset → wait until both are ready → soak → talos on Node (300 s, stress 120–180 s) → reset → the same on Java → writes `docs/benchmarks/COMPARE-<date>.md` with the README-style table (bytes per client, tick-to-screen p50/p95/p99, last hop, getRows warm, cold view change, startup burst, command ack, CPU median and max, RSS median and max, lag p99 and longest stall) side by side, a ratio column, Grafana links for each run's time window, and the startup stages | One recorded run for each codec (JSON and msgpack) is committed under `docs/benchmarks/`; the README gets a "Node vs Java" section quoting only those runs |
| 🔍 | **OPUS REVIEW CP-11: Comparison verdict** | | Whether the method is fair; that the figures match the dashboards; a written verdict (where Java wins, where it doesn't, why, and what PLAN2 phase 2.8 would change) |

## Optional

- **Container-level metrics** (cAdvisor) for runtime-neutral CPU and memory figures. cAdvisor is limited on Docker
  Desktop for macOS, so the process metrics stay the primary source, and cAdvisor applies on the Linux/AWS box only.
- **Re-run after 2.8** (Java concurrency optimisation) to show the gain in the startup burst and in `getRows` p99.
