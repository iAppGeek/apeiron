# Optional: the blotter on a host name over HTTPS through a Cloudflare Tunnel. The tunnel, its DNS records and the
# Access login live in infra/cloudflare, which outlives this stack; this stack only lets the box read the tunnel token.

locals {
  tunnel = var.tunnel_token_parameter != ""
}

data "aws_iam_policy_document" "tunnel_token" {
  count = local.tunnel ? 1 : 0

  # SecureString with the AWS managed key: its key policy already lets SSM decrypt for this account's principals.
  statement {
    sid       = "ReadTunnelToken"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${var.tunnel_token_parameter}"]
  }
}

resource "aws_iam_role_policy" "tunnel_token" {
  count = local.tunnel ? 1 : 0

  name   = "tunnel-token"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.tunnel_token[0].json
}
