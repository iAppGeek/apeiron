# CP-5: Release review (Phase 8, Ship)

Branch `phase-8-ship`, PR https://github.com/iAppGeek/apeiron/pull/9 (not merged). Tag `cp-5` on the PR head.

## 1. What was built

- **Images workflow** (`.github/workflows/images.yml`): `workflow_dispatch` and `v*` tags only. Five services (antikythera, hermes, gaia, talos, pharos), amd64 on `ubuntu-latest` and arm64 on `ubuntu-24.04-arm` (native, no QEMU), push by digest with GHA cache, then a merge job per service builds the multi-arch manifest. Registry is GHCR by default (`GITHUB_TOKEN`); ECR through GitHub OIDC only when repo variable `REGISTRY_KIND=ecr` and `AWS_ROLE_ARN` are set (falls back to GHCR with a warning otherwise). Tags: `sha-<short>`, `latest` (main or version tag), semver on `v*`.
- **Terraform** (`infra/aws`): ECR repos (scan on push, keep last 10), default VPC, security group inbound only from `allowed_cidr` on 8080 (3001 optional, no SSH), `t4g.xlarge` AL2023 arm64 (AMI from the SSM parameter), 30 GB encrypted gp3, IMDSv2 required with hop limit 1, cloud-init (Docker, git, checksum-verified Compose plugin, clone, `.env.remote`), instance role (SSM core plus ECR pull scoped to the repos), GitHub OIDC provider and a push-only role trusted for `refs/tags/v*` and `refs/heads/main`. Local state, git-ignored. Outputs: instance id, public IP, web URL, ECR URLs, role ARN.
- **Scripts**: `scripts/remote-up.sh`, `remote-down.sh`, `remote-destroy.sh`, `remote-loadtest.sh` plus `remote-lib.sh`. All `set -euo pipefail`, shellcheck clean, `--help`, `--dry-run`, idempotent, stop by default; destroy needs the typed phrase `destroy apeiron`.
- **Docs**: `docs/hosting.md`, `docs/db-adapters.md` (contract, Oracle and KDB sketches), `docs/architecture.md` (Mermaid), README quick start and links.
- **Playwright E2E** (`e2e/`, package `@apeiron/e2e`): 18 tests in 5 files covering the plan's list, including group rows without order actions and the non-default-sort anchor case (asserting on the wire that the refresh path is the one exercised). Page object and pure parsing helpers (with unit tests) in `e2e/support`. `pnpm e2e`, `pnpm e2e:ci`.
- **CI**: new `e2e` job (compose `core` with `SEED_ROWS=200000`, health wait, `pnpm e2e:ci`, report uploaded on failure), plus `terraform` and `shellcheck` jobs. Actions bumped to current majors.
- **pharos**: `data-testid`s (`blotter`, `blotter-overlay`, `trader-select`, `dev-menu-button`) and the anchor fix below.

## 2. Deviations and findings

1. **Real bug found by the E2E anchor test, fixed in pharos (needs review).** Under a non-default sort (the `storeRefreshed` path) the viewport drifted: a refresh re-requests blocks ending with block 0, so the server's `newAbove` ("rows above the start of the client's last root block request") is about 0 and the client undercounted. Fix in `apps/pharos/src/grid/apply-delta.ts`: before a root refresh the applier notes the order at the top of the viewport, and on `storeRefreshed` scrolls to that order's new index. The move is accepted only if it is within the rows that arrived since the previous refresh plus 25 rows of slack (so a sort on a ticking column that reorders rows does not drag the viewport); otherwise it falls back to `newAbove`. The badge is topped up by the difference. Unit tests added in `apply-delta.spec.ts`. This took several iterations (cap measured from the wrong baseline, then too tight); the final behaviour was verified live (anchored order stays within a pixel across many refreshes) and the test passes 8 of 8 repeats. The server contract (Appendix D, `newAbove`) is unchanged but is arguably wrong for refreshes: Opus should decide whether the server should count against the topmost block of a refresh burst instead.
2. **Cost figures.** The plan and brief say about $0.13/hr. eu-west-2 on-demand `t4g.xlarge` is $0.1504/hr (Price List API) plus $0.005/hr public IPv4, so scripts and docs say about $0.16/hr and about $2.80/month stopped (gp3 $0.0928/GB-month).
3. **Compose**: added `WEB_BIND` and `GRAFANA_BIND` (default 127.0.0.1) so the box can publish the web port without opening anything else locally.
4. **Seeding order**: the server loads the database once at startup and does not retry an empty one, so the quick start seeds before starting `antikythera`, and `remote-up.sh` seeds before starting it.
5. **Tests are data-aware**: LIVE orders are picked inside a LIVE-filtered view and then isolated by an `orderId` text filter, because what is on top depends on history (after a stress run the top rows are pending) and a 200k seed has no PAUSED orders. Found by running the CI configuration locally before pushing.
6. **First ever dispatch** failed on a workflow syntax error (an empty `env:` and `runner.temp` in `working-directory`); fixed in commit "Fix images workflow syntax".
7. Playwright E2E mutates a few orders (cancel, pause/resume) and briefly toggles the Stress preset (restored in `finally`). `scripts/loadtest-reset.sh` restores the dataset.
8. Not done by design: no `terraform apply`, no AWS call that writes, no remote deploy. The remote scripts were only exercised with `--help`, `--dry-run` and the no-deployment paths.

