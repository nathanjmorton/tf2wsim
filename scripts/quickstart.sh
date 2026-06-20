#!/usr/bin/env bash
# tf2wsim quickstart: install deps, prepare the example Terraform project, and
# launch the Wing Console on it. Safe to re-run; each step is idempotent.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
EXAMPLE="$ROOT/examples/basic"
PORT="${PORT:-3000}"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# --- preflight: required tools -------------------------------------------------
missing=()
command -v node      >/dev/null 2>&1 || missing+=("node (https://nodejs.org — v18+)")
command -v npm       >/dev/null 2>&1 || missing+=("npm (ships with Node.js)")
command -v terraform >/dev/null 2>&1 || missing+=("terraform (https://developer.hashicorp.com/terraform/install)")
command -v unzip     >/dev/null 2>&1 || missing+=("unzip")
if [ "${#missing[@]}" -ne 0 ]; then
  printf 'Missing required tools:\n' >&2
  for m in "${missing[@]}"; do printf '  - %s\n' "$m" >&2; done
  fail "install the above, then re-run ./scripts/quickstart.sh"
fi

# --- install node dependencies -------------------------------------------------
if [ ! -d "$ROOT/node_modules/@wingconsole/app" ]; then
  say "Installing dependencies (npm install)..."
  npm install --no-audit --no-fund
else
  say "Dependencies already installed."
fi

# --- prepare the example terraform project ------------------------------------
if [ ! -d "$EXAMPLE/.terraform" ]; then
  say "Initializing example Terraform project (downloads providers)..."
  terraform -chdir="$EXAMPLE" init -input=false
else
  say "Example Terraform project already initialized."
fi

# --- launch the console --------------------------------------------------------
say "Starting the Wing Console on the Terraform graph..."
say "Open http://localhost:$PORT/ in your browser (Ctrl-C to stop)."
exec node "$ROOT/bin/tf2wsim.js" console "$EXAMPLE" -p "$PORT"
