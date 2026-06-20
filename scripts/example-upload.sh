#!/usr/bin/env bash
# Run the full image-upload example end-to-end:
#   S3 website bucket (serves the upload form)
#     -> Lambda Function URL (validates the request)
#       -> S3 storage bucket (stores the image)
# Installs deps, terraform-inits the example, and opens the Wing Console on it.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
EXAMPLE="$ROOT/examples/website-upload"
PORT="${PORT:-3000}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preflight ---------------------------------------------------------------
missing=()
command -v node      >/dev/null 2>&1 || missing+=("node (https://nodejs.org — v18+)")
command -v npm       >/dev/null 2>&1 || missing+=("npm (ships with Node.js)")
command -v terraform >/dev/null 2>&1 || missing+=("terraform (https://developer.hashicorp.com/terraform/install)")
command -v unzip     >/dev/null 2>&1 || missing+=("unzip")
if [ "${#missing[@]}" -ne 0 ]; then
  printf 'Missing required tools:\n' >&2
  for m in "${missing[@]}"; do printf '  - %s\n' "$m" >&2; done
  fail "install the above, then re-run ./scripts/example-upload.sh"
fi

# --- install deps ------------------------------------------------------------
if [ ! -d "$ROOT/node_modules/@wingconsole/app" ]; then
  say "Installing dependencies (npm install)..."
  npm install --no-audit --no-fund
else
  say "Dependencies already installed."
fi

# --- terraform init ----------------------------------------------------------
if [ ! -d "$EXAMPLE/.terraform" ]; then
  say "Initializing example Terraform project (downloads providers)..."
  terraform -chdir="$EXAMPLE" init -input=false
else
  say "Example Terraform project already initialized."
fi

# --- launch ------------------------------------------------------------------
WEBSITE_RES="aws_s3_bucket_website_configuration.site"
say "Starting the Wing Console on the upload example..."
say "When it's ready, open the upload form (served from the simulated website bucket):"
say "  http://localhost:$PORT/tf2wsim/site/$WEBSITE_RES/"
say "Drop in an image — it flows website → Lambda Function URL → S3 storage bucket."
exec node "$ROOT/bin/tf2wsim.js" console "$EXAMPLE" -p "$PORT"
