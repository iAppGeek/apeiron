# CP-5 Review: Release (Phase 8)

- **Reviewer:** Opus 5.5
- **Reviewed:** tag `cp-5`, PR #9 (`phase-8-ship`), `docs/checkpoints/CP-5.md`, plus a `/code-review high` of the PR diff
- **Date:** 2026-10-07

## Verdict: APPROVE WITH FIXES
Phase 8 is about 95% complete. CI is green: verify, terraform, shellcheck and e2e on 200k rows. The E2E suite passes **18/18 locally (my run)**, and 54/54 with `--repeat-each=3` (agent's run). Multi-arch images are built on native runners, and the read-only Terraform plan shows 21 resources. **No AWS resources were created.**

**User decision (2026-10-07):** the AWS work is paused after these fixes. Nothing gets deployed; `remote-up` is for the user to run later.

## Security review (done by hand)
All of this checks out:
- **Network:** the security group allows only `allowed_cidr` on 8080, and on 3001 only if opted in. `0.0.0.0/0` is rejected by validation. There's no SSH; access is SSM only.
- **Instance:** IMDSv2 required with hop limit 1, so containers can't reach the instance credentials. The disk is an encrypted gp3 volume.
- **IAM:** the instance role has SSM plus **pull-only** ECR access, scoped to the stack's repos.
- **Compose:** every DB, bus and metrics port is bound to loopback, and the web and Grafana ports are loopback by default.
- **Grafana on the box:** a random admin password generated there, which never leaves it.
- **Repo:** no secrets (scanned), and no Playwright reports committed.

## Required fixes (Sonnet applies them on `phase-8-ship`, then merges)
- **F1. `remote-up.sh` first-boot race.** The remote script runs `cd "$BOX_DIR"` *before* waiting for `.bootstrapped`. On first boot, SSM is often online before cloud-init has cloned the repo, so the deploy fails. Fix: wait for `$BOX_DIR/.bootstrapped` first, then `cd`.
- **F2. Registry default mismatch.** `images.yml` pushes to **GHCR** by default, but Terraform and `remote-up` default the box to **ECR**, which is empty, so the first deploy can't pull.
  - Make the remote default follow the same `REGISTRY_KIND` choice.
  - Simplest is a Terraform variable `registry_kind` (`ghcr` default, or `ecr`) with `ghcr_owner`.
  - Document that GHCR packages must be **public** for a token-less pull. The user decides when to set that, since it's a visibility change on their GitHub account.
- **F3. OIDC trust is too broad.** The push role trusts `ref:refs/heads/main`, so any workflow on main could assume it.
  - Trust only the GitHub **environment** `release`: `repo:<repo>:environment:release`.
  - Have the images.yml jobs that push to ECR declare `environment: release`.
  - Document protecting that environment, with deployment rules for main and `v*` tags.
- **F4. Seed check robustness.** `[ "${count:-0}" -eq 0 ]` breaks on non-numeric mongosh output. Parse the number defensively (`grep -Eo '^[0-9]+$'`) and fail with a clear message when it can't be read.
- **F5. Anchor bug when the anchored row reorders.** In `apply-delta.ts`, `anchorOnOrder` returns `true` and zeroes `pendingShift` when the anchored order moved further than the slack, so the `newAbove` fallback is skipped. Fix: return `false` in that case so the fallback applies, and add a unit test (ticking-column sort plus inserts above).
- **F6. Fixed sleeps in E2E.** Replace the `page.waitForTimeout(50)` and `waitForTimeout(300)` calls in `e2e/support/blotter.ts` with `expect.poll` or `waitForFunction` on the real condition.
- **F7. `ssm_run` can poll forever.** Add an overall deadline (`timeout` + 120s), and fail after N consecutive API errors.
- **F8. Conventions.** Add `e2e/support/blotter.ts.spec`-style unit tests for its pure helpers, or move them into `parse.ts`, which already has tests. The user's CLAUDE.md requires a test file per new module.

Then:
1. Run `pnpm lint && typecheck && test && build`, `terraform fmt`/`validate`, `shellcheck`, and the full E2E locally.
2. Get CI green.
3. Squash-merge PR #9.

## Accepted
- **The anchor fix for non-default sorts:** tracking the order at the top across a background refresh. The three-attempt stop rule was exceeded, but the agent's choice to ship a bounded fix and flag it was reasonable. The residual (one row of drift on the first refresh after scrolling) is documented as a limitation.
- **Cost figures:** corrected to about $0.16/hr running and about $2.80/month stopped, checked against the Price List API.
- **Other additions:** `remote-lib.sh`, `WEB_BIND`/`GRAFANA_BIND`, the terraform and shellcheck CI jobs, and the `data-testid`s.
- **Untested on real AWS:** cloud-init and `remote-up`. AWS is paused per the user, and this is flagged in the plan's handover section.
