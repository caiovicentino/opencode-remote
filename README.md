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
  session has no title yet); a fresh conversation shows a welcome empty state
  with quick tips (audio, photo or text)
- **AutoMode** — the agent runs hands-free; every auto-approved action is
  audited and pushable
- **Approval preview** — permission cards show the first lines of the
  command/patch being requested (from the permission event payload) before
  you Approve/Deny, so you always know what you're green-lighting
- **Interactive questions** — the model asks, you tap an option from the beach
- **Rewind** — go back to any point of the conversation *and* the code, one tap
- **Voice** — hold to talk, local whisper transcription, no cloud
- **Files** — upload from the phone, preview anything, export a conversation
  as markdown with one tap; every file card has a ⧉ button that copies the
  file's full path (Clipboard API with an execCommand fallback)
- **Handoff** — continue the exact session on your Mac (💻 button)
- **Live board** — every session's state at a glance: working, waiting for
  your approval, asked a question, done, errored; cards show relative
  last-activity time (`5m`, `2h`, `3d`); sessions are sorted by most recent
  activity first
- **Session filters** — chips above the search (All / With badge / No badge)
  narrow the board to sessions with or without an unread badge
- **Routines** — real cron: daily, specific weekdays, or interval loop
- **Secure by construction** — passkey (WebAuthn) gate, ECDH P-256 + AES-256-GCM,
  replay protection, device allowlist, audit log, biometric unlock
- **BYOM** — opencode supports any provider; pick the model per session
- **API + SDK** — drive sessions from code (`packages/sdk`)
- **Artifacts** — the agent writes documents (html, md, csv, pdf) to
  `~/.opencode-remote/artifacts/<sessionId>/`; the desktop app gains an
  **Artifacts pane** that lists and renders them in-app (sandboxed html,
  markdown/tables, inline PDF) and chat messages that mention an artifact get
  an attached card; on viewports ≥ 900 px wide, clicking the card opens the
  preview in a **side-by-side pane** next to the chat (draggable divider, chat
  stays visible and navigable — Claude/Codex style), while narrower screens
  keep the full-screen overlay; also listed programmatically via `GET /api/artifacts`
- **Desktop shell (early)** — Electron app wrapping the same UI, with tray and native menu;
  includes a **Browser pane** that drives a headless Chromium on the host through the daemon
  (`/api/browse` — navigate, click, extract text, screenshot) so agents can visually validate
  their own UI output
- **Consistent icon language** — every chrome icon (desktop nav rail, tab bar, chat header,
  artifact cards, status dots) is the same inline-SVG stroke set on top of CSS design tokens;
  no emoji as icons, and the missing `--panel`/`--bg2`/`--fg` tokens are now defined so the
  light theme renders correctly in the desktop shell

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

## CLI

```bash
node cli.mjs doctor    # full diagnostics: binaries, health, services, devices
node cli.mjs qr        # re-print the pairing QR
node cli.mjs status    # launchd services state + paired devices
node cli.mjs start     # restart services (relay + daemon)
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

## Architecture & security

- [docs/architecture.md](docs/architecture.md) — tunnel, chunking, services
- [docs/security.md](docs/security.md) — crypto, pairing, threat model
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/capacitor.md](docs/capacitor.md) — native iOS shell recipe

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

```bash
npm run build --workspace @ocr/web       # build the UI once
npm run build --workspace @ocr/desktop   # compile the shell (TypeScript main process)
npm start  --workspace @ocr/desktop      # open the window
npm run dist --workspace @ocr/desktop -- --dir  # package web UI + daemon sidecar
```

During web development, point the shell at the Vite dev server:
`OCR_WEB_URL=http://localhost:5173 npm start --workspace @ocr/desktop`.
Packaging (DMG, notarization) comes with the distribution stage.

`npm run dist` is self-sufficient: it builds the web UI and the shell
(TypeScript + daemon bundle) before packaging, so the command also works on a
clean checkout.

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
polls.

**Zero pairing on the host machine**: on the desktop, the sidecar also captures
the `opencode-remote://pair?v=2&…` URI the daemon prints at boot and the UI
pairs itself automatically — on the machine that hosts the daemon there is no
QR scan on first run. The manual QR/paste screen remains as a fallback
(machines switcher → add machine), for example when an already-running daemon
was reused and never printed a URI to capture.

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
across app restarts and OS reboots. Right below **Open OpenCode Remote** sits
an always-present **Restart daemon** action: it cancels any pending respawn,
resets the crash budget, stops the daemon the shell spawned and starts it
again — the one-click recovery when the sidecar gave up ("daemon down") or an
adopted daemon turned unstable, no quit-and-relaunch needed. The action is
best-effort: it is a no-op with a clear log line when no daemon was ever
started, and any failure is logged without taking the shell down. The
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
(**Open OpenCode Remote**) or by launching the app again; **Quit** in the tray
menu (or `Cmd+Q` on macOS) performs a real quit with full daemon cleanup.

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
of opening off-screen or crashing.

**Persistent shell log**: the desktop app appends everything the main process
logs (`[desktop] …` lines: daemon sidecar lifecycle, pairing polls, renderer
crashes, fatal errors) to `userData/logs/desktop.log` — so a packaged app used
by someone without a terminal still has a diagnosable trail. The file is
capped at ~1MB and rotates to `desktop.log.1` (only 2 files kept); if the disk
is full the app keeps running and simply stops writing log lines. To find the
folder on macOS: `~/Library/Application Support/OpenCode Remote/logs/`.

**First-run QR for your phone**: while no phone is paired yet, the desktop
window shows a first-run overlay with a scannable pairing QR (rendered by the
main process from the daemon's `GET /__ocr/pairing-uri`, a read-only loopback
route gated by the same bearer token). The shell polls the allowlist every 3s —
once a phone pairs the overlay leaves and the chat appears. "Pair later"
dismisses it for the session.

**Staged update feed (spike P2-012)**: the shell can check for updates against
a static feed you host — a loopback URL is enough. The check runs exactly once
at boot and **only** when `OCR_UPDATE_FEED` is set; without it nothing happens:

```bash
OCR_UPDATE_FEED=http://127.0.0.1:9310/feed.json npm start --workspace @ocr/desktop
```

The feed directory can contain an electron-builder-style `latest-mac.yml`
(`version: 0.2.1` + fake release notes) or a Squirrel.Mac JSON feed (`feed.json`
with `url`/`name`/`notes`) — both are parsed and a newer release is logged as
`update-available`. For JSON feeds the release is also handed to Electron's
built-in `autoUpdater` (`setFeedURL` + `checkForUpdates`, `serverType: "json"`),
which downloads it in the background; yml feeds are parse-and-log only, since
the built-in updater cannot read `latest-mac.yml` (spike finding). Feed or
network failures are strictly log-only and never block or crash the window.

When `OCR_UPDATE_FEED` is set, the tray menu also gains two items (P3-019):
a disabled status line reflecting the latest check ("Update available —
restart to install", "Up to date", or the failure reason) and a clickable
"Check for updates" item that re-runs the check and refreshes the menu in
place. Without the env var the tray stays exactly as before.

## Roadmap

Next up: hosted relay option,
onboarding wizard, skills sharing, native iOS push.

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
