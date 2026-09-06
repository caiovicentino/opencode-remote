# OpenCode Remote

[🇧🇷 Português](README.pt-BR.md) | 🇬🇧 English

Control the [opencode](https://opencode.ai) agent on your machine from your
phone, from anywhere. **Your machine, your code, your keys** — nothing leaves
your hardware; the relay is a blind pipe that cannot read the traffic.

```
[PWA (phone)] ⇄ [Relay] ⇄ [Daemon] ⇄ [opencode serve]
   passkey+QR      blind       E2E          localhost
```

<p align="center">
  <a href="assets/demo.mp4"><img src="assets/demo-poster.jpg" width="300" alt="OpenCode Remote demo — tap to watch"></a>
</p>

## Why this exists

Claude Code, Codex and friends run your agent in *their* cloud. OpenCode
Remote runs it on **your** machine — full filesystem, real terminal, your
API keys, any model — and gives you a phone cockpit that is end-to-end
encrypted. The relay never sees plaintext, so even a hosted relay stays
private. That is the product: **local power, remote control, zero trust**.

## What you get

- **Full chat** with streaming, markdown, images and tool-activity history;
  the chat header shows the conversation's title (generic "session" while the
  session has no title yet) and carries quiet ghost action buttons (handoff,
  export, tool activity) matching the composer's icon chrome; a fresh
  conversation shows a welcome empty state
  with quick tips (audio, photo or text). Assistant replies paint straight
  onto the canvas — the bubble is reserved for your own messages. The view
  only auto-follows the
  newest message while you are already at the bottom — scroll up to read and
  a small ↓ pill appears to jump back to the tail; when the connection drops
  a slim banner with the reconnection attempt count replaces the old header dot.
  The model's reasoning streams into a collapsible "Thought for Xs" block —
  expanded while it thinks, collapsed as soon as the answer starts, click to
  re-open; a streaming caret marks the live tail. 
  Code blocks and long lines never clip at the right edge: text and URLs wrap,
  and wide code/diff blocks scroll horizontally inside their own block, so
  nothing ever leaves the viewport (chat, diff modal and artifact pane)
- **AutoMode** — the agent runs hands-free; every auto-approved action is
  audited and pushable. In AutoMode the chat shows no approval cards for
  auto-approved asks — just a passive badge. When the auto-approval itself
  fails (one quick retry, then a final failure), the ask never stalls
  silently: a red note appears above the composer and the ask surfaces as a
  normal actionable card for manual review. Asks that are already answered
  collapse into "resolved" lines, duplicates of the same request render once,
  and tapping a stale card says "Permission already resolved" instead of a
  raw 404
- **Approval preview** — permission cards show the first lines of the
  command/patch being requested (from the permission event payload) before
  you Approve/Deny, so you always know what you're green-lighting
- **Interactive questions** — the model asks, you tap an option from the beach
- **Rewind** — go back to any point of the conversation *and* the code, one tap
- **Context gauge** — when the model's context window is known, the chat
  header shows how full it is for that session (token totals from opencode,
  yellow from 70%, red from 85%), refreshed whenever the agent goes idle
- **Pinned recap** — a one-line strip under the composer shows where the
  conversation left off: the first sentence of the agent's last reply (or the
  session summary when the backend provides one)
