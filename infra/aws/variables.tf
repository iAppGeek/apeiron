variable "region" {
  description = "AWS region for everything."
  type        = string
  default     = "eu-west-2"
}

variable "allowed_cidr" {
  description = "The only address range allowed to reach the web port (and Grafana, if exposed), for example \"203.0.113.7/32\". Use your own public IP."
  type        = string

  validation {
    condition     = can(cidrhost(var.allowed_cidr, 0)) && var.allowed_cidr != "0.0.0.0/0" && var.allowed_cidr != "::/0"
    error_message = "allowed_cidr must be a valid CIDR block and must not be open to the whole internet."
  }
}

variable "instance_type" {
  description = "Graviton instance type. t4g.xlarge is 4 vCPU and 16 GB."
  type        = string
  default     = "t4g.xlarge"
}

variable "volume_size_gb" {
  description = "Size of the encrypted gp3 root volume, which also holds the Mongo and NATS data."
  type        = number
  default     = 30
}

variable "github_repo" {
  description = "GitHub repository (owner/name) whose workflows may push images to ECR through OIDC."
  type        = string
  default     = "iAppGeek/apeiron"
}

variable "expose_grafana" {
  description = "Also open port 3001 (Grafana) to allowed_cidr. Off by default: use an SSM port forward instead."
  type        = bool
  default     = false
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC identity provider. Set to false when the account already has one (only one per URL is allowed)."
  type        = bool
  default     = true
}

variable "registry" {
  description = "Registry the box pulls images from, without a trailing slash. Empty means this stack's own ECR registry; use \"ghcr.io/iappgeek\" for GHCR."
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Image tag written to .env.remote on first boot. remote-up overrides it on every start."
  type        = string
  default     = "latest"
}

variable "git_ref" {
  description = "Git ref of the repository cloned to the box for its compose files."
  type        = string
  default     = "main"
}

variable "mongo_cache_gb" {
  description = "WiredTiger cache cap in GB. 4 suits the 16 GB box."
  type        = number
  default     = 4
}

variable "services" {
  description = "Service images, one ECR repository each (apeiron/<name>)."
  type        = list(string)
  default     = ["antikythera", "hermes", "gaia", "talos", "pharos"]
}
