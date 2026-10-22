#!/usr/bin/env bash
# One-time setup of the free AWS parts (infra/aws with box=false), so START only has to create the paid instance.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-setup.sh [options]

Runs 'terraform apply' in infra/aws with box=false (you approve the plan at Terraform's prompt). It creates only the
parts that cost nothing while they sit there: the instance role and profile, the GitHub OIDC provider and push role,
the security group and the ECR repositories (empty while images come from GHCR). No instance, no disk, no IP.

Optional: scripts/remote-up.sh creates these too if they are missing. Run scripts/remote-tunnel.sh --apply first if
you want the Cloudflare Tunnel, so the instance role gets its permission to read the tunnel token from the start.

Options:
  --allowed-cidr CIDR  the same as for scripts/remote-up.sh (default: your public IP, /32)
  --dry-run            say what would happen and exit without touching AWS
  -h, --help           show this help
USAGE
}

ALLOWED_CIDR=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --allowed-cidr) ALLOWED_CIDR="${2:?--allowed-cidr needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: would run 'terraform apply -var box=false' in infra/aws (free parts only, no instance)."
  exit 0
fi

require terraform curl
if load_deployment; then
  die "the box is up; this would delete it. Use scripts/remote-down.sh to STOP it"
fi
tf_apply_box false "$ALLOWED_CIDR"
info "Free parts ready. Running cost: \$0. START with scripts/remote-up.sh."
