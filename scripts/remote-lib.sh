# shellcheck shell=bash
# Shared helpers for the remote-*.sh scripts. Sourced, never run directly.
# Everything talks to AWS through the AWS CLI and Terraform; the box is reached over SSM (no SSH, no keys).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TF_DIR="$REPO_ROOT/infra/aws"
CF_TF_DIR="$REPO_ROOT/infra/cloudflare"
export BOX_DIR=/opt/apeiron
export HOURLY_USD="0.16"

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

# The same for the persistent tunnel stack (infra/cloudflare): empty when no tunnel has been set up.
cf_output() {
  terraform -chdir="$CF_TF_DIR" output -raw "$1" 2>/dev/null || true
}

# Applies infra/aws with box=true (the instance, its disk and public IP: the only paid resources) or box=false (only
# the free parts). Every caller passes the same settings, so the free parts never drift between START and STOP: the
# allowed CIDR (the one given, or this machine's public IP when it is empty) and, once infra/cloudflare exists, the
# tunnel. Further arguments go to terraform apply. Terraform shows the plan and asks you to approve it.
# Usage: tf_apply_box true|false <allowed CIDR, or ""> [terraform apply arguments...]
tf_apply_box() {
  local box="$1" cidr="$2" host
  shift 2
  if [ -z "$cidr" ]; then
    cidr="$(curl -fsS -m 10 https://checkip.amazonaws.com | tr -d '[:space:]')/32" ||
      die "could not detect your public IP; pass --allowed-cidr"
  fi
  local -a vars=(-var "box=$box" -var "allowed_cidr=$cidr")
  host="$(cf_output hostname)"
  [ -z "$host" ] || vars+=(-var "public_hostname=$host" -var "tunnel_token_parameter=$(cf_output tunnel_token_parameter)")
  terraform -chdir="$TF_DIR" init -input=false >/dev/null
  terraform -chdir="$TF_DIR" apply "${vars[@]}" "$@"
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

# Prints the blotter's base URL: https://<host name> when the box is behind the tunnel, otherwise http://<ip>:8080.
web_url() {
  local host
  host="$(tf_output public_hostname)"
  if [ -n "$host" ]; then printf 'https://%s\n' "$host"; else printf 'http://%s:8080\n' "$(instance_ip)"; fi
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

# Runs a shell script on the box over SSM and prints its output when it finishes.
# Gives up after the script's own timeout plus two minutes, or after 5 AWS API errors in a row.
# Usage: ssm_run <timeout-seconds> <script>
ssm_run() {
  local timeout="$1" script="$2" params id status="" out errors=0 deadline
  deadline=$((SECONDS + timeout + 120))
  params="$(jq -n --arg c "$script" --arg t "$timeout" '{commands: [$c], executionTimeout: [$t]}')"
  id="$(aws_ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
    --comment "apeiron remote script" --parameters "$params" \
    --query 'Command.CommandId' --output text)"
  while :; do
    [ "$SECONDS" -lt "$deadline" ] || die "remote command $id did not finish within $((timeout + 120))s (check it in the SSM console)"
    sleep 4
    if status="$(aws_ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE_ID" \
      --query 'Status' --output text 2>/dev/null)"; then
      errors=0
    else
      errors=$((errors + 1))
      [ "$errors" -lt 5 ] || die "5 consecutive errors polling SSM command $id; check your credentials and network"
      continue
    fi
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
