variable "account_id" {
  description = "Cloudflare account ID (the dashboard shows it on the zone's overview page)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be the 32-character hex Cloudflare account ID."
  }
}

variable "zone_name" {
  description = "Cloudflare zone the host names live in."
  type        = string
  default     = "oramalabs.dev"
}

variable "hostname" {
  description = "Host name the blotter is served on, inside zone_name."
  type        = string
  default     = "blotter.oramalabs.dev"
}

variable "grafana_hostname" {
  description = "Host name for Grafana behind the same Access login, inside zone_name. Empty keeps Grafana private (SSM port forward only)."
  type        = string
  default     = "grafana.oramalabs.dev"
}

variable "allowed_emails" {
  description = "Email addresses Cloudflare Access lets in (each signs in with a one-time PIN sent to that address)."
  type        = list(string)

  validation {
    condition     = length(var.allowed_emails) > 0 && alltrue([for e in var.allowed_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "allowed_emails must list at least one email address."
  }
}

variable "session_duration" {
  description = "How long an Access login lasts before the browser has to sign in again."
  type        = string
  default     = "24h"
}

variable "region" {
  description = "AWS region of the SSM parameter that hands the tunnel token to the box. Keep it the same as infra/aws."
  type        = string
  default     = "eu-west-2"
}
