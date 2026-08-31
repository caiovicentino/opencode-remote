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

- **Full chat** with streaming, markdown, images and tool-activity history
- **AutoMode** — the agent runs hands-free; every auto-approved action is
  audited and pushable
- **Interactive questions** — the model asks, you tap an option from the beach
- **Rewind** — go back to any point of the conversation *and* the code, one tap
- **Voice** — hold to talk, local whisper transcription, no cloud
- **Files** — upload from the phone, preview anything, export a conversation
  as markdown with one tap
- **Handoff** — continue the exact session on your Mac (💻 button)
- **Live board** — every session's state at a glance: working, waiting for
  your approval, asked a question, done, errored; cards show relative
  last-activity time (`5m`, `2h`, `3d`); sessions are sorted by most recent
  activity first
- **Routines** — real cron: daily, specific weekdays, or interval loop
- **Secure by construction** — passkey (WebAuthn) gate, ECDH P-256 + AES-256-GCM,
  replay protection, device allowlist, audit log, biometric unlock
- **BYOM** — opencode supports any provider; pick the model per session
- **API + SDK** — drive sessions from code (`packages/sdk`)

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
