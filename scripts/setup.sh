#!/bin/bash
# One-time environment check for opencode-remote.
# Verifies everything the Quick Start needs and prints actionable fixes.
set -u
cd "$(dirname "$0")/.."

FAIL=0
ok()   { echo "  ✓ $1"; }
miss() { echo "  ✗ $1"; FAIL=1; }

echo "opencode-remote setup"
echo "─────────────────────"

# 1. node >= 22
if command -v node >/dev/null; then
  MAJOR=$(node -p "process.versions.node.split('.')[0]")
  if [ "$MAJOR" -ge 22 ]; then ok "node $(node -v)"; else miss "node >= 22 required (have $(node -v)) — brew install node@22"; fi
else
  miss "node missing — brew install node@22"
fi

# 2. dependencies
if [ -d node_modules ]; then ok "node_modules present"; else
  echo "  … running npm install (first time)"
  npm install || { miss "npm install failed"; FAIL=1; }
fi

# 3. opencode server (core dependency)
if command -v opencode >/dev/null; then
  ok "opencode CLI ($(opencode --version 2>/dev/null | head -1))"
  echo "    → make sure the server is up: opencode serve --port 4096"
else
  miss "opencode CLI missing — install: curl -fsSL https://opencode.ai/install | bash"
fi

# 4. phone access path
if command -v tailscale >/dev/null && tailscale status &>/dev/null; then
  ok "tailscale connected ($(tailscale status --json | python3 -c "import json,sys; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null))"
else
  echo "  ~ tailscale not active — dev-iphone.sh will fall back to LAN/mkcert"
  echo "    (recommended for phone-from-anywhere: brew install tailscale && tailscale login)"
fi

# 5. optional: voice transcription
if command -v whisper-cli >/dev/null; then ok "whisper-cli (voice features ready)"; else
  echo "  ~ whisper-cli missing — voice transcription off. Enable later: ./scripts/setup-whisper.sh"
fi

# 6. optional: ffmpeg for clips
if command -v ffmpeg >/dev/null; then ok "ffmpeg present"; else
  echo "  ~ ffmpeg missing — social clips pipeline off. brew install ffmpeg-full"
fi

echo "─────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo "Ready. Next:  opencode serve --port 4096 &   (if not running)"
  echo "              ./scripts/dev-iphone.sh"
else
  echo "Fix the ✗ items above and re-run."
fi
exit "$FAIL"
