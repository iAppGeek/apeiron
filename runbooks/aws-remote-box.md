# Remote box runbook: START, verify, STOP, verify $0

This is the single reference for running the Apeiron stack on AWS for a session and tearing it back down to a running
cost of **$0**. It is written so an assistant (or a person) with no other context can follow it from the repo root.
It holds the procedure only; the facts it relies on live in [docs/](../docs) and are linked where they are needed.

## Rules for an assistant

- **Never start anything that costs money without the user saying so in this session.** START costs about $0.16/hour
  until STOP. Reading state (`terraform plan`, `output`, `state list`, `aws ... describe-*`) is always fine.
- **Show the plan before any apply** and wait for an explicit yes. The scripts use Terraform's own `yes` prompt; you
  cannot answer it from a non-interactive shell, so use the [assistant procedure](#starting-and-stopping-from-an-assistant).
- **Always finish with [Verify $0](#verify-0-after-stop)** after a STOP, and report what you checked.
- The AWS CLI may be signed in as the account root user. Say so if it is; it is the user's call.
- Never print or commit secrets: `infra/*/terraform.tfstate`, `infra/cloudflare/terraform.tfvars`, `.env.remote` on the
  box, the tunnel token, the Access service token secret.

## Background

What each part is, what it costs, and why: [docs/hosting.md](../docs/hosting.md) ("What Terraform creates", the
Cloudflare Tunnel section, "Cost" and "Security notes"). In short, only the EC2 instance (with its disk and public IP)
costs money, about $0.16/hour, and it exists only between START and STOP; everything else is free and permanent.
Terraform state is **local and git-ignored** (`infra/aws/terraform.tfstate`, `infra/cloudflare/terraform.tfstate`), so
run this on the machine that holds it. Region: **eu-west-2**.

The commands used below (all have `--help` and `--dry-run`; reference in hosting.md):

- `scripts/remote-up.sh`: **START**
- `scripts/remote-down.sh`: **STOP**
- `scripts/remote-tunnel.sh --status`: checks both host names answer with the Access login
- `scripts/remote-setup.sh`, `scripts/remote-tunnel.sh --apply`: one-time free setup, already done if the preflight
  below shows the free parts

## Preflight (read-only)

```bash
aws sts get-caller-identity                       # which account and identity will be billed
scripts/remote-tunnel.sh --status                 # both host names: "behind Access"
terraform -chdir=infra/aws output -raw instance_id 2>/dev/null; echo   # empty = box is down
terraform -chdir=infra/aws state list 2>/dev/null | grep -c '^aws_'   # 0 = nothing set up yet (free parts not created)
terraform -chdir=infra/aws state list 2>/dev/null | grep -c '^aws_instance'   # 1 = the box is up (billing)
```

Images must be public on GHCR and the box takes its compose files from git (`main` by default), so changes must be
merged first or deployed with `--ref` ([hosting.md](../docs/hosting.md#choosing-a-registry-ghcr-or-ecr)).

## START

```bash
scripts/remote-up.sh                  # or with --seed-rows 200000 for a faster seed and load
```

1. Asks to confirm the cost (`--yes` skips this).
2. `terraform apply -var box=true` in `infra/aws`: Terraform shows the plan (**1 to add**, the instance, when the free
   parts already exist) and waits for `yes`.
3. Waits for SSM, then on the box: checks out the compose files, reads the tunnel token from SSM, pulls the images,
   starts MongoDB and NATS, **seeds** (about 3 minutes for 1M orders), starts everything, waits until every service is
   healthy, and prints a status table and the URLs.

Expect about **12 to 20 minutes** in all (first boot installs Docker, then the seed, then the 1M-order load into
memory). If it fails part-way, the box is still up and billing: fix and re-run START (it only redeploys), or STOP.

## Verify the deployed stack

Do all of these and report each result.

**1. Terraform and EC2.**

```bash
terraform -chdir=infra/aws output -raw instance_id; echo        # i-...
aws ec2 describe-instances --region eu-west-2 --instance-ids "$(terraform -chdir=infra/aws output -raw instance_id)" \
  --query 'Reservations[0].Instances[0].State.Name' --output text   # running
```

**2. Containers on the box** (over SSM; no SSH exists). Every service with a healthcheck must say `(healthy)`;
`cloudflared` has none (distroless image) and must say `Up`. The blotter server must report `status: ok` and the
seeded row count (1000000 by default).

```bash
id=$(terraform -chdir=infra/aws output -raw instance_id)
cmd=$(aws ssm send-command --region eu-west-2 --instance-ids "$id" --document-name AWS-RunShellScript \
  --parameters 'commands=["cd /opt/apeiron && docker compose --env-file .env.remote --profile core --profile monitoring --profile tunnel ps --format \"table {{.Service}}\t{{.Status}}\"","curl -s localhost:4000/health"]' \
  --query Command.CommandId --output text)
sleep 5; aws ssm get-command-invocation --region eu-west-2 --command-id "$cmd" --instance-id "$id" \
  --query StandardOutputContent --output text
```

Expected: every service of the `core` and `monitoring` profiles healthy (the list is in
[hosting.md](../docs/hosting.md#compose-profiles)) and `cloudflared` Up. `/health` returns JSON with `"status":"ok"` and
`"rows":1000000` (its fields are described in [architecture.md](../docs/architecture.md#loading)).

**3. Through Cloudflare** (the path a browser takes). Uses the Access service token, so no browser login is needed.
Resolve with public DNS if the local resolver has not caught up (see Troubleshooting).

```bash
export CF_ID=$(terraform -chdir=infra/cloudflare output -raw access_client_id)
export CF_SECRET=$(terraform -chdir=infra/cloudflare output -raw access_client_secret)
h=(-H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET")
curl -s -o /dev/null -w '%{http_code}\n' "${h[@]}" https://blotter.oramalabs.dev/          # 200: the web app
curl -s -o /dev/null -w '%{http_code}\n' "${h[@]}" https://grafana.oramalabs.dev/api/health  # 200
curl -s -o /dev/null -w '%{http_code}\n' https://blotter.oramalabs.dev/                    # 302: no token, sent to the login
# WebSocket upgrade through the tunnel to the blotter server: 101 Switching Protocols
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 -m 5 "${h[@]}" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://blotter.oramalabs.dev/ws
```

A 502 or 530 from Cloudflare with the token means the tunnel is not connected: check `cloudflared` in step 2.

**4. No inbound ports with the tunnel** (the security group must have no ingress rules):

```bash
sg=$(aws ec2 describe-instances --region eu-west-2 --instance-ids "$id" \
  --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
aws ec2 describe-security-group-rules --region eu-west-2 --filters Name=group-id,Values="$sg" \
  --query 'SecurityGroupRules[?IsEgress==`false`]' --output json      # []
```

**5. Optional, by a person:** open <https://blotter.oramalabs.dev>, sign in with an allowed email (one-time PIN), and
check the grid ticks. Optional load test: `scripts/remote-loadtest.sh --clients 50 --duration 300`.

## STOP

```bash
scripts/remote-down.sh
```

`terraform apply -var box=false`: the plan must show **0 to add, 0 to change, 1 to destroy** (`aws_instance.box[0]`).
Anything else being destroyed means the settings drifted: say no and investigate. After `yes`, the instance and its
disk are deleted and the script prints the running cost: $0.

## Verify $0 after STOP

All must hold. Report each.

```bash
# 1. Terraform: no instance; only the free parts remain.
terraform -chdir=infra/aws output -raw instance_id 2>/dev/null; echo        # empty
terraform -chdir=infra/aws state list | grep -c aws_instance               # 0

# 2. EC2: no Apeiron instance in any state but terminated.
aws ec2 describe-instances --region eu-west-2 \
  --filters Name=tag:Project,Values=apeiron Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text             # empty

# 3. No leftover disks (the root volume is deleted with the instance) and no Elastic IPs.
aws ec2 describe-volumes --region eu-west-2 --filters Name=status,Values=available \
  --query 'Volumes[].[VolumeId,Size,CreateTime]' --output text              # empty, or only volumes that are not Apeiron's
aws ec2 describe-addresses --region eu-west-2 --query 'Addresses[].PublicIp' --output text   # empty (the stack uses none)

# 4. ECR holds no images (the default registry is GHCR; with registry_kind=ecr it is pennies, see hosting.md).
for r in $(aws ecr describe-repositories --region eu-west-2 --query 'repositories[?starts_with(repositoryName, `apeiron/`)].repositoryName' --output text); do
  printf '%s %s\n' "$r" "$(aws ecr list-images --region eu-west-2 --repository-name "$r" --query 'length(imageIds)')"
done                                                                        # every count 0
```

What remains is free ([hosting.md](../docs/hosting.md#cost)). AWS billing (Cost Explorer) lags by about a day, so the checks above,
not the bill, are the proof on the day.

## Starting and stopping from an assistant

Terraform's prompt needs a terminal. From a non-interactive shell, plan first, show the user, and apply the saved plan
only after they approve it. The plan uses exactly the settings the scripts use (`tf_apply_box` in
`scripts/remote-lib.sh`), so the script that follows finds **no changes** and does not prompt.

```bash
ip="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')/32"
host=$(terraform -chdir=infra/cloudflare output -raw hostname 2>/dev/null)
tv=(); [ -z "$host" ] || tv=(-var "public_hostname=$host" \
  -var "tunnel_token_parameter=$(terraform -chdir=infra/cloudflare output -raw tunnel_token_parameter)")
terraform -chdir=infra/aws init -input=false >/dev/null

# START: plan, show it, and after the user approves:
terraform -chdir=infra/aws plan -input=false -out=start.tfplan -var box=true -var "allowed_cidr=$ip" "${tv[@]}"
terraform -chdir=infra/aws apply -input=false start.tfplan
scripts/remote-up.sh --yes            # Terraform: no changes; then deploys, seeds and waits until healthy

# STOP: plan (must be 1 to destroy: aws_instance.box[0]), show it, and after the user approves:
terraform -chdir=infra/aws plan -input=false -out=stop.tfplan -var box=false -var "allowed_cidr=$ip" "${tv[@]}"
terraform -chdir=infra/aws apply -input=false stop.tfplan
scripts/remote-down.sh                # reports the box is already down; running cost $0
rm -f infra/aws/start.tfplan infra/aws/stop.tfplan   # git-ignored, but do not leave stale plans around
```

Run these in **bash**, not by sourcing `remote-lib.sh` into zsh: it locates the repo with `BASH_SOURCE`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Could not resolve host: blotter.oramalabs.dev` but `--status` says "behind Access" | a local resolver cached "no such name" (up to 30 minutes). Wait, or use `dig @1.1.1.1` and `curl --resolve host:443:<ip>` |
| START: `first-boot setup has not finished after 15 minutes` | cloud-init failed on the box. Check `/var/log/cloud-init-output.log` over SSM, then STOP and START again |
| START times out in `up --wait` | a service is unhealthy: run verify step 2 and read that service's logs (`docker compose logs <service>`) |
| Cloudflare 502/530 with the service token | `cloudflared` is not running or the token is wrong: verify step 2, and check `TUNNEL_TOKEN` is set in `/opt/apeiron/.env.remote` (do not print it) |
| STOP plan destroys more than the instance | the settings differ from the last apply (for example infra/cloudflare state is missing). Do not approve; investigate |
| Terraform: `Error: No value for required variable` / prompts in a non-interactive shell | use the assistant procedure above |
| Something billable is left after STOP | run [Verify $0](#verify-0-after-stop); delete strays in the console and tell the user |
