# Troubleshooting

Run `opencode-remote doctor` first — it checks everything below in one shot.

| Symptom | Cause and fix |
|---|---|
| `client rejected: not in allowlist` | device not paired. Scan the QR again, or `npm run manage --workspace apps/daemon -- revoke-all` |
| `relay connection lost; retrying` | relay down or tailscale dropped — check the relay terminal/service |
| `502` on chat | `opencode serve` not running on :4096. Watchdog pushes `opencode is DOWN` when this happens |
| `transcription unavailable` | install whisper: `./scripts/setup-whisper.sh` |
| push never arrives on iPhone | must be installed via Add to Home Screen (iOS 16.4+) with permission granted; Settings → Push → Send test shows per-endpoint HTTP errors |
| `GET messages -> 413` | daemon older than the chunked-response feature — restart it |
| `attachment expired` | daemon restarted between attach and send (uploads are in-memory). The PWA auto-re-uploads when it still holds the image; attach again otherwise |
| `request timeout` after backgrounding | fixed by heartbeat+auto-reconnect; if on an old bundle, refresh the PWA |
| chat shows duplicated replies | fixed by the incremental event watermark; refresh the PWA |
| Settings shows a version mismatch | the daemon and the PWA are different builds: restart daemon, pull-to-refresh the PWA |
| PWA won't open away from home | no TLS — use the tailscale path from `scripts/dev-iphone.sh` or a Caddy-fronted relay |
| watch the logs | `tail -f ~/.opencode-remote/logs/daemon.log` (JSON lines; `OCR_LOG_LEVEL=debug` for frame-level) |

## Health endpoints

```
curl 127.0.0.1:8787/healthz            # relay, public (safe for LB health checks): {ok,version,uptimeS,rooms}
curl 127.0.0.1:8792/metrics            # daemon, localhost only, JSON
curl '127.0.0.1:8792/metrics?format=prom'
curl 127.0.0.1:8790/metrics            # relay, localhost only, same contract
```

## Service control (macOS launchd)

```
opencode-remote status
opencode-remote restart      # or launchctl kickstart -k gui/$(id -u)/com.ocr.daemon
```
