#!/bin/zsh
# Installs opencode-remote relay + daemon as launchd services (KeepAlive),
# the static PWA origin (com.ocr.pwa), plus a daily log-rotation timer.
# Idempotent: safe to re-run.
#
#   ./deploy/install.sh
#   RELAY_URL=wss://other-host:8788 ./deploy/install.sh
#
# LAN mode (no tailnet) — P2-098, every port/cert is overridable:
#   RELAY_URL=wss://<lan-ip>:8788 RELAY_TLS_CERT=.certs/lan.pem \
#   RELAY_TLS_KEY=.certs/lan.key PWA_HOST=0.0.0.0 PWA_TLS_CERT=.certs/lan.pem \
#   PWA_TLS_KEY=.certs/lan.key ./deploy/install.sh
# Defaults keep the tailscale layout (see README "Install as a third party").
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOGS="$HOME/.opencode-remote/logs"
GUI="gui/$(id -u)"
# point this at your relay, e.g. wss://your-host.tailnet-name.ts.net:8788
RELAY_URL="${RELAY_URL:?set RELAY_URL=wss://your-relay-host:8788}"
# relay + pwa origin layout (defaults = the tailscale deploy)
RELAY_PORT="${RELAY_PORT:-8788}"
PWA_HOST="${PWA_HOST:-127.0.0.1}"
PWA_PORT="${PWA_PORT:-5173}"
PWA_TLS_CERT="${PWA_TLS_CERT:-}"
PWA_TLS_KEY="${PWA_TLS_KEY:-}"
# TLS is optional (P2-098): overridden for LAN mode, defaulted to the operator's
# tailscale pair when present, and otherwise left off — a fresh clone without
# .certs must not install a crash-looping relay (readFileSync on a missing cert).
RELAY_TLS_CERT="${RELAY_TLS_CERT:-}"
RELAY_TLS_KEY="${RELAY_TLS_KEY:-}"
if [ -z "$RELAY_TLS_CERT" ] && [ -f "$REPO/.certs/tailscale.pem" ] && [ -f "$REPO/.certs/tailscale.key" ]; then
  RELAY_TLS_CERT="$REPO/.certs/tailscale.pem"
  RELAY_TLS_KEY="$REPO/.certs/tailscale.key"
fi

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
# P2-075: a leftover vite dev (or stray http server) holding the pwa port is
# exactly the failure mode com.ocr.pwa replaces — free the port before
# bootstrap (|| true: lsof exits 1 when the port is already free, pipefail is on)
lsof -ti tcp:$PWA_PORT -sTCP:LISTEN 2>/dev/null | while read -r pid; do kill "$pid" 2>/dev/null || true; done || true
sleep 1

RELAY_TLS_ENV=""
if [ -n "$RELAY_TLS_CERT" ]; then
  RELAY_TLS_ENV="    <key>RELAY_TLS_CERT</key><string>$RELAY_TLS_CERT</string>
    <key>RELAY_TLS_KEY</key><string>$RELAY_TLS_KEY</string>"
fi

RELAY_ENV="    <key>RELAY_PORT</key><string>$RELAY_PORT</string>
$RELAY_TLS_ENV
    <key>RELAY_METRICS_PORT</key><string>8790</string>"

# watchdog probe follows the origin scheme: plain http locally, https when the
# pwa origin itself serves TLS (LAN mode). With TLS the probe needs the CA —
# NODE_EXTRA_CA_CERTS (mkcert root) is passed through so Node trusts it.
PWA_HEALTHZ_URL="${PWA_HEALTHZ_URL:-http://127.0.0.1:$PWA_PORT/healthz}"
if [ -n "$PWA_TLS_CERT" ]; then
  PWA_HEALTHZ_URL="${PWA_HEALTHZ_URL_OVERRIDE:-https://127.0.0.1:$PWA_PORT/healthz}"
fi
DAEMON_ENV="    <key>RELAY_URL</key><string>$RELAY_URL</string>
    <key>OCR_METRICS_PORT</key><string>8792</string>
    <key>OCR_LOG_LEVEL</key><string>info</string>
    <key>PWA_HEALTHZ_URL</key><string>$PWA_HEALTHZ_URL</string>"
if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then
  DAEMON_ENV="$DAEMON_ENV
    <key>NODE_EXTRA_CA_CERTS</key><string>$NODE_EXTRA_CA_CERTS</string>"
fi
DAEMON_ENV="$DAEMON_ENV
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>"

write_plist com.ocr.relay "$LOGS/relay.log" "$LOGS/relay.err.log" "apps/relay/src/index.ts" "$RELAY_ENV"
write_plist com.ocr.daemon "$LOGS/daemon.log" "$LOGS/daemon.err.log" "apps/daemon/src/index.ts" "$DAEMON_ENV"

# P2-075: static PWA origin — serves apps/web/dist on 127.0.0.1:5173 (the port
# `tailscale serve` proxies the phone to). KeepAlive survives reboots; no dev
# server involved. /healthz is what the daemon's watchdog probes.
# PWA_TLS_ENV: optional TLS block for the pwa origin (LAN mode — the phone
# needs a secure context for WebAuthn; tailscale mode gets TLS at the edge).
PWA_TLS_ENV=""
if [ -n "$PWA_TLS_CERT" ]; then
  PWA_TLS_ENV="    <key>PWA_TLS_CERT</key><string>$PWA_TLS_CERT</string>
    <key>PWA_TLS_KEY</key><string>$PWA_TLS_KEY</string>"
fi

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
    <key>PWA_HOST</key><string>$PWA_HOST</string>
    <key>PWA_PORT</key><string>$PWA_PORT</string>
    <key>PWA_DIST_DIR</key><string>$REPO/apps/web/dist</string>
$PWA_TLS_ENV
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
echo "pwa:     curl 127.0.0.1:$PWA_PORT/healthz (static origin for the phone)"
echo "logs:    $LOGS"
