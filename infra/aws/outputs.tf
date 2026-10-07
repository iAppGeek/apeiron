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
  value       = "http://${aws_instance.box.public_ip}:8080"
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
