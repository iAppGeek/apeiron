terraform {
  required_version = ">= 1.14"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  # State stays local (gitignored), like infra/aws. It holds the tunnel token and the service token secret, so it is
  # as sensitive as a credentials file. This stack is created once and outlives every box.
}

# Reads CLOUDFLARE_API_TOKEN from the environment (docs/hosting.md lists the permissions it needs).
provider "cloudflare" {}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "apeiron"
      ManagedBy = "terraform"
    }
  }
}
