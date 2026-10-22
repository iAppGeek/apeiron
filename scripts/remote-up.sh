#!/usr/bin/env bash
# START: creates the AWS test box and deploys the stack on it. Safe to run again at any time.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-up.sh [options]

START: creates the Apeiron test box (a Graviton t4g.xlarge) and runs the core + monitoring stack on it.

  Runs 'terraform apply' in infra/aws with box=true (you approve the plan at Terraform's prompt): it creates the
  instance, and the free parts too if scripts/remote-setup.sh has not run. Then it waits for SSM and, on the box,
  updates the compose files, logs in to the registry, pulls the images, seeds the data if the database is empty
  (always, on a new box) and starts the stack. On a box that is already up it only redeploys.
  Tunnel      once infra/cloudflare has been applied (scripts/remote-tunnel.sh, see docs/hosting.md), the blotter
              is served on its host name over HTTPS through a Cloudflare Tunnel, behind an Access login, and the
              box opens no inbound port.

Options:
  --tag TAG           image tag to deploy (default: latest; for example sha-abc1234 or 1.2.3)
  --ref REF           git ref the compose files are taken from on the box (default: main)
  --registry-kind K   ghcr (default) or ecr: where the box pulls images from on first use (Terraform variable
                      registry_kind). GHCR packages must be public; ECR needs REGISTRY_KIND=ecr in GitHub too
  --registry HOST     registry host and owner overriding Terraform's choice, for example ghcr.io/iappgeek
  --allowed-cidr CIDR address range allowed to reach the web port when there is no tunnel (default: your public
                      IP, /32)
  --seed-rows N       rows the seeder loads when the database is empty (default 1000000)
  --yes               skip the cost confirmation
  --dry-run           print what would happen and exit without touching AWS
  -h, --help          show this help

Cost: about \$$HOURLY_USD per hour while it is up. STOP with scripts/remote-down.sh when you are done: it deletes the
instance and its disk, so nothing is billed until the next START.
USAGE
}

TAG="latest"
REF="main"
REGISTRY_OVERRIDE=""
REGISTRY_KIND=""
ALLOWED_CIDR=""
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
  host="$(cf_output hostname)"
  if [ -n "$host" ]; then
    web_note="https://$host (Cloudflare Tunnel; the token is read from SSM on the box)"
  else
    web_note="http://<ip>:8080 (no tunnel: infra/cloudflare has not been applied)"
  fi
  cat <<PLAN
Dry run: nothing will be changed.
  1. Warn about the cost (about \$$HOURLY_USD/hour) and ask for confirmation.
  2. terraform apply in infra/aws with box=true (creates the instance; no changes if it is already up).
  3. Wait for the SSM agent to be Online.
  4. On the box, over SSM: checkout git ref '$REF', set TAG='$TAG'${registry_note},
     log in to the registry (ECR), 'docker compose --profile core --profile monitoring pull', start mongo and nats,
     run the seeder only if the database is empty${SEED_ROWS:+ (SEED_ROWS=$SEED_ROWS)}, then 'up -d --wait'.
  5. Print the web URL and how to reach Grafana. The blotter will be at $web_note.
PLAN
  exit 0
fi

require aws terraform jq curl

info "This creates an EC2 t4g.xlarge in your AWS account. It costs about \$$HOURLY_USD per hour while it is up"
info "(a 4-hour session is about \$0.65). STOP it with scripts/remote-down.sh when you are done: that deletes it,"
info "and its disk, so the running cost goes back to \$0."
confirm "Continue?" || die "cancelled"

# The tunnel comes from the persistent Cloudflare stack; without it the box serves plain HTTP on its IP.
PUBLIC_HOSTNAME="$(cf_output hostname)"
TOKEN_PARAM="$(cf_output tunnel_token_parameter)"
GRAFANA_HOSTNAME="$(cf_output grafana_hostname)"

# Always apply: it creates the box when it is down and changes nothing when it is up (no prompt then).
extra=(-var "image_tag=$TAG" -var "git_ref=$REF")
[ -z "$REGISTRY_OVERRIDE" ] || extra+=(-var "registry=$REGISTRY_OVERRIDE")
[ -z "$REGISTRY_KIND" ] || extra+=(-var "registry_kind=$REGISTRY_KIND")
tf_apply_box true "$ALLOWED_CIDR" "${extra[@]}"
load_deployment || die "Terraform did not produce an instance (was the apply cancelled?)"

state="$(instance_state)"
case "$state" in
  running) info "Instance $INSTANCE_ID is already running." ;;
  stopped)
    # Only if someone stopped it outside these scripts; STOP deletes it.
    info "Starting instance $INSTANCE_ID..."
    aws_ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
    aws_ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    ;;
  pending) aws_ec2 wait instance-running --instance-ids "$INSTANCE_ID" ;;
  *) die "instance is '$state'; wait for it to settle, or run scripts/remote-down.sh and start again" ;;
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

profiles=(--profile core --profile monitoring)
if [ -n "$TOKEN_PARAM" ]; then
  # cloudflared reaches pharos over the compose network, so nginx stays on loopback. The token is read with the
  # instance role and only ever written to .env.remote (mode 600), never printed.
  token="$(aws ssm get-parameter --region "$AWS_REGION" --name "$TOKEN_PARAM" --with-decryption \
    --query Parameter.Value --output text)"
  set_env TUNNEL_TOKEN "$token"
  set_env WEB_BIND 127.0.0.1
  profiles+=(--profile tunnel)
else
  sed -i '/^TUNNEL_TOKEN=/d' .env.remote
  set_env WEB_BIND 0.0.0.0
fi

dc() { docker compose --env-file .env.remote "$@"; }

case "$REGISTRY" in
  *.dkr.ecr.*.amazonaws.com)
    aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${REGISTRY%%/*}" ;;
esac

dc "${profiles[@]}" pull --quiet
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

dc "${profiles[@]}" up -d --wait --wait-timeout 900
dc "${profiles[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
REMOTE

# Prefix the variable assignments so they are plain shell variables in the remote script.
prelude="$(printf 'export BOX_DIR=%q REF=%q TAG=%q REGISTRY=%q SEED_ROWS=%q AWS_REGION=%q TOKEN_PARAM=%q\n' \
  "$BOX_DIR" "$REF" "$TAG" "$registry" "$SEED_ROWS" "$REGION" "$TOKEN_PARAM")"
ssm_run 3600 "$prelude
$REMOTE_SCRIPT"

if [ -n "$PUBLIC_HOSTNAME" ]; then
  web="https://$PUBLIC_HOSTNAME      (Cloudflare Access: sign in with an allowed email)"
else
  web="$(web_url)      (reachable only from the allowed address)"
fi
if [ -n "$TOKEN_PARAM" ] && [ -n "$GRAFANA_HOSTNAME" ]; then
  grafana="https://$GRAFANA_HOSTNAME      (same Access login)"
else
  grafana="private: aws ssm start-session --region $REGION --target $INSTANCE_ID \\
              --document-name AWS-StartPortForwardingSession --parameters portNumber=3001,localPortNumber=3001
            then open http://localhost:3001   (needs the Session Manager plugin)"
fi
cat <<URLS

The stack is up.
  Blotter   $web
  Grafana   $grafana

STOP it when you are done (deletes the box; back to \$0):  scripts/remote-down.sh
URLS
