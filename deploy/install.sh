#!/bin/zsh
# Installs opencode-remote relay + daemon as launchd services (KeepAlive),
# the static PWA origin (com.ocr.pwa), plus a daily log-rotation timer.
# Idempotent: safe to re-run.
#
#   ./deploy/install.sh
#   RELAY_URL=wss://other-host:8788 ./deploy/install.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOGS="$HOME/.opencode-remote/logs"
GUI="gui/$(id -u)"
# point this at your relay, e.g. wss://your-host.tailnet-name.ts.net:8788
RELAY_URL="${RELAY_URL:?set RELAY_URL=wss://your-relay-host:8788}"

[ -d "$REPO/node_modules/tsx" ] || { echo "tsx not found — run npm install first"; exit 1; }
mkdir -p "$LOGS"

write_plist() {
  # $1 = label, $2 = stdout log, $3 = stderr log, $4 = script path, $5 = env block
  cat > "$HOME/Library/LaunchAgents/$1.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>--import</string>
    <string>tsx/esm</string>
    <string>$4</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
$5
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$2</string>
  <key>StandardErrorPath</key><string>$3</string>
</dict></plist>
PLIST
}

# stop ad-hoc runs (nohup / manual tsx)
launchctl bootout "$GUI/com.ocr.daemon" 2>/dev/null || true
launchctl bootout "$GUI/com.ocr.relay" 2>/dev/null || true
launchctl bootout "$GUI/com.ocr.pwa" 2>/dev/null || true
launchctl bootout "$GUI/com.ocr.logrotate" 2>/dev/null || true
pkill -f "tsx apps/daemon/src/index.ts" 2>/dev/null || true
pkill -f "tsx apps/relay/src/index.ts" 2>/dev/null || true
pkill -f "daemon/src/index.ts" 2>/dev/null || true
pkill -f "relay/src/index.ts" 2>/dev/null || true
# P2-075: a leftover vite dev (or stray http server) holding :5173 is exactly
# the failure mode com.ocr.pwa replaces — free the port before bootstrap
# (|| true: lsof exits 1 when the port is already free, and pipefail is on)
lsof -ti tcp:5173 -sTCP:LISTEN 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done || true
sleep 1

RELAY_ENV="    <key>RELAY_PORT</key><string>8788</string>
    <key>RELAY_TLS_CERT</key><string>$REPO/.certs/tailscale.pem</string>
    <key>RELAY_TLS_KEY</key><string>$REPO/.certs/tailscale.key</string>
    <key>RELAY_METRICS_PORT</key><string>8790</string>"

DAEMON_ENV="    <key>RELAY_URL</key><string>$RELAY_URL</string>
    <key>OCR_METRICS_PORT</key><string>8792</string>
    <key>OCR_LOG_LEVEL</key><string>info</string>
    <key>PWA_HEALTHZ_URL</key><string>http://127.0.0.1:5173/healthz</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>"

write_plist com.ocr.relay "$LOGS/relay.log" "$LOGS/relay.err.log" "apps/relay/src/index.ts" "$RELAY_ENV"
write_plist com.ocr.daemon "$LOGS/daemon.log" "$LOGS/daemon.err.log" "apps/daemon/src/index.ts" "$DAEMON_ENV"

# P2-075: static PWA origin — serves apps/web/dist on 127.0.0.1:5173 (the port
# `tailscale serve` proxies the phone to). KeepAlive survives reboots; no dev
# server involved. /healthz is what the daemon's watchdog probes.
cat > "$HOME/Library/LaunchAgents/com.ocr.pwa.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ocr.pwa</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$REPO/deploy/pwa-server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PWA_PORT</key><string>5173</string>
    <key>PWA_DIST_DIR</key><string>$REPO/apps/web/dist</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGS/pwa.log</string>
  <key>StandardErrorPath</key><string>$LOGS/pwa.err.log</string>
</dict></plist>
PLIST

cat > "$HOME/Library/LaunchAgents/com.ocr.logrotate.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ocr.logrotate</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string>
    <string>$REPO/deploy/rotate-logs.sh</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>7</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOGS/logrotate.log</string>
</dict></plist>
PLIST

for label in com.ocr.relay com.ocr.daemon com.ocr.pwa com.ocr.logrotate; do
  launchctl bootstrap "$GUI" "$HOME/Library/LaunchAgents/$label.plist"
  echo "bootstrapped $label"
done

sleep 3
echo "\n--- status ---"
launchctl print "$GUI/com.ocr.relay" | grep -E "state|pid" | head -2
launchctl print "$GUI/com.ocr.daemon" | grep -E "state|pid" | head -2
launchctl print "$GUI/com.ocr.pwa" | grep -E "state|pid" | head -2
echo "\nmetrics: curl 127.0.0.1:8790/metrics (relay) · 127.0.0.1:8792/metrics (daemon)"
echo "pwa:     curl 127.0.0.1:5173/healthz (static origin for tailscale serve)"
echo "logs:    $LOGS"
