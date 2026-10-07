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
that includes `infra/docker-compose.yml`, so every command runs from the repo root.

### Compose profiles

| Profile | Services | Purpose |
|---|---|---|
| `core` | `mongo`, `nats`, `antikythera`, `hermes`, `pharos` | the blotter itself |
| `seed` | `mongo`, `gaia` | load the orders into Mongo (one-shot) |
| `monitoring` | `prometheus`, `grafana` | metrics and the server dashboard |
| `loadtest` | `talos` | the load harness (needs `core`) |

```bash
cp .env.example .env                                        # optional local overrides, never committed
docker compose --profile core up -d --build                 # build and start the stack
docker compose --profile core --profile seed run --rm gaia  # seed 1M orders (a second run is a no-op)
docker compose --profile core --profile monitoring up -d    # add Prometheus and Grafana
```

Start the stack, seed, then restart `antikythera` (or start it after seeding): the server loads Mongo once at startup,
so a server that started against an empty database has nothing to show until it is restarted.

### Ports

Every published port binds to `127.0.0.1`, so nothing is reachable from the network by default.

| Service | Port | Notes |
|---|---|---|
| pharos (nginx) | 8080 | the web app, and `/ws` proxied to the server |
| antikythera | 4000 | `/health`, `/metrics`, `/debug/lag`, and the WebSocket at `/ws` |
| mongo | 27017 | |
| nats | 4222, 8222 | client and monitoring |
| prometheus | 9090 | |
| grafana | 3001 | anonymous Viewer access; admin sign-in uses `GRAFANA_ADMIN_PASSWORD` (default `admin`) |

`WEB_BIND` and `GRAFANA_BIND` change the interface the web and Grafana ports bind to (default `127.0.0.1`). The remote
box sets `WEB_BIND=0.0.0.0` and relies on its security group.

### Memory: `MONGO_CACHE_GB`

MongoDB's WiredTiger cache defaults to half of the Docker VM's RAM. Under the live write-behind load that starves the
blotter server and the VM swaps, after which every container stalls. `MONGO_CACHE_GB` (default `1`) caps it; 1 GB holds
the working set of this dataset. Raise it on a bigger host (the AWS box uses 4). The server container is capped at
`mem_limit: 3g` and needs about 0.9 GB at the load peak.

### Other variables

All variables, with their defaults, are in `.env.example`. The ones you are most likely to change: `SEED_ROWS`
(default 1,000,000; a smaller number seeds faster), `LOAD_PRESET` (`medium` or `stress`, also switchable from the Dev
menu), `FLUSH_MS` and `LOG_LEVEL`.

### Resetting before a load test

`scripts/loadtest-reset.sh` empties JetStream, re-seeds the orders (so the LIVE population is back to about 500) and
brings everything up on the Medium preset.

## AWS, on demand, for short test sessions

One Graviton instance runs the whole stack for the length of a test session, and is stopped (not destroyed) in between.
There is no load balancer and no NAT gateway.

```
laptop ──(AWS CLI + SSM)──▶ EC2 t4g.xlarge, Amazon Linux 2023 arm64, 30 GB encrypted gp3
   │                          docker compose: mongo, nats, antikythera, hermes, pharos, prometheus, grafana
   └──(HTTP :8080, your IP only)──▶ pharos
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

| Resource | Notes |
|---|---|
| EC2 instance | `t4g.xlarge` (4 vCPU, 16 GB), latest AL2023 arm64 AMI from the public SSM parameter, 30 GB encrypted gp3, IMDSv2 only |
| Security group | inbound **only** from `allowed_cidr`, on 8080 (and 3001 if `expose_grafana`); **no SSH** |
| ECR repositories | `apeiron/<service>` for the five services, scan on push, lifecycle policy keeps the last 10 images |
| Instance role | `AmazonSSMManagedInstanceCore` plus ECR pull scoped to those repositories |
| GitHub OIDC provider and push role | trusted only for jobs that declare the GitHub environment `release` (`repo:<github_repo>:environment:release`); ECR push scoped to those repositories |

The default VPC and one of its public subnets are used. State is **local** (`infra/aws/terraform.tfstate`, git-ignored).

On first boot cloud-init installs Docker, Git and a checksum-verified Compose plugin, clones this repository to
`/opt/apeiron`, and writes `/opt/apeiron/.env.remote` (`REGISTRY`, `TAG`, `MONGO_CACHE_GB=4`, `WEB_BIND=0.0.0.0`, and a
randomly generated Grafana admin password that never leaves the box).

Variables (`infra/aws/variables.tf`): `region` (default `eu-west-2`), `allowed_cidr` (required, your public IP as
`x.x.x.x/32`; `0.0.0.0/0` is rejected), `instance_type` (`t4g.xlarge`), `github_repo` (`iAppGeek/apeiron`), and a few
more (`volume_size_gb`, `expose_grafana`, `create_github_oidc_provider`, `registry_kind`, `ghcr_owner`, `registry`).
`registry_kind` is `ghcr` by default, matching the Images workflow, so the box pulls `ghcr.io/<ghcr_owner>/apeiron/<service>`; set it to `ecr` (and `REGISTRY_KIND=ecr` in GitHub) to use the stack's own ECR repositories.

### First `remote-up`

```bash
aws sts get-caller-identity                 # confirm which account you are about to spend money in
scripts/remote-up.sh --dry-run              # shows the steps without touching AWS
scripts/remote-up.sh                        # cost warning, then 'terraform apply' (you approve its plan), then deploy
```

On first use the script detects your public IP, runs `terraform init` and `terraform apply -var allowed_cidr=<ip>/32` in
`infra/aws` (Terraform shows the plan and asks you to type `yes`), waits for the SSM agent, then runs the deploy over SSM:
update the compose files from git, log in to the registry (ECR), `docker compose pull`, start MongoDB and NATS, **seed
only if the database is empty** (about 3 minutes for a million rows on this box), and start everything else. It prints
the web URL when the stack is healthy.

Nothing is created until you answer Terraform's prompt; the scripts never apply by themselves. Useful options:
`--tag sha-abc1234` (deploy one specific build), `--ref <git ref>` (compose files from a branch or tag),
`--registry-kind ecr`, `--registry ghcr.io/iappgeek`, `--seed-rows 200000`, `--allowed-cidr`, `--apply` (re-run Terraform after your IP changes).

### A normal session

```bash
scripts/remote-up.sh --yes          # starts the stopped box (about 2 minutes), pulls newer images, no re-seed
open http://<ip>:8080               # the URL is printed; the IP changes at every start
scripts/remote-loadtest.sh --clients 50 --duration 300     # talos on the box, over SSM
scripts/remote-down.sh              # stop the instance: compute billing ends, the data stays
```

Grafana is not exposed by default. Forward it over SSM and open <http://localhost:3001>:

```bash
aws ssm start-session --region eu-west-2 --target <instance-id> \
  --document-name AWS-StartPortForwardingSession --parameters portNumber=3001,localPortNumber=3001
