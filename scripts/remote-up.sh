#!/usr/bin/env bash
# Brings the AWS test box up and deploys the stack on it. Safe to run again at any time.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-up.sh [options]

Starts the Apeiron test box (a Graviton t4g.xlarge) and runs the core + monitoring stack on it.

  First use   runs 'terraform apply' (you approve it at Terraform's prompt) to create the box.
  Later uses  start the stopped instance (or do nothing if it is running), wait for SSM, then
              update the compose files, log in to the registry, pull the images, start the stack,
              and seed the data only if the database is empty.

Options:
  --tag TAG           image tag to deploy (default: latest; for example sha-abc1234 or 1.2.3)
  --ref REF           git ref the compose files are taken from on the box (default: main)
  --registry-kind K   ghcr (default) or ecr: where the box pulls images from on first use (Terraform variable
                      registry_kind). GHCR packages must be public; ECR needs REGISTRY_KIND=ecr in GitHub too
  --registry HOST     registry host and owner overriding Terraform's choice, for example ghcr.io/iappgeek
  --allowed-cidr CIDR address range allowed to reach the web port (default: your public IP, /32)
  --apply             run 'terraform apply' even when the box exists (use after your IP changes)
  --seed-rows N       rows the seeder loads when the database is empty (default 1000000)
  --yes               skip the cost confirmation
  --dry-run           print what would happen and exit without touching AWS
  -h, --help          show this help

Cost: about \$$HOURLY_USD per hour while running, about \$$STOPPED_USD_PER_MONTH per month while stopped.
Stop it with scripts/remote-down.sh when you are done.
USAGE
}

TAG="latest"
REF="main"
REGISTRY_OVERRIDE=""
REGISTRY_KIND=""
ALLOWED_CIDR=""
FORCE_APPLY=0
SEED_ROWS=""
DRY_RUN=0
export ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --registry-kind) REGISTRY_KIND="${2:?--registry-kind needs a value}"; shift 2 ;;
    --registry) REGISTRY_OVERRIDE="${2:?--registry needs a value}"; shift 2 ;;
    --allowed-cidr) ALLOWED_CIDR="${2:?--allowed-cidr needs a value}"; shift 2 ;;
    --seed-rows) SEED_ROWS="${2:?--seed-rows needs a value}"; shift 2 ;;
    --apply) FORCE_APPLY=1; shift ;;
    --yes | -y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ "$TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "invalid --tag: $TAG"
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid --ref: $REF"
case "$REGISTRY_KIND" in "" | ghcr | ecr) ;; *) die "--registry-kind must be ghcr or ecr" ;; esac
[ -z "$SEED_ROWS" ] || [[ "$SEED_ROWS" =~ ^[0-9]+$ ]] || die "--seed-rows must be a whole number"
[ -z "$REGISTRY_OVERRIDE" ] || [[ "$REGISTRY_OVERRIDE" =~ ^[a-z0-9.:/_-]+$ ]] || die "invalid --registry: $REGISTRY_OVERRIDE"

if [ "$DRY_RUN" = "1" ]; then
  registry_note=""
  [ -z "$REGISTRY_OVERRIDE" ] || registry_note=", REGISTRY=$REGISTRY_OVERRIDE"
  cat <<PLAN
Dry run: nothing will be changed.
  1. Warn about the cost (about \$$HOURLY_USD/hour) and ask for confirmation.
  2. terraform apply in infra/aws on first use (or with --apply); otherwise start the instance if it is stopped.
  3. Wait for the SSM agent to be Online.
  4. On the box, over SSM: checkout git ref '$REF', set TAG='$TAG'${registry_note},
     log in to the registry (ECR), 'docker compose --profile core --profile monitoring pull', start mongo and nats,
     run the seeder only if the database is empty${SEED_ROWS:+ (SEED_ROWS=$SEED_ROWS)}, then 'up -d --wait'.
  5. Print the web URL and how to reach Grafana.
PLAN
  exit 0
fi

require aws terraform jq curl

info "This starts an EC2 t4g.xlarge in your AWS account. It costs about \$$HOURLY_USD per hour while running"
info "(a 4-hour session is about \$0.65), and about \$$STOPPED_USD_PER_MONTH per month for the disk while stopped."
info "Stop it with scripts/remote-down.sh when you are done."
confirm "Continue?" || die "cancelled"

