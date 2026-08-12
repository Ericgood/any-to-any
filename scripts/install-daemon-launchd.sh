#!/usr/bin/env bash
# Install the anyd daemon as a launchd LaunchAgent (macOS) so it starts at login
# and is auto-restarted if it dies. Without this the daemon runs only as long as
# the shell that launched it — when it exits, queued messages never deliver
# ("daemon offline"), which looks like "messaging is broken" even locally.
#
# Idempotent: re-running regenerates the plist and reloads it.
# Remove with:  launchctl unload ~/Library/LaunchAgents/dev.anytoany.daemon.plist && rm "$_"
set -euo pipefail

LABEL="dev.anytoany.daemon"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG="$HOME/.anytoany/daemon.log"

# Resolve node + the anyd entry (dist/cli.js) absolutely — launchd has no PATH/shell.
NODE="$(command -v node)" || { echo "node not found in PATH"; exit 1; }
ANYD_SHIM="$(command -v anyd)" || { echo "anyd not found — install anytoany first"; exit 1; }
# Follow the shim symlink to the real dist/cli.js so launchd runs it directly.
ANYD_ENTRY="$(node -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$ANYD_SHIM")"

# CRITICAL: the daemon delivers by spawning codex/kimi/claude/zcode. launchd starts
# processes with a minimal PATH, so bake in every dir those binaries live in, or
# deliveries fail with "command not found". Derive from where they actually are.
dirs=("$(dirname "$NODE")")
for bin in codex claude kimi anyd; do
  p="$(command -v "$bin" 2>/dev/null || true)"
  [ -n "$p" ] && dirs+=("$(dirname "$p")")
done
dirs+=(/usr/bin /bin /usr/sbin /sbin)
# de-dup, join with ':'
DAEMON_PATH="$(printf '%s\n' "${dirs[@]}" | awk '!seen[$0]++' | paste -sd: -)"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.anytoany"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ANYD_ENTRY}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${DAEMON_PATH}</string>
    <key>HOME</key><string>${HOME}</string>
  </dict>
  <key>WorkingDirectory</key><string>${HOME}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null

# Stop any hand-started daemon so the launchd one owns the port, then (re)load.
anyd stop >/dev/null 2>&1 || true
sleep 1
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 5

echo "Installed ${LABEL}. PATH baked for delivery: ${DAEMON_PATH}"
launchctl list | grep "$LABEL" || { echo "WARNING: not registered"; exit 1; }
anyd status | head -1