```

If your IP changes between sessions the box will not answer: run `scripts/remote-up.sh --apply` to update the security
group.

All four scripts are idempotent, default to **stop rather than destroy**, and have `--help` and `--dry-run`.

| Script | Does |
|---|---|
| `remote-up.sh` | first use: `terraform apply`; otherwise starts the instance. Deploys and seeds if needed. Safe to re-run |
| `remote-down.sh` | stops the instance and keeps the disk |
| `remote-destroy.sh` | `terraform destroy` after you type `destroy apeiron`; removes the disk and all data |
| `remote-loadtest.sh` | talos on the box over SSM (default), or from your machine with `--from-laptop` |

### Cost

Prices are for eu-west-2 (London), on demand, checked against the AWS Price List API; the stop/start pattern is the
whole saving.

| State | Cost |
|---|---|
| Running | about **$0.16/hour**: $0.1504 for the `t4g.xlarge`, $0.005 for the public IPv4 address, plus a little for the volume |
| A 4-hour session | about $0.65 |
| Stopped | about **$2.80/month**: the 30 GB gp3 volume at $0.0928/GB-month. The public IP is released while stopped |
| ECR | pennies: the lifecycle policy keeps the last 10 images per repository (a few hundred MB in all) |
| Destroyed | nothing |

Spot instances would cut the compute price by 60 to 70 percent but can be reclaimed mid-test, which defeats a latency
measurement, so the stack does not use them. In us-east-1 the instance is about 11 percent cheaper.

### Cleaning up

`scripts/remote-down.sh` after every session. `scripts/remote-destroy.sh` when you are done with the experiment: it runs
`terraform destroy` (instance, disk, security group, IAM roles, ECR repositories and their images). Check the AWS
console afterwards if you want to be certain nothing is left. The ECR repositories are created with `force_delete`, so
destroying them removes the images too.

## Choosing a registry: GHCR or ECR

The **Images** workflow (`.github/workflows/images.yml`) builds all five images on native runners (`ubuntu-latest` for
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

- **Network:** the only inbound rule is 8080 (and optionally 3001) from `allowed_cidr`, a single address by default.
  MongoDB (27017), NATS (4222, 8222), the server (4000) and Prometheus (9090) are never published beyond loopback on the
  box, and the security group would not admit them anyway. `/metrics` and `/health` are not proxied by nginx.
- **No SSH:** there is no key pair and no port 22 rule. Shell access is AWS Systems Manager Session Manager, authorised by
  IAM and logged in CloudTrail.
- **Instance:** IMDSv2 required with a hop limit of 1 (containers cannot reach the instance credentials); encrypted root
  volume; the instance role can only talk to SSM and pull from this stack's ECR repositories.
- **CI to AWS:** GitHub OIDC, no long-lived keys. The role trusts only this repository's `v*` tags and its `main` branch,
  and can only push to this stack's ECR repositories.
- **Plain HTTP:** traffic between your browser and the box is unencrypted. It is restricted to your IP and carries
  synthetic data only. If that is not acceptable, put TLS in front (the plan reserves an `edge` profile for Caddy).
- **Grafana** allows anonymous Viewer access. That is acceptable on loopback; on the box Grafana stays on loopback unless
  you set `expose_grafana`.
- **Public repo:** only `.env.example` is committed, `*.tfstate`, `*.tfvars` and `.terraform/` are git-ignored, and no
  secret or AG Grid licence key appears anywhere in the repository or the images. Terraform state contains resource IDs
  and is kept local; do not commit it.
- **Images** run as a non-root user (`node`, or uid 101 for nginx).
