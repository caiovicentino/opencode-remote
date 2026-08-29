#!/bin/zsh
# Rotates opencode-remote logs in place (copytruncate): archives when a log
# exceeds 10MB, truncates the live file, keeps the 5 newest archives.
# Scheduled by com.ocr.logrotate (launchd timer). No sudo required.
set -euo pipefail

LOGS="$HOME/.opencode-remote/logs"
MAX_BYTES=$((10 * 1024 * 1024))
KEEP=5

mkdir -p "$LOGS"
for f in "$LOGS"/*.log(N); do
  size=$(stat -f%z "$f")
  if (( size > MAX_BYTES )); then
    archive="${f}.$(date +%Y%m%d-%H%M%S)"
    cp "$f" "$archive"
    : > "$f"
    echo "rotated $f ($size bytes) -> $archive"
  fi
done

# prune old archives, keep the newest $KEEP across all logs
for f in "$LOGS"/*.log.*(N); do
  print "$f"
done | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old"
done
