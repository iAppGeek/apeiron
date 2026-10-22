output "hostname" {
  description = "Host name the blotter is served on (read by the remote-* scripts)."
  value       = var.hostname
}

output "grafana_hostname" {
  description = "Host name Grafana is served on, or empty (read by scripts/remote-up.sh)."
  value       = var.grafana_hostname
}

output "tunnel_token_parameter" {
  description = "SSM parameter holding the tunnel token (passed to infra/aws by scripts/remote-up.sh)."
  value       = aws_ssm_parameter.tunnel_token.name
}

output "access_client_id" {
  description = "Service token ID for scripts, sent as CF-Access-Client-Id (read by scripts/remote-loadtest.sh)."
  value       = cloudflare_zero_trust_access_service_token.scripts.client_id
}

output "access_client_secret" {
  description = "Service token secret for scripts, sent as CF-Access-Client-Secret (read by scripts/remote-loadtest.sh)."
  value       = cloudflare_zero_trust_access_service_token.scripts.client_secret
  sensitive   = true
}