## 3. Verification (raw)

### pnpm lint && typecheck && test && build
```
 Tasks:    12 successful, 12 total
Cached:    10 cached, 12 total
  Time:    1.708s 
 Tasks:    12 successful, 12 total
Cached:    10 cached, 12 total
  Time:    1.278s 
@apeiron/mnemosyne:test: [2m Test Files [22m [1m[32m4 passed[39m[22m[90m (4)[39m
@apeiron/mnemosyne:test: [2m      Tests [22m [1m[32m35 passed[39m[22m[90m (35)[39m
@apeiron/gaia:test: [2m Test Files [22m [1m[32m5 passed[39m[22m[90m (5)[39m
@apeiron/gaia:test: [2m      Tests [22m [1m[32m25 passed[39m[22m[90m (25)[39m
@apeiron/hermes:test: [2m Test Files [22m [1m[32m8 passed[39m[22m[90m (8)[39m
@apeiron/hermes:test: [2m      Tests [22m [1m[32m60 passed[39m[22m[90m (60)[39m
@apeiron/logos:test: [2m Test Files [22m [1m[32m12 passed[39m[22m[90m (12)[39m
@apeiron/logos:test: [2m      Tests [22m [1m[32m156 passed[39m[22m[90m (156)[39m
@apeiron/talos:test: [2m Test Files [22m [1m[32m15 passed[39m[22m[90m (15)[39m
@apeiron/talos:test: [2m      Tests [22m [1m[32m123 passed[39m[22m[90m (123)[39m
@apeiron/antikythera:test: [2m Test Files [22m [1m[32m40 passed[39m[22m[90m (40)[39m
@apeiron/antikythera:test: [2m      Tests [22m [1m[32m434 passed[39m[22m[90m (434)[39m
@apeiron/iris:test: [2m Test Files [22m [1m[32m2 passed[39m[22m[2m | [22m[33m1 skipped[39m[90m (3)[39m
@apeiron/iris:test: [2m      Tests [22m [1m[32m9 passed[39m[22m[2m | [22m[33m2 skipped[39m[90m (11)[39m
@apeiron/e2e:test: [2m Test Files [22m [1m[32m1 passed[39m[22m[90m (1)[39m
@apeiron/e2e:test: [2m      Tests [22m [1m[32m8 passed[39m[22m[90m (8)[39m
@apeiron/pharos:test: [2m Test Files [22m [1m[32m34 passed[39m[22m[90m (34)[39m
@apeiron/pharos:test: [2m      Tests [22m [1m[32m389 passed[39m[22m[90m (389)[39m
 Tasks:    12 successful, 12 total
Cached:    10 cached, 12 total
  Time:    2.82s 
 Tasks:    8 successful, 8 total
Cached:    7 cached, 8 total
  Time:    651ms 
```

### terraform
```
fmt -check: ok
Success! The configuration is valid.

Plan: 21 to add, 0 to change, 0 to destroy.
Changes to Outputs:
```

### shellcheck scripts/*.sh
```
no findings (ShellCheck 0.11.0)
```

