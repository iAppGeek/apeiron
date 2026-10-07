#!/usr/bin/env bash
# Runs the talos load test against the AWS test box: on the box itself (default), or from this machine.
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-loadtest.sh [options]

Runs the talos load test (WebSocket clients scrolling, sorting, filtering and grouping) against the deployed stack.

  default        runs the talos container on the box over SSM, so the network is not in the way and the
                 server's CPU, RSS and event-loop lag are scraped from /metrics. Needs the box running.
  --from-laptop  runs talos from this machine against http://<box>:8080/ws. The server /metrics endpoint is
                 not exposed publicly, so server-side figures are skipped.

Options:
  --clients N        concurrent clients (default 50)
  --duration SECONDS test length (default 300)
  --codec NAME       json, msgpack or both (default json)
  --seed N           scenario seed (default 1)
  --from-laptop      run talos locally (needs 'pnpm install' and 'pnpm build' first)
  --dry-run          print the command that would run and exit
  -h, --help         show this help
USAGE
}

CLIENTS=50
DURATION=300
CODEC=json
SEED=1
FROM_LAPTOP=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --clients) CLIENTS="${2:?--clients needs a value}"; shift 2 ;;
    --duration) DURATION="${2:?--duration needs a value}"; shift 2 ;;
    --codec) CODEC="${2:?--codec needs a value}"; shift 2 ;;
    --seed) SEED="${2:?--seed needs a value}"; shift 2 ;;
    --from-laptop) FROM_LAPTOP=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

if ! [[ "$CLIENTS" =~ ^[0-9]+$ ]] || [ "$CLIENTS" -lt 1 ]; then die "--clients must be a positive whole number"; fi
if ! [[ "$DURATION" =~ ^[0-9]+$ ]] || [ "$DURATION" -lt 1 ]; then die "--duration must be a positive whole number"; fi
[[ "$SEED" =~ ^[0-9]+$ ]] || die "--seed must be a whole number"
case "$CODEC" in json | msgpack | both) ;; *) die "--codec must be json, msgpack or both" ;; esac

if [ "$DRY_RUN" = "1" ]; then
  if [ "$FROM_LAPTOP" = "1" ]; then
    echo "Dry run: would run 'pnpm --filter @apeiron/talos start -- --clients $CLIENTS --duration $DURATION --codec $CODEC --seed $SEED --url ws://<box-ip>:8080/ws --metrics off'."
  else
    echo "Dry run: would run 'docker compose --profile core --profile loadtest run --rm -T talos' on the box over SSM (clients=$CLIENTS, duration=${DURATION}s, codec=$CODEC, seed=$SEED)."
  fi
  exit 0
fi

require aws terraform
load_deployment || die "nothing is deployed; run scripts/remote-up.sh first"
[ "$(instance_state)" = "running" ] || die "the box is not running; run scripts/remote-up.sh first"

if [ "$FROM_LAPTOP" = "1" ]; then
  require pnpm
  ip="$(instance_ip)"
  cd "$REPO_ROOT"
  exec pnpm --filter @apeiron/talos start -- --clients "$CLIENTS" --duration "$DURATION" --codec "$CODEC" \
    --seed "$SEED" --url "ws://$ip:8080/ws" --metrics off
fi

require jq
wait_ssm_online
prelude="$(printf 'export BOX_DIR=%q TALOS_CLIENTS=%q TALOS_DURATION=%q TALOS_CODEC=%q TALOS_SEED=%q\n' \
  "$BOX_DIR" "$CLIENTS" "$DURATION" "$CODEC" "$SEED")"
read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -euo pipefail
cd "$BOX_DIR"
docker compose --env-file .env.remote --profile core --profile loadtest run --rm -T talos
ls -1t loadtest/results | head -3
REMOTE
ssm_run "$((DURATION + 900))" "$prelude
$REMOTE_SCRIPT"
info "Results are in $BOX_DIR/loadtest/results on the box."
