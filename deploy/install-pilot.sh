#!/bin/sh
# Installs the opencode-remote Pilot autonomous loop as a launchd service.
# Idempotent: re-running updates the plist and restarts the service.
#
# P2-098: the relay URL is fully parametrized — no operator hostname is
# hardcoded. RELAY_URL env wins; a re-install without it reuses the value
# from the existing plist; a first install requires it (LAN mode:
# RELAY_URL=wss://<lan-ip>:8788, see README "Install as a third party").
# NODE_EXTRA_CA_CERTS follows the same rule: env wins, re-install recovers
# from the plist (round 5 — dropping it silently broke mkcert wss:// relays).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/.opencode-remote"
LOGS="$DIR/logs"
PLIST="$HOME/Library/LaunchAgents/com.ocr.pilot.plist"

mkdir -p "$LOGS" "$DIR/pilot"

RELAY_URL="${RELAY_URL:-}"
NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}"
if [ -f "$PLIST" ]; then
  if [ -z "$RELAY_URL" ]; then
    RELAY_URL="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:RELAY_URL' "$PLIST" 2>/dev/null || true)"
  fi
  # Round 5: recover the CA exactly like RELAY_URL — an idempotent re-install
  # without the env var must not silently strip it from the plist (Node does
  # not trust the macOS keychain, so the wss:// relay becomes unreachable).
  if [ -z "$NODE_EXTRA_CA_CERTS" ]; then
    NODE_EXTRA_CA_CERTS="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:NODE_EXTRA_CA_CERTS' "$PLIST" 2>/dev/null || true)"
  fi
fi
if [ -z "$RELAY_URL" ]; then
  echo "error: RELAY_URL is required on first install — no default hostname is baked in." >&2
  echo "       LAN mode (no tailnet): RELAY_URL=wss://<lan-ip>:8788 $0" >&2
  echo "         (wss with a local CA needs the root too:" >&2
  echo "          NODE_EXTRA_CA_CERTS=\"\$(mkcert -CAROOT)/rootCA.pem\")" >&2
  echo "       Tailnet/public relay:  RELAY_URL=wss://host:8788 $0" >&2
  exit 1
fi

# P2-098 round 2: pass the custom CA through when provided — Node does not
# trust the macOS keychain, so a wss:// mkcert relay is unreachable without it
# (same passthrough deploy/install.sh wires into the daemon plist).
CA_ENV=""
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  CA_ENV="    <key>NODE_EXTRA_CA_CERTS</key><string>${NODE_EXTRA_CA_CERTS}</string>"
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
$CA_ENV
  </dict>
</dict></plist>
EOF

launchctl bootout gui/$(id -u)/com.ocr.pilot 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
launchctl enable gui/$(id -u)/com.ocr.pilot
echo "pilot installed: $PLIST"
echo "freeze: touch ~/.opencode-remote/pilot.lock · logs: $LOGS/pilot.log"
