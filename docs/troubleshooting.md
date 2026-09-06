# Troubleshooting

Run `opencode-remote doctor` first — it checks everything below in one shot.

| Symptom | Cause and fix |
|---|---|
| `client rejected: not in allowlist` | device not paired. Scan the QR again, or `npm run manage --workspace apps/daemon -- revoke-all` |
| `relay connection lost; retrying` | relay down or tailscale dropped — check the relay terminal/service |
| `502` on chat | `opencode serve` not running on :4096. Watchdog pushes `opencode is DOWN` when this happens |
| `transcription unavailable` | transcription is an **optional** host capability. The phone shows a short actionable sentence (engine missing vs model missing) and the mic stays disabled — install whisper on the host: `./scripts/setup-whisper.sh` (re-run it to add a missing model). The daemon logs the same verdict at boot; `GET /__ocr/voice/stt-status` returns `{ available, state, message }`. `OCR_STT_BLOCK=1` on the daemon forces the missing-binary verdict for deterministic screenshots |
| raw upstream error on the first message (P2-210) | no provider on the machine hosting the daemon has a credential (or the credentials expose no models). The composer now warns BEFORE the send: a calm line above it derived from the same provider catalog the context gauge already fetches. The indicator describes the machine hosting the daemon — never the phone — and **never blocks sending**. `GET /__ocr/model/status` returns `{ available, state, message }`; `OCR_MODEL_BLOCK=1` on the daemon forces the no-provider verdict for deterministic screenshots |
| raw upstream error mid-conversation with an old opencode (P2-213) | the opencode installed on the machine hosting the daemon is older than the minimum the daemon's API surface expects (**1.18.0**). Settings → machine section shows one calm line ("the agent server on this computer is older than this app expects…") probed once at boot from the resolved binary; the indicator describes the machine hosting the daemon — never the phone — and **never blocks anything**: every control stays enabled, and ok/unknown verdicts stay silent. The verdict also rides `GET /api/health` (`opencode.versionState`/`opencode.versionMessage`). To fix it, update opencode on that machine (`curl -fsSL https://opencode.ai/install \| bash` or `brew upgrade opencode`) and restart the daemon; `OCR_OPENCODE_OLD=1` on the daemon forces the too-old verdict for deterministic screenshots |
| raw write/filesystem errors mid-conversation, or a full disk (P2-215) | the volume hosting the daemon's state directory (`~/.opencode-remote/`) is out of free space — the daemon writes session artifacts, upload staging, the audit log and the state file there. Settings → machine section shows one calm line asking the machine's owner to free space; the indicator describes the machine hosting the daemon — never the phone — and **never blocks anything**: every control stays enabled, and ok/unknown verdicts stay silent. Thresholds (most severe wins): warning below 2 GB free or 10% of the volume, critical below 500 MB free or 5%. To fix it, delete or archive large files on that machine (old session artifacts are trimmed automatically by the retention janitor) and keep at least a few GB free; `OCR_DISK_FULL=1` on the daemon forces the critical verdict for deterministic screenshots |
| push never arrives on iPhone | must be installed via Add to Home Screen (iOS 16.4+) with permission granted; Settings → Push → Send test shows per-endpoint HTTP errors |
| `GET messages -> 413` | daemon older than the chunked-response feature — restart it |
| `attachment expired` | daemon restarted between attach and send (uploads are in-memory). The PWA auto-re-uploads when it still holds the image; attach again otherwise |
| `request timeout` after backgrounding | fixed by heartbeat+auto-reconnect; if on an old bundle, refresh the PWA |
| chat shows duplicated replies | fixed by the incremental event watermark; refresh the PWA |
| messages repeat after switching conversations and back | fixed by the per-messageID bubble merge (P1-089): history and streamed events key bubbles by message id, so a replayed event buffer can no longer double-render a turn; refresh the PWA |
| Settings shows a version mismatch | the daemon and the PWA are different builds: restart daemon, pull-to-refresh the PWA |
| PWA won't open away from home | no TLS — use the tailscale path from `scripts/dev-iphone.sh`, a Caddy-fronted relay, or the LAN-mode install from the README (mkcert + `PWA_TLS_CERT`/`PWA_TLS_KEY`) |
| white screen on the phone, desktop fine | the PWA origin died (the desktop shell loads the bundle from disk, only the phone is affected). The origin is the `com.ocr.pwa` launchd service (P2-075), not a dev server: `curl 127.0.0.1:5173/healthz`; if it fails, `opencode-remote restart` or `launchctl kickstart -k gui/$(id -u)/com.ocr.pwa`. The daemon posts a `[pwa] origin` event + red chip on the dashboard when this happens |
| the disk is filling up and I suspect old artifacts (P2-207) | the daemon bounds `~/.opencode-remote/artifacts/` by itself: a sweep at boot and then every 6 h deletes session dirs older than **30 days** and, oldest-first, enough of the rest to keep the folder within **1 GB**. Artifacts written in the last **48 h** are never touched, and the **3 most recently modified** session dirs always survive. Only the artifacts root is scanned by this janitor — `clips/` and every other state dir are never deleted (`uploads/` has its own retention, next row). Each sweep logs one `artifact retention sweep` line (deleted count + bytes) in the daemon log and bumps `ocr_artifact_retention_deleted_total`. To opt out entirely set `OCR_ARTIFACT_RETENTION=off` in the daemon environment and restart it |
| the disk is filling up and I suspect old uploads (P2-228) | the daemon bounds `~/.opencode-remote/uploads/` (videos and documents sent from the phone, files generated for download) on the same sweep as the artifacts janitor: files older than **30 days** go and, oldest-first, enough of the rest to keep the folder within **2 GB**. Files written in the last **24 h** are never touched and the **5 most recently modified** files always survive — anything deleted here still exists on the phone that sent it. Each sweep logs one `upload retention sweep` line (deleted count + bytes, never file names) and bumps `ocr_upload_retention_deleted_total`. To opt out entirely set `OCR_UPLOAD_RETENTION=off` in the daemon environment and restart it |
| the disk is filling up and I suspect old rendered clips (P2-248) | the daemon bounds `~/.opencode-remote/clips/` (rendered social clips plus the extracted transcription audio — the heaviest files the product produces) on the same sweep and cadence as the other janitors: the deletion unit is the **group** (one folder per source video, or one loose work file at the root), removed whole. Groups older than **30 days** go and, oldest-first, enough of the rest to keep the folder within **4 GB**. Groups modified in the last **24 h** are never touched and the **3 most recently modified** groups always survive. Only the clips root is scanned — symlinks are never followed, and `uploads/`, `artifacts/` and every other state dir stay out of reach. Each sweep logs one `clip retention sweep` line (deleted count + bytes, never file or folder names — those come from your video titles) and bumps `ocr_clip_retention_deleted_total`. To opt out entirely set `OCR_CLIP_RETENTION=off` in the daemon environment and restart it; ceilings are overridable via `OCR_CLIP_RETENTION_GRACE_HOURS`, `OCR_CLIP_RETENTION_MAX_AGE_DAYS`, `OCR_CLIP_RETENTION_MAX_BYTES` and `OCR_CLIP_RETENTION_MIN_GROUPS` (invalid values fail the boot, fail-closed) |
| watch the logs | `tail -f ~/.opencode-remote/logs/daemon.log` (JSON lines; `OCR_LOG_LEVEL=debug` for frame-level) |
| watch the desktop app logs | tray → **Open logs folder** (or the app menu: **Ajuda → Abrir pasta de logs**), then `tail -f ~/Library/Application\ Support/OpenCode\ Remote/logs/desktop.log` (`userData/logs/desktop.log`, ~1MB cap, rotates to `desktop.log.1`) — the packaged app writes here instead of the console |
| watch the daemon sidecar's own output | same folder, `userData/logs/daemon-sidecar.log` (JSONL; rotates to `daemon-sidecar.log.1`, ~1MB cap) — the desktop shell tees the spawned daemon's stdout/stderr there; the tray's **Open logs folder** click cites both files in `desktop.log` |
| desktop app crashed or the window went white | crash reports land in `~/.opencode-remote/pilot/client-logs/` (newest 20 kept, one `.txt` per event: `uncaught` = main process, `renderer` = renderer crash). Copy one when filing an issue |
| the app stopped opening when the machine boots (P2-218) | **Start at login** was turned off in the tray — that choice is definitive by design (no boot re-enables it). Reopen the app, tray → **Start at login** to turn it back on. See the section below |
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
| which file on the release page is for my machine (P2-216) | the release body now opens with a **"Qual arquivo baixar"** download guide written by the `release-publish` job (`scripts/release-notes.ts`): one line each for Mac com Apple Silicon, Mac com Intel and Windows, naming the exact installer file for that machine, plus the right-click → **Open** warning for unsigned macOS builds and how to check the download against `checksums.txt`. The guide only names files actually attached to the release — each line is matched against the published asset list — so it can never point at a download that does not exist |
| the release workflow failed at "Write the download guide into the release body" | since P2-216 the guide step (`scripts/release-notes.ts`) runs after the checksum manifest upload and before publication: it reads the asset list and current body via `gh release view`, and exits 1 listing every problem at once when an audience's installer (Mac Apple Silicon DMG, Mac Intel DMG, Windows setup exe) or `checksums.txt` is missing from the draft, or the tag is not a valid semver. The release stays a draft (P2-179 contract) instead of publishing a guide for a download that does not exist — fix the asset set and re-run |
| how do I install on Windows without hunting the loose exe (P2-245) | every release now attaches the three winget manifests of the `caiovicentino.opencode-remote` package (version, installer and en-US locale), generated and verified by the `release-publish` job ("Attach the winget manifests to the release" step) from the tag and the sha256 in `checksums.txt` before publication — a manifest whose version, installer URL, hash or package id drifts fails the job and the release stays a draft. Download the three `.yaml` files from the releases page and run `winget install --manifest caiovicentino.opencode-remote.yaml` in their folder: an alternative install path to the loose setup exe, like the Homebrew formula on the Mac |
| the release workflow failed at "Attach the winget manifests to the release" | since P2-245 that step builds the three winget manifests from the tag plus the sha256 already hashed into `checksums.txt`, verifies them via `scripts/wingetmanifest.ts` (declared version vs tag, installer URL vs the published asset list, sha256 vs `checksums.txt`, package id vs the documented `caiovicentino.opencode-remote`) and exits 1 listing every problem at once — the release stays a draft (P2-179 contract). Nothing is committed by CI and nothing is pushed to any Microsoft manifest repository; fix the asset set and re-run |
| how do I install on macOS without hunting the loose DMG (P2-255) | every release attaches `opencode-remote-cask.rb`, a Homebrew cask manifest for both Mac architectures (Apple Silicon and Intel), generated and verified by the `release-publish` job ("Attach the Homebrew cask to the release" step) from the tag and the sha256 lines in `checksums.txt` before publication — a cask whose version, DMG addresses, hashes or download targets drift fails the job and the release stays a draft. Download the cask file from the releases page and run `brew install --cask ./opencode-remote-cask.rb`: a one-line install path to the app, like the winget manifests on Windows |
| the pairing QR points the phone at `127.0.0.1` and pairing never completes | the QR carries the relay address the daemon dials, and the default is the machine's own loopback (`ws://127.0.0.1:8787`) — it only ever works while the phone runs on the same Mac. Point the app at a hosted relay: Settings → **Phone relay / Relay do celular** → paste `wss://your-relay:8788` → Save (the app restarts its daemon and re-emits the QR). See the section below |
| the pairing screen has no step-one app address (P2-189) | the app address is derived from the relay address (`wss://` → `https://`, same host and port), and the local default is loopback — a phone can never reach it. Point the app at a hosted relay (Settings → **Phone relay / Relay do celular**) or save an explicit address in Settings → **App address (phone) / Endereço do app (celular)**; the pairing screen picks it up on the next poll |
| the pairing QR is fine but the phone lands on a blank page (P2-197) | read the reach line below the QR: while the pairing screen is up, the shell probes the app address once per tick (2s ceiling) from the machine that hosts the daemon and says which side failed — "unreachable" (relay down), "timeout", "certificate", "DNS", "HTTP error" or "not our app" (that origin serves something else). Use **Test again** after fixing. The probe only checks the address origin — it never probes the credential-bearing pairing link and sends no credential header. A warning never blocks pairing and never hides the QR: this machine failing to reach the relay does not prove the phone will |
| the pairing QR is fine and the app address answers, but nobody answers the phone (P2-199) | read the relay-link line right below the reach line: while the pairing screen is up, the shell reports the WebSocket between the daemon (the machine hosting it) and the relay — "connected", "local mode", "connecting/reconnecting" (dial or backoff in progress), "refused" (relay at capacity or rate-limiting) or "misconfigured" (the daemon's relay address was refused at boot). The line describes the machine hosting the daemon — never the phone, never the camera. A warning never blocks pairing and never hides the QR: the link can come back up before the phone finishes scanning |
| the first boot asks me to drag the app to Applications (P2-211) | the app was opened straight from the mounted DMG (or its Downloads copy): the bundle runs read-only from a path the auto-updater can never replace, so the app would silently never update. The calm line under the pairing QR describes the machine hosting the daemon and asks you to drag the app to the Applications folder, eject the disk and reopen it from there. It **never blocks pairing** (the QR stays visible — fix the location after pairing) and **never blocks any other use of the app**; when the location cannot be confirmed it stays quiet. macOS only. `OCR_DESKTOP_FORCE_DMG_VOLUME=1` on the desktop shell forces the warning for deterministic screenshots (test-only hatch) |
| an update downloaded but the "restart to install" dialog never appeared (P2-211) | with the app running from the DMG volume or from a quarantine-translocated copy, the consent dialog is skipped on purpose (one `update install not offered` line in `desktop.log`): Squirrel.Mac could not swap that bundle, so the restart would come back as the very same version. Install the app in Applications and the dialog returns |
| Windows: "Check for updates" says an update is ready — now what? (P2-233) | that explicit click downloaded the installer named by `latest.yml` into the `update-staging` folder inside the app's user data directory, verified its sha512 against the digest the feed publishes and opened Explorer with the file already selected — **double-click it yourself**; the app never runs the installer. If the digest did not match, the file was deleted on purpose (one `win update:` line in `desktop.log` explains it) and the app falls back to the release page — click **Check for updates** again to retry the verified download |
| where did my download go / why was a download refused (P2-241) | downloads started inside the desktop shell (Browser pane, artifact links, redirects) never open a native save dialog: what passes the policy lands in the system **Downloads folder** — sanitized name deduped against the folder so nothing is overwritten — and is revealed selected in the file manager with at most one notification when it completes. What is refused (one `download refused` line in `desktop.log`, never a path): a scheme the external-open gate already refuses (`file:`, `blob:`, `data:`, `javascript:` — only http/https/mailto pass), a hostile name (empty, only spaces, `/` `\` `..` `:`, control characters, Windows reserved names like `CON`, over 200 characters) and anything whose announced size exceeds **1 GB** (unknown sizes don't refuse on their own). The app never executes or opens the downloaded file — it only reveals it, so opening it is always your call |
| what does uninstalling on Windows remove (P2-249) | uninstalling removes the **Start at login** autostart entry (the next boot stops trying to open a removed executable) and the app's own data folder in your user profile — state files and logs included, since the install is per-user and the removal reaches only the profile of who uninstalls; it never touches Documents, Desktop, Downloads or anything outside the app's own data |
| the phone refuses the relay certificate or the timestamps look wrong, and nothing explained why (P2-214) | read the clock line under the pairing QR: while the pairing screen is up, the shell compares the machine's clock against the `Date` response header of the same answer the reach probe already obtained (no second request, no time server) and, when the machine hosting the daemon is **ahead of** or **behind** the reference, one calm line asks you to turn on automatic date and time in the system settings and reopen the app. The line describes the machine hosting the daemon — not the phone. It **never blocks pairing** (the QR stays visible — a wrong clock does not stop pairing from working right now) and stays quiet when the reference is missing or unreadable. `OCR_DESKTOP_FORCE_CLOCK_BEHIND=1` on the desktop shell forces the warning for deterministic screenshots (test-only hatch) |

## The identity file is unreadable (P2-234)

At boot the daemon reads `~/.opencode-remote/daemon.json` — the file that
carries the machine identity and the paired-devices list. If that file is
unreadable (a truncated write from before the P2-165 atomic-write fix, a disk
that filled up, a failed manual edit), the daemon refuses to start with ONE
calm line in the log instead of a raw syntax error:

```
{"level":"error","msg":"O arquivo de identidade está ilegível e foi preservado ao lado do original — …"}
```

What it means:

- **The old file is preserved, never deleted.** The daemon moves the illegible
  `daemon.json` to a sibling quarantine file next to the original
  (`daemon.json.<timestamp>.quarantine`, mode 0600) and exits with code **78**
  (documented: identity config error). Nothing is regenerated behind your
  back.
- **Restoring the file restores the pairings.** Rename the quarantine file
  back over `daemon.json` (fix what made it unreadable first) and restart the
  app — every pairing comes back exactly as it was.
- **There is an automatic backup that restores itself (P2-254).** The daemon
  keeps a recovery copy carrying the full identity and the paired-devices list
  as the sibling `daemon.json.backup` in the same state directory, born with
  the same restricted 0600 permission as the original (written at most once a
  day right after a state save, never in any downloadable folder), and when
  the main file is illegible at boot the daemon preserves it in quarantine and
  puts that copy in its place automatically — pairings survive with no manual
  work; it only refuses as below when no usable copy exists.
- **Deleting both files starts the machine over.** Remove `daemon.json` and
  its quarantine copy and the next boot is a fresh first run: a new identity
  is created and every phone must pair again by scanning the QR.
- If the log line instead says the file **could not be read** (permission
  denied, file busy), nothing was moved: fix the file's permission and start
  the app again — a transient read failure is never treated as a fresh start,
  so it can never silently wipe your pairings.

The same phrase rides the audit log (`identity.unreadable`, no file content)
and the desktop status card's generic daemon-down diagnosis.

## A routine stopped running after a restart (P2-236)

A fired routine stays "in flight" (marked with `lastSessionID` in
`routines.json`) until the opencode session reports back. If the daemon is
restarted mid-run, opencode closes, or the session event simply never arrives,
that marker used to be written forever — and since the periodic sweep skips
routines with a live marker, the routine silently stopped firing on every
following day, with no log line and no notification.

The daemon now carries a **run lease**: during the same 30 s routine sweep, any
run still in flight after the lease expires is released automatically.

- **Default lease: 2 hours** (`OCR_RUN_LEASE_MS=7200000` is the equivalent
  explicit value). A routine run is one prompt → answer session; two hours is
  far beyond any legitimate run.
- **Adjust it** with the `OCR_RUN_LEASE_MS` environment variable (whole number
  of milliseconds, up to the 24 h ceiling). `OCR_RUN_LEASE_MS=off` disables the
  automatic release entirely; an invalid value (zero, negative, fractional,
  non-numeric or above the ceiling) refuses the boot at startup, like every
  other `OCR_*` knob.
- **Nothing is lost**: the release clears the stuck marker, marks the routine
  as errored with a calm message, writes one warn line (no session ids) and
  sends at most one notification — and the routine fires again at its **next
  scheduled time** (the same day's slot is not re-run). A run with no known
  start instant is never killed: it gets stamped on first observation, so the
  lease only ever counts forward.

## The routines file is unreadable (P2-256)

`routines.json` is written atomically — the same tmp+rename write, created
0600, that protects the daemon state file — so a power loss mid-write can no
longer truncate it. If the file is ever illegible anyway (an old damaged
file, a failed manual edit), the daemon logs one calm line, keeps running
with an empty routine list and **preserves the original bytes** in a
`routines.json.<timestamp>.quarantine` copy beside it — nothing is ever
deleted and no later save touches that copy; put the copy back in place to
recover the schedules, or delete both files to start empty. A read failure
(permission, file busy) moves nothing at load — the daemon still runs with
an empty list, and the **first save after that refusal preserves the
original through the same quarantine move before writing anything**; if even
that move fails, the save is skipped and retried on the next one, so the
original file is never overwritten and a transient read failure can never
silently wipe your routines.

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

## Document → PDF conversion unavailable (P2-231)

The agent converts documents locally with LibreOffice (full fidelity, all of
docx/doc/rtf/html/csv/xlsx/pptx). The converter is discovered from PATH plus
the default install locations — the macOS app bundle
(`/Applications/LibreOffice.app/Contents/MacOS/soffice`) and the Windows
default install path (`C:\Program Files\LibreOffice\program\soffice.exe`).

What you see when the machine has no converter:

- `node tools/doc2pdf.mjs <file>` answers with one short sentence (in
  Portuguese) asking to install LibreOffice — never a raw English terminal
  error — and the original file stays intact.
- `GET /api/health` reports `docConvertState: "unavailable"` with
  `docConvertMessage` carrying the same sentence. On a macOS machine without
  LibreOffice the verdict is `"partial"`: the native textutil+cupsfilter
  fallback still converts doc/docx/rtf/html/csv but loses formatting
  (`docConvertExts` lists exactly what is covered).

Fix: install LibreOffice (macOS: `brew install --cask libreoffice`; Windows:
the default installer works) and retry — the tool needs no daemon restart;
the health verdict refreshes on the next daemon boot (the probe runs once,
at boot).

## Machine state in one place (P2-232)

Settings → **Machine state** ("Estado da máquina") gathers every readiness
verdict the machine itself reports — the remote relay link, the agent server
and its version, disk space, document → PDF conversion — in a single calm
list, worst verdict first, each row with a severity marker (green / amber /
red), a short label and **the machine's own phrase, verbatim**: the app never
rewrites a phrase and never invents one. The section consumes the same
settings read the screen already performs (the daemon mirrors its health
verdicts on `GET /__ocr/settings`) — no new request, no new poll.

- A verdict the connected daemon does not report simply renders no row; with
  nothing known yet the section shows the calm empty state. Nothing in the
  panel ever blocks or disables a control — it describes the machine hosting
  the daemon, never the phone.
- Deterministic screenshots: `OCR_OPENCODE_OLD=1` forces the too-old agent
  version (amber row) and `OCR_DISK_FULL=1` the critical disk verdict (red
  row) on the daemon — the same hatches documented for the single-line
  indicators above.

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

## Start at login (P2-218)

The installed app now opens at login by default: on the **first boot of a
packaged build** (macOS/Windows) the shell turns on **Start at login** by
itself and announces it with one calm line on the pairing screen — the QR is
never hidden and pairing is never blocked. This is what lets the phone keep
finding the machine after the first reboot, power cut or logout: an app that
is not running is the one failure neither the wake reaction (P2-209) nor the
sidecar respawn can fix, and from the phone it looks like the machine simply
vanished.

- Turning **Start at login** off in the tray menu is **definitive** — the
  owner's decision is recorded and no future boot turns it back on. Turn it
  back on the same way if you change your mind.
- Dev builds (`npm start`) never touch the OS setting; platforms other than
  macOS/Windows keep the previous behavior (the tray item stays hidden).
- The decision rides the boot log (`[desktop] login item: …`), the pairing
  payload (`startup`) and the diagnostics bundle (`login item:`) — never with
  paths or tokens. `OCR_DESKTOP_FORCE_LOGIN_ITEM=1` on the desktop shell
  forces the announce for deterministic screenshots (test-only hatch; the
  machine's setting is never touched under it).

## What the tray says (P2-252)

The tray tooltip and the disabled status line at the top of the tray menu tell
the whole journey, refreshed by the same 3s pairing poll with no new requests:
`processo local fora do ar: nenhum telefone alcança esta máquina` (sidecar
down — it wins over every other fact), the relay-link phrases (`o relay
recusou a conexão`, `endereço do relay recusado na partida`, `conectando ao
relay`, `sem informação do relay por enquanto`), `nenhum telefone pareado:
escaneie o código no celular` (sidecar up, link fine, zero phones) and `tudo
pronto: o celular alcança esta máquina` — static pt-BR sentences that never
echo the daemon's raw reason and never carry paths, addresses, ports or
secrets.

## Quitting and the phone's access (P2-221)

Closing the window is **not** quitting: the app keeps running in the
menu bar / system tray and the phone keeps its remote access. **Quitting is**
what ends it — the tray **Quit** item and the app menu's **Encerrar OpenCode
Remote** (`Cmd+Q`) stop the daemon sidecar, so the phone finds no machine
until the app is opened again (for example at the next login, P2-218).

- On a packaged build with a healthy daemon and a paired phone, quitting asks
  first with a native box: **Sair** (quit for real), **Continuar na bandeja**
  (dismiss — the app and the phone's access stay alive) and **Não perguntar de
  novo** (quit now and never ask again).
- The **Não perguntar de novo** choice is **definitive by design**: the request
  is stored as a boolean-only flag (`userData/quit-ask.json`, written 0600) and
  every future explicit quit is silent, even after reboot. To be asked again,
  quit the app and delete `quit-ask.json` from the app's userData folder.
- The box never appears when there is nothing to lose — dev builds, an
  unhealthy daemon, no paired phone — or in a test-harness session, which
  always quits silently so the automated gates never stall on a modal.
- The last quit decision rides the desktop.log (`[desktop] quit confirm: …`)
  and the diagnostics bundle (`quit confirm:`) — state and reason only, never
  paths or tokens. `OCR_DESKTOP_FORCE_QUIT_CONFIRM=1` forces the box and
  `OCR_DESKTOP_QUIT_DIALOG_ANSWER=quit|stay|never` auto-answers it on the
  desktop shell (test-only hatches for deterministic screenshots/flows).

## The global reopen shortcut (P2-229)

After the window is closed to the tray, a system-wide key combination brings
it back from anywhere — `Command+Shift+O` on macOS, `Ctrl+Shift+O` on
Windows/Linux — running the same show-and-focus path as the tray click. The
Help menu and the tray show the active combination as a disabled line, so you
can always see what is registered and why.

- **Another app already owns the combination**: registration fails with one
  line in the desktop.log (`global hotkey not registered`) and no dialog —
  the tray keeps working as before. Pick a free combination with
  `OCR_DESKTOP_HOTKEY="Ctrl+Alt+R"` and reopen the app.
- **You want it gone**: set `OCR_DESKTOP_DISABLE_HOTKEY=1` and the shell
  registers nothing; the Help menu and the tray then show the reason instead
  of a shortcut.
- **Your custom combination is ignored**: the value must be a real
  accelerator with at least one modifier (`Ctrl`, `Alt`, `Shift`,
  `CommandOrControl`…) plus an allowed key. An invalid value never falls back
  silently to the default — nothing is registered and the surfaces say why.
- **Automated test sessions never register a global shortcut**: a test run on
  your machine must not steal system-wide keys, so the harness-session rule
  comes first in the decision and disables the feature entirely.

## Right-click menu (P2-235)

Right-clicking the window opens a native context menu with the basics a lay
user looks for: **Recortar**, **Copiar**, **Colar** and **Selecionar tudo** in
editable fields, **Copiar** for selected text anywhere, **Abrir link / Copiar
endereço do link** for links and spelling suggestions (up to four) for a
misspelled word. Opening a link goes through the same scheme gate as every
other external open — only http/https/mailto; a refused scheme offers only
**Copiar endereço do link**, never **Abrir link**.

- **Dev vs packaged builds**: **Inspecionar elemento** exists only in
  unpackaged (dev) builds — a packaged app never offers it.
- **Nothing to act on, no menu**: when the click lands somewhere with no edit
  action, no selection and no link, the shell opens no menu at all instead of
  a dead list.
- **Test sessions never open the menu**: under the desktop test harness
  (`tools/desktop.mjs`, `npm run test:desktop-flow`) the menu spec comes back
  empty by design — a native popup would steal focus from the gate and stall
  the interaction flow. This is the same harness-session-first rule every
  other native surface follows.
- **Right-click inside a Browser pane page** keeps the guest page's own
  behavior (the pane is a sandboxed webview with its own navigation policy);
  the context menu belongs to the app shell around it.

## Text size that stays put (P2-238)

The View menu's **Ampliar**, **Reduzir** and **Tamanho padrão** items change
the app's text size (shortcuts Cmd/Ctrl + +, Cmd/Ctrl + − and Cmd/Ctrl + 0 —
the same keys the old zoom roles used). The chosen size is remembered across
restarts: it lives in the same `window-state.json` file as the window bounds
and is re-applied the moment the window finishes loading.

- **The range**: roughly 58%–3× of the factory size (zoom levels −3 to 6,
  ~20% per click). The limits keep the app legible and usable; an item at its
  limit shows up disabled instead of pretending it worked.
- **Back to normal**: **Visualizar → Tamanho padrão** (Cmd/Ctrl+0) always
  returns the factory size.
- **Text too big after a bad level?** Opened at 3× and lost? The keyboard
  shortcut Cmd/Ctrl+0 resets it instantly — no need to read the menu.
- **Test sessions** (`OCR_DESKTOP_SESSION` — the desktop harness and
  `npm run test:desktop-flow`) always start at the default size and write no
  zoom to disk, so screenshots keep a stable framing.
- **The Browser pane is unaffected**: the zoom belongs to the app shell
  around it, not to the webview guest or its navigation guard.

## The window stopped responding (P2-223)

If the app window freezes, the shell tells you instead of leaving you staring
at a dead app: first a notification ("the window stopped responding — it may
recover on its own"), then — if the freeze keeps going — a native box offering
**Recarregar** and **Aguardar**; reloading is safe and **does not lose the
conversation** (it lives in the daemon, so the page reload simply brings it
back). The third renderer crash in a row (the reload budget is 3 per 60s)
also stops being silent: the definitive white screen logs
(`[desktop] hang watch: …` in desktop.log), tips the tray and offers the same
box. The last episode's duration and outcome show up in the diagnostics
bundle (`last hang:`). Test sessions never see the box, and
`OCR_DESKTOP_HANG_DIALOG_ANSWER=reload|wait` auto-answers it (test-only
hatch).

## Black window: video acceleration turns itself off (P2-244)

On machines with a defective video driver, the app used to open on a black
window (or full of rendering artifacts), get the exact same thing after every
reopen and repeat that path forever with no word from the shell. The desktop
app now watches the GPU process the way the renderer already had its watch:

- **What happens**: every crash of the GPU process is counted inside a
  one-hour window (a window long enough to bridge app restarts, since the
  machine that reopens the app keeps crashing seconds after each boot). The
  first crashes are only recorded — one static line in desktop.log per crash.
  At the **third crash inside the window** the shell turns hardware
  acceleration off for the next start (`app.disableHardwareAcceleration`
  before the app is ready) and keeps going on software rendering, which
  survives a broken driver.
- **How to know the acceleration was turned off**: a single notification
  ("Aceleração de vídeo desligada após quedas repetidas…", at most one per
  start — the same tip covers a boot that started already disabled) and the
  `[desktop] gpu acceleration: disable (…)` line in desktop.log. There is no
  native dialog, no new setting and nothing is disabled without a count of
  real crashes behind it.
- **How to go back to the default**: nothing to do in the common case — the
  policy heals itself. When an entire hour passes without a new GPU crash
  (driver updated or fixed, for instance), the next boot reads the state as
  expired and starts with acceleration on again; three new crashes inside an
  hour turn it off once more. To reset the counter immediately, quit the app
  and delete `gpu-state.json` from the userData folder (the same folder that
  holds `window-state.json`; the file carries only a crash count and a
  timestamp). A test session (harness) never disables the acceleration and
  never writes the file.

## The window never finishes loading (P2-247)

If the app window opens **white and stays white** — no spinner, no error —
the load itself failed. That used to be a silent dead end; the shell now
recovers on its own and, when it cannot, says so:

- **What you see**: up to **3 automatic reloads** happen by themselves, one
  every 1.5s (a transient cause — an antivirus scan, a slow disk — is
  usually gone by then). If the load keeps failing after the third reload,
  the window stops flashing white and shows a short message instead: the
  load failed, reopening the app is the next step, and a reinstall is worth
  it if it persists (a damaged install, a partially written update or an
  antivirus quarantine are the usual causes).
- **Where to look**: desktop.log (the app's folder under logs) carries one
  line per decision, tagged `[desktop] load watch:` — the reason in words
  plus the error code and the **URL scheme only** ("esquema file"), never the
  full address of what you were doing, so the shared log stays safe to share.
- **What resets it**: the first load that completes successfully refills the
  reload budget — an isolated failure never consumes the budget of the next
  episode. Deliberate cancellations (the shell's own navigation guards) and
  failures inside embedded browser panes never count against it.

## The phone asked to be added to the Home Screen (P2-220)

When the phone opens the web app as a **regular browser tab** (iPhone or iPad,
not installed to the Home Screen), iOS may erase that site's script-writable
storage after ~7 days without use. The pairing identity lives in that storage
(IndexedDB + localStorage), so the tab would silently lose the pairing and
land back on the pairing screen with no explanation — the only recovery being
another QR read on the Mac.

To keep that loss from being silent, the app shows a calm one-line note above
the conversation list explaining that **adding the app to the Home Screen
keeps the pairing saved** and where the action lives in the browser (Share
button → Add to Home Screen).

- The note appears **only on iPhone/iPad browsers outside the installed
  (standalone) mode**, and only while a saved pairing exists. The desktop app
  and the first-run screen never show it.
- **Dismissing is definitive** on that device — there is no undo UI. To see
  the note again, clear the site's localStorage (or reinstall) — or, for
  testing, open the address with `?installhint=1`, a documented test-only
  hatch that forces the note to show without persisting anything.
- The note is a normal element in the page flow: it never covers the message
  field, never blocks sending and never disables a control.
- Android is deliberately out of scope: Chrome has its own install prompt and
  a different storage-eviction policy (future task if it ever earns one).

## The phone opens the app with no network (P2-239)

Since P2-239 the service worker precaches the root document and every
same-origin, hash-named asset it references on install, and answers those
addresses cache-first offline — so after one online visit the app opens
without a network and without a white screen. Hash-named files never mix
publications (each install fills a fresh versioned cache; activate deletes
old cache names and versioned leftovers of an earlier publication).

- **Nothing was cached yet** — the first visit happened offline, or the
  install was interrupted: the app answers with a minimal static page
  ("Você está sem conexão … quando a conexão voltar, recarregue a página")
  instead of the browser's raw error. Reconnect and reload; the next
  install fills the cache by itself.
- **A lazy-loaded feature still fails offline**: only assets referenced by
  the root document are precached; chunks fetched on demand (e.g. the push
  settings panel) need the network the first time they are used.
- **How to clear**: publishing a new version rotates the cache automatically.
  To force it by hand, clear the site's data for the app origin in the phone
  browser settings (iOS: Settings → Apps → Safari → Advanced → Website Data,
  or the browser's "Delete website data" for the origin), or remove and
  re-add the Home Screen entry — the next online visit rebuilds everything.
- **The new version only arrived after I closed and reopened the app**: by
  design (P2-246) — while a window from the previous publication is open the
  updated service worker waits and takes over on the next opening, so the tab
  in use never has its cached assets swept mid-conversation.

## Service control (macOS launchd)

```
opencode-remote status                 # relay + daemon + pwa service states
opencode-remote restart
launchctl kickstart -k gui/$(id -u)/com.ocr.pwa   # static PWA origin alone
```

The `com.ocr.pwa` service (P2-075) serves `apps/web/dist` statically on
`127.0.0.1:5173` with `KeepAlive` — it survives reboots and never runs a dev
server. Its logs are `~/.opencode-remote/logs/pwa.log` / `pwa.err.log`.
