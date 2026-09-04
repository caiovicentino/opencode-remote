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
| messages repeat after switching conversations and back | fixed by the per-messageID bubble merge (P1-089): history and streamed events key bubbles by message id, so a replayed event buffer can no longer double-render a turn; refresh the PWA |
| Settings shows a version mismatch | the daemon and the PWA are different builds: restart daemon, pull-to-refresh the PWA |
| PWA won't open away from home | no TLS — use the tailscale path from `scripts/dev-iphone.sh`, a Caddy-fronted relay, or the LAN-mode install from the README (mkcert + `PWA_TLS_CERT`/`PWA_TLS_KEY`) |
| white screen on the phone, desktop fine | the PWA origin died (the desktop shell loads the bundle from disk, only the phone is affected). The origin is the `com.ocr.pwa` launchd service (P2-075), not a dev server: `curl 127.0.0.1:5173/healthz`; if it fails, `opencode-remote restart` or `launchctl kickstart -k gui/$(id -u)/com.ocr.pwa`. The daemon posts a `[pwa] origin` event + red chip on the dashboard when this happens |
| watch the logs | `tail -f ~/.opencode-remote/logs/daemon.log` (JSON lines; `OCR_LOG_LEVEL=debug` for frame-level) |
| watch the desktop app logs | tray → **Open logs folder**, then `tail -f ~/Library/Application\ Support/OpenCode\ Remote/logs/desktop.log` (`userData/logs/desktop.log`, ~1MB cap, rotates to `desktop.log.1`) — the packaged app writes here instead of the console |
| watch the daemon sidecar's own output | same folder, `userData/logs/daemon-sidecar.log` (JSONL; rotates to `daemon-sidecar.log.1`, ~1MB cap) — the desktop shell tees the spawned daemon's stdout/stderr there; the tray's **Open logs folder** click cites both files in `desktop.log` |
| desktop app crashed or the window went white | crash reports land in `~/.opencode-remote/pilot/client-logs/` (newest 20 kept, one `.txt` per event: `uncaught` = main process, `renderer` = renderer crash). Copy one when filing an issue |
| opened the app twice and nothing new appeared | that is the single-instance lock (P2-069): the second launch quits and focuses the running window, logging `another instance already owns this userData` in `desktop.log` |
| `possible zombie instance` in desktop.log | a previous copy of the app on this same userData is still alive from an earlier start (crash, SIGKILL, killed test run). Quit it from the tray (or `kill <pid>` — the line names the pid) and relaunch |
| desktop says the daemon is down — and names a cause | the status card explains WHY it died (P2-140): "another app took the daemon's port" → close that program or restart the machine; "daemon files are missing" → reinstall the app; "shut down by the system"/"exited unexpectedly" → reopen the app (it reconnects by itself). The same verdict is logged in `desktop.log`; the copy never contains paths or tokens |
| report a problem with everything attached | desktop → Settings → **Diagnostics → Copy diagnostic**: versions, platform, daemon state, last 40 `desktop.log` lines and the crash-file names, on your clipboard. No secrets (apiToken/allowlist/pairing URI never included) |
| update didn't install | the consent dialog only appears after a **background download** finished; check `desktop.log` for `update status`, then tray → **Check for updates**. A version you deferred ("Later") is not re-offered until the next manual check or app restart |

## Staging a desktop update release (P1-050)

The packaged desktop app checks `http://127.0.0.1:8792/__ocr/updates/feed.json`
(loopback-only, served by the local daemon from `~/.opencode-remote/updates/`).
To publish a new version:

```
~/.opencode-remote/updates/
  feed.json                          # Squirrel.Mac pointer doc: {url, name, notes, releaseDate}
  0.3.0/OpenCode Remote-0.3.0-mac.zip
  0.3.0/latest-mac.yml               # optional, electron-builder metadata
```

`feed.json`'s `url` field must point at the absolute artifact URL, e.g.
`http://127.0.0.1:8792/__ocr/updates/0.3.0/OpenCode Remote-0.3.0-mac.zip`.
The route is unauthenticated (autoUpdater cannot send headers) but strictly
loopback-bound and limited to that folder: only plain filenames with a known
extension, no traversal. Dev builds stay opt-in via `OCR_UPDATE_FEED`.

Since P2-098, a machine with **no** staged feed falls back to the public
`latest-mac.yml` attached to the latest GitHub release
(`OCR_PUBLIC_UPDATE_FEED` overrides it; the tray then reports
"update available" but the background download still requires a Squirrel JSON
feed — stage one as above to get the consent flow). The fallback fires for
the packaged loopback default only: a feed explicitly set via
`OCR_UPDATE_FEED` (dev/staging) fails with "feed unreachable" instead of
making a surprise outbound request.

## Health endpoints

```
curl 127.0.0.1:8787/healthz            # relay, public (safe for LB health checks): {ok,version,uptimeS,rooms,roomsRejected}
curl 127.0.0.1:5173/healthz            # PWA origin (com.ocr.pwa, loopback only): {ok,service}
curl 127.0.0.1:8792/metrics            # daemon, localhost only, JSON
curl '127.0.0.1:8792/metrics?format=prom'
curl 127.0.0.1:8790/metrics            # relay, localhost only, same contract
```

## Local daemon port fallback (P2-143)

The desktop shell's local daemon prefers port 8792. If another program already
owns it, the shell deterministically tries 8793 → 8796 (once per app start,
logged as `[desktop] daemon port <p> (<reason>)`) and adopts or spawns the
daemon on the first port that is free or already running our own daemon. The
chosen port rides in Settings → **Diagnostics → Copy diagnostic** (the
`daemon:` line, e.g. `— porta 8793 (fallback)`) and in the local pairing link.
Setting `OCR_DAEMON_METRICS_PORT` (or `OCR_METRICS_PORT`) disables the
fallback entirely: the shell uses exactly that port, like before the fallback
existed.

## Service control (macOS launchd)

```
opencode-remote status                 # relay + daemon + pwa service states
opencode-remote restart
launchctl kickstart -k gui/$(id -u)/com.ocr.pwa   # static PWA origin alone
```

The `com.ocr.pwa` service (P2-075) serves `apps/web/dist` statically on
`127.0.0.1:5173` with `KeepAlive` — it survives reboots and never runs a dev
server. Its logs are `~/.opencode-remote/logs/pwa.log` / `pwa.err.log`.
