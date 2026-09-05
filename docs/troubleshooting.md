# Troubleshooting

Run `opencode-remote doctor` first — it checks everything below in one shot.

| Symptom | Cause and fix |
|---|---|
| `client rejected: not in allowlist` | device not paired. Scan the QR again, or `npm run manage --workspace apps/daemon -- revoke-all` |
| `relay connection lost; retrying` | relay down or tailscale dropped — check the relay terminal/service |
| `502` on chat | `opencode serve` not running on :4096. Watchdog pushes `opencode is DOWN` when this happens |
| `transcription unavailable` | transcription is an **optional** host capability. The phone shows a short actionable sentence (engine missing vs model missing) and the mic stays disabled — install whisper on the host: `./scripts/setup-whisper.sh` (re-run it to add a missing model). The daemon logs the same verdict at boot; `GET /__ocr/voice/stt-status` returns `{ available, state, message }`. `OCR_STT_BLOCK=1` on the daemon forces the missing-binary verdict for deterministic screenshots |
| raw upstream error on the first message (P2-210) | no provider on the machine hosting the daemon has a credential (or the credentials expose no models). The composer now warns BEFORE the send: a calm line above it derived from the same provider catalog the context gauge already fetches. The indicator describes the machine hosting the daemon — never the phone — and **never blocks sending**. `GET /__ocr/model/status` returns `{ available, state, message }`; `OCR_MODEL_BLOCK=1` on the daemon forces the no-provider verdict for deterministic screenshots |
| push never arrives on iPhone | must be installed via Add to Home Screen (iOS 16.4+) with permission granted; Settings → Push → Send test shows per-endpoint HTTP errors |
| `GET messages -> 413` | daemon older than the chunked-response feature — restart it |
| `attachment expired` | daemon restarted between attach and send (uploads are in-memory). The PWA auto-re-uploads when it still holds the image; attach again otherwise |
| `request timeout` after backgrounding | fixed by heartbeat+auto-reconnect; if on an old bundle, refresh the PWA |
| chat shows duplicated replies | fixed by the incremental event watermark; refresh the PWA |
| messages repeat after switching conversations and back | fixed by the per-messageID bubble merge (P1-089): history and streamed events key bubbles by message id, so a replayed event buffer can no longer double-render a turn; refresh the PWA |
| Settings shows a version mismatch | the daemon and the PWA are different builds: restart daemon, pull-to-refresh the PWA |
| PWA won't open away from home | no TLS — use the tailscale path from `scripts/dev-iphone.sh`, a Caddy-fronted relay, or the LAN-mode install from the README (mkcert + `PWA_TLS_CERT`/`PWA_TLS_KEY`) |
| white screen on the phone, desktop fine | the PWA origin died (the desktop shell loads the bundle from disk, only the phone is affected). The origin is the `com.ocr.pwa` launchd service (P2-075), not a dev server: `curl 127.0.0.1:5173/healthz`; if it fails, `opencode-remote restart` or `launchctl kickstart -k gui/$(id -u)/com.ocr.pwa`. The daemon posts a `[pwa] origin` event + red chip on the dashboard when this happens |
| the disk is filling up and I suspect old artifacts (P2-207) | the daemon bounds `~/.opencode-remote/artifacts/` by itself: a sweep at boot and then every 6 h deletes session dirs older than **30 days** and, oldest-first, enough of the rest to keep the folder within **1 GB**. Artifacts written in the last **48 h** are never touched, and the **3 most recently modified** session dirs always survive. Only the artifacts root is scanned — `uploads/` (what you asked to download), `clips/` and every other state dir are never deleted. Each sweep logs one `artifact retention sweep` line (deleted count + bytes) in the daemon log and bumps `ocr_artifact_retention_deleted_total`. To opt out entirely set `OCR_ARTIFACT_RETENTION=off` in the daemon environment and restart it |
| watch the logs | `tail -f ~/.opencode-remote/logs/daemon.log` (JSON lines; `OCR_LOG_LEVEL=debug` for frame-level) |
| watch the desktop app logs | tray → **Open logs folder** (or the app menu: **Ajuda → Abrir pasta de logs**), then `tail -f ~/Library/Application\ Support/OpenCode\ Remote/logs/desktop.log` (`userData/logs/desktop.log`, ~1MB cap, rotates to `desktop.log.1`) — the packaged app writes here instead of the console |
| watch the daemon sidecar's own output | same folder, `userData/logs/daemon-sidecar.log` (JSONL; rotates to `daemon-sidecar.log.1`, ~1MB cap) — the desktop shell tees the spawned daemon's stdout/stderr there; the tray's **Open logs folder** click cites both files in `desktop.log` |
| desktop app crashed or the window went white | crash reports land in `~/.opencode-remote/pilot/client-logs/` (newest 20 kept, one `.txt` per event: `uncaught` = main process, `renderer` = renderer crash). Copy one when filing an issue |
| opened the app twice and nothing new appeared | that is the single-instance lock (P2-069): the second launch quits and focuses the running window, logging `another instance already owns this userData` in `desktop.log` |
| `possible zombie instance` in desktop.log | a previous copy of the app on this same userData is still alive from an earlier start (crash, SIGKILL, killed test run). Quit it from the tray (or `kill <pid>` — the line names the pid) and relaunch |
| desktop says the daemon is down — and names a cause | the status card explains WHY it died (P2-140): "another app took the daemon's port" → close that program or restart the machine; "daemon files are missing" → reinstall the app; "shut down by the system"/"exited unexpectedly" → reopen the app (it reconnects by itself). The same verdict is logged in `desktop.log`; the copy never contains paths or tokens |
| report a problem with everything attached | desktop → Settings → **Diagnostics → Copy diagnostic**: versions, platform, daemon state, last 40 `desktop.log` + 20 `daemon-sidecar.log` lines and the crash-file names, on your clipboard. No secrets (apiToken/allowlist/pairing URI never included) |
| update didn't install | the consent dialog only appears after a **background download** finished; check `desktop.log` for `update status`, then tray → **Check for updates** (or the app menu: **Ajuda → Verificar atualizações**). A version you deferred ("Later") is not re-offered until the next manual check or app restart |
| no mic/camera in the packaged app (P2-169) | the first voice recording or QR scan triggers a macOS permission prompt — grant it. Denied by mistake: System Settings → Privacy & Security → Microphone / Camera → enable **OpenCode Remote**, then reopen the app (the signed build blocks the device without the grant; dev builds only fail the same way without the P2-169 entitlements/usage strings) |
| mac download says "damaged and can't be opened" | that is an unsigned/stale DMG, not this project's release path: since P2-170 the desktop-dmg job runs the Gatekeeper verdicts (`codesign` verify, `spctl` assess, `stapler` validate — `scripts/gatekeeper-verify.ts`) on the packaged app before uploading, so a notarized release can never ship without its stapled ticket and a Developer ID release can never ship `spctl: rejected`. A normal **ad-hoc** release (no signing secrets) still shows the standard "unidentified developer" wall instead — right-click → **Open** once, per the README |
| which macOS download do I pick (P2-191) | every release carries two installers: `OpenCode-Remote-<version>-arm64.dmg` (Apple Silicon) and `OpenCode-Remote-<version>-x64.dmg` (Intel). Check Apple menu → **About This Mac** → **Chip**: "Apple" → `-arm64`, "Intel" → `-x64`. The same split holds for the update feeds (`update-mac-arm64.json` / `update-mac-x64.json`), and the app picks the right one by itself — an app already installed as arm64 keeps updating through the legacy `update-mac.json`, which is a byte-identical alias of the arm64 feed |
| the release workflow failed and the downloads page shows nothing new | that is the P2-179 draft flow working: releases are created as **drafts** and only go public after `release-verify` and `release-feeds` pass and the `release-publish` job's `scripts/release-publish.ts` confirms every required asset is attached. Open the run in Actions and look at which job has the red ✗ (its failing step lists every missing asset at once); the release stays a private draft, so users were never exposed to a broken download. Fix the cause and re-run the workflow (a re-run treats an already-published release as a no-op), or discard the draft with `gh release delete vX.Y.Z --yes` and re-tag — the draft is invisible to users either way |
| the desktop-win release job failed at "Authenticode verification of the packaged installer" | since P2-183 the job verifies the packaged setup exe with PowerShell `Get-AuthenticodeSignature` (`scripts/authenticode-verify.ts`) before attaching it to the release, so an installer that would trip SmartScreen never ships: only `Status: Valid` with a certificate subject passes in authenticode mode. The failing step lists every problem at once under `authenticode-verify:` (not signed, hash mismatch, untrusted chain, expired certificate, unknown error, missing subject, or unrecognizable verification output); the raw `Status:`/`StatusMessage:`/`Subject:` lines are in `authenticode.txt` in the workspace — check whether the certificate expired, the WIN_CSC_KEY_PASSWORD was wrong, or electron-builder skipped signing, fix and re-run |
| the downloaded installer's hash does not match `checksums.txt` (P2-186) | every release ships `checksums.txt` (coreutils format, one `sha256  <file>` line per asset) built from the finished assets right before publication, so a match proves the file is exactly what CI produced. Re-check with the right tool in the download folder: `shasum -a 256 -c checksums.txt` (macOS), `sha256sum -c checksums.txt` (Linux), `Get-FileHash <file> -Algorithm SHA256` compared with the manifest line (Windows PowerShell). A mismatch after a fresh re-download (truncated/proxied downloads are the usual cause) means: do not open or distribute the file — report it on the releases page; the release job itself refuses to publish when any hash or name is off (`release-checksums: FAIL` in the log lists every problem) |
| the release workflow failed at "Attach the SHA-256 checksum manifest to the release" | since P2-186 the `release-publish` job downloads the draft's assets back, hashes each file with node and validates the list via `scripts/release-checksums.ts` BEFORE the release goes public — the failing step lists every problem at once (empty list, repeated name, hash that is not 64 lowercase hex digits, name with a space or path separator, an entry named `checksums.txt`, or a required asset missing). The release stays a draft (P2-179 contract); fix the asset set and re-run |
| the pairing QR points the phone at `127.0.0.1` and pairing never completes | the QR carries the relay address the daemon dials, and the default is the machine's own loopback (`ws://127.0.0.1:8787`) — it only ever works while the phone runs on the same Mac. Point the app at a hosted relay: Settings → **Phone relay / Relay do celular** → paste `wss://your-relay:8788` → Save (the app restarts its daemon and re-emits the QR). See the section below |
| the pairing screen has no step-one app address (P2-189) | the app address is derived from the relay address (`wss://` → `https://`, same host and port), and the local default is loopback — a phone can never reach it. Point the app at a hosted relay (Settings → **Phone relay / Relay do celular**) or save an explicit address in Settings → **App address (phone) / Endereço do app (celular)**; the pairing screen picks it up on the next poll |
| the pairing QR is fine but the phone lands on a blank page (P2-197) | read the reach line below the QR: while the pairing screen is up, the shell probes the app address once per tick (2s ceiling) from the machine that hosts the daemon and says which side failed — "unreachable" (relay down), "timeout", "certificate", "DNS", "HTTP error" or "not our app" (that origin serves something else). Use **Test again** after fixing. The probe only checks the address origin — it never probes the credential-bearing pairing link and sends no credential header. A warning never blocks pairing and never hides the QR: this machine failing to reach the relay does not prove the phone will |
| the pairing QR is fine and the app address answers, but nobody answers the phone (P2-199) | read the relay-link line right below the reach line: while the pairing screen is up, the shell reports the WebSocket between the daemon (the machine hosting it) and the relay — "connected", "local mode", "connecting/reconnecting" (dial or backoff in progress), "refused" (relay at capacity or rate-limiting) or "misconfigured" (the daemon's relay address was refused at boot). The line describes the machine hosting the daemon — never the phone, never the camera. A warning never blocks pairing and never hides the QR: the link can come back up before the phone finishes scanning |

## Staging a desktop update release (P1-050)

The packaged desktop app checks `http://127.0.0.1:8792/__ocr/updates/feed.json`
(loopback-only, served by the local daemon from `~/.opencode-remote/updates/`).
To publish a new version:

```
~/.opencode-remote/updates/
  feed.json                          # Squirrel.Mac pointer doc: {url, name, notes, releaseDate}
  0.3.0/OpenCode-Remote-0.3.0-arm64.zip
  0.3.0/latest-mac.yml               # optional, electron-builder metadata
```

`feed.json`'s `url` field must point at the absolute artifact URL, e.g.
`http://127.0.0.1:8792/__ocr/updates/0.3.0/OpenCode-Remote-0.3.0-arm64.zip`.
The route is unauthenticated (autoUpdater cannot send headers) but strictly
loopback-bound and limited to that folder: only plain filenames with a known
extension, no traversal. Dev builds stay opt-in via `OCR_UPDATE_FEED`.

Since P2-098, a machine with **no** staged feed falls back to the update feed
attached to the latest GitHub release (`OCR_PUBLIC_UPDATE_FEED` overrides it;
the tray then reports "update available" but the background download still
requires a Squirrel JSON feed — stage one as above to get the consent flow).
Since P2-191 that public feed is per-architecture on macOS:
`update-mac-arm64.json` on Apple Silicon, `update-mac-x64.json` on Intel, and
the legacy `update-mac.json` (arm64 content, byte-identical alias) for any
other architecture — so an Intel Mac never receives the arm64 zip. The
fallback fires for
the packaged loopback default only: a feed explicitly set via
`OCR_UPDATE_FEED` (dev/staging) fails with "feed unreachable" instead of
making a surprise outbound request.

## Windows installer signing (P2-159)

The Windows installer is signed only from the `WIN_CSC_LINK` /
`WIN_CSC_KEY_PASSWORD` release secrets (optional `WIN_CSC_SUBJECT_NAME` picks
the certificate by subject name) — the Apple `CSC_LINK`/`CSC_KEY_PASSWORD`
pair used for macOS signing/notarization is never consulted on Windows. The
preflight (`apps/desktop/scripts/signing-profile-win.mjs`) decides the mode
before packaging:

- no `WIN_CSC_*` secrets → **unsigned** installer; SmartScreen shows "Windows
  protected your PC" on first run (More info → Run anyway, one time). The job
  stays green — this is the default;
- both secrets set → Authenticode-signed installer, no SmartScreen warning;
- exactly one of them set (or a whitespace-only value) → fail-closed: the
  `desktop-win` job aborts in the signing preflight with every problem listed
  (`::warning::` annotations + exit 1) and nothing is uploaded.

Since P2-183 the signed/unsigned difference is enforced, not assumed: when
the profile decided mode=authenticode the packaged setup exe is verified with
`Get-AuthenticodeSignature` before upload, and any status other than `Valid`
(not signed, hash mismatch, untrusted chain, expired/revoked certificate,
unknown error) — or a `Valid` signature with no certificate subject — aborts
the job before the exe reaches the release. mode=unsigned skips the
verification by design (the one-time SmartScreen warning is the documented
no-secrets path, same as ad-hoc on macOS).

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
fallback entirely: the shell uses exactly that port — even when it points
elsewhere inside the 8792–8796 span — like before the fallback existed. If
that port is busy, the child dies with the familiar "address in use" error
and the P2-140 diagnosis explains it; no other port is ever picked.

## Pointing the desktop app at a hosted relay (P2-187)

The local relay (`ws://127.0.0.1:8787`) only serves the machine running the
app: a phone reading a QR with that address dials itself. For remote pairing,
give the app a hosted relay address (stage-4 setup, `docs/RELAY-HOSTING.md`):

- **Settings surface (packaged app):** Settings → **Phone relay / Relay do
  celular** → paste `wss://your-relay:8788` → **Save**. The shell persists it
  in `relay.json` inside its userData (mode 0600, atomic tmp+rename) and
  restarts the daemon sidecar so the pairing URI is re-emitted with the new
  relay. **Use local relay** clears the saved value and goes back to the
  loopback default.
- **Environment (operators/dev):** exporting `RELAY_URL` before launching the
  app still wins over anything saved in Settings — the card shows
  "set by the RELAY_URL environment variable" and becomes read-only while it
  is set.
- **Validation (fail-closed, in the app):** only `ws://`/`wss://`; plain
  `ws://` to a non-loopback host, embedded `user:pass@` credentials and
  over-length values are rejected with an error in the card, and nothing is
  saved. The saved value is applied as-is but the daemon re-validates at boot
  (`apps/daemon/src/relayurl.ts` remains the final authority): an invalid
  address makes the daemon withhold the pairing URI instead of dialing garbage.
- **Adopted daemons (launchd/CLI):** the Settings value only reaches a daemon
  the shell spawns. If the app adopted an external daemon (reused on :8792),
  that process gets its `RELAY_URL` from its own service definition — set it
  in the launchd plist/unit and restart the service; changing the card alone
  has no effect on it.

## The two pairing steps (P2-189)

Pairing has two steps, and the desktop pairing screen labels both:

1. **Open the app on the phone** — the shell shows the app address
   (`https://…`) as a QR and as copyable text. It is derived from the phone
   relay address (`wss://` → `https://`, `ws://` → `http://`, same host and
   port, path and query discarded), because the deployment convention is that
   the host serving the relay also serves the web app on the same origin
   (`docs/RELAY-HOSTING.md`). When the derivation does not apply, save an
   explicit address in Settings → **App address (phone) / Endereço do app
   (celular)** — a stored value always beats the derived one, and an invalid
   stored value is shown as an error instead of silently falling back.
2. **Pair the machine** — the `opencode-remote://pair?v=2…` QR that was
   always there (unchanged; `apps/daemon/src/relayurl.ts` stays the final
   authority on the relay the daemon dials).

With the loopback local relay there is no address a phone could reach, so
step one shows a calm explanation pointing at Settings instead of a QR — an
address that cannot work is worse than no address. The same discipline holds
for a `ws://`-only relay: the derived `http://` address carries a warning and
no QR is generated for it.

## After sleep and wake (P2-209)

A laptop that sleeps overnight used to wake with the daemon sidecar either out
of respawn attempts or with its next retry minutes away — the phone then found
no machine until someone walked up to the computer. Now, when the OS reports
the return from sleep or the session unlock (macOS/Windows `powerMonitor`
events), the shell reacts at most once per event; repeats inside a 10 s
debounce window are dropped silently, so a wake never becomes a log flood.

- **Daemon healthy at the last poll** → an immediate health probe confirms it
  (the same probe the 3 s pairing tick already runs — no new periodic probe,
  no extra request per tick).
- **Respawn budget exhausted, or the scheduled retry more than 30 s away** →
  the daemon is restarted on the spot, through the same path as the tray's
  **Restart daemon** action.
- **Anything else** → an immediate health probe.

Each handled event logs exactly one `[desktop] wake event (…)` line with the
action and the reason. Pairing is never touched by a wake: no re-pairing, no
allowlist or state-file writes, no new routes. If the desktop.log has no wake
lines after a wake, the platform did not expose `powerMonitor` and the shell
keeps its previous behavior (the existing backoff/reconnect still applies).

## Service control (macOS launchd)

```
opencode-remote status                 # relay + daemon + pwa service states
opencode-remote restart
launchctl kickstart -k gui/$(id -u)/com.ocr.pwa   # static PWA origin alone
```

The `com.ocr.pwa` service (P2-075) serves `apps/web/dist` statically on
`127.0.0.1:5173` with `KeepAlive` — it survives reboots and never runs a dev
server. Its logs are `~/.opencode-remote/logs/pwa.log` / `pwa.err.log`.
