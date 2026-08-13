#!/usr/bin/env bash
# anytoany installer — safe to re-run (updates in place).
#
#   curl -fsSL https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh | bash
#
# Join an existing cluster (printed by `anyd pair --invite` on the first device):
#   ... | bash -s -- --join <token> [--name mini]
set -euo pipefail

REPO="git+https://github.com/Ericgood/any-to-any.git"
JOIN=""
NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --join) JOIN="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }

command -v git >/dev/null 2>&1 || { echo "✗ git is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "✗ node >= 20 is required — https://nodejs.org"; exit 1; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || { echo "✗ node >= 20 required (found $(node --version))"; exit 1; }

say "Installing anytoany (this builds from source, ~30s)…"
npm install -g "$REPO"

say "Configuring agents (skills: any-to-any + reload; inbox hooks)…"
anyd setup

if [[ -n "$JOIN" ]]; then
  anyd pair --set "$JOIN"
fi
if [[ -n "$NAME" ]]; then
  anyd pair --name "$NAME"
fi

echo
say "✓ anytoany is installed."
echo "  Start the daemon:   anyd start"
echo "  Web console:        http://127.0.0.1:7433"
echo "  See your sessions:  anyd list"
if [[ -z "$JOIN" ]]; then
  echo "  Link another device: anyd pair --invite   (prints a one-liner to paste there)"
fi
