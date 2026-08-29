#!/bin/bash
# OpenCode Remote — iPhone testing orchestrator.
#
# Path A (Tailscale, recommended): valid TLS via your tailnet, works from
#   anywhere. Requires: `tailscale login` once.
# Path B (mkcert LAN): local CA you install on the iPhone manually.
#   Requires: brew install mkcert && mkcert -install
#
# Usage: ./scripts/dev-iphone.sh [tailscale|lan]
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CERT_DIR="$ROOT/.certs"
mkdir -p "$CERT_DIR"

MODE="${1:-}"
if [ -z "$MODE" ]; then
  if tailscale status &>/dev/null; then MODE="tailscale"; else MODE="lan"; fi
fi

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")

start_relay_and_daemon() {
  npx tsx apps/relay/src/index.ts &
  npx tsx apps/daemon/src/index.ts &
}

if [ "$MODE" = "tailscale" ]; then
  if ! tailscale status &>/dev/null; then
    echo "✗ Tailscale is logged out. Run:  tailscale login   (then re-run this script)"
    exit 1
  fi
  DNS_NAME=$(tailscale status --json | python3 -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))")
  echo "✓ Tailscale: $DNS_NAME"

  # proxy PWA (root) and relay (/relay) with automatic TLS
  tailscale serve --bg 5173 >/dev/null
  tailscale serve --bg --set-path=/relay 8787 >/dev/null

  PWA_URL="https://$DNS_NAME"
  RELAY_URL="wss://$DNS_NAME/relay"
  echo "✓ tailscale serve: $PWA_URL -> :5173, /relay -> :8787 (plain ws locally, TLS at the edge)"
  start_relay_and_daemon
  npx vite apps/web &

else
  if ! command -v mkcert &>/dev/null; then
    echo "✗ mkcert missing. Run:  brew install mkcert && mkcert -install"
    exit 1
  fi
  [ -z "$LAN_IP" ] && { echo "✗ no LAN IP found (wifi off?)"; exit 1; }
  echo "✓ mkcert path, LAN IP: $LAN_IP"

  if [ ! -f "$CERT_DIR/cert.pem" ]; then
    mkcert -cert-file "$CERT_DIR/cert.pem" -key-file "$CERT_DIR/key.pem" \
      "$LAN_IP" localhost 127.0.0.1 "*.local" >/dev/null 2>&1
    echo "✓ certs generated for $LAN_IP (root CA: $(mkcert -CAROOT)/rootCA.pem)"
  fi
  echo "  ⚠ ONE-TIME on the iPhone: AirDrop $(mkcert -CAROOT)/rootCA.pem → install profile →"
  echo "    Settings → General → About → Certificate Trust Settings → enable"

  export RELAY_PORT=8788
  export RELAY_TLS_CERT="$CERT_DIR/cert.pem" RELAY_TLS_KEY="$CERT_DIR/key.pem"
  export VITE_TLS_CERT="$CERT_DIR/cert.pem" VITE_TLS_KEY="$CERT_DIR/key.pem"
  PWA_URL="https://$LAN_IP:5173"
  RELAY_URL="wss://$LAN_IP:8788"
  start_relay_and_daemon
  npx vite apps/web &
fi

echo "✓ stack running..."
sleep 3

echo
echo "═══════════════════════════════════════════════════════"
echo "  iPhone steps"
echo "═══════════════════════════════════════════════════════"
echo "  1. Safari → $PWA_URL"
echo "  2. Share → Add to Home Screen (enables push on iOS 16.4+)"
echo "  3. Open from Home Screen → Scan QR code (daemon QR above)"
echo "  4. Enable push"
echo "  PWA URL:   $PWA_URL"
echo "  RELAY URL: $RELAY_URL  (already embedded in the daemon QR)"
echo "═══════════════════════════════════════════════════════"
echo
echo "  PWA QR code (point the iPhone camera):"
npx tsx -e "import QRCode from 'qrcode'; QRCode.toString('$PWA_URL', {type:'terminal', small:true}).then(console.log)"
wait
