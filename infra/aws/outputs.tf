output "instance_id" {
  description = "EC2 instance ID (used by the remote-* scripts)."
  value       = aws_instance.box.id
}

output "public_ip" {
  description = "Public IPv4 address. It changes each time the instance is stopped and started."
  value       = aws_instance.box.public_ip
}

output "web_url" {
  description = "Blotter URL (reachable only from allowed_cidr)."
  value       = local.tunnel ? "https://${var.public_hostname}" : "http://${aws_instance.box.public_ip}:8080"
}

output "public_hostname" {
  description = "Host name the tunnel serves the blotter on, or empty for plain HTTP on the IP (read by the remote-* scripts)."
  value       = local.tunnel ? var.public_hostname : ""
}

output "tunnel_token_parameter" {
  description = "SSM parameter the box reads the tunnel token from, or empty (read by scripts/remote-up.sh)."
  value       = var.tunnel_token_parameter
}

output "region" {
  description = "AWS region."
  value       = var.region
}

output "registry" {
  description = "Registry host and owner the box pulls from."
  value       = local.registry
}

output "ecr_repository_urls" {
  description = "ECR repository URL per service."
  value       = { for name, repo in aws_ecr_repository.service : name => repo.repository_url }
}

output "github_role_arn" {
  description = "Set this as the AWS_ROLE_ARN repository variable (and REGISTRY_KIND=ecr) to push images to ECR."
  value       = aws_iam_role.github_push.arn
}
