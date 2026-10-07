terraform {
  required_version = ">= 1.14"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
  }

  # State stays local (gitignored): this is a short-lived test box, not shared infrastructure.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "apeiron"
      ManagedBy = "terraform"
    }
  }
}
