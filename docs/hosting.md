# Hosting

The same `docker compose` file runs on a laptop and on a rented box; only the environment file differs. Every service
is a container, and the images are built for both `linux/amd64` (laptops, CI) and `linux/arm64` (Apple silicon,
Graviton).

- [Local](#local)
- [AWS, on demand](#aws-on-demand-for-short-test-sessions)
- [Choosing a registry: GHCR or ECR](#choosing-a-registry-ghcr-or-ecr)
- [Alternatives](#alternatives)
- [Security notes](#security-notes)

## Local

Requirements: Docker with Compose v2, and about 6 GB of RAM given to the Docker VM. The repo root has a `compose.yaml`
that includes `infra/docker-compose.yml`, so every command runs from the repo root. The commands to start, seed, reset
and stop the stack are in [user-guide.md](user-guide.md#running-it); this section is the reference for what they use.

### Compose profiles

| Profile | Services | Purpose |
|---|---|---|
| `core` | `mongo`, `nats`, `themis`, `helios`, `hermes`, `antikythera`, `pharos` | the blotter itself |
| `seed` | `mongo`, `gaia` | load the orders into Mongo (one-shot) |
| `monitoring` | `prometheus`, `grafana` | metrics and the server dashboard |
| `loadtest` | `talos` | the load harness (needs `core`) |
| `resilience` | `toxiproxy`, `pharos-e2e` | the resilience suite's fault proxy and test-hooks web app (needs `core`; [testing.md](testing.md)) |
| `tunnel` | `cloudflared` | Cloudflare Tunnel from the remote box to its host name (needs `core` and `TUNNEL_TOKEN`) |

**Startup order matters once.** `themis` rebuilds the `ORDER_STATE` bucket from the database at startup when the two
disagree, and the blotter loads from that bucket, so seed before starting the services (the order in the user guide). If
you seed into a running stack, restart `themis` and then `antikythera`.

### Ports

Every published port binds to `127.0.0.1`, so nothing is reachable from the network by default.

| Service | Port | Notes |
|---|---|---|
| pharos (nginx) | 8080 | the web app, and `/ws` proxied to the server |
| antikythera | 4000 | `/health`, `/health/live`, `/health/ready`, `/metrics`, `/debug/lag`, and the WebSocket at `/ws` |
| themis | 4200 | `/health`, `/metrics`, `/debug` |
| helios | 4300 | `/health`, `/metrics` |
| mongo | 27017 | |
| nats | 4222, 8222 | client and monitoring |
| prometheus | 9090 | |
| grafana | 3001 | anonymous Viewer access; admin sign-in uses `GRAFANA_ADMIN_PASSWORD` (default `admin`) |
| toxiproxy | 8474 | resilience profile: the fault proxy's API |
| pharos-e2e | 8081 | resilience profile: the web app with test hooks |

`hermes` publishes no port (its `:4100` health and metrics are reachable inside the compose network). The Vite dev server
(`pnpm --filter @apeiron/pharos dev`) runs on 5173 and proxies `/ws` to localhost:4000.

`WEB_BIND` and `GRAFANA_BIND` change the interface the web and Grafana ports bind to (default `127.0.0.1`). The remote
box keeps the web port on loopback when it has the Cloudflare Tunnel, and sets `WEB_BIND=0.0.0.0` (behind its security
group) when it does not.

### Memory: `MONGO_CACHE_GB`

MongoDB's WiredTiger cache defaults to half of the Docker VM's RAM. Under `themis`'s steady write load that starves the
other containers and the VM swaps, after which every container stalls (the CP-4 incident in
[performance.md](performance.md#the-death-spiral-cp-4)). `MONGO_CACHE_GB` (default `1`) caps it; 1 GB holds
the working set of this dataset. Raise it on a bigger host (the AWS box uses 4). The server container is capped at
`mem_limit: 3g` and needs about 0.9 GB at the load peak.

### Other variables

All variables, with their defaults, are in `.env.example`. The ones you are most likely to change: `SEED_ROWS`
(default 1,000,000; a smaller number seeds faster), `LOAD_PRESET` (`medium` or `stress`, also switchable from the Dev
menu), `FLUSH_MS` and `LOG_LEVEL`.

### Resetting before a load test

`scripts/loadtest-reset.sh` puts the stack back to a known state; what it does is in
[user-guide.md](user-guide.md#seeding-and-reset).

## AWS, on demand, for short test sessions

Step-by-step procedure (START, verify, STOP, verify $0): [runbooks/aws-remote-box.md](../runbooks/aws-remote-box.md).

One Graviton instance runs the whole stack for the length of a test session, and is deleted in between, so nothing is
billed between sessions. The parts that cost nothing while idle (IAM, the security group, ECR, the Cloudflare Tunnel)
are set up once and kept. There is no load balancer and no NAT gateway.

```
laptop ──(AWS CLI + SSM)──▶ EC2 t4g.xlarge, Amazon Linux 2023 arm64, 30 GB encrypted gp3
   │                          docker compose: the core and monitoring profiles (every service but the test ones)
   └──(HTTP :8080, your IP only)──▶ pharos        (without a tunnel)

with a tunnel (below; the box then opens no inbound port):
browser ──HTTPS──▶ Cloudflare (Access login) ◀──outbound tunnel── cloudflared on the box ──▶ pharos, grafana
```

### Prerequisites

- An AWS account and credentials configured for the AWS CLI (`aws sts get-caller-identity` works). Use a role or user
  with permission to manage EC2, IAM, ECR and SSM; avoid the account root user for anything routine.
- [Terraform](https://developer.hashicorp.com/terraform) 1.14 or newer, the [AWS CLI](https://aws.amazon.com/cli/) v2,
  `jq` and `curl`.
- The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  for the AWS CLI, only if you want an SSM shell or a port forward to Grafana.
- Images in a registry the box can pull from: GHCR (the default) or ECR; see
  [Choosing a registry](#choosing-a-registry-ghcr-or-ecr). Run the **Images** workflow first (GitHub, Actions,
  Images, Run workflow), or push a `v*` tag.

### What Terraform creates (`infra/aws`)

The variable `box` splits the stack in two. Everything is created once and kept, except the instance, which exists
only while `box = true`: START (`remote-up.sh`) applies with `box = true`, STOP (`remote-down.sh`) with `box = false`.

| Resource | Kept between sessions | Notes |
|---|---|---|
| EC2 instance | **no**: START creates it, STOP deletes it | `t4g.xlarge` (4 vCPU, 16 GB), latest AL2023 arm64 AMI from the public SSM parameter, 30 GB encrypted gp3 (deleted with the instance), IMDSv2 only. The only resource that costs money |
| Security group | yes, free | inbound **only** from `allowed_cidr`, on 8080 (none with a tunnel; 3001 if `expose_grafana`); **no SSH** |
| ECR repositories | yes, free while empty | `apeiron/<service>` for the seven services (`antikythera`, `themis`, `helios`, `hermes`, `gaia`, `talos`, `pharos`), scan on push, lifecycle policy keeps the last 10 images |
| Instance role | yes, free | `AmazonSSMManagedInstanceCore` plus ECR pull scoped to those repositories |
| GitHub OIDC provider and push role | yes, free | trusted only for jobs that declare the GitHub environment `release` (`repo:<github_repo>:environment:release`); ECR push scoped to those repositories |

The default VPC and one of its public subnets are used. State is **local** (`infra/aws/terraform.tfstate`, git-ignored).

On first boot cloud-init installs Docker, Git and a checksum-verified Compose plugin, clones this repository to
`/opt/apeiron`, and writes `/opt/apeiron/.env.remote` (`REGISTRY`, `TAG`, `MONGO_CACHE_GB=4`, `WEB_BIND=0.0.0.0`, and a
randomly generated Grafana admin password that never leaves the box).

Variables (`infra/aws/variables.tf`): `box` (default `false`; the scripts set it), `region` (default `eu-west-2`), `allowed_cidr` (required, your public IP as
`x.x.x.x/32`; `0.0.0.0/0` is rejected), `instance_type` (`t4g.xlarge`), `github_repo` (`iAppGeek/apeiron`), and a few
more (`volume_size_gb`, `expose_grafana`, `create_github_oidc_provider`, `registry_kind`, `ghcr_owner`, `registry`).
`registry_kind` is `ghcr` by default, matching the Images workflow, so the box pulls `ghcr.io/<ghcr_owner>/apeiron/<service>`; set it to `ecr` (and `REGISTRY_KIND=ecr` in GitHub) to use the stack's own ECR repositories.

### Setting up (free) and the first START

```bash
aws sts get-caller-identity                 # confirm which account you are about to spend money in
scripts/remote-tunnel.sh --apply            # optional, free: the Cloudflare Tunnel (next section)
scripts/remote-setup.sh                     # optional, free: the AWS parts that cost nothing (box = false)
scripts/remote-up.sh --dry-run              # shows the START steps without touching AWS
```

`remote-setup.sh` runs `terraform apply -var box=false` in `infra/aws`: IAM, the OIDC provider, the security group and
the ECR repositories, and no instance. It is optional, because START creates whatever is missing, but it leaves
everything ready at no cost, so START only has to create the instance.

Nothing is created until you answer Terraform's prompt; the scripts never apply by themselves.

### A session: START, use, STOP

```bash
scripts/remote-up.sh                # START: cost warning, terraform apply box=true (you approve), deploy, seed
open https://blotter.oramalabs.dev  # with the tunnel; otherwise the printed http://<ip>:8080
scripts/remote-loadtest.sh --clients 50 --duration 300     # talos on the box, over SSM
scripts/remote-down.sh              # STOP: terraform apply box=false (you approve): the box and its disk are deleted
```

START detects your public IP, runs `terraform apply -var box=true` in `infra/aws` (Terraform shows the plan and asks you
to type `yes`), waits for the SSM agent, then runs the deploy over SSM: update the compose files from git, log in to
the registry (ECR), `docker compose pull`, start MongoDB and NATS, **seed if the database is empty** (always, on a new
box: about 3 minutes for a million rows), and start everything else. It prints the URLs when the stack is healthy.
Run it again on a box that is up and it changes nothing in Terraform and only redeploys.

STOP deletes the instance and its disk, so **the seeded data does not survive a session**: every START seeds again.
Useful START options: `--tag sha-abc1234` (deploy one specific build), `--ref <git ref>` (compose files from a branch or
tag), `--registry-kind ecr`, `--registry ghcr.io/iappgeek`, `--seed-rows 200000` (seeds and loads about 5x faster),
`--allowed-cidr`.

Grafana is not exposed by default. Forward it over SSM and open <http://localhost:3001>:

```bash
aws ssm start-session --region eu-west-2 --target <instance-id> \
  --document-name AWS-StartPortForwardingSession --parameters portNumber=3001,localPortNumber=3001
```

With a tunnel set up (next section) the URL is `https://blotter.oramalabs.dev` instead, it never changes, and Grafana
is at `https://grafana.oramalabs.dev` behind the same login.

Without a tunnel, if your IP changes while the box is up it will not answer: run `scripts/remote-up.sh` again to update
the security group. With a tunnel your IP does not matter.

All the scripts are idempotent, show Terraform's plan before changing anything, and have `--help` and `--dry-run`.

| Script | Does |
|---|---|
| `remote-setup.sh` | optional, once: the free AWS parts (`box = false`) |
| `remote-up.sh` | **START**: creates the box (`box = true`), deploys, seeds a new box. Safe to re-run |
| `remote-down.sh` | **STOP**: deletes the box and its disk (`box = false`); back to $0 running cost |
| `remote-destroy.sh` | `terraform destroy` after you type `destroy apeiron`; removes the free AWS parts too |
| `remote-loadtest.sh` | talos on the box over SSM (default), or from your machine with `--from-laptop` |
| `remote-tunnel.sh` | one-time Cloudflare Tunnel setup (`--apply`), check (`--status`), removal (`--destroy`) |

### A fixed host name over HTTPS (Cloudflare Tunnel)

By default the blotter is at `http://<ip>:8080`, and the IP changes every start. With a tunnel it is at
`https://blotter.oramalabs.dev`: `cloudflared` on the box dials out to Cloudflare, Cloudflare serves the host name with
its own certificate, and [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) asks
for an email login first. The box then opens **no inbound port at all**. Everything is in the `infra/cloudflare`
Terraform stack, which `remote-destroy.sh` leaves alone, so it is set up once.

| Resource | Notes |
|---|---|
| Tunnel `apeiron-box` | remotely managed: the ingress rules (`blotter` → `pharos:8080`, `grafana` → `grafana:3000`, anything else 404) live in Cloudflare, not on the box |
| DNS records | proxied CNAMEs to `<tunnel id>.cfargotunnel.com` in the `oramalabs.dev` zone |
| Access applications | one per host name: the emails in `allowed_emails` (one-time PIN by email), plus the `apeiron-scripts` service token |
| Service token | lets scripts through Access with the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers; valid for a year |
| SSM parameter | `/apeiron/cloudflared/tunnel-token`, a standard SecureString (free); the box reads it with its instance role |

All of it is free: Access is free for up to 50 users, and a standard SSM parameter costs nothing.

**One-time setup in the Cloudflare dashboard** (Terraform cannot do these):

1. Zero Trust: open it once, choose a team name and the **Free** plan.
2. Create an API token (My Profile, API Tokens, Create Custom Token) with:
   - Account: **Cloudflare Tunnel: Edit**, **Access: Apps and Policies: Edit**, **Access: Service Tokens: Edit**
   - Zone `oramalabs.dev`: **DNS: Edit**, **Zone: Read**
3. Note the account ID (on the zone's overview page).

**Then:**

```bash
cp infra/cloudflare/terraform.tfvars.example infra/cloudflare/terraform.tfvars   # account_id, allowed_emails
export CLOUDFLARE_API_TOKEN=...                     # the token above; never commit it
scripts/remote-tunnel.sh --apply                    # once: terraform apply in infra/cloudflare (you approve the plan)
scripts/remote-tunnel.sh --status                   # both host names should redirect to the Access login
scripts/remote-up.sh                                # START picks the tunnel up by itself
```

With a tunnel, `remote-up.sh`:

1. applies `infra/aws` with the tunnel: the 8080 rule is dropped from the security group, and the instance role may
   read the one SSM parameter;
2. on the box: reads the token from SSM into `.env.remote` (mode 600, never printed), keeps nginx on loopback, and
   starts the stack with the `tunnel` profile.

`remote-loadtest.sh` on the box works as before. `--from-laptop` goes through Cloudflare to
`wss://blotter.oramalabs.dev/ws`, with the service token from `terraform output` (talos sends
`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` as headers), so its latencies include Cloudflare's edge.

Things to know:

- `infra/cloudflare/terraform.tfstate` holds the tunnel token and the service token secret in plain text. It is
  git-ignored; treat it like a credentials file.
- The stack is not validated against a live Cloudflare account until the first `--apply`.
- Cloudflare closes a proxied WebSocket that carries no data for about 100 seconds. The blotter ticks constantly, so
  this only matters if a quiet mode is added later.
- Grafana keeps its anonymous Viewer role behind Access; edits still need the admin password, which is on the box
  (`GRAFANA_ADMIN_PASSWORD` in `.env.remote`). Set `grafana_hostname = ""` to keep Grafana private.

### Cost

Prices are for eu-west-2 (London), on demand, checked against the AWS Price List API; creating the box only for a
session is the whole saving.

| State | Cost |
|---|---|
| Up (after START) | about **$0.16/hour**: $0.1504 for the `t4g.xlarge`, $0.005 for the public IPv4 address, plus a little for the 30 GB volume ($0.0928/GB-month, billed only while it exists) |
| A 4-hour session | about $0.65 |
| Down (after STOP, or after setup) | **$0**: no instance, no disk, no IP. IAM, the security group, empty ECR repositories, the SSM parameter and the Cloudflare stack are free |
| ECR, only with `registry_kind = ecr` | pennies: the lifecycle policy keeps the last 10 images per repository (a few hundred MB in all). The default, GHCR, stores nothing in AWS |

Spot instances would cut the compute price by 60 to 70 percent but can be reclaimed mid-test, which defeats a latency
measurement, so the stack does not use them. In us-east-1 the instance is about 11 percent cheaper.

### Cleaning up

`scripts/remote-down.sh` (STOP) after every session: that is enough to get back to $0. `scripts/remote-destroy.sh` when
you are done with the experiment altogether: it runs `terraform destroy` (the instance if it is up, the security group,
IAM roles, ECR repositories and their images). Check the AWS
console afterwards if you want to be certain nothing is left. The ECR repositories are created with `force_delete`, so
destroying them removes the images too. The Cloudflare Tunnel stack outlives it; `scripts/remote-tunnel.sh --destroy`
removes it.

## Choosing a registry: GHCR or ECR

The **Images** workflow (`.github/workflows/images.yml`) builds all seven images on native runners (`ubuntu-latest` for
amd64, `ubuntu-24.04-arm` for arm64, no emulation), pushes each platform by digest, and merges them into one multi-arch
manifest per service. It runs on `workflow_dispatch` and on `v*` tags, not on every push. Images are tagged with the
git sha (`sha-abc1234`), `latest` (from `main` or a version tag) and, for version tags, the version.

The registry is chosen by a **repository variable**, `REGISTRY_KIND`:

| | GHCR (default) | ECR |
|---|---|---|
| Set up | nothing | `terraform apply` with `registry_kind=ecr`, create and protect the `release` environment (below), then set variables `REGISTRY_KIND=ecr` and `AWS_ROLE_ARN=<github_role_arn output>` (optionally `AWS_REGION`) |
| Auth from the workflow | the built-in `GITHUB_TOKEN` with `packages: write` | GitHub OIDC: `aws-actions/configure-aws-credentials` assumes `AWS_ROLE_ARN`; no stored keys |
| Cost | free for public packages | about $0.10/GB-month |
| Auth from the box | none if the packages are public | the instance role (ECR pull), `aws ecr get-login-password` |
| Image names | `ghcr.io/<owner>/apeiron/<service>` | `<account>.dkr.ecr.<region>.amazonaws.com/apeiron/<service>` |

ECR is used only when `REGISTRY_KIND=ecr` **and** `AWS_ROLE_ARN` is set; otherwise the workflow falls back to GHCR with a
warning.

With GHCR, packages created by a workflow start out private. **The box pulls without credentials, so the packages must be
public**: after the first run, open each package's settings on GitHub and change its visibility. That is your decision (it
changes what your GitHub account exposes) and nothing in this repository does it. Because GHCR is the default registry,
`scripts/remote-up.sh` then needs no extra flag. Compose reads the image name as
`${REGISTRY}/apeiron/<service>:${TAG}`, so a local `docker compose up --build` still builds from source.

Check a published manifest:

```bash
docker buildx imagetools inspect ghcr.io/iappgeek/apeiron/antikythera:latest
```

## Alternatives

The same images and compose file work on any Docker host.

| Option | About | Notes |
|---|---|---|
| Oracle Cloud Always Free (Ampere A1, 4 OCPU, 24 GB) | $0 | capacity in popular regions can be scarce; arm64 images work as they are |
| Hetzner CAX31 (8 vCPU, 16 GB, arm64) | about EUR 0.02/hour | hourly billing, delete the server to stop paying; install Docker, clone, `docker compose --profile core --profile monitoring up -d` |
| AWS ECS Fargate + ALB + MongoDB Atlas | about $250+/month | production-style; not needed for a proof of concept |

Atlas M0 (512 MB) cannot hold 1M orders x 50 columns, and DocumentDB is not fully MongoDB-compatible, so MongoDB runs in
a container everywhere.

## Security notes

- **Network:** with the Cloudflare Tunnel there is **no inbound rule at all** (cloudflared dials out); without it the only
  inbound rule is 8080, and optionally 3001, from `allowed_cidr`, a single address by default. MongoDB (27017), NATS (4222, 8222), the server (4000) and Prometheus (9090) are never published beyond loopback on the
  box, and the security group would not admit them anyway. `/metrics` and `/health` are not proxied by nginx.
- **No SSH:** there is no key pair and no port 22 rule. Shell access is AWS Systems Manager Session Manager, authorised by
  IAM and logged in CloudTrail.
- **Instance:** IMDSv2 required with a hop limit of 1 (containers cannot reach the instance credentials); encrypted root
  volume; the instance role can only talk to SSM, pull from this stack's ECR repositories, and read the one tunnel token
parameter.
- **CI to AWS:** GitHub OIDC, no long-lived keys. The role trusts only this repository's `v*` tags and its `main` branch,
  and can only push to this stack's ECR repositories.
- **TLS and access:** with the tunnel, browsers reach the box only over HTTPS through Cloudflare, behind an Access login
  (one-time PIN to an allowed email) or the scripts' service token. Without it, traffic is plain HTTP restricted to your
  IP, carrying synthetic data only.
- **Secrets:** the tunnel token lives in a SecureString SSM parameter and is written on the box only to `.env.remote`
  (mode 600). `infra/cloudflare/terraform.tfstate` holds the tunnel token and the service token secret in plain text: it
  is git-ignored; treat it like a credentials file.
- **Grafana** allows anonymous Viewer access. That is acceptable on loopback and behind the Access login; without the
  tunnel, Grafana stays on loopback on the box unless you set `expose_grafana`.
- **Public repo:** only `.env.example` is committed, `*.tfstate`, `*.tfvars` and `.terraform/` are git-ignored, and no
  secret or AG Grid licence key appears anywhere in the repository or the images. Terraform state contains resource IDs
  and is kept local; do not commit it.
- **Images** run as a non-root user (`node`, or uid 101 for nginx).
