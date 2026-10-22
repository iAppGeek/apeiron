#!/usr/bin/env bash
# One-time setup of the blotter's host name: a Cloudflare Tunnel, its DNS records and an Access login (infra/cloudflare).
set -euo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/remote-lib.sh"

usage() {
  cat <<USAGE
Usage: scripts/remote-tunnel.sh --apply | --status | --destroy

Creates (or shows) the persistent part of the remote setup in infra/cloudflare: a Cloudflare Tunnel, proxied CNAME
records for the blotter (and Grafana), an Access application that lets in only the listed emails, a service token for
scripts, and the SSM parameter that hands the tunnel token to the box. scripts/remote-destroy.sh keeps it, so a
rebuilt box reuses the same tunnel. Cost: nothing (Access is free up to 50 users; a standard SSM parameter is free).

After this, scripts/remote-up.sh serves the blotter on https://<hostname> automatically.

Needs:
  CLOUDFLARE_API_TOKEN       in the environment (permissions are listed in docs/hosting.md)
  infra/cloudflare/terraform.tfvars   copied from terraform.tfvars.example: account_id and allowed_emails
  AWS credentials            for the SSM parameter

Options:
  --apply      run 'terraform apply' in infra/cloudflare (you approve its plan)
  --status     print the host names and whether they answer through Cloudflare
  --destroy    remove the tunnel, the records, the Access application and the parameter
               (STOP the box first: scripts/remote-down.sh)
  --dry-run    say what --apply would do and exit
  -h, --help   show this help
USAGE
}

ACTION=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) ACTION=apply; shift ;;
    --status) ACTION=status; shift ;;
    --destroy) ACTION=destroy; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
[ -n "$ACTION" ] || { usage >&2; exit 1; }

if [ "$DRY_RUN" = "1" ]; then
  echo "Dry run: would run 'terraform $ACTION' in infra/cloudflare with infra/cloudflare/terraform.tfvars."
  exit 0
fi

require terraform curl dig

needs_credentials() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set (see docs/hosting.md for its permissions)"
  [ -f "$CF_TF_DIR/terraform.tfvars" ] ||
    die "infra/cloudflare/terraform.tfvars is missing; copy terraform.tfvars.example and fill in account_id and allowed_emails"
}

status() {
  local host ip code
  host="$(cf_output hostname)"
  [ -n "$host" ] || die "no tunnel is set up; run scripts/remote-tunnel.sh --apply"
  for host in "$host" "$(cf_output grafana_hostname)"; do
    [ -n "$host" ] || continue
    # Resolve through public DNS: a local resolver can keep a "no such name" from before the record existed for up
    # to the zone's negative TTL (30 minutes), which says nothing about the tunnel.
    ip="$(dig +short A "$host" @1.1.1.1 2>/dev/null | grep -E '^[0-9.]+$' | head -1 || true)"
    if [ -z "$ip" ]; then
      info "https://$host: not in public DNS yet (new records can take a few minutes)"
      continue
    fi
    # Access answers a request without a login with a redirect to the sign-in page, box running or not.
    code="$(curl -s -o /dev/null -m 10 --resolve "$host:443:$ip" -w '%{http_code}' "https://$host/" || true)"
    case "$code" in
      302 | 303) info "https://$host: behind Access (sign in with an allowed email)" ;;
      000) info "https://$host: in public DNS ($ip) but no HTTPS answer" ;;
      *) info "https://$host: HTTP $code (expected a redirect to the Access login)" ;;
    esac
  done
  if [ -n "$ip" ] && ! dig +short A "$host" 2>/dev/null | grep -q .; then
    info "Note: your local DNS resolver does not see these names yet (a cached negative answer); browsers on this"
    info "machine will fail until it expires, or use a public resolver such as 1.1.1.1."
  fi
}

case "$ACTION" in
  apply)
    needs_credentials
    terraform -chdir="$CF_TF_DIR" init -input=false >/dev/null
    terraform -chdir="$CF_TF_DIR" apply
    status
    ;;
  status) status ;;
  destroy)
    [ -z "$(tf_output instance_id)" ] || die "the box is up; STOP it first with scripts/remote-down.sh"
    [ -n "$(cf_output hostname)" ] || { info "Nothing to destroy."; exit 0; }
    needs_credentials
    terraform -chdir="$CF_TF_DIR" destroy
    ;;
esac