### E2E, local, full suite against the 1M-row stack (Medium preset)
```
Running 18 tests using 1 worker
  ✓   1 [chromium] › tests/actions.e2e.ts:31:3 › order actions › Pause and Resume round trip (3.9s)
  ✓   2 [chromium] › tests/actions.e2e.ts:48:3 › order actions › Cancel asks for confirmation and then cancels (4.3s)
  ✓   3 [chromium] › tests/actions.e2e.ts:80:3 › order actions › a finished order offers no actions (1.9s)
  ✓   4 [chromium] › tests/dev-menu.e2e.ts:12:3 › dev menu › switches the wire codec to msgpack and back, and live updates keep flowing (1.6s)
  ✓   5 [chromium] › tests/dev-menu.e2e.ts:36:3 › dev menu › the stress preset shows a STRESS pill and Medium takes it away (645ms)
  ✓   6 [chromium] › tests/grid.e2e.ts:6:3 › grid › loads with the row count, the summary and the column headers (962ms)
  ✓   7 [chromium] › tests/grid.e2e.ts:33:3 › grid › sorts numbers and text, ascending and descending (2.3s)
  ✓   8 [chromium] › tests/grid.e2e.ts:51:3 › grid › clicking a header cycles ascending, descending, then back to unsorted (1.1s)
  ✓   9 [chromium] › tests/grid.e2e.ts:67:3 › grid › set filter keeps only the chosen value and shrinks the row count (2.1s)
  ✓  10 [chromium] › tests/grid.e2e.ts:85:3 › grid › number filter: greater than a threshold (2.0s)
  ✓  11 [chromium] › tests/grid.e2e.ts:103:3 › grid › date filter: equals the value date of the first row (1.7s)
  ✓  12 [chromium] › tests/grid.e2e.ts:120:3 › grid › switching trader narrows the grid to that trader and back again (971ms)
  ✓  13 [chromium] › tests/grouping.e2e.ts:8:3 › grouping › group by pair, aggregate, and drill down into a group (1.5s)
  ✓  14 [chromium] › tests/grouping.e2e.ts:53:3 › grouping › group rows offer no order actions; their orders do (1.0s)
  ✓  15 [chromium] › tests/live.e2e.ts:5:3 › live updates › a LIVE row ticks: its price cells flash and change value (2.9s)
  ✓  16 [chromium] › tests/live.e2e.ts:29:3 › live updates › a new order arrives at the top of the default view (760ms)
  ✓  17 [chromium] › tests/live.e2e.ts:44:3 › live updates › scrolled down: the same orders stay in place while the badge counts new ones (4.7s)
  ✓  18 [chromium] › tests/live.e2e.ts:70:3 › live updates › anchoring also holds under a non-default sort (the storeRefreshed path) (6.6s)
  18 passed (41.6s)
```
Earlier the whole suite was also run 3 times in a row (`--repeat-each=3`): 54 passed (2.3 min).

### E2E, CI
PR checks on the final code (all pass): `verify`, `terraform`, `shellcheck`, `e2e (containerised stack, 200k rows)` (about 3 min). Run: https://github.com/iAppGeek/apeiron/actions/runs/37638288523. A local rehearsal of the CI configuration (separate compose project, 200,000 rows) found the data-dependence issue in deviation 5 before it reached CI.

### Images workflow
Run: https://github.com/iAppGeek/apeiron/actions/runs/37637706287 (dispatched with `gh workflow run images.yml --ref phase-8-ship`; 10 build jobs and 5 manifest jobs succeeded, GHCR).
```
$ docker buildx imagetools inspect ghcr.io/iappgeek/apeiron/antikythera:sha-cda5f07
MediaType: application/vnd.oci.image.index.v1+json
Digest:    sha256:7f3b4911c22e47e8be76dd16e83be33f011392f88ce381e39ccaf972e1883ac3
Manifests:
  Platform:  linux/arm64   (sha256:9693082fc036def920ce122043726fa2d54c6610afe1871cc3f479bb63df741f)
  Platform:  linux/amd64   (sha256:c9d2132fbd079d6d4e27f4642ae17c953cd8a4baab488678d76711011b00f0d6)
```
pharos is likewise a two-platform index (`sha256:c1ae5b8e...`). The GHCR packages are probably still private until their visibility is set to public (see `docs/hosting.md`).

## 4. Security notes

