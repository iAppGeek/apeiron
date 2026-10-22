# The blotter on a fixed host name over HTTPS, through a Cloudflare Tunnel. cloudflared on the box (the tunnel
# compose profile) dials out to Cloudflare, so the box needs no inbound port, no certificate and no DNS update when
# its IP changes. Cloudflare Access puts an email login in front. Cost: nothing (Access is free up to 50 users).
#
# This stack outlives scripts/remote-destroy.sh: a rebuilt box reuses the same tunnel through the token in SSM.

data "cloudflare_zone" "site" {
  filter = {
    name = var.zone_name
    account = {
      id = var.account_id
    }
  }
}

locals {
  # Every host name the tunnel serves, and the compose service behind it.
  origins = merge(
    { (var.hostname) = "http://pharos:8080" },
    var.grafana_hostname == "" ? {} : { (var.grafana_hostname) = "http://grafana:3000" },
  )
}

# --- Tunnel ---------------------------------------------------------------------------------------------------

resource "cloudflare_zero_trust_tunnel_cloudflared" "box" {
  account_id = var.account_id
  name       = "apeiron-box"
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "box" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.box.id

  config = {
    ingress = concat(
      [for host, service in local.origins : { hostname = host, service = service }],
      # Required catch-all: anything else that reaches the tunnel gets a 404.
      [{ service = "http_status:404" }],
    )
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "box" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.box.id
}

resource "cloudflare_dns_record" "origin" {
  for_each = local.origins

  zone_id = data.cloudflare_zone.site.zone_id
  name    = each.key
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.box.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # automatic; required for proxied records
  comment = "Apeiron box through Cloudflare Tunnel (infra/cloudflare)"
}

# --- Access ---------------------------------------------------------------------------------------------------

# Lets talos (scripts/remote-loadtest.sh --from-laptop) and other scripts through Access without a browser login,
# with the CF-Access-Client-Id and CF-Access-Client-Secret headers.
resource "cloudflare_zero_trust_access_service_token" "scripts" {
  account_id = var.account_id
  name       = "apeiron-scripts"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_application" "origin" {
  for_each = local.origins

  account_id       = var.account_id
  name             = "Apeiron ${each.key}"
  domain           = each.key
  type             = "self_hosted"
  session_duration = var.session_duration

  policies = [
    {
      name       = "Allowed people"
      decision   = "allow"
      precedence = 1
      include    = [for e in var.allowed_emails : { email = { email = e } }]
    },
    {
      name       = "Scripts"
      decision   = "non_identity"
      precedence = 2
      include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.scripts.id } }]
    },
  ]
}

# --- Hand-off to the box --------------------------------------------------------------------------------------

# The box reads the token at deploy time with its instance role (infra/aws grants GetParameter on this name only).
# A standard-tier parameter encrypted with the AWS managed key: no charge.
resource "aws_ssm_parameter" "tunnel_token" {
  name        = "/apeiron/cloudflared/tunnel-token"
  description = "Cloudflare Tunnel token for the Apeiron box (infra/cloudflare)"
  type        = "SecureString"
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.box.token
}
