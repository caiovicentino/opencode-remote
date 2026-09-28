#!/bin/zsh
# Rotates opencode-remote logs in place (copytruncate): a log above 10MB is
# archived gzip-compressed and the live file truncated; each log keeps its 5
# newest archives. Scheduled by com.ocr.logrotate (launchd timer). No sudo.
#
# eval-02: the 2026-09 disk-full nights exposed three defects of the first
# version — (1) under `set -e` one failed `cp` aborted the whole run, so a
# single unarchivable log stopped every other rotation AND the prune, exactly
# when space mattered; (2) the prune kept the 5 lexicographically-last archives
# ACROSS all logs (`sort -r` on paths: relay.* archives crowded out daemon.*
# whatever their age); (3) archives stayed plain text (relay.log.20260830 was
# 74MB). Now every log is handled on its own, a live log is truncated only once
# its compressed copy is safely written, legacy plain archives get compressed,
# and the prune is per log, newest by mtime. Every outcome goes to stdout (the
# plist captures stdout only).
set -uo pipefail

LOGS="$HOME/.opencode-remote/logs"
MAX_BYTES=$((10 * 1024 * 1024))
KEEP=5

mkdir -p "$LOGS" || exit 1
rc=0

for f in "$LOGS"/*.log(N.); do
  size=$({ wc -c < "$f"; } 2>/dev/null | tr -d ' ')
  if [[ -z "$size" ]]; then
    echo "rotate FAILED for $f: unreadable"
    rc=1
    continue
  fi
  (( size > MAX_BYTES )) || continue
  archive="${f}.$(date +%Y%m%d-%H%M%S).gz"
  if ! gzip -c < "$f" > "$archive" 2>/dev/null; then
    rm -f -- "$archive"
    echo "rotate FAILED for $f ($size bytes): archive not written — live log left intact"
    rc=1
    continue
  fi
  if : > "$f" 2>/dev/null; then
    echo "rotated $f ($size bytes) -> $archive"
  else
    echo "rotate FAILED for $f: archived to $archive but the live log could not be truncated"
    rc=1
  fi
done

# legacy plain archives (<log>.YYYYmmdd-HHMMSS) → compressed in place; gzip
# keeps the original untouched when it cannot write the .gz
for old in "$LOGS"/*.log.<->-<->(N.); do
  if gzip -f -- "$old" 2>/dev/null; then
    echo "compressed $old"
  else
    echo "compress FAILED for $old"
    rc=1
  fi
done

# prune per log: keep its $KEEP newest archives (plain or .gz), by mtime
typeset -A seen
for a in "$LOGS"/*.log.<->-<->*(N.); do
  base="${a%.log.*}.log"
  (( ${+seen[$base]} )) && continue
  seen[$base]=1
  archives=( "$base".<->-<->*(N.om) )
  (( ${#archives} > KEEP )) || continue
  for old in "${(@)archives[KEEP+1,-1]}"; do
    if rm -f -- "$old"; then
      echo "pruned $old"
    else
      echo "prune FAILED for $old"
      rc=1
    fi
  done
done

exit $rc