- Security group: one ingress rule on 8080 from `allowed_cidr` (validation rejects `0.0.0.0/0` and `::/0`); no SSH, no key pair; egress open (pulls, SSM). Mongo, NATS, the server, Prometheus and (by default) Grafana stay on loopback on the box; nginx does not proxy `/metrics` or `/health`.
- IAM: instance role = `AmazonSSMManagedInstanceCore` plus `ecr:GetAuthorizationToken` (must be `*`) and pull actions on the five repositories only. GitHub role: OIDC `aud=sts.amazonaws.com`, `sub` in `repo:iAppGeek/apeiron:ref:refs/tags/v*` and `...:ref:refs/heads/main`, push actions on the five repositories only. Review point: `refs/heads/main` also lets any workflow on main (not just Images) push to ECR.
- IMDSv2 required, hop limit 1; encrypted volume; Grafana admin password generated on the box, never in the repo.
- No secrets in the repo: `.env*` (except the example), `*.tfstate*`, `*.tfvars`, `*.tfplan`, `.terraform/` ignored; `.terraform.lock.hcl` is committed. Images run non-root. Plain HTTP to the box (documented).
- AWS credentials in this environment are the account root user; nothing was written to AWS. `terraform plan` was run read-only with a placeholder CIDR (it reads the default VPC and the AMI parameter).

## 5. Versions

Node 25.8 locally (containers `node:24-slim`), pnpm 10.33.0, TypeScript ~6.0.3, Playwright `@playwright/test` 1.63.0, Terraform 1.16.4 (config requires >= 1.14), AWS provider `~> 6.67` (6.67.0), Docker 29.8.1, Compose plugin on the box v5.6.0, ShellCheck 0.11.0. Actions: checkout v7, setup-node v7, cache v6, upload-artifact v7, download-artifact v8, pnpm/action-setup v6, hashicorp/setup-terraform v4, docker/setup-buildx v4, build-push v7, login v4, metadata v6, aws-actions/configure-aws-credentials v6, amazon-ecr-login v2. Images unchanged: mongo 9.0, nats 2.15-alpine, nginx-unprivileged 1.30, prometheus v3.15.0, grafana 13.2.

## 6. Known weaknesses

- The remote scripts and the user-data bootstrap are untested against real AWS (by instruction). Most likely first-run problems: GHCR packages still private, cloud-init timing, the Compose release URL.
- Anchor fix (deviation 1) is client-side and heuristic (25-row slack); the first one or two refreshes after scrolling can still lose a row (the test allows up to 3 rows of settling, then requires no further drift).
- `e2e` depends on live data: tests tolerate a changing top of the grid but assume at least a few LIVE orders and `E2E_MIN_ROWS` rows (150k in CI).
- Plain-HTTP access to the box; Grafana only via SSM port forward.
- `remote-up.sh` runs `docker compose pull` of the monitoring images from Docker Hub on the box (rate limits apply to anonymous pulls).
- CI e2e builds the images with no layer cache (about 3 minutes total today).

## CP-5 fixes (after review: APPROVE WITH FIXES)

- **F1** `remote-up.sh`: the remote script waits (up to 15 minutes) for `$BOX_DIR/.bootstrapped` before `cd`.
- **F2** Terraform gets `registry_kind` (`ghcr` default, or `ecr`) and `ghcr_owner` (`iappgeek`); the box's registry follows them (plan output: `registry = "ghcr.io/iappgeek"`), `registry` still overrides. `remote-up.sh --registry-kind`. `docs/hosting.md` states that GHCR packages must be public for a token-less pull; nothing in the repo changes package visibility.
- **F3** The OIDC trust is `repo:<repo>:environment:release` only. `images.yml` build and merge jobs declare `environment: ${{ kind == 'ecr' && 'release' || null }}`, so GHCR runs declare none. `docs/hosting.md` explains protecting the `release` environment (deployment branches and tags: `main`, `v*`). The `|| null` form is untested for ECR runs (they need AWS); the GHCR path was exercised by CI/dispatch syntax checks only after this change, see the images run noted below.
- **F4** The seed count is parsed with `grep -Eo '^[0-9]+$'`; an unreadable value prints mongosh's output and fails.
- **F5** `anchorOnOrder` returns false when the order moved more than the arrivals explain, so the `newAbove` fallback (and its badge count) applies. Unit test: ticking sort with inserts above (`falls back to newAbove ...`), plus the no-arrivals case.
- **F6** `waitForTimeout` removed from `e2e/support/blotter.ts`: column reveal waits for the header, resting offset and row-count settling poll until three readings agree.
- **F7** `ssm_run` gives up after `timeout + 120 s` or 5 consecutive polling errors.
- **F8** The settling rule is a pure `hasSettled` in `e2e/support/parse.ts`, with tests (11 unit tests in the e2e package).

Verification after the fixes: `pnpm lint && typecheck && test && build` pass; `terraform fmt -check`, `validate` pass and the read-only plan still shows 21 to add; `shellcheck scripts/*.sh` clean; full `pnpm e2e` against the 1M stack: 18 passed (49 s). No AWS resource was created or modified.
