#!/usr/bin/env bash
# Puts the local stack in a known state before a load test: empty JetStream, the 1M rows re-seeded (so the LIVE
# population is back to about 500 and no earlier stress run has left extra LIVE orders or an event backlog),
# everything up on the Medium preset. Takes about 45 seconds.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose --profile core stop antikythera hermes nats >/dev/null
docker compose --profile core rm -f nats >/dev/null
docker volume rm apeiron_nats-data >/dev/null 2>&1 || true
docker compose --profile core --profile seed run --rm -e SEED_RESET=true gaia 2>&1 | tail -3
docker compose --profile core --profile monitoring up -d >/dev/null

for _ in $(seq 1 120); do
  if curl -fsS -m 3 localhost:4000/health 2>/dev/null | grep -q '"status":"ok"'; then break; fi
  sleep 3
done
sleep 15
curl -fsS localhost:4000/health
echo
