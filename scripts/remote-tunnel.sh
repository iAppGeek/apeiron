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
               (run scripts/remote-destroy.sh first)
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

require terraform curl

needs_credentials() {
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "CLOUDFLARE_API_TOKEN is not set (see docs/hosting.md for its permissions)"
  [ -f "$CF_TF_DIR/terraform.tfvars" ] ||
    die "infra/cloudflare/terraform.tfvars is missing; copy terraform.tfvars.example and fill in account_id and allowed_emails"
}

status() {
  local host code
  host="$(cf_output hostname)"
  [ -n "$host" ] || die "no tunnel is set up; run scripts/remote-tunnel.sh --apply"
  for host in "$host" "$(cf_output grafana_hostname)"; do
    [ -n "$host" ] || continue
    # Access answers a request without a login with a redirect to the sign-in page, box running or not.
    code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$host/" || true)"
    case "$code" in
      302 | 303) info "https://$host: behind Access (sign in with an allowed email)" ;;
      000) info "https://$host: no answer yet (new DNS records can take a few minutes)" ;;
      *) info "https://$host: HTTP $code (expected a redirect to the Access login)" ;;
    esac
  done
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
    [ -z "$(tf_output instance_id)" ] || die "the box still exists; run scripts/remote-destroy.sh first"
    [ -n "$(cf_output hostname)" ] || { info "Nothing to destroy."; exit 0; }
    needs_credentials
    terraform -chdir="$CF_TF_DIR" destroy
    ;;
esac
