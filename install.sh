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

say "Installing anytoany (dist is committed — a zero-compile install)…"
npm install -g "$REPO" || {
  echo "✗ 'npm install -g' failed." >&2
  echo "  If this was a permission error (EACCES), your npm global prefix needs root." >&2
  echo "  Fix it without sudo, then re-run this installer:" >&2
  echo "    npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\"" >&2
  exit 1
}

# Resolve anyd even if npm's global bin isn't on PATH yet (common on a fresh setup),
# so the very next step doesn't die with "anyd: command not found".
ANYD="$(command -v anyd || true)"
ON_PATH=1
if [[ -z "$ANYD" ]]; then
  ON_PATH=0
  ANYD="$(npm prefix -g 2>/dev/null)/bin/anyd"
fi
if [[ ! -x "$ANYD" ]]; then
  echo "✗ Installed, but 'anyd' isn't on your PATH." >&2
  echo "  Add npm's global bin to PATH, then re-run:" >&2
  echo "    export PATH=\"$(npm prefix -g 2>/dev/null)/bin:\$PATH\"" >&2
  exit 1
fi

say "Configuring agents (skills: any-to-any + reload; inbox hooks)…"
"$ANYD" setup

if [[ -n "$JOIN" ]]; then
  "$ANYD" pair --set "$JOIN"
fi
if [[ -n "$NAME" ]]; then
  "$ANYD" pair --name "$NAME"
fi

echo
say "✓ anytoany is installed."
if [[ "$ON_PATH" -eq 0 ]]; then
  echo "  ⚠ Add npm's global bin to PATH so 'anyd' works in new shells:"
  echo "      export PATH=\"$(npm prefix -g 2>/dev/null)/bin:\$PATH\""
fi
echo "  Start the daemon:   anyd start"
echo "  Web console:        http://127.0.0.1:7433"
echo "  See your sessions:  anyd list"
if [[ -z "$JOIN" ]]; then
  echo "  Link another device: anyd pair --invite   (prints a one-liner to paste there)"
fi
