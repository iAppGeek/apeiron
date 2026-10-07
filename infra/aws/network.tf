# The default VPC and one of its public subnets are enough for a single test box (no NAT gateway, no load balancer).
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

resource "aws_security_group" "box" {
  name_prefix = "apeiron-box-"
  description = "Apeiron test box: web (and optionally Grafana) from one CIDR only; no SSH, access is through SSM"
  vpc_id      = data.aws_vpc.default.id

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  security_group_id = aws_security_group.box.id
  description       = "Blotter web (nginx)"
  cidr_ipv4         = var.allowed_cidr
  from_port         = 8080
  to_port           = 8080
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "grafana" {
  count = var.expose_grafana ? 1 : 0

  security_group_id = aws_security_group.box.id
  description       = "Grafana"
  cidr_ipv4         = var.allowed_cidr
  from_port         = 3001
  to_port           = 3001
  ip_protocol       = "tcp"
}

# Outbound is open: the box pulls images, reaches the SSM endpoints and clones the repository.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.box.id
  description       = "All outbound"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