terraform_apply() {
  local cidr="$ALLOWED_CIDR"
  if [ -z "$cidr" ]; then
    cidr="$(curl -fsS -m 10 https://checkip.amazonaws.com | tr -d '[:space:]')/32" || die "could not detect your public IP; pass --allowed-cidr"
  fi
  info "Terraform will allow only $cidr to reach the box."
  terraform -chdir="$TF_DIR" init -input=false >/dev/null
  local -a vars=(-var "allowed_cidr=$cidr" -var "image_tag=$TAG" -var "git_ref=$REF")
  [ -z "$REGISTRY_OVERRIDE" ] || vars+=(-var "registry=$REGISTRY_OVERRIDE")
  [ -z "$REGISTRY_KIND" ] || vars+=(-var "registry_kind=$REGISTRY_KIND")
  terraform -chdir="$TF_DIR" apply "${vars[@]}"
}

if ! load_deployment || [ "$FORCE_APPLY" = "1" ]; then
  terraform_apply
  load_deployment || die "Terraform did not produce an instance (was the apply cancelled?)"
fi

state="$(instance_state)"
case "$state" in
  running) info "Instance $INSTANCE_ID is already running." ;;
  stopped)
    info "Starting instance $INSTANCE_ID..."
    aws_ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
    aws_ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    ;;
  pending) aws_ec2 wait instance-running --instance-ids "$INSTANCE_ID" ;;
  *) die "instance is '$state'; wait for it to settle, or run scripts/remote-destroy.sh and start again" ;;
esac

wait_ssm_online

registry="${REGISTRY_OVERRIDE:-$(tf_output registry)}"
info "Deploying tag '$TAG' (compose files at '$REF', registry '$registry')..."

# Runs on the box. Quoted heredoc so nothing expands here; values arrive through the exported variables below.
read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -euo pipefail
# SSM can be online before cloud-init has cloned the repository, so wait for the marker before touching the directory.
for _ in $(seq 1 180); do [ -f "$BOX_DIR/.bootstrapped" ] && break; sleep 5; done
[ -f "$BOX_DIR/.bootstrapped" ] || { echo "first-boot setup has not finished after 15 minutes"; exit 1; }
cd "$BOX_DIR"

git fetch --quiet --tags --force origin
if git rev-parse --verify --quiet "origin/$REF" >/dev/null; then target="origin/$REF"; else target="$REF"; fi
git checkout --quiet --force --detach "$target"

set_env() { # idempotent KEY=VALUE in .env.remote
  if grep -q "^$1=" .env.remote; then sed -i "s|^$1=.*|$1=$2|" .env.remote; else echo "$1=$2" >> .env.remote; fi
}
set_env TAG "$TAG"
set_env REGISTRY "$REGISTRY"
[ -z "$SEED_ROWS" ] || set_env SEED_ROWS "$SEED_ROWS"

dc() { docker compose --env-file .env.remote "$@"; }

case "$REGISTRY" in
  *.dkr.ecr.*.amazonaws.com)
    aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REGISTRY%%/*}" ;;
esac

dc --profile core --profile monitoring pull --quiet
dc --profile core up -d --wait --wait-timeout 300 mongo nats

raw="$(dc exec -T mongo mongosh --quiet --eval 'db.getSiblingDB("blotter").orders.estimatedDocumentCount()')"
count="$(printf '%s\n' "$raw" | tr -d '\r' | grep -Eo '^[0-9]+$' | tail -1 || true)"
if [ -z "$count" ]; then
  echo "could not read the order count from mongosh; output was:"
  printf '%s\n' "$raw"
  exit 1
fi
if [ "$count" -eq 0 ]; then
  echo "Database is empty: seeding..."
  dc --profile core --profile seed run --rm gaia
else
  echo "Database already holds $count orders: not seeding."
fi

dc --profile core --profile monitoring up -d --wait --wait-timeout 900
dc --profile core --profile monitoring ps --format 'table {{.Service}}\t{{.Status}}'
REMOTE

# Prefix the variable assignments so they are plain shell variables in the remote script.
prelude="$(printf 'export BOX_DIR=%q REF=%q TAG=%q REGISTRY=%q SEED_ROWS=%q AWS_REGION=%q\n' \
  "$BOX_DIR" "$REF" "$TAG" "$registry" "$SEED_ROWS" "$REGION")"
ssm_run 3600 "$prelude
$REMOTE_SCRIPT"

ip="$(instance_ip)"
cat <<URLS

The stack is up.
  Blotter   http://$ip:8080      (reachable only from the allowed address)
  Grafana   private: aws ssm start-session --region $REGION --target $INSTANCE_ID \\
              --document-name AWS-StartPortForwardingSession --parameters portNumber=3001,localPortNumber=3001
            then open http://localhost:3001   (needs the Session Manager plugin)

Stop it when you are done:  scripts/remote-down.sh
URLS
