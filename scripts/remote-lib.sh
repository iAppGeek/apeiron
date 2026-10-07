# shellcheck shell=bash
# Shared helpers for the remote-*.sh scripts. Sourced, never run directly.
# Everything talks to AWS through the AWS CLI and Terraform; the box is reached over SSM (no SSH, no keys).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$REPO_ROOT/infra/aws"
export BOX_DIR=/opt/apeiron
export HOURLY_USD="0.16"
export STOPPED_USD_PER_MONTH="2.80"

info() { printf '%s\n' "$*" >&2; }
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require() {
  local cmd
  for cmd in "$@"; do
    command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' is required but not installed"
  done
}

# Prints the value of a Terraform output, or nothing when there is no state (nothing deployed yet).
tf_output() {
  terraform -chdir="$TF_DIR" output -raw "$1" 2>/dev/null || true
}

REGION=""
INSTANCE_ID=""

# Loads INSTANCE_ID and REGION from the Terraform state. Returns 1 when nothing is deployed.
load_deployment() {
  INSTANCE_ID="$(tf_output instance_id)"
  REGION="$(tf_output region)"
  [ -n "$INSTANCE_ID" ] && [ -n "$REGION" ]
}

aws_ec2() { aws --region "$REGION" ec2 "$@"; }
aws_ssm() { aws --region "$REGION" ssm "$@"; }

instance_state() {
  aws_ec2 describe-instances --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' --output text
}

instance_ip() {
  aws_ec2 describe-instances --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text
}

# Waits until the SSM agent on the instance reports Online (it takes a minute or two after a start).
wait_ssm_online() {
  local status=""
  info "Waiting for the SSM agent to come online..."
  for _ in $(seq 1 60); do
    status="$(aws_ssm describe-instance-information \
      --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
      --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)"
    if [ "$status" = "Online" ]; then return 0; fi
    sleep 5
  done
  die "SSM agent on $INSTANCE_ID did not come online (last status: ${status:-none})"
}

# Runs a shell script on the box over SSM and streams its output when it finishes.
# Usage: ssm_run <timeout-seconds> <script>
ssm_run() {
  local timeout="$1" script="$2" params id status="" out
  params="$(jq -n --arg c "$script" --arg t "$timeout" '{commands: [$c], executionTimeout: [$t]}')"
  id="$(aws_ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "apeiron remote script" --parameters "$params" \
    --query 'Command.CommandId' --output text)"
  while :; do
    sleep 4
    status="$(aws_ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
      --query 'Status' --output text 2>/dev/null || echo Pending)"
    case "$status" in
      Pending | InProgress | Delayed) ;;
      *) break ;;
    esac
  done
  out="$(aws_ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
    --query '[StandardOutputContent, StandardErrorContent]' --output text)"
  printf '%s\n' "$out"
  [ "$status" = "Success" ] || die "remote command ended with status $status"
}

# Asks for a plain yes. --yes (ASSUME_YES=1) skips the question; without a terminal the answer is no.
confirm() {
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  [ -t 0 ] || die "not a terminal; pass --yes to confirm non-interactively"
  local answer
  read -r -p "$1 [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || [ "$answer" = "yes" ]
}
