#!/usr/bin/env bash
# Stops the AWS test box. The disk (and the seeded data) is kept, so the next remote-up needs no re-seed.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-down.sh [options]

Stops the Apeiron test box (it does not destroy anything). Compute billing ends once the instance
is stopped; the 30 GB encrypted disk stays and costs about \$$STOPPED_USD_PER_MONTH per month.
Running it on an already-stopped box does nothing.

To remove everything including the data, use scripts/remote-destroy.sh.

Options:
  --no-wait    return as soon as the stop is requested
  --dry-run    say what would happen and exit without touching AWS
  -h, --help   show this help
USAGE
}

WAIT=1
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-wait) WAIT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: would stop the EC2 instance from infra/aws (keeping its volume) and print the stopped-box cost."
  exit 0
fi

require aws terraform
if ! load_deployment; then
  info "Nothing is deployed (no Terraform state in infra/aws). Nothing to stop."
  exit 0
fi

case "$(instance_state)" in
  stopped | stopping)
    info "Instance $INSTANCE_ID is already stopped."
    ;;
  terminated | shutting-down)
    info "Instance $INSTANCE_ID is gone. Run scripts/remote-destroy.sh to clean up the rest."
    exit 0
    ;;
  *)
    info "Stopping instance $INSTANCE_ID..."
    aws_ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
    [ "$WAIT" = "0" ] || aws_ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
    ;;
esac

cat <<DONE
Stopped. Compute is no longer billed.
While stopped the box costs about \$$STOPPED_USD_PER_MONTH per month (the 30 GB gp3 volume), plus pennies for ECR.
Bring it back with scripts/remote-up.sh (the data is kept, so no re-seed). Remove everything with scripts/remote-destroy.sh.
DONE
