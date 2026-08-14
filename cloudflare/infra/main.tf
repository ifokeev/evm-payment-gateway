terraform {
  required_version = ">= 1.8.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }
}

provider "cloudflare" {}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID. Set CLOUDFLARE_API_TOKEN separately; do not put it in tfvars."
  type        = string
}

variable "d1_location" {
  description = "Optional D1 primary location hint such as weur, eeur, wnam, or apac."
  type        = string
  default     = null
}

resource "cloudflare_d1_database" "gateway" {
  account_id            = var.cloudflare_account_id
  name                  = "evm-payment-gateway"
  primary_location_hint = var.d1_location
}

resource "cloudflare_queue" "sweeps" {
  account_id = var.cloudflare_account_id
  queue_name = "evm-payment-gateway-sweeps"
  settings = {
    message_retention_period = 345600
  }
}

output "d1_database_id" {
  value = cloudflare_d1_database.gateway.id
}

output "sweep_queue_id" {
  value = cloudflare_queue.sweeps.queue_id
}
