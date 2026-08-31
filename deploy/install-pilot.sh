#!/bin/sh
# Installs the opencode-remote Pilot autonomous loop as a launchd service.
# Idempotent: re-running updates the plist and restarts the service.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/.opencode-remote"
LOGS="$DIR/logs"
PLIST="$HOME/Library/LaunchAgents/com.ocr.pilot.plist"

mkdir -p "$LOGS" "$DIR/pilot"

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
  </dict>
</dict></plist>
EOF

launchctl bootout gui/$(id -u)/com.ocr.pilot 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
launchctl enable gui/$(id -u)/com.ocr.pilot
echo "pilot installed: $PLIST"
echo "freeze: touch ~/.opencode-remote/pilot.lock · logs: $LOGS/pilot.log"
