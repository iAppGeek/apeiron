#!/usr/bin/env bash
# STOP: deletes the AWS test box (the instance and its disk), so nothing is billed until the next START.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-down.sh [options]

STOP: runs 'terraform apply' in infra/aws with box=false (you approve the plan at Terraform's prompt). It deletes the
instance, its 30 GB disk (with the seeded data) and its public IP: the only resources that cost money. The free parts
(IAM, the OIDC provider, the security group, the ECR repositories) and the Cloudflare Tunnel stay, so the running cost
goes back to \$0 and the next scripts/remote-up.sh starts from a fresh box (and seeds again, about 3 minutes).
Running it when the box is already down does nothing.

To remove the free parts too, use scripts/remote-destroy.sh.

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
  echo "Dry run: would run 'terraform apply -var box=false' in infra/aws, deleting the instance and its disk."
  exit 0
fi

require aws terraform curl
if ! load_deployment; then
  info "The box is already down (no instance in the Terraform state). Running cost: \$0."
  exit 0
fi

info "About to delete instance $INSTANCE_ID and its disk, including the seeded data. The next START seeds again."
tf_apply_box false "$ALLOWED_CIDR"
if load_deployment; then
  die "the instance is still in the Terraform state (was the apply cancelled?)"
fi

cat <<DONE
Stopped: the box and its disk are deleted. Running cost: \$0.
Kept (free): IAM roles, the GitHub OIDC provider, the security group, the ECR repositories$([ -z "$(cf_output hostname)" ] || echo ", the Cloudflare Tunnel").
START again with scripts/remote-up.sh. Remove the free parts too with scripts/remote-destroy.sh.
DONE
