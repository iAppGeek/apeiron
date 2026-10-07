#!/usr/bin/env bash
# Destroys everything Terraform created for the AWS test box, including the data on its disk.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-destroy.sh [options]

Runs 'terraform destroy' in infra/aws: the instance and its disk (the seeded data), the security group,
the IAM roles, the GitHub OIDC provider (if Terraform created it) and the ECR repositories with their images.
This cannot be undone. To keep the data and stop paying for compute, use scripts/remote-down.sh instead.

You must type the confirmation phrase 'destroy apeiron' (or pass it with --confirm 'destroy apeiron').
Running it when nothing is deployed does nothing.

Options:
  --confirm PHRASE   the confirmation phrase, for non-interactive use
  --dry-run          show what would be destroyed and exit
  -h, --help         show this help
USAGE
}

PHRASE="destroy apeiron"
CONFIRM=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) CONFIRM="${2:?--confirm needs a value}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: would run 'terraform destroy' in infra/aws after you type '$PHRASE'."
  exit 0
fi

require terraform
if [ ! -f "$TF_DIR/terraform.tfstate" ] || [ -z "$(tf_output instance_id)" ]; then
  info "Nothing is deployed (no resources in the Terraform state). Nothing to destroy."
  exit 0
fi

info "About to DESTROY the Apeiron AWS stack, including the disk and the seeded data."
if [ -z "$CONFIRM" ]; then
  [ -t 0 ] || die "not a terminal; pass --confirm '$PHRASE'"
  read -r -p "Type '$PHRASE' to continue: " CONFIRM
fi
[ "$CONFIRM" = "$PHRASE" ] || die "confirmation phrase did not match; nothing was destroyed"

# Destroy ignores the variable values, but Terraform still wants a valid allowed_cidr.
terraform -chdir="$TF_DIR" init -input=false >/dev/null
terraform -chdir="$TF_DIR" destroy -var "allowed_cidr=192.0.2.1/32"
info "Destroyed."
