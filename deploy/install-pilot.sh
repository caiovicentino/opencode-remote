#!/bin/sh
# Installs the opencode-remote Pilot autonomous loop as a launchd service.
# Idempotent: re-running updates the plist and restarts the service.
#
# P2-098: the relay URL is fully parametrized — no operator hostname is
# hardcoded. RELAY_URL env wins; a re-install without it reuses the value
# from the existing plist; a first install requires it (LAN mode:
# RELAY_URL=ws://<lan-ip>:8787, see README "Install as a third party").
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/.opencode-remote"
LOGS="$DIR/logs"
PLIST="$HOME/Library/LaunchAgents/com.ocr.pilot.plist"

mkdir -p "$LOGS" "$DIR/pilot"

RELAY_URL="${RELAY_URL:-}"
if [ -z "$RELAY_URL" ] && [ -f "$PLIST" ]; then
  RELAY_URL="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:RELAY_URL' "$PLIST" 2>/dev/null || true)"
fi
if [ -z "$RELAY_URL" ]; then
  echo "error: RELAY_URL is required on first install — no default hostname is baked in." >&2
  echo "       LAN mode (no tailnet): RELAY_URL=wss://<lan-ip>:8788 $0" >&2
  echo "       Tailnet/public relay:  RELAY_URL=wss://host:8788 $0" >&2
  exit 1
fi

# dedicated clone where the agents work (production runs from $REPO)
if [ ! -d "$DIR/pilot/repo/.git" ]; then
  URL="$(git -C "$REPO" remote get-url origin)"
  git clone "$URL" "$DIR/pilot/repo"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ocr.pilot</string>
  <key>ProgramArguments</key><array>
    <string>$(which node)</string>
    <string>--import</string><string>tsx/esm</string>
    <string>apps/pilot/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOGS/pilot.log</string>
  <key>StandardErrorPath</key><string>$LOGS/pilot.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.opencode/bin:$(dirname $(which node)):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
    <key>RELAY_URL</key><string>${RELAY_URL}</string>
  </dict>
</dict></plist>
EOF

launchctl bootout gui/$(id -u)/com.ocr.pilot 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
launchctl enable gui/$(id -u)/com.ocr.pilot
echo "pilot installed: $PLIST"
echo "freeze: touch ~/.opencode-remote/pilot.lock · logs: $LOGS/pilot.log"
