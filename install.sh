#!/usr/bin/env bash
# anytoany installer — safe to re-run (updates in place).
#
#   curl -fsSL https://raw.githubusercontent.com/Ericgood/any-to-any/main/install.sh | bash
#
# Pair with one of your existing devices (printed by `anyd pair --invite` there):
#   ... | bash -s -- --trust <that device's ID> --trust-name macbook [--name mini]
# Only public device IDs are exchanged — nothing in the command is secret (ADR-028).
set -euo pipefail

REPO="git+https://github.com/Ericgood/any-to-any.git"
TRUST=""
TRUST_NAME=""
NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --trust) TRUST="${2:-}"; shift 2 ;;
    --trust-name) TRUST_NAME="${2:-}"; shift 2 ;;
    --name) NAME="${2:-}"; shift 2 ;;
    --join)
      echo "✗ --join <token> was removed: devices now pair by public device ID (ADR-028)." >&2
      echo "  On your other device run 'anyd pair --invite' for an updated command." >&2
      exit 1 ;;
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

if [[ -n "$NAME" ]]; then
  "$ANYD" pair --name "$NAME"
fi
if [[ -n "$TRUST" ]]; then
  if [[ -n "$TRUST_NAME" ]]; then
    "$ANYD" pair add "$TRUST" --name "$TRUST_NAME"
  else
    "$ANYD" pair add "$TRUST"
  fi
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
if [[ -n "$TRUST" ]]; then
  echo
  say "One step left — on ${TRUST_NAME:-your other device}, trust this one back:"
  "$ANYD" pair | grep '^id:' | sed 's/^id: */      anyd pair add /'
else
  echo "  Link another device: anyd pair --invite   (prints a one-liner to paste there)"
fi