- **Voice** — hold to talk, local whisper transcription, no cloud. Transcription
  is an **optional** host capability: when the machine has no whisper engine
  (or the engine's model file is missing) the mic button renders disabled with
  a short actionable sentence from the daemon instead of recording into a dead
  end — and the daemon serves the same verdict on
  `GET /__ocr/voice/stt-status` (`{ available, state, message }`, mirroring the
  tts-status route). Install it on the host with `./scripts/setup-whisper.sh`.
  `OCR_STT_BLOCK=1` on the daemon is a test hatch that forces the
  missing-binary verdict so the disabled-mic UI can be evidenced
  deterministically even on hosts that do have whisper installed
- **Model readiness** — the composer warns before the first send when the
  machine hosting the daemon has no usable model configured (no provider
  credential, or credentials without models): a single calm line above the
  composer says what to do, derived from the same provider catalog the
  context gauge already fetches. The indicator describes the machine hosting
  the daemon and **never blocks sending** — the message can still go through
  if a model is reachable anyway. The same verdict is served on
  `GET /__ocr/model/status` (`{ available, state, message }`, mirroring the
  stt-status route). `OCR_MODEL_BLOCK=1` on the daemon is a test hatch that
  forces the no-provider verdict for deterministic screenshots
- **opencode version readiness** — the Settings machine section warns when the
  opencode installed on the machine hosting the daemon is older than the
  minimum the daemon's API surface expects (`1.18.0`): a single calm line says
  the machine's agent server should be updated and restarted. The indicator
  describes the machine hosting the daemon — never the phone — is probed once
  at boot from the resolved binary, and **never blocks anything**: sending,
  voice and every control stay enabled even when the verdict is too-old, and
  ok/unknown verdicts stay silent. The same verdict rides
  `GET /api/health` (`opencode.versionState` / `opencode.versionMessage`) and
  `GET /__ocr/settings` (`opencodeVersion`). To update the machine, install the
  latest opencode (e.g. `curl -fsSL https://opencode.ai/install | bash` or
  `brew upgrade opencode`) and restart the daemon;
  `OCR_OPENCODE_OLD=1` on the daemon is a test hatch that forces the too-old
  verdict for deterministic screenshots
- **Disk-space readiness** — the Settings machine section warns when the
  volume hosting the daemon's state directory is running out of free space
  (the daemon writes artifacts, upload staging, the audit log and the state
  file there): a single calm line asks the machine's owner to free space
  before writes start failing mid-conversation. Two thresholds are watched,
  whichever is more severe wins: **warning** below 2 GB free or 10% of the
  volume free, **critical** below 500 MB free or 5% of the volume free. The
  indicator describes the machine hosting the daemon — never the phone — is
  read once at boot and then on the same cycle as the artifacts retention
  janitor, and **never blocks anything**: sending, voice and every control
  stay enabled even when the verdict is critical (ok/unknown verdicts stay
  silent). The same verdict rides `GET /api/health`
  (`diskState` / `diskMessage`) and `GET /__ocr/settings` (`disk`). To free
  space on that machine, remove or archive large files (old session
  artifacts under `~/.opencode-remote/artifacts/` are trimmed automatically
  by the retention janitor); `OCR_DISK_FULL=1` on the daemon is a test hatch
  that forces the critical verdict for deterministic screenshots
- **Machine state panel** — Settings → **Machine state** gathers in one calm
  list every readiness verdict the machine itself reports: the remote relay
  link, the agent server and its version, disk space and document→PDF
  conversion. Worst verdict first, one row per verdict with a severity marker
  and **the machine's own phrase, verbatim** — the app never rewrites it and
  never invents one. Verdicts the connected daemon does not report simply
  don't appear (calm empty state), and nothing in the panel ever blocks: it
  describes the machine hosting the daemon — never the phone
- **Files** — upload from the phone, preview anything, export a conversation
  as markdown with one tap; every file card has a ⧉ button that copies the
  file's full path (Clipboard API with an execCommand fallback)
- **Document → PDF conversion** — send a document (docx/doc/rtf/html/csv/xlsx/pptx)
  and the agent converts it locally: LibreOffice gives full fidelity and is
  discovered from PATH plus the default install paths (macOS app bundle,
  `C:\Program Files\LibreOffice\program\soffice.exe` on Windows); on macOS a
  native textutil+cupsfilter fallback covers doc/docx/rtf/html/csv without
  preserving formatting. The machine's readiness is announced by `GET /api/health`
  (`docConvertState` / `docConvertMessage` / `docConvertExts`, probed once at
  boot) before you send anything; with no converter installed the tool answers
  with one short sentence asking for LibreOffice — never a raw English error —
  and the original file is never modified
- **Handoff** — continue the exact session on your Mac (laptop icon in the
  chat header)
- **Live board** — every session's state at a glance: working, waiting for
  your approval, asked a question, done, errored; cards show relative
  last-activity time (`5m`, `2h`, `3d`); sessions are sorted by most recent
  activity first
- **Session filters** — chips above the search (All / With badge / No badge)
  narrow the board to sessions with or without an unread badge
- **Fast session switching (P1-064)** — opening a conversation fetches only
  the last 50 messages (paged by the daemon with `?limit&before`, sized in
  exact bytes — huge tool outputs are clipped — to stay under the relay's
  frame limit); older history loads on demand via
  "Load older messages" or by scrolling to the top. The last 3 visited
  conversations stay cached in memory, so switching back repaints instantly
  (a background refetch still refreshes the tail), and a timed-out history
  fetch shows an error with a Retry button instead of an eternal skeleton.
  Sessions titled like the autonomous pilot's tasks (`P3-123 …`) collapse
  into a "Pilot sessions" group at the end of the board. The match is by
  task id anywhere in the title (the heuristic cannot tell agent naming
  intent from yours), so one of your own conversations that mentions e.g.
  `P2-049` in its title is grouped as well — rename it to bring it back
- **Per-conversation drafts (P1-088)** — the composer keeps one draft per
  conversation: switch sessions mid-typing and each chat holds its own text;
  sending clears only the conversation you sent from
- **Complete composer (P3-086)** — the chat input is one raised card: a "+"
  button attaches files with an inline preview chip (thumbnail, name, one-tap
  remove), a mic button sits next to it (functional placeholder — disabled,
  with an explanatory tooltip, until the daemon reports transcription
  capability; since P2-201 the tooltip and the quiet line under the composer
  carry the daemon's actionable verdict phrase — missing engine vs missing
  model — and an unknown verdict keeps the mic usable, failing open on
  purpose), an inline **agent · model** dropdown replaces the old header
  select and the full-width model list, the textarea auto-grows up to ~6 lines
  and then scrolls internally, Enter sends / Shift+Enter breaks the line
- **Routines** — real cron: daily, specific weekdays, or interval loop; a run
  stuck in flight (daemon restarted mid-execution, lost session event) is
  released automatically after a 2 h run lease (`OCR_RUN_LEASE_MS`, `off` to
  disable) and the routine fires again at its next scheduled time
- **Secure by construction** — passkey (WebAuthn) gate, ECDH P-256 + AES-256-GCM,
  replay protection, device allowlist, audit log, biometric unlock
- **Distinguishable devices** — every pairing gets a stable, personal-data-free
  label (`Telefone 1`, `Telefone 2`, …) instead of the old hardcoded `first`, and
  the Settings device list shows an approximate last-seen stamp (`last seen 5m`,
  or `never seen` for entries that predate the field) next to the key prefix —
  so a lost phone can be revoked without guessing between public-key prefixes.
  The stamp is throttled to one `daemon.json` write per device per hour
  (`DEVICE_TOUCH_INTERVAL_MS`): deliberately coarse, never per frame, and it
  never changes admission decisions
- **BYOM** — opencode supports any provider; pick the model per session
- **API + SDK** — drive sessions from code (`packages/sdk`)
- **Artifacts** — the agent writes documents (html, md, csv, pdf) to
  `~/.opencode-remote/artifacts/<sessionId>/`; the desktop app gains an
  **Artifacts pane** that lists and renders them in-app (sandboxed html,
  markdown/tables, inline PDF) and chat messages that mention an artifact get
  an attached card; on viewports ≥ 900 px wide, clicking the card opens the
  preview in a **side-by-side pane** next to the chat (draggable divider, chat
  stays visible and navigable — Claude/Codex style), while narrower screens
  keep the full-screen overlay; also listed programmatically via `GET /api/artifacts`.
  The listing comes newest-first and is capped at the **500 most recent**
  artifacts (`total`/`truncated` fields report the real count), so a long-lived
  install never pays a multi-megabyte payload per pane open over the E2E tunnel.
  The global Artifacts list groups by **conversation title** (the daemon resolves
  session ids against the opencode session list; unknown ids fall back to the raw
  id) and, on wide viewports, clicking a list item jumps back to Conversas with
  the preview in the side-by-side pane — no full-screen detour.
  When the agent writes a new artifact the daemon emits a `session.artifact`
  event, and on the turn's next idle the desktop app opens the preview pane
  by itself — never overriding a manual pick, a pane the user closed, or an
  open Browser pane. Previews are capped at **5 MB**: larger artifacts show a
  clear "too large to preview" note instead of stalling the app (the daemon
  answers `413`; the header Save button is hidden because there are no bytes
  to save). The PDF preview runs in a sandboxed iframe (scripts/forms/popups
  blocked). Every session created by the daemon carries the artifacts
  protocol — it is
  injected into the agent's system prompt even in workspaces without an
  `AGENTS.md` (a workspace AGENTS.md that already documents the protocol
  suppresses the injection; sessions created directly in the opencode CLI/TUI
  are not touched). The injected-session registry lives in memory: sessions
  created before a daemon restart are not re-injected after it — only
  sessions created from the fresh daemon are
- **Artifact retention** — the artifacts folder is bounded by a janitor so a
  long-lived install never silently fills the disk: a daemon sweep (once at
  boot, then every **6 h**) deletes whole session dirs under
  `~/.opencode-remote/artifacts/` that are older than **30 days**, oldest
  first, until the folder fits within **1 GB** total. The **48 h** grace
  period keeps freshly written artifacts safe no matter what, and the **3
  most recently modified** session dirs are always preserved even when every
  ceiling is blown. Only the artifacts root is ever touched by this janitor —
  `clips/` and every other state dir are never scanned or deleted (`uploads/`
  has its own retention janitor, next bullet). Set `OCR_ARTIFACT_RETENTION=off` in the daemon
  environment to disable the janitor entirely (default: on). Each sweep logs
  one line with the deleted count and bytes and bumps the
  `ocr_artifact_retention_deleted_total` metric
- **Uploads retention** — `~/.opencode-remote/uploads/` (videos and documents
  sent from the phone, plus files generated for download) is bounded by the
  same janitor sweep and cadence (once at boot, then every **6 h**): files
  older than **30 days** are deleted and, oldest first, enough of the rest
  goes to keep the folder within **2 GB**. Files written in the last **24 h**
  are never touched and the **5 most recently modified** files always
  survive, even when every ceiling is blown — and anything deleted here still
  exists on the phone that sent it. Only the uploads root is scanned (flat
  regular files; subdirectories, hidden files and symlinks are ignored). Each
  sweep logs one line with the deleted count and bytes (never file names) and
  bumps the `ocr_upload_retention_deleted_total` metric. Set
  `OCR_UPLOAD_RETENTION=off` in the daemon environment to disable it entirely
  (default: on); the ceilings are overridable via
  `OCR_UPLOAD_RETENTION_GRACE_HOURS`, `OCR_UPLOAD_RETENTION_MAX_AGE_DAYS`,
  `OCR_UPLOAD_RETENTION_MAX_BYTES` and `OCR_UPLOAD_RETENTION_MIN_FILES`
  (invalid values fail the boot, fail-closed)
- **Desktop shell (early)** — Electron app wrapping the same UI, with tray and native menu;
  includes a **Browser pane**: in the desktop shell it renders a real sandboxed Electron
  `<webview>` (scroll, click and edit work like in a browser; `contextIsolation`/`sandbox` on,
  `nodeIntegration` off, popups off), with an editable URL bar, reload and a maximize toggle
  (~80% width). The webview guest always fills the whole pane — including after the maximize
  toggle or a window resize — instead of painting in a top strip (P2-092). The Playwright
  screenshot mode (`/api/browse`) remains the fallback in the PWA
  and the reviewer-driving path (`tools/browse.mjs`)
- **Auto-preview** — when the agent mentions a `http(s)://localhost:<port>` / `127.0.0.1:<port>`
  URL in a reply, the daemon emits a synthetic `ocr.preview` event (deterministic URL parse,
  deduped per session for 10 minutes) and the desktop app opens the Browser pane side-by-side
  with the chat, pointed at that URL, with a back button to the chat. In the PWA the event is
  ignored (the machine's localhost is unreachable from the phone)
- **Mission Control** — navigable post-mortem of the pilot's autonomous runs in the desktop
  app: a card per agent task (goal, progress, effort, ETA) and a forensic timeline parsed
  from the real `pilot.log`/`events.jsonl` (decisions, reviewer verdicts, gate failures with
  output tails, deploys), post-deploy shots, a live dashboard shot and a one-click
  **Take over** (Terminal attached to the agent's opencode session); also served
  programmatically via `GET /api/pilot-forensic`
- **Consistent icon language** — every chrome icon (desktop nav rail, tab bar, chat header,
  artifact cards, status dots) is the same inline-SVG stroke set on top of CSS design tokens;
  every color literal lives in `apps/web/src/tokens.css` (dark + light theme), and
  Settings → Appearance accepts **System/Dark/Light** — System follows the OS
  `prefers-color-scheme` live, with no reload
- **Bilingual UI + keyboard access** — every screen (pairing, chat composer, tool
  activity and diff dialogs) reads from one EN/pt-BR dictionary, dialogs close
  with Esc and trap focus, and the session board is fully reachable by keyboard.
  Connection screens follow one locale end-to-end: daemon-down/reconnecting
  banners, the QR scanner and the desktop home screen resolve their copy from
  the same dictionary as the actions next to them — no pt-BR/English mix on a
  single screen
- **Quiet chrome, one status surface** — the mobile sessions header reads as a
  0.72rem overline (machine name + connection dot) instead of a page title, the
  badge filters fold into a menu attached to the search field (active filter
  marked with a dot on the funnel icon), the desktop empty state ends in a
  composer-styled "New conversation" action, and the daemon status is stated
  once: the shell's reconnecting/down strip replaces — never duplicates — the
  in-chat connection banner

## Quick Start (Mac → iPhone, ~5 min)

```bash
git clone https://github.com/caiovicentino/opencode-remote.git
cd opencode-remote && npm ci
opencode serve --port 4096    # if not already running
node cli.mjs setup --relay=wss://your-host.ts.net:8788
```

The wizard checks node/opencode/whisper/ffmpeg, installs launchd services
with KeepAlive and prints the pairing QR. Point the camera at it from the
PWA and you are in.

The phone's PWA origin is the `com.ocr.pwa` launchd service — it serves the
built `apps/web/dist` statically on `127.0.0.1:5173` (P2-075), never a dev
server. The daemon watches `/healthz` and flags a dead origin on the
dashboard (red chip + `[pwa] origin` event).

### Keep the pairing on the iPhone: add to Home Screen (P2-220)

If the phone opens the app as a **regular Safari tab** (never installed to the
Home Screen), iOS may wipe that website's saved storage — including the
pairing key — after about a week of no use, and the only recovery would be
walking back to the Mac to scan another QR. To prevent that silent loss, the
app shows a **calm one-line hint** above the conversation list explaining how
to add it to the Home Screen (Share button → Add to Home Screen). The hint:

- appears **only on iPhone/iPad** browsers, outside the installed
  (standalone) mode, while a saved pairing exists;
- never appears in the desktop app (its storage is never swept) and never on
  the first-run screen with nothing to lose;
- can be dismissed — **dismissal is definitive** on that device; and
- never blocks anything: it is a normal element in the page flow, it never
  covers the message field or disables a control.

`?installhint=1` on the address forces the hint to show for screenshots and
support reproduction (test-only hatch; nothing is persisted by it).

## Install as a third party (no tailnet — LAN mode)

The `wss://…ts.net` in the Quick Start is just one way to reach the relay.
Any Mac on the same Wi-Fi can host everything with a locally-trusted
certificate — no tailnet, no public hostname (WebAuthn's passkey gate needs a
secure context, hence the TLS):

```bash
git clone https://github.com/caiovicentino/opencode-remote.git
cd opencode-remote && npm ci
npm run build --workspace @ocr/web
opencode serve --port 4096    # if not already running

# one-time: local CA + certificate for your LAN IP (brew install mkcert)
mkcert -install
LAN_IP=$(ipconfig getifaddr en0)
mkdir -p .certs
mkcert -cert-file .certs/lan.pem -key-file .certs/lan.key "$LAN_IP" localhost 127.0.0.1

# relay + daemon + static PWA origin as launchd services (KeepAlive)
RELAY_URL="wss://$LAN_IP:8788" \
RELAY_TLS_CERT="$PWD/.certs/lan.pem" RELAY_TLS_KEY="$PWD/.certs/lan.key" \
PWA_HOST=0.0.0.0 PWA_TLS_CERT="$PWD/.certs/lan.pem" PWA_TLS_KEY="$PWD/.certs/lan.key" \
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
  ./deploy/install.sh

RELAY_URL="wss://$LAN_IP:8788" node cli.mjs qr   # pairing QR (embeds the relay URL)
```

Then on the phone (same Wi-Fi): AirDrop `$(mkcert -CAROOT)/rootCA.pem` →
install profile → enable in **Settings → General → About → Certificate Trust
Settings**; open `https://<LAN_IP>:5173` in Safari → **Add to Home Screen** →
scan the QR. Omit the `PWA_*`/`RELAY_TLS_*` overrides to keep the default
tailscale layout — **but note that a fresh clone has no `.certs/`**: without
generated certificates the relay installs plain-ws on 8788, so pair it with
`RELAY_URL="ws://$LAN_IP:8788"` and leave the `PWA_TLS_*`/`NODE_EXTRA_CA_CERTS`
vars out too. `RELAY_TLS_CERT`/`RELAY_TLS_KEY` are a mandatory pair: set both
for direct `wss://` termination or neither — setting only one, leaving a
blank value, or pointing at an unreadable file makes the relay refuse to boot
(exit 1) instead of silently serving plain `ws://`. Every port and cert path is an environment variable
(`RELAY_PORT`, `PWA_PORT`, `PWA_HOST`…). The autonomous pilot service follows
the same rule: `deploy/install-pilot.sh` has no hardcoded hostname — set
`RELAY_URL` in the environment (re-installs without it keep the value already
stored in the plist), plus `NODE_EXTRA_CA_CERTS` when the relay uses a local
CA — recovered from the plist on re-install as well, never silently dropped;
Node never trusts the macOS keychain.

### Desktop app installer (DMG)

Every GitHub release ships a real macOS installer in **two** architectures
(P2-191): `OpenCode-Remote-<version>-arm64.dmg` for Apple Silicon and
`OpenCode-Remote-<version>-x64.dmg` for Intel (electron-builder `dmg` target,
branded window). Pick the file that matches your Mac: Apple menu → **About This Mac**
→ **Chip** says "Apple" → `-arm64`; it says "Intel" → `-x64`. A signing
preflight (`apps/desktop/scripts/signing-profile.mjs`) runs
before packaging and picks one of two modes:

- **Developer ID + notarized** — when the runner has a Developer ID
  Application certificate (`CSC_LINK` or `CSC_NAME` secret, with
  `CSC_IDENTITY_AUTO_DISCOVERY` unset or `true`) plus the Apple notarization
  credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`). The bundle is signed with hardened runtime and the
  `build/entitlements.mac.plist` entitlements, then notarized.
- **Ad-hoc (default)** — without those secrets the DMG ships ad-hoc signed and
  you right-click → **Open** once to pass Gatekeeper. The preflight only turns
  notarization on when the certificate is actually usable: a certificate
  configured while `CSC_IDENTITY_AUTO_DISCOVERY=false` (electron-builder would
  silently ignore it) or notarization credentials without a certificate are
  reported as problems and the build falls back to ad-hoc instead of failing.

The two modes differ in what first launch looks like, and the release pipeline
holds each one to its own bar (P2-170). A **notarized** release must open with
no friction: the desktop-dmg job runs the three Gatekeeper verdicts on the
packaged app (`codesign --verify`, `spctl` assessment and `stapler validate`
via `scripts/gatekeeper-verify.ts`) between the bundle smoke-check and the
upload, so a DMG whose notarization ticket never got stapled, whose identity
expired mid-release, or whose profile silently dropped to ad-hoc fails the job
before `gh release upload` — never as a published "app is damaged" surprise. An
**ad-hoc** release is held to the ad-hoc bar: the signature itself must verify
and the tools must produce readable verdicts, but spctl rejecting the build and
an absent staple are exactly the documented right-click → **Open** flow, so the
no-secrets release path stays green.

Homebrew users get the same code via the `Formula/opencode-remote.rb` formula
(AGPL-3.0-only, checksum pinned automatically by the release pipeline at tag
time).

Since P2-146 the macOS packaging also produces the zip artifacts Squirrel.Mac
needs (one per architecture, additive to the DMGs) and the release workflow
publishes the Squirrel.Mac JSON feeds built from `latest-mac.yml` by
`apps/desktop/scripts/update-feed.mjs`: `update-mac-arm64.json` and
`update-mac-x64.json` (P2-191), plus `update-mac.json` — kept as a
byte-identical alias of the arm64 feed so installs predating P2-191 keep their
update path. Each feed points at the zip of its own architecture, so an Intel
Mac can never be handed the arm64 build. **macOS installs update themselves**:
the packaged shell fetches the feed for the architecture it runs as and
applies the release in the background (with the consent dialog below) — but
only when the running app is **Developer ID signed** (P2-136): Squirrel.Mac
refuses an update whose code signature does not match the installed app, so
ad-hoc signed builds (the default without signing secrets) keep the manual
flow via the release page.

**Install it once from the DMG (P2-211).** The updater can only replace a
bundle living in **Applications** — an app opened straight from the mounted
DMG (or from the Downloads folder) runs read-only from a random path the
updater can never swap, so it would silently never update. The app now says
so at the first boot: a calm line under the pairing QR asks you to drag the
app to the Applications folder, eject the disk and reopen it from there. The
line describes the machine hosting the daemon, **never blocks pairing** (the
QR stays visible — drag the app and reopen after pairing) and **never blocks
any other use of the app**; when the location cannot be confirmed it stays
quiet. With the location wrong, an update that finished downloading is **not
offered as a restart** (one `desktop.log` line instead) because the restart
could not apply it anyway. Diagnostics → Copy diagnostic reports the verdict
state (never the path). macOS only; other platforms are unaffected.
`OCR_DESKTOP_FORCE_DMG_VOLUME=1` on the desktop shell forces the warning for
deterministic screenshots (test-only hatch, never set in production).

### Desktop app installer (Windows)

Releases also ship a Windows installer, `OpenCode-Remote-Setup-<version>.exe`
(electron-builder `nsis` target: assisted setup, per-user install, you can
pick the installation directory), alongside the `latest.yml` metadata the
in-app update check falls back to. Windows signing has its own profile,
resolved by `apps/desktop/scripts/signing-profile-win.mjs` before packaging
from the `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` secrets (optional
`WIN_CSC_SUBJECT_NAME` to pick the certificate by subject name) — the Apple
`CSC_LINK` / `CSC_KEY_PASSWORD` pair the macOS job uses is never consulted on
Windows. With the pair configured the installer is Authenticode-signed
automatically and the warning goes away. Without any `WIN_CSC_*` secret the
installer is **unsigned** and Windows SmartScreen shows "Windows protected
your PC" on first run — click **More info → Run anyway** once; the same
one-time trust dance as the macOS Gatekeeper flow above. A half-configured
profile (link without password, password without link, or a blank value) is
fail-closed: the release job aborts during the signing preflight and lists
every problem instead of publishing a broken signature.

#### How updates work on Windows (P2-233)

Windows has no background update engine: the app checks `latest.yml`, and
the actual install is always a manual, user-driven act. Since P2-233 the
in-app flow no longer dead-ends on the seven-file release page. When **you**
click the existing **Check for updates** item (tray or Help menu) and a newer
version is published, the app downloads the one installer the feed names —
the file resolved right next to `latest.yml`, nothing else — into the
`update-staging` folder inside the app's user data directory, verifies it and
reveals it in
Explorer, already selected, ready for you to double-click. The app **never
executes the installer** — not with confirmation, not scheduled, never:
running a freshly downloaded binary is a surface the product does not open.
Integrity is fail-closed: the sha512 digest published in `latest.yml` is
compared against the digest measured on the downloaded bytes (case-insensitive
base64), a mismatch deletes the downloaded file and keeps the release page as
the fallback, and a network failure or a feed without a digest likewise leaves
the old manual flow — opening the GitHub release page — untouched. Nothing
downloads at boot, on a timer, or from the periodic background re-check; only
your explicit click does.

The two release paths stay visibly different on purpose. When the profile
decides mode=authenticode, the `desktop-win` job additionally verifies the
packaged installer's Authenticode signature (PowerShell
`Get-AuthenticodeSignature` → `scripts/authenticode-verify.ts`) between the
bundle smoke check and the release upload: a signature that is not exactly
`Valid` (file not signed, hash mismatch, untrusted chain, expired/revoked
certificate, unknown error) or a signature whose certificate carries no
subject aborts the job BEFORE the setup exe is attached to the release — the
SmartScreen wall can no longer be the first signal. When the profile decides
mode=unsigned the verification is skipped by design (the one-time SmartScreen
warning is the documented flow), exactly like the ad-hoc path on macOS. When
the step fails, the job log lists every problem at once under
`authenticode-verify:`; the `Status:`/`StatusMessage:` lines of the
verification itself are in `authenticode.txt` (workflow workspace artifact of
the run).

Windows packaging is no longer release-only: every PR that touches the desktop
surface also runs the `desktop-package-win` CI job (P2-219), which builds,
packages the `dir` target only — the unpacked `win-unpacked` bundle, never the
NSIS installer, nothing signed — and smoke-checks the result, so a broken
Windows package fails the PR instead of surfacing on publication day.
Reproduce the same run locally on a Windows machine:

    npm run dist --workspace @ocr/desktop -- --win --dir
    npm run dist:smoke --workspace @ocr/desktop -- --no-installer

The first command produces `apps/desktop/dist/win-unpacked`; the second
validates its layout deterministically (web UI, daemon sidecar, executable).

Since P2-224 the same PR also runs the `verify-win` job on windows-latest,
which typechecks and runs the portable, Windows-safe subset of the unit
battery (`scripts/portable-suite.ts` — no Electron, sockets, chmod, spawns or
listening ports), so a separator or path-normalization regression in modules
like `webroot.ts`, `installloc.ts`, `desktop-log.ts`, `sidecar-log.ts`,
`tray.ts` or `versions.ts` fails the PR instead of the user's machine. Run
the same sub-battery locally on any OS:

    npm run test:unit-win

**Releasing**: a tag `vX.Y.Z` must carry the same version in **both**
`package.json` files (repo root and `apps/desktop`) plus `apps/web/src/version.ts`.
The release workflow runs `scripts/release-preflight.ts` as its first step and
blocks the release on any mismatch, and runs
`npm run dist:smoke --workspace @ocr/desktop` on the packaged bundle before
uploading the DMG. Since P2-204 (DMG) and P2-208 (Windows) both packaging jobs
also **boot** the packaged app once (`Smoke-boot the packaged app` step): a
hermetic launch of the real bundle (temp userData, no daemon sidecar, hidden
window) that waits for the UI to mount, verifies renderer console-error
capture with an injected canary and fails closed when Playwright is
unavailable — a package that does not open aborts the release before upload.
Run the boot smoke locally against an already-built package too:

    node apps/desktop/scripts/packaged-boot.mjs "apps/desktop/dist/mac-arm64/OpenCode Remote.app"
    node apps/desktop/scripts/packaged-boot.mjs "apps/desktop/dist/win-unpacked"

One command stamps all three from the tag — never bump by
hand:

    npx tsx scripts/sync-version.ts vX.Y.Z && git add -A && git commit -m "release: vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags PRs that touch the desktop shell, the web UI or `package-lock.json`
additionally run a scoped packaging job (`desktop-package`, mac `dir` target
only, no DMG/signing) smoke-checked with `dist:smoke --no-installer`; the full
signed installers still ship only at tag time. Before packaging, that job also
enforces the bundle size budgets of `scripts/bundle-budget.ts` (P2-162): the
summed `apps/web/dist` payload and the `apps/desktop/dist-daemon/index.js`
sidecar bundle must stay under their ceilings or the job fails before anything
is packaged — a fat dependency can no longer turn into a silent slow download.
Measure locally after a build with `npx tsx scripts/bundle-budget.ts`; raise a
ceiling only on purpose, bumping `BUNDLE_BUDGETS` with the justification in the
commit message.

**What each release must carry** (P2-153): the source tarball
(`opencode-remote-<tag>.tar.gz`) from the `release` job; the macOS side from
`desktop-dmg` — the DMG and the Squirrel.Mac zip **for each architecture**
(arm64 and x64, P2-191), `latest-mac.yml` and the three feed files
(`update-mac.json` plus the per-arch `update-mac-arm64.json` /
`update-mac-x64.json`); and the Windows side from
`desktop-win` — the NSIS setup exe and `latest.yml` (the relay image is
published to GHCR and is not a download asset). A final `release-verify` job
lists the published assets with `gh release view --json assets` and runs
`scripts/release-assets.ts` against that list: the release is only considered
complete when that job passes — a missing installer (including the Intel one,
P2-191) or update feed fails the
workflow (every missing artifact listed at once) instead of surfacing later as
a 404 on the in-app update check. The release is also only considered complete
when the feeds point at artifacts of the same tag (P2-157): a `release-feeds`
job downloads `update-mac.json`, `latest.yml` and the two per-architecture
feeds, and checks via `scripts/feed-consistency.ts` that the Squirrel
`name`/`url` and the yml `version`/`path` reference this tag's version and
published files, and fails the workflow — otherwise a stale feed ships green
and every installed app silently fails its auto-update. Since P2-212 the gate
also covers the architecture: `update-mac-arm64.json` must point at a
published zip carrying the `arm64` token and `update-mac-x64.json` at one
carrying `x64` (an Intel Mac must never be handed the arm64 zip — the exact
feeds real machines consult are the ones checked), and the legacy
`update-mac.json` — which exists only for the pre-P2-191 installed base — must
stay identical to the arm64 document. Publication stays blocked until every
feed points at a present, right-architecture artifact.

**Releases are born as drafts** (P2-179): `gh release create` runs with
`--draft`, so nothing is visible to the installed base while the packaging
jobs are still running. A final `release-publish` job — after `release-verify`
and `release-feeds` both passed — reads the draft flag + asset list with
`gh release view --json isDraft,tagName,assets`, runs
`scripts/release-publish.ts` (publish only a draft carrying every required
asset; an already-published release is an idempotent no-op) and only then
flips the release public with `gh release edit --draft=false`. A release whose
signing, notarization or packaging failed therefore ends the run as a **draft**
instead of a public download page with no installers. The Homebrew formula pin
also moved into `release-publish`, after publication: the sha256 is computed
from the tarball downloaded back from the release, so `main` never points at a
release that is not public yet (the pin push stays fail-open — a refused push
only warns). To inspect or discard a failed run's draft: open the Actions run
to see which job failed (the failing step lists every missing asset), then
either fix the cause and re-run the workflow — a re-run walks past an already
published release — or delete the draft with
`gh release delete vX.Y.Z --yes` (the tag stays; delete it too with
`--cleanup-tag` if you want a clean re-tag).

**The release page tells you what to download** (P2-216): the auto-generated
release body is a wall of commit titles, so before a release goes public the
`release-publish` job writes a short download guide into it
(`scripts/release-notes.ts`): one line each for **Mac com Apple Silicon**,
**Mac com Intel** and **Windows**, naming the exact installer file for that
machine, plus the first-open warning for unsigned macOS builds and how to
check the download against `checksums.txt`. The guide only ever names files
that are actually attached to the release — each audience line is matched
against the published asset list — and if any audience's installer (or
`checksums.txt` itself) is missing, the guide step fails and the release stays
a draft instead of publishing guidance for a download that does not exist.

**Verify your download** (P2-186): every release also carries
`checksums.txt`, a SHA-256 manifest in the standard coreutils format (one
`<hash>  <name>` line per download asset, sorted by name, two spaces between
hash and name). It is built by the release pipeline itself: the
`release-publish` job downloads the finished assets back from the draft,
hashes each file and attaches the manifest **before** the release goes public,
so the checksums can only ever describe the bytes that were actually
published. After downloading an installer (and the `checksums.txt` next to it),
check it with your system's standard tool:

    # macOS / Linux — inside the folder with the downloaded files:
    shasum -a 256 -c checksums.txt     # macOS
    sha256sum -c checksums.txt         # Linux

    # Windows (PowerShell) — compare with the line in checksums.txt:
    Get-FileHash ".\OpenCode-Remote-Setup-0.3.0.exe" -Algorithm SHA256

The tool prints `OK` for every file whose hash matches. A mismatch means the
file on disk is not what CI produced: **do not open or run it**. The most
common cause is a truncated or proxied download — download again and re-check;
if the hash still does not match, do not distribute the file and report it on
the releases page (the Homebrew formula is an alternative install path that
pins its own sha256 at tag time).

## Hosted relay (Docker)

Prefer not to host the relay on your own Mac? `deploy/relay/Dockerfile` builds
a small multi-stage image (node 22 slim, tsc-compiled, non-root, `HEALTHCHECK`
on `/healthz`) for any container platform — point your provider's TLS at it,
set `RELAY_URL` on the daemon and re-pair the phone. Release tags build that
image in CI, boot and smoke-probe it, and only then publish it to GHCR (opt-in:
only when the repository variable `PUBLISH_RELAY_IMAGE` is `true`; without it
the tag still proves the image builds and boots, but publishes nothing):

```bash
docker pull ghcr.io/caiovicentino/opencode-remote:0.2.0   # pin the version, not latest
```

Every PR that touches the relay surface (`apps/relay`,
`deploy/relay/Dockerfile`, `.dockerignore`, `package-lock.json`) also builds
and smoke-boots the image in CI (`relay-image` job, P2-222) — same build and
probes as the release, no registry login and no push. Reproduce locally:
`docker build -f deploy/relay/Dockerfile -t relay-smoke:pr .`, then
`npx tsx scripts/relay-image-smoke.ts http://127.0.0.1:<port> "$(docker exec relay-smoke whoami)"`
against a container started from that tag.

Hosted, the relay also protects its own memory (P2-217): a peer that stops
reading has its outgoing buffer capped by `RELAY_BUFFER_CAP_BYTES` (default
4 MiB per socket) and is closed alone — with close code `1013` and an
additive `slow_consumers_total` metric — instead of one frozen 4G phone
growing the process without bound and dropping every room's conversations.
Admission is capped process-wide too (P2-227): once the live socket count
reaches `RELAY_MAX_SOCKETS_GLOBAL` (default 1000, ceiling 10000), new
upgrades are refused with close `1013` and a `capacity_refused_total` metric —
the relay says no to new sockets instead of dying from file-descriptor
exhaustion and dropping every tenant's conversations. And a connection has to
earn its slot (P2-230): a socket that never enters a room is closed after
`RELAY_JOIN_DEADLINE_MS` (default 60s, ceiling 1h, `-1` disables) with an
`idle_unjoined_closed` metric — the automatic pong alone no longer holds a
capacity slot forever.

On the desktop shell you do not need to export `RELAY_URL` by hand: Settings
has a **Phone relay** card (desktop-only section) where you paste the hosted
address — e.g. `wss://relay.example.com:8788` — and the app restarts its daemon
with it, so the pairing QR stops pointing the phone at the machine's own
loopback. Precedence is environment first (`RELAY_URL`, for operators who
script the app), then the saved value, then the local default
`ws://127.0.0.1:8787` — which only ever works on the machine running the app.
Addresses are validated by the app before anything is saved (ws/wss only,
`ws://` restricted to loopback hosts, no embedded credentials); an invalid
saved address is shown as an error in Settings, never silently replaced by the
default.

**Two-step pairing (P2-189)**: the phone needs an address before there is a
pairing QR to scan, so the desktop pairing screen shows two labeled steps.
Step one is the **app address** — `https://…` derived from the relay address
(`wss://` becomes `https://` on the same host and port, path and query
discarded) — rendered as a QR plus copyable text. Step two is the pairing QR
you already know. The deployment convention is that the host serving the
relay also serves the web app on the same origin; when it does not, save an
explicit address in Settings → **App address (phone)** — a stored value beats
the derived one. With the loopback local relay the shell shows a calm
explanation instead of an address the phone could never reach.

**One-QR pairing (P2-193)**: when the app address is usable, the shell fuses
both steps into a single QR — the pairing credential travels in the URL
**fragment** of the app address (`…/#/pair?v=2&…`), so the phone's camera
alone opens the app already paired. No browser ever sends a fragment to a
server, so the hosted relay stays a blind router; the web app wipes the
fragment from the address bar and history (`history.replaceState`) the moment
it consumes the link; and a problem-bearing link is never rendered as a QR —
the two labeled QRs above remain the fallback. The limited pairing window
(P2-190) is still what bounds the credential's validity.

**Reach probe (P2-197)**: a syntactically valid address can still lead
nowhere — a relay that is down, a DNS name that never existed, an expired
certificate or a stranger's server. While the pairing screen is up, the shell
probes the app address once per poll tick (2s ceiling) from the machine that
hosts the daemon and shows the verdict as one calm line below the QR
("unreachable", "timeout", "certificate", "DNS", "HTTP error", "not our app"),
with a **Test again** action on failure. The probe hits only the origin of the
app address — never the credential-bearing pairing link — and sends no
credential header. A warning never blocks pairing and never hides the QR: the
Mac failing to reach the relay does not prove the phone will (different
network, different DNS).

**Relay link (P2-199)**: the reach probe says whether the app address answers,
but the conversation itself rides a second link — the WebSocket between the
daemon on this machine and the relay written inside the QR. While the pairing
screen is up, the shell reads that link's verdict from the same `/api/health`
answer it already fetches every tick and shows one calm line right below the
reach line: **connected**, **local mode** (no relay needed), **connecting /
reconnecting** (dial in progress or backoff), **refused** (relay at capacity
or rate-limiting) or **misconfigured** (the daemon's relay address was refused
at boot). The line describes the machine hosting the daemon — not the phone,
not the camera. Like every warning on this screen it never blocks pairing and
never hides the QR: the link can come back up before the phone finishes
scanning.

**Clock skew (P2-214)**: a machine whose clock is far off has its own failure
mode — the phone's browser refuses the hosted relay's certificate (the
validity window no longer covers the phone's "now"), the pairing window closes
at an unpredictable instant and every timestamp the phone is shown looks
wrong, all with no explanation. While the pairing screen is up, the shell
compares its clock against the `Date` response header of the very same answer
the reach probe already obtained — no second request, no time server — and
shows one calm line right below the install-location line when the clock is
**ahead** or **behind**, pointing at the automatic date/time setting. The line
describes the machine hosting the daemon and never blocks pairing nor hides
the QR (a wrong clock does not stop pairing from working right now); when the
reference is missing or unreadable it stays quiet. `OCR_DESKTOP_FORCE_CLOCK_BEHIND=1`
on the desktop shell forces the warning for deterministic screenshots
(test-only hatch).

**Start at login by default (P2-218)**: a packaged app that is not running is
the one failure no wake reaction can fix — after the first reboot, power cut
or logout, the phone simply finds no machine, with no cause shown anywhere.
So the first boot of an installed app (macOS/Windows) turns on **Start at
login** by itself — that is what lets the phone keep finding this machine —
and announces it with one calm line on the pairing screen (the QR is never
hidden). The toggle stays in the tray menu: turning **Start at login** off
there is definitive and no future boot turns it back on. Dev builds are never
touched, other platforms keep the previous behavior, and
`OCR_DESKTOP_FORCE_LOGIN_ITEM=1` on the desktop shell forces the announce for
deterministic screenshots (test-only hatch, machine untouched).

The image carries no secrets and the relay stays a blind
router: it never sees plaintext or keys. The optional metrics endpoint
(`RELAY_METRICS_PORT`) binds loopback by default; setting
`RELAY_METRICS_BIND` to a network address requires `RELAY_METRICS_TOKEN`
(`Authorization: Bearer <token>`) — the relay refuses to boot an
unauthenticated metrics endpoint exposed to the network. The admission
ceilings (`RELAY_MAX_SOCKETS`, `RELAY_MAX_PER_ROOM`, `RELAY_MAX_FRAME_BYTES`,
defaults 1000 / 10 / 1000000) are env-configurable without recompiling and
validated fail-closed: a non-numeric, zero/negative, per-room-above-sockets
or above-16 MiB frame value makes the relay refuse to boot — reasons logged
once, exit 1, no listener. The same discipline applies to the TLS pair
(`RELAY_TLS_CERT` + `RELAY_TLS_KEY`): a mandatory pair, set both for direct
`wss://` termination or neither to serve plain `ws://` behind a proxy that
terminates TLS — one variable alone, a blank value, or an unreadable file
refuses the boot (reason cites the variable, never the path). The tuning
knobs (`RELAY_RATE_PER_MIN`, `RELAY_RATE_BURST`, `RELAY_MAX_PER_IP`,
`RELAY_TRUST_PROXY_HOPS`, `RELAY_PING_INTERVAL_S`) get the same discipline
(P2-171): a non-numeric, negative, fractional or zero value (zero stays valid
only for the proxy hops) or a value above the knob's documented ceiling makes
the relay refuse to boot — reasons logged once, exit 1, no listener — instead
of silently falling back to the default; an absent or blank variable keeps the
default. On `SIGTERM`
the drain is visible to the load
balancer (P2-145): `/healthz` answers `503` with `ok:false,draining:true`
and WebSocket upgrades are refused while the drain runs, so the balancer
stops routing new peers to the closing instance — the container
`HEALTHCHECK` therefore reports unhealthy during the drain on purpose.
`RELAY_DRAIN_GRACE_MS` (default `0`, max `2000`) delays the socket close
after the 503 so coarse-polling balancers have time to notice. The relay log
never records client addresses: the per-IP-cap rejection line carries
`ipTag`, an identifier derived per process (first 12 hex digits of
`sha256(salt || address)` with a random salt minted at boot) — two
rejections with the same tag inside one process come from the same origin,
the tag changes at every restart, and it cannot be reversed to the address
(P2-174). Log verbosity is env-tunable (`RELAY_LOG_LEVEL`, default `info`,
values `error`/`warn`/`info`/`debug` case-insensitive): only `debug` writes
the per-frame `frame in` line — keep it off on any public host, since a line
per routed message reconstructs who talked to whom and when out of retained
provider logs — and an unknown or non-string value refuses the boot (exit 1,
no listener) instead of silently falling back to the default (P2-177); the
`relay listening` line advertises the resolved level as an additive
`logLevel` field. The daemon
validates
`RELAY_URL` at boot and fails closed: only `ws://`/`wss://` URLs dial, and
plain `ws://` at a non-loopback host is refused — an invalid URL disables the
relay connection (reason logged once at boot and surfaced in `/api/health` as
an additive `relay` field) and withholds the pairing QR instead of serving one
the phone can never use; the desktop app's local mode doesn't depend on the
relay and keeps working. Runbook:
[docs/RELAY-HOSTING.md](docs/RELAY-HOSTING.md).

The image also serves the phone PWA itself (P2-188): it sets
`RELAY_WEB_DIR=/app/apps/web/dist`, so the URL you point a browser at the
relay delivers the app — the first step of the journey needs no dev server,
TLS origin or tailscale. Only static files are served (extension allowlist,
no traversal, no dotfiles, symlink-safe containment, SPA fallback to
`index.html`), the WebSocket routing and `/healthz` body are untouched, and
the static route answers `503` during the drain. A configured
`RELAY_WEB_DIR` whose directory is missing, not a directory, unreadable or
without a readable `index.html` refuses the boot — reasons logged once,
exit 1, no listener; unset keeps the old 404-for-everything behavior. An
incomplete bundle is caught too (P2-225): the boot verifies every local
script/style the entry document references exists and is readable next to
it, so a partial or stale volume-mounted copy exits 1 with a log line per
missing asset instead of serving a white screen — boot the container once
against the directory you plan to publish and confirm it reaches the
`relay listening` line. Every
200 document the static route serves is locked down (P2-192): a
same-origin-only `Content-Security-Policy` (inline style allowed — the
generated bundle injects style — plus `data:`/`blob:` images and
`wss:`/`https:` connects because the app dials the relay), `Referrer-Policy:
no-referrer` so the room URL never leaks as a referrer, `Permissions-Policy`
denying geolocation/payment/USB/serial/HID/MIDI, `X-Frame-Options: DENY`,
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Resource-Policy: same-origin` — and `Strict-Transport-Security`
only when the request actually arrived under TLS, since announcing HSTS on an
`http://` origin would lock out an operator still bringing the service up.
`RELAY_WEB_CSP` overrides the policy (must declare `default-src`, no control
bytes, ≤1024 chars — anything else refuses the boot, fail-closed); 404/405
and the `/healthz` bytes are untouched. The static route also has a
per-identity request budget (P2-195): every non-probe request spends one
token from a token bucket (`RELAY_WEB_RATE_PER_MIN=120`, `RELAY_WEB_BURST=60`,
both fail-closed with a `10000` ceiling), burst exhaustion answers `429` with
`retry-after` and the same security headers as the 200 documents, the
identity key is the P2-174 `ipTag` of the same proxy-hops-aware address the
upgrade path derives (never a raw IP), idle buckets are pruned by the
liveness sweep under a 4096-entry cap — and `GET /healthz` is never counted
nor barred, so a load balancer cannot be starved out of its own probe. Text
assets are also negotiated with gzip (P2-198): html/js/css/map/json/svg/txt/
webmanifest between 1024 bytes and 8 MiB are served `content-encoding: gzip`
when the client's `Accept-Encoding` allows it (quality zero and malformed
headers mean identity, the `*` wildcard counts as gzip), both variants carry
`Vary: Accept-Encoding`, the compressed bytes are memoized in memory capped
at 64 entries / 32 MiB (keyed by path + size + mtime, oldest discarded), and
`png`/`jpg`/`webp`/`ico`/`woff2` plus every body outside the size range stay
uncompressed — while the 404/405 answers and the `/healthz` probe remain
byte-for-byte as they were. Conditional requests close the loop (P2-200):
every 200 of the static route carries a strong `ETag` derived from the
negotiation's own stat plus the encoding — so the gzip and identity
validators always differ and a shared cache never serves compressed bytes to
an identity client — and a matching `If-None-Match` (list, wildcard `*`,
weak `W/` prefix ignored, malformed header means send) is answered `304`
with no body and no disk read, carrying the etag, `Cache-Control`,
`Vary: Accept-Encoding` and the P2-192 security headers but never
`Content-Encoding`/`Content-Length`/`Content-Type`; 404/405 and `/healthz`
keep byte-for-byte behavior and the request budget is still charged before
the conditional decision. The relay stays a blind router: no
plaintext, no keys, no room ids in any of it — only public static assets
from the allowlisted web root are ever cached or revalidated.

**Close-code-aware relay retries (P2-156)**: when the relay socket closes, the
daemon classifies the close code instead of treating every drop as a network
outage. `1013` (server busy / too many connections / room full) means the
relay is at capacity and floors the reconnect wait at 30s; `4029` (rate
limited) floors it at 60s; `1001` (draining) and `1000` reconnect on the
regular schedule; anything else (including an abrupt 1006-style drop) keeps
the P2-129 jittered backoff unchanged. The verdict shows up as additive
`closeCode`/`closeKind` fields on the `relay connection lost` log line and as
`lastClose: { code, kind }` inside `/api/health`'s `relayRetry` object — the
raw close reason is never exposed.

## CLI

```bash
node cli.mjs doctor    # full diagnostics: binaries, health, services, devices
node cli.mjs qr        # re-print the pairing QR
node cli.mjs status    # launchd services state + paired devices
node cli.mjs start     # restart services (relay + daemon + pwa)
node cli.mjs update    # pull, reinstall deps, restart — one-command upgrades
node cli.mjs token     # print the local HTTP API token
```

## HTTP API & SDK

Scripts and integrations can drive the agent on the same machine:

```js
import { createClient } from "@ocr/sdk";

const ocr = createClient({ token: process.env.OCR_TOKEN });
const { id } = await ocr.createSession();
const reply = await ocr.sendAndWait(id, "explain the auth module");
```

See [docs/api.md](docs/api.md).

JSON request bodies are capped at 1 MB by default (`OCR_MAX_BODY_BYTES`, up to
100 MB); oversized bodies answer `413`, and an invalid value makes the daemon
refuse to boot instead of silently using the default — see
[docs/api.md](docs/api.md#request-body-limit-p2-180).

Chunked uploads are bounded the same way (`OCR_UPLOAD_MAX_MB`, default 200 MB,
ceiling 2000): staged bytes per id, at most 8 concurrent ids, chunk index up to
100,000, staged ids expire after 5 minutes, and violations answer `400`, `413`
or `429` — see
[docs/api.md](docs/api.md#chunked-upload-staging-limits-p2-181).

The first pairing on a virgin daemon is only accepted while the **bootstrap
pairing window** is open: 15 minutes by default (`OCR_PAIR_WINDOW_MS`, positive
whole milliseconds, ceiling 24 h; an invalid value makes the daemon refuse to
boot). The window opens at boot and re-arms on every authenticated read of the
pairing screen, so the QR staying on screen keeps pairing available. Once the
window closed, unknown clients are rejected (audit event
`client.bootstrap-expired`) — reopen the pairing screen in the desktop app or
restart the daemon to pair a new device — see
[docs/security.md](docs/security.md).

## Architecture & security

- [docs/architecture.md](docs/architecture.md) — tunnel, chunking, services
- [docs/security.md](docs/security.md) — crypto, pairing, threat model
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/capacitor.md](docs/capacitor.md) — native iOS shell recipe

**Self-protecting identity file (P2-234).** `daemon.json` carries the machine
identity and the paired-devices list, so an unreadable file (truncated
pre-P2-165 write, full disk, failed manual edit) no longer crashes the daemon
with a raw syntax error that makes the machine vanish from the phone. The boot
refuses with one calm pt-BR line, moves the illegible file to a 0600
quarantine copy beside the original and exits with the documented code 78 —
nothing is deleted, the identity is never regenerated behind your back.
Restoring the quarantine file over `daemon.json` brings every pairing back;
deleting both files starts the machine over and requires pairing again. See
[docs/troubleshooting.md](docs/troubleshooting.md#the-identity-file-is-unreadable-p2-234).

## Pilot — autonomous development (24/7)

This repo evolves itself: the Pilot service ([docs/PILOT.md](docs/PILOT.md)) picks tasks from
[BACKLOG.md](BACKLOG.md), implements them with agents, has them reviewed by two independent
adversarial reviewer agents, and only merges when the deterministic gatekeeper (eval battery +
[executable constitution](docs/CONSTITUTION.md)) is fully green. Deploys are staged with health
watch and automatic rollback. Freezing: `touch ~/.opencode-remote/pilot.lock`.

## Desktop app (early)

The first stage of the [desktop vision](docs/VISION.md): an Electron shell
([`apps/desktop`](apps/desktop)) that opens the cockpit in a native window,
with a tray icon, native menus and a sandboxed renderer — no terminal, no
Tailscale. It loads the same `@ocr/web` build as the phone.

The shell runs on **Electron 44** (Chromium 152, V8 15.2, Node 24.18.1),
which requires **macOS 13 (Ventura) or later**.

Since P2-178 every external open goes through a single gate: only `http`,
`https` and `mailto` links are handed to the OS browser/app handler.
`file`, `javascript`, `data`, `blob` and any other scheme are refused on
purpose (the refusal is logged as scheme + reason only, never the URL).

P2-184 extends the same policy to the Browser pane itself: it speaks only
**http** and **https**. Navigations that start inside the pane — redirects,
meta refreshes, clicked links — are refused on purpose for every other
scheme (`file`, `javascript`, `data`, `blob`, custom app schemes), and the
guest's web preferences are forced in the main process (context isolation +
sandbox on, node integration off, no renderer-declared preload), so a page
opened there can never render local files or grant itself privileges.

Since P1-046 the window is a real two-column cockpit: the conversation stays
open in the left column while Artifacts, Browser, Files or Settings open in a
contextual pane on the right (switching panes never destroys the chat), and
the whole navigation lives behind a single view stack. Keyboard shortcuts
(also in the **Ir** menu): `Cmd+T` new conversation (**Nova conversa**),
`Cmd+K` command palette (**Paleta de comandos** — searches conversations and
actions), `Cmd+1..6` switch to chat / Artifacts / Browser / Files / Settings /
Mission Control. The native menu is Portuguese since P2-176 (matching the UI
copy), including a **Ajuda** menu with **Verificar atualizações**, **Abrir
pasta de logs** and **Copiar diagnóstico** — the tray's support actions,
reachable from the menu bar too (the update items appear only when an update
feed is configured).

**Right-click menu (P2-235)**: right-clicking the window opens a native
context menu with the lay-user basics — **Recortar / Copiar / Colar / Selecionar
tudo** in editable fields, **Copiar** for selected text anywhere, **Abrir link /
Copiar endereço do link** for links (opening follows the same
http/https/mailto scheme gate as every other external open — a refused scheme
offers only "copy address", never "open") and up to four spelling suggestions
for a misspelled word. Dev (unpackaged) builds also offer **Inspecionar
elemento**; packaged builds never do. When there is nothing to act on, no menu
opens at all. Automated test sessions never open the menu — a native popup
would steal focus from the gate (same harness-session rule as every other
native surface).

**Living home (P2-123)**: with no conversation selected the cockpit shows a
real home instead of a dead end — a serif greeting ("Back in action, &lt;machine&gt;",
from the same EN/pt-BR dictionary), a central composer with placeholder, a
Chat/Cowork mode toggle (Cowork pre-selects the `build` agent for the next
session), the model selector and a working press-and-hold mic (dictates into
the composer via the same transcription flow as the chat mic) on the bottom
row, and three clickable "Ideas for you" that open a new session with the
prompt pre-filled (failure surfaces an inline error, never a frozen screen).

**Design tokens & reading typography (P3-083)**: the conversation column is
capped at ~46rem and centered like the Claude Desktop benchmark, with a
purposeful type scale (15–16px body, 1.65 line-height), motion standardized
on 150/300ms ease-out tokens (fully disabled under `prefers-reduced-motion`,
including programmatic scrolls) and a six-step dark-gray ladder where every
step has one role — canvas, chrome, raised surface, hover, resting and active
borders. All color/type/spacing/motion literals live in `apps/web/src/tokens.css`.

**Benchmark conversation list & ⌘K (P3-084)**: the sidebar groups conversations
into **Today / Yesterday / Earlier** (bounded by local calendar midnights, so
DST-change days group correctly), the open conversation gets a sharp active
state (tinted row + accent bar), truncated titles ellipsize with a full-name
tooltip, and hovering a row reveals **rename** and **archive** actions in the
timestamp's slot. Archiving is per-device (localStorage) and reversible —
archived conversations move to a collapsible "Archived" group at the end of
the list (hidden on the phone board too, with a restore action in the group).
The `Cmd+K` switcher now shows the **last known message line** under each
conversation in the search results.

**Claude-level sidebar shell (P2-124)**: the desktop sidebar is a 280px
navigation shell — a full-width **"+ New"** primary button and the section nav
(Conversations, Artifacts, Browser, Files, Mission Control, Settings —
consistent SVG icons, zero emoji) pinned to the top, the grouped conversation
list (search + badge filters + Today/Yesterday/Earlier) in the middle, and a
fixed **account footer** at the bottom showing the machine avatar/initial,
name and connection mode ("Local · this machine" / "Remote · paired"). The
footer opens the machine picker, the same overlay as the mobile header.

**Degraded first boot (P2-112)**: when the local daemon is unreachable on
first launch, the app no longer dead-ends on the pairing screen. A calm status
card — "Connecting for the first time…" for a daemon this machine has never
met, never a red "daemon fell" alert — explains that conversations, files and
artifacts sync as soon as the daemon answers, shows the automatic retry, and
keeps the purely-local data (language, theme) working. "Reconnect now" gives
real feedback (spinner + trying state + result toast), and manual pairing
stays one click away.

**First-run welcome (P2-148)**: the very first desktop launch walks through
three steps — what the app is (one sentence), the local agent's live state
(reusing the calm degraded-journey copy and the P2-138 upstream notice), and
the phone-pairing invitation with an explicit "do this later". It is skippable
at any moment; finishing or skipping stamps a flag in the renderer's
localStorage (no IPC, no main-process change), so existing users — including
everyone upgrading with a stored pairing — never see it. It renders as a
single full-screen surface: no banners, no pairing overlay (P2-108 rule).

**Upstream notice (P2-138)**: the daemon can be healthy while the agent server
it proxies is not (`opencode serve` not installed, wrong port, changed
password). `/api/health` carries the classified verdict (`opencode.state`:
unauthorized / unreachable / timeout / unhealthy) and the desktop shell
forwards it to the renderer over the same channel as the version fields. The
calm first-boot card and the new **Agent server help** section at the top of
Settings then say exactly what happened and what to do — as one block inside
an existing surface, never a second banner — with a secondary button that
opens that help section straight from the first-boot card. The daemon's own
reason/hint strings render as secondary text only; no tokens or secrets are
ever part of the displayed copy.

**Benchmark pairing journey (P2-106)**: the manual pairing screen is a narrow
(~420px), vertically centered column with a one-sentence intro and two titled
sections — **Connect to another machine** (scan/paste, this device as client)
and **Pair a phone with this machine** (host entry). An invalid pairing code
renders a styled error block with an inline helper showing the expected
`opencode-remote://pair?…` format (announced to screen readers), and on the
first-run QR splash "Pair later" is now a quiet text link — the QR is the only
primary element on that screen.

**Auto-preview (P1-072)**: when the agent brings up a local site (http.server,
vite, a dev server…) and mentions `http://localhost:<port>` in its reply, the
Browser pane opens by itself next to the chat, pointed at that URL, rendered
as a real sandboxed webview — scroll, click and form edits are live. The URL
bar is editable, `↻` reloads, `⤢` toggles the pane to ~80% width and back, and
`←` returns to the chat. A load failure shows an error and the reload button
instead of a blank pane.

**Mission Control** (Cmd+6) is a navigable post-mortem of the pilot's
autonomous runs: one card per agent task (goal, progress, wall-clock effort,
ETA while running) parsed from the real `pilot.log`/`events.jsonl`, plus a
forensic timeline per task — every builder decision, reviewer verdict, gate
failure (with output tail) and deploy navigable, the post-deploy screenshots,
a live dashboard shot via the browse surface, and a **Take over** button that
attaches Terminal to the agent's own opencode session for human handoff.

**Unread badge (P3-053/P2-150)**: when a message lands in the open conversation
while the window is in the background — or while you are scrolled away from
the tail — the app icon shows the indicator: a count on the macOS dock / Linux
and a green overlay disk on the Windows taskbar icon. Focusing the window or
jumping back to the tail clears it.

```bash
npm run build --workspace @ocr/web       # build the UI once
npm run build --workspace @ocr/desktop   # compile the shell (TypeScript main process)
npm start  --workspace @ocr/desktop      # open the window
npm run dist --workspace @ocr/desktop -- --dir  # package web UI + daemon sidecar
```

During web development, point the shell at the Vite dev server:
`OCR_WEB_URL=http://localhost:5173 npm start --workspace @ocr/desktop`.
`npm run dist` is self-sufficient: it builds the web UI and the shell
(TypeScript + daemon bundle) before packaging, so the command also works on a
clean checkout.

**Packaging (P1-050)**: `npm run dist --workspace @ocr/desktop` now also
produces distributable DMGs — **`OpenCode-Remote-<version>-arm64.dmg`** and
**`OpenCode-Remote-<version>-x64.dmg`** (P2-191: both architectures declared
in the electron-builder mac targets; the branded
installer window, semantic version in the About panel and in the DMG file
name) — and `npm run dist:smoke --workspace @ocr/desktop` verifies the
bundle **and** the DMG artifact. Local builds are ad-hoc signed with hardened
runtime and the shared entitlements (`build/entitlements.mac.plist`) — on
first launch, right-click → **Open** once to pass Gatekeeper; afterwards the
app behaves like any installed app. P2-169: the first time you record a voice
message or scan the pairing QR, macOS asks for **microphone** and **camera**
permission — grant both, or the signed build silently blocks those features
(denied by mistake? System Settings → Privacy & Security → Microphone /
Camera → enable **OpenCode Remote**, then reopen the app). P2-182: the shell
grants **camera, microphone and fullscreen only to its own interface** — any
page loaded in the Browser pane has every permission request (camera,
microphone, geolocation, notifications, MIDI, HID, serial, USB…) **denied on
purpose**, so a third-party site can never trigger an OS permission prompt in
the app's name. Tag releases ship both DMGs, the per-arch zips,
`latest-mac.yml` and the update feeds on GitHub
(`.github/workflows/release.yml`); the release's
signing preflight notarizes only when a Developer ID certificate and the
Apple credentials are actually configured (see *Desktop app installer*). The
same release pipeline ships the **Windows NSIS installer**
(`OpenCode-Remote-Setup-<version>.exe` + `latest.yml`) from a `windows-latest`
runner — unsigned (SmartScreen, see the Windows section above) until the
`WIN_CSC_*` signing secrets are configured; the smoke check validates the
setup exe and the metadata on any OS, no Windows required.

**Auto-updates with consent (P1-050)**: the packaged shell checks the daemon's
loopback updates folder (`http://127.0.0.1:8792/__ocr/updates/` — a versioned
folder served by the same local daemon, no new network surface) at boot and on
demand from the tray (**Check for updates**). P2-155: while the app stays open
(even with the window closed to the tray) it also rechecks on its own roughly
every 6 h — ±10% jitter — and backs off from 15 min up to the 6 h cap while
the feed is unreachable. P2-098: when that staged feed is
absent — the normal case on a plain DMG install — the shell falls back to the
public yml feed attached to the latest GitHub release, so the tray still
reports "update available" on third-party machines. P2-131: that fallback is
platform-aware — a Squirrel.Mac JSON feed on macOS, `latest.yml` on Windows,
and no feed at all on other platforms (the whole check stays `disabled` with
zero network requests there) — and `OCR_PUBLIC_UPDATE_FEED` remains an
absolute override that ignores both the platform and the architecture.
P2-191: on macOS the feed file follows the architecture the app runs as —
`update-mac-arm64.json` on Apple Silicon, `update-mac-x64.json` on Intel, and
the legacy `update-mac.json` (arm64 content) for anything else — so an Intel
Mac can never be handed the arm64 zip. The two platforms update differently: on
**macOS** the public fallback is a real Squirrel.Mac JSON feed (P2-146), so
the release downloads in the background and the consent dialog applies it —
the download only completes on a Developer ID signed build (P2-136), while
ad-hoc signed installs stay manual; on **Windows** there is no
download engine yet (Squirrel.Windows support pending), so a yml feed resolves
to `update-available-manual` and an explicit **Check for updates** click opens
the release page — at most once per version per session, and never
automatically at boot (the boot decision is log/tray only, P2-131) — nothing is
downloaded or installed behind your back. The fallback triggers for
the packaged default only — a feed pointed at explicitly via `OCR_UPDATE_FEED`
never produces an outbound request behind your back. When a newer `feed.json`
is found on macOS, the release downloads in the background and a consent dialog
offers **Restart now / Later** — nothing installs without an explicit click, a
deferred version is not re-offered during the session, and repeated checks
never stack stale offers. Staging a release is a plain copy:
drop `<version>/` with the artifact under `~/.opencode-remote/updates/` and
rewrite `feed.json` (see `docs/troubleshooting.md`). P2-161: the port recorded
in `feed.json`'s absolute loopback `url` is resolved when the route serves the
document, not when the release is staged — after a fallback-port boot
(8793–8796) the daemon retargets the url at the port it actually bound, so the
feed is found and the download lands; artifacts (`zip`, `dmg`, `exe`, `yml`,
`blockmap`) are streamed verbatim and `latest.yml` is never rewritten (its
`path` field is relative to the feed's own address). Dev runs stay opt-in via
`OCR_UPDATE_FEED`.

**Crash reports & diagnostics (P1-050)**: fatal main-process errors and
renderer crashes land as timestamped files under
`~/.opencode-remote/pilot/client-logs/` (newest 20 kept). Settings gains a
**Diagnostics → Copy diagnostic** card that puts a support bundle on the
clipboard — app/electron versions, platform, daemon state, the last desktop.log
and daemon-sidecar.log lines (20, P2-163) and the crash-file names. No
secrets: the apiToken, allowlist and pairing URI are never included (the
sidecar log is already redacted on disk).

**One shell per userData (P2-069)**: launching the app while an instance is
already running simply focuses the existing window — a second copy never
paints its own (possibly white) window. Every boot writes an instance record
into its `userData`; if an older instance of the *same* userData is still
alive with an earlier start, the new boot logs a `possible zombie instance`
warning to `desktop.log` so a leaked shell (e.g. one whose keeper/parent died)
is diagnosable from the **Open logs folder** item. Hermetic harness launches
(`tools/desktop.mjs`) additionally watch the keeper's pid and quit by
themselves when it disappears, so killed test runs can no longer leak
Electron instances.

The desktop shell boots the daemon as a **sidecar**: on launch it spawns the
daemon — in packaged apps a single-file CJS bundle shipped at
`resources/daemon/index.js` (built with esbuild during `npm run build`; the
`/dashboard` route is served from a `dashboard.html` shipped next to it, since
the CJS bundle has no `import.meta`; dev checkouts run the TypeScript source
via the workspace `tsx` install, and `OCR_DAEMON_ENTRY` overrides both) — waits
for `GET 127.0.0.1:8792/api/health`
to answer **with an authenticated 200** before showing the UI, and terminates
the child on quit. The health probe challenges the responder unauthenticated first and only
sends the bearer token to something reproducing the daemon's 401 signature, so a
generic 200-anywhere process squatting on the port is never trusted nor fed the
token. A daemon already on the port (launchd/CLI install) is reused only when
the 0600 state file yields the token that proves its identity — otherwise the
shell spawns its own. Override the port with `OCR_DAEMON_METRICS_PORT` (falls
back to `OCR_METRICS_PORT`); the spawned child binds exactly the port the shell
polls. The dashboard HTML never carries the apiToken: authenticate with the
token box (or `?token=`, stored in localStorage) or exchange the Bearer token
once via `POST /api/session` for a 12-hour HttpOnly `ocr_session` cookie that
authorizes `/api/*` until the daemon restarts.

**Honest agent-server health (P2-135)**: `/api/health` keeps the legacy
`opencodeHealthy` boolean and now also exposes an additive `opencode` object —
`state` (`unknown` until the first probe, then `ok`, `unauthorized`,
`unreachable`, `timeout` or `unhealthy`), a short `reason`, an actionable
pt-BR `hint` and the `checkedAt` timestamp of the last probe. The classifier
distinguishes what used to collapse into one generic failure: server not
installed, wrong port, refused token (401) and a slow/hung server now each
carry a specific reason. Since P2-149 the `opencode` object also carries
`binaryFound` and `binarySource`: `binaryFound` is true when an executable
`opencode` binary exists on this machine (resolved from `PATH` plus known
install locations once at boot, refreshed at most once a minute while the
upstream is unreachable), and `binarySource` is `"path"`, `"known"` or `null`
depending on where it was found — so a refused connection reads as "start the
server" when a binary exists and as "install opencode first" when it does not.
No absolute path, token or password ever appears in `reason`, `hint` or the
payload — only the boolean and the origin. The "opencode is DOWN" push uses the
classifier's hint as its body (prefixed with the machine name), so the phone
tells you what to do instead of repeating a fixed phrase. The full contract
lives in `docs/api.md`.

**Zero pairing on the host machine**: the desktop shell treats the daemon on
the same machine as one trust domain (loopback, same user, 0600
`daemon.json`). If that daemon proves healthy at boot — the shell's
anti-squatter 401 challenge followed by an authenticated 200 — the app opens
straight into the chat: no pairing screen, no QR, nothing to scan (P1-070).
The QR ceremony only exists for remote clients: it appears when no local
daemon is reachable, or on demand via **Settings → Pair a phone (remote
device)** or an `opencode-remote://` deep link. When a phone still needs to
pair on first run, the QR opens with a proper **welcome splash** (pt/en): the
product value up front and a three-step onboarding promising the first real
value in under a minute. The manual QR/paste screen remains as a fallback
(machines switcher → add machine). On the desktop, **paste/deep-link is the
primary path** — pointing a camera at another screen is a circular flow — and
the in-app scanner is a visible state machine (looking → live preview →
unavailable) that always offers the paste fallback; an empty camera feed
(capture device with no signal) resolves to the unavailable state instead of
rendering the device's own OSD placeholder.

**Direct local connection (P1-061)**: on the host machine the desktop app
skips the relay entirely — it dials the daemon's loopback WebSocket
(`ws://127.0.0.1:8792/ws`, authenticated with the local token from the 0600
state file). Deploy kickstarts of the relay no longer interrupt a running
session, and after any reconnect the open conversation is refetched so
messages produced during the gap show up without a resend. Remote access
(phone, away from home) keeps using the relay as before; the current wire is
shown in Settings → About ("Connection: direct (local) / via relay").

**Pairing deep links**: the packaged desktop app registers the
`opencode-remote://` protocol with the OS (macOS/Windows). An install or
invite page can open the app with an `opencode-remote://pair?v=2&…` link and
it pairs itself through the same path as pasting a code — no QR scan. Links
are validated in the shell (pair action, protocol version 2, query capped at
4 KB, safe character set) and everything else is ignored. The registration
only happens in the packaged app; a dev run never claims the OS handler.

**Self-healing sidecar**: if the spawned daemon dies at runtime (crash, OOM,
stray kill), the shell respawns it automatically with a growing backoff —
5s, then 15s, then 45s. The failure counter resets as soon as `/api/health`
answers 200 again, so an isolated crash never escalates. After 3 consecutive
failed attempts the shell gives up (logging
`[desktop] daemon sidecar gave up after 3 attempts`), shows a persistent
"local daemon is down" warning in the UI through the pairing-state channel,
and an authenticated daemon that appears on the port (e.g. a launchd install)
is adopted instead of spawned on top of. Restarting the app always resets the
cycle — and the tray's **Restart daemon** action (below) does the same without
relaunching.

**Honest degradation when an adopted daemon vanishes**: when the shell reuses
an external daemon (a launchd/CLI install already answering on the metrics
port) there is no child to respawn and no budget to exhaust — losing it is
never terminal. The shell probes the daemon with an infinite backoff
(5s → 15s → capped at 30s) and the UI shows a yellow
"Reconnecting to daemon… (n)" banner (`role="status"`) with the attempt
counter; no QR overlay can open from this state and no child is ever spawned
against the external supervisor. When the daemon answers again, the banner
disappears and the previous session is picked up with **no re-pairing** — the
desktop never rewrites the 0600 state file and never adds allowlist entries.
The red "daemon is down" banner is now only for the hosted sidecar give-up
case and carries a **Reconnect now** button wired to the same restart as the
tray action — so a daemon `kickstart`d by a deploy no longer leaves the app
stuck on the pairing screen.

**Wake-from-sleep reaction**: when the machine returns from sleep and when the
session unlocks (macOS/Windows `powerMonitor` events), the shell reacts
instead of waiting for a backoff that may already be exhausted: if the daemon
answered healthy at the last poll, an immediate health probe confirms it; if
the sidecar's respawn budget is exhausted — or the retry the backoff scheduled
sits more than 30 s away — the daemon is restarted on the spot (the same
restart the tray action uses); everything else probes immediately too. Each
event is handled at most once per 10 s window — repeat events inside the
window are dropped silently, so waking up never floods the log — and each
handled event writes exactly one `[desktop] wake event (…)` line with the
action and the reason. Platforms without the OS signal keep the previous
behavior unchanged, no new periodic probe is introduced, and pairing is never
touched by a wake: no re-pairing, no allowlist or state-file writes.

**Daemon/app version mismatch banner**: because the shell adopts an external
daemon (launchd/CLI install), it can end up talking to a daemon older than the
app itself — the symptom for a lay user is random breakage, not a clear
message. The shell now reads the daemon's version from the same authenticated
`/api/health` probe it already uses and, when the daemon's major differs from
the app's or the daemon is simply older (a `-dev` suffix is tolerated, a daemon
minor ahead is fine), shows a non-blocking yellow strip: "Daemon vX · app vY —
reinicie o daemon" ("restart the daemon"), with the same **Reconnect now**
one-click recovery button. Compatible versions render nothing, and a browser
without the desktop bridge is never affected.

**Crash-proof shell**: a renderer crash no longer leaves a dead white window —
the shell logs the crash reason and reloads the UI automatically (bounded to
3 reloads per minute so a page that crashes on boot cannot become a reload
loop). And if the main process itself hits an unexpected exception, the app
now quits gracefully: the error is logged with its stack and the exit runs the
normal quit path, which stops the daemon sidecar cleanly instead of orphaning
it.

**Tray: daemon health + start at login**: the tray tooltip doubles as a
sidecar health indicator — it reads `OpenCode Remote — daemon ok` /
`OpenCode Remote — daemon down`, refreshed by the same 3s poll that feeds the
pairing overlay. The context menu also has a **Start at login** checkbox
(macOS/Windows) backed by `app.setLoginItemSettings`, so the toggle persists
across app restarts and OS reboots; since P2-218 a packaged build turns it on
by itself on the very first boot (the phone must keep finding this machine
after a reboot) and unchecking it in the tray is definitive — no future boot
re-enables it. Right below **Open OpenCode Remote** sits
an always-present **Restart daemon** action: it cancels any pending respawn,
resets the crash budget, stops the daemon the shell spawned and starts it
again — the one-click recovery when the sidecar gave up ("daemon down") or an
adopted daemon turned unstable, no quit-and-relaunch needed. The action is
best-effort: it is a no-op with a clear log line when no daemon was ever
started, and any failure is logged without taking the shell down. An
**Open logs folder** item (just above **Quit**) creates the logs folder if
needed and reveals it in the OS file manager — the lay-user entry point into
the persistent shell log described below. The
menu-bar glyph is a monochrome
template image (`apps/desktop/build/trayTemplate.png`, generated by
`make-icon.mjs` alongside the app icon) that macOS recolors to match the
light/dark menu bar, degrading to an embedded 16px glyph when the asset is
unavailable.

**Native notification when the daemon stops**: if the sidecar's respawn budget
is exhausted, the shell fires a one-time native notification —
`daemon parou — use "Reconectar agora" no OpenCode Remote` — and
`daemon de volta` when a
healthy daemon answers again. Each transition notifies exactly once (deduped
by the same 3s poll that feeds the tray tooltip) and the feature is
best-effort: on platforms without notification support the shell keeps
running silently, and with the window closed to the tray this is how a
non-technical user finds out control was lost. On Windows the shell also
registers its AppUserModelID at boot (`com.culturabuilder.opencode-remote`,
matching the packaged appId) — without it win32 toasts are silently dropped
by the OS, so this is what makes notifications functional there.

**Close-to-tray keeps the daemon alive**: closing the window (red button,
`Alt+F4`) no longer quits the app — on every platform the window hides and the
daemon sidecar keeps running, so the phone never loses its connection just
because the window went away. Reopen the window from the tray
(**Open OpenCode Remote**) or by launching the app again. The first time the
window is closed, a one-time native notification says the app keeps running —
in the menu bar on macOS, in the system tray on Windows/Linux — and how to
reopen it; it is shown once and never again.

**Global shortcut to reopen the window (P2-229)**: a system-wide key
combination brings the window back from anywhere — `Command+Shift+O` on macOS
and `Ctrl+Shift+O` on Windows/Linux. It runs the same show-and-focus path as
the tray click, so a window closed by mistake needs no tray-icon hunt. The
Help menu and the tray show the active combination as a disabled line — or
the reason none is registered, never a lying shortcut. Choose another
combination with `OCR_DESKTOP_HOTKEY="Ctrl+Alt+R"` (at least one modifier is
required; an invalid value registers nothing instead of silently falling back
to the default) or turn the feature off with `OCR_DESKTOP_DISABLE_HOTKEY=1`.
If another application already owns the combination, registration fails open:
one line in the desktop.log and the tray keeps working. Automated test
sessions never register a global shortcut — a test run must not steal
system-wide keys.

**Quitting asks when the phone would lose access (P2-221)**: **Quit** in the
tray menu and **Encerrar OpenCode Remote** in the app menu (or `Cmd+Q`) are a
real quit with full daemon cleanup — and since the app now opens at login
(P2-218) precisely so the phone always finds this machine, that quit is the
one silent way to cut the phone's remote access. So when a packaged build with
a healthy daemon and a paired phone quits, one native confirmation asks first,
with three exits: **Sair** (quit for real), **Continuar na bandeja** (the app
stays alive and the phone keeps access) and **Não perguntar de novo** (quit
now, and every future explicit quit is silent — the choice is definitive and
recorded only as a boolean flag in `userData`). Quitting never asks when
there is nothing to lose: dev builds, an unhealthy daemon, no paired phone, or
a recorded choice. The verdict and its reason ride the desktop.log
(`[desktop] quit confirm: …`) and the diagnostics bundle (`quit confirm:`) —
never with paths or tokens. Two test-only hatches keep the flow deterministic:
`OCR_DESKTOP_FORCE_QUIT_CONFIRM=1` forces the confirmation and
`OCR_DESKTOP_QUIT_DIALOG_ANSWER=quit|stay|never` answers the box in place.

**Frozen window warns instead of staring silently (P2-223)**: when the app
window stops responding, the shell says so — first a calm notification
("the window stopped responding; it may recover on its own"), and if the
freeze keeps going a native box offers **Recarregar** or **Aguardar**.
Reloading does not lose the conversation (it lives in the daemon). The
verdict, its duration and outcome ride the desktop.log
(`[desktop] hang watch: …`) and the diagnostics bundle (`last hang:`). Test
sessions never see the box, and `OCR_DESKTOP_HANG_DIALOG_ANSWER=reload|wait`
auto-answers it for deterministic flows.

**Real app icon + About panel**: the shell ships a real 512×512 icon
(`apps/desktop/build/icon.png`, generated by the zero-dependency script
`apps/desktop/scripts/make-icon.mjs`) — used by `electron-builder` for the
packaged app on macOS/Windows/Linux, as the window icon (Windows/Linux), the
macOS dock icon, and the About panel shows the app name plus the actual
version (`About OpenCode Remote`). Regenerate the icon after tweaks with
`node apps/desktop/scripts/make-icon.mjs`.

**The window remembers its size and position**: move/resize the window, quit
and reopen — the bounds are restored. They live in
`userData/window-state.json`, written on close, and are validated against the
displays currently attached at boot: a window left on a since-disconnected
screen (or a corrupted state file) falls back to the 1280×820 default instead
of opening off-screen or crashing. Quitting while maximized also reopens
maximized (P2-172) — the normal rect plus the maximized flag are persisted, so
a maximized session never comes back as a screen-sized window stuck to the
desktop. Fullscreen is deliberately not persisted (on macOS it creates its own
Space; restoring it standalone would be hostile).

**Persistent shell log**: the desktop app appends everything the main process
logs (`[desktop] …` lines: daemon sidecar lifecycle, pairing polls, renderer
crashes, fatal errors) to `userData/logs/desktop.log` — so a packaged app used
by someone without a terminal still has a diagnosable trail. The file is
capped at ~1MB and rotates to `desktop.log.1` (only 2 files kept); if the disk
is full the app keeps running and simply stops writing log lines. To find the
folder, use the tray's **Open logs folder** item (it creates and reveals the
folder even if it was deleted); on macOS it is
`~/Library/Application Support/OpenCode Remote/logs/`.

**Daemon sidecar log**: the daemon the desktop app spawns writes its JSONL
output to the same `userData/logs/daemon-sidecar.log` (rotating to
`daemon-sidecar.log.1`, ~1MB cap, 2 files kept — write failures are silently
ignored). In the packaged app the daemon's stdout/stderr used to be forwarded
to a console that does not exist; the tray's **Open logs folder** item now
logs which file holds what. Before anything is written, a line redactor
replaces every pairing URI with `[pairing-uri redacted]` and drops the boot
QR block, so this file is safe to attach to a bug report — it never contains
the credential that could pair a new device with your machine.

**First-run QR for your phone**: the first-run overlay with a scannable pairing
QR (rendered by the main process from the daemon's `GET /__ocr/pairing-uri`, a
read-only loopback route gated by the same bearer token) is reserved for remote
clients — it appears when no local daemon is reachable, or on explicit request
from **Settings → Pair a phone (remote device)** (P1-070). The shell polls the
allowlist every 3s — once a phone pairs the overlay leaves and the chat
appears. "Pair later" dismisses it for the session.

**Staged update feed (spike P2-012, real flow since P1-050)**: the shell checks
for updates against a static feed you host — a loopback URL is enough. The
check runs at boot and on demand from the tray, and only acts when a feed is
configured: an explicit `OCR_UPDATE_FEED` (dev/staging) or, in packaged builds,
the daemon's loopback updates folder by default:

```bash
OCR_UPDATE_FEED=http://127.0.0.1:9310/feed.json npm start --workspace @ocr/desktop
```

The feed directory can contain an electron-builder-style `latest-mac.yml`
(`version: 0.2.1` + fake release notes) or a Squirrel.Mac JSON feed (`feed.json`
with `url`/`name`/`notes`) — both are parsed and a newer release is logged as
`update-available`. For JSON feeds the release is also handed to Electron's
built-in `autoUpdater` (`setFeedURL` + `checkForUpdates`, `serverType: "json"`),
which downloads it in the background. yml feeds have no download engine (the
built-in updater cannot read `latest-mac.yml` — spike finding): since P2-131
they resolve to the dedicated `update-available-manual` status, and the release
page opens via `shell.openExternal` only when the user explicitly clicks
**Check for updates** — never automatically at boot, and at most once per
version per session. GitHub-hosted feeds point at the repo's releases page;
self-hosted `OCR_PUBLIC_UPDATE_FEED` overrides point at the feed's own
directory (where the artifacts live). `setFeedURL` is only ever called on the
JSON feed path. Feed or network
failures are strictly log-only and never block or crash the window.

Whenever a feed is configured, the tray menu also gains two items (P3-019): a
disabled status line reflecting the latest check ("Update available — check for
updates", "Update available — open release page", "Update ready — restart to
install", "Up to date", or the failure reason) and a clickable "Check for
updates" item that re-runs the check and refreshes the menu in place. Since
P2-176 the app menu's **Ajuda** submenu mirrors both items (rebuilt on every
status change, so its label never goes stale). Applying
a release always goes through the consent dialog (P1-050): the updater asks
"Restart now / Later" once the download finishes — a deferred version is not
re-offered in the same session. On macOS the packaged shell updates itself
this way, and the same Squirrel JSON feeds are published on every GitHub
release (per architecture since P2-191: `update-mac-arm64.json` /
`update-mac-x64.json`, with `update-mac.json` kept as the arm64 alias; built
by `apps/desktop/scripts/update-feed.mjs` from the packaged `latest-mac.yml`
+ mac zips — P2-146) so third-party installs
auto-update too, but only when the app is Developer ID signed (P2-136):
Squirrel.Mac rejects an update whose signature does not match the installed
app, so ad-hoc builds keep the manual release page. On Windows (no
Squirrel.Windows integration yet) the shell opens the release page instead of
downloading anything (P2-131).

## Roadmap

Next up: onboarding wizard, skills sharing, native iOS push.

## License

Open core, chosen so the community gets the client and the business gets the
service:

| Part | License | Why |
|---|---|---|
| `apps/relay` (the hosted side) | **AGPL-3.0-only** | anyone hosting it for others must ship their source — no parasitic SaaS |
| `apps/daemon`, `apps/web`, `cli.mjs`, `tools/` | **AGPL-3.0-only** | the product stays open and self-hostable, forever |
| `packages/sdk`, `packages/protocol` | **MIT** | build integrations and products on top, no strings |

Your own deployments, forks and internal use are unrestricted either way —
AGPL only bites if you offer the software as a network service to third
parties and withhold the source.

---

🇧🇷 Este projeto também fala português: [README.pt-BR.md](README.pt-BR.md)
