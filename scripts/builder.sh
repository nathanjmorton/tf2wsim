#!/usr/bin/env bash
# tf2wsim builder quickstart: install deps and launch the drag-and-drop
# Terraform builder. From the builder you drag resources, wire edges, edit
# handler code, and click "Init & Open Console" to simulate — no terminal needed
# beyond this one command. Safe to re-run.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PORT="${PORT:-3100}"
CONSOLE_PORT="${CONSOLE_PORT:-3000}"
TARGET="${TARGET:-$ROOT/tf-project}"

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
  fail "install the above, then re-run ./scripts/builder.sh"
fi

# --- install node dependencies -------------------------------------------------
if [ ! -d "$ROOT/node_modules/@wingconsole/app" ]; then
  say "Installing dependencies (npm install)..."
  npm install --no-audit --no-fund
else
  say "Dependencies already installed."
fi

# --- launch the builder --------------------------------------------------------
mkdir -p "$TARGET"
say "Starting the tf2wsim builder."
say "Open http://localhost:$PORT/ — drag a graph, then click 'Init & Open Console'."
say "Generated Terraform is written to: $TARGET"
exec node "$ROOT/bin/tf2wsim.js" builder "$TARGET" -p "$PORT" --console-port "$CONSOLE_PORT"
