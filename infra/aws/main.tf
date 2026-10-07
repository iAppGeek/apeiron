# Latest Amazon Linux 2023 arm64 AMI, resolved at plan time from the public SSM parameter.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

locals {
  registry = var.registry != "" ? var.registry : local.ecr_registry
}

resource "aws_instance" "box" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.box.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = true

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  # IMDSv2 only. One hop keeps containers on the box from reaching the instance credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    registry       = local.registry
    image_tag      = var.image_tag
    git_ref        = var.git_ref
    git_url        = "https://github.com/${var.github_repo}.git"
    mongo_cache_gb = var.mongo_cache_gb
    grafana_bind   = var.expose_grafana ? "0.0.0.0" : "127.0.0.1"
    region         = var.region
  })

  tags = {
    Name = "apeiron-box"
  }

  lifecycle {
    # A newer AMI must not replace the box (and its data); the stack is rebuilt with destroy and apply instead.
    ignore_changes = [ami, user_data]
  }
}
