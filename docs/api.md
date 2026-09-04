# HTTP API & SDK

Local, programmatic access to the harness. Binds to `127.0.0.1` only —
scripts and integrations run on the same machine as the daemon. (Remote
access goes through the E2E tunnel / phone app by design.)

## Auth

Every request needs the API token:

```
Authorization: Bearer <apiToken>
```

The token lives in `~/.opencode-remote/daemon.json` (`apiToken` field,
auto-generated on first daemon boot) and can be printed with:

```bash
opencode-remote token
```

## Endpoints (daemon, port 8792)

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | daemon/opencode/relay status |
| GET | `/api/session` | list sessions |
| POST | `/api/session` | create session `{ title? }` |
| GET | `/api/session/:id` | session info |
| DELETE | `/api/session/:id` | delete session |
| GET | `/api/session/:id/messages?limit=200` | message history (oldest→newest) |
| POST | `/api/session/:id/message` | send a prompt `{ text }` → `202` |
| GET | `/api/artifacts?session=<id>` | list agent artifacts (all sessions, or one); the global listing also carries `titles: { sessionId: conversationTitle }` |
| GET | `/api/artifacts/file?session=<id>&name=<file>` | raw artifact bytes |
| GET | `/api/browse` | list live browser sessions |
| POST | `/api/browse/open` | navigate `{ url, session?, width?, height? }` |
| POST | `/api/browse/click` | click by `{ selector }`, `{ text }` or `{ x, y }` |
| GET | `/api/browse/text?session=` | extract visible text `{ title, url, text }` |
| GET | `/api/browse/screenshot?session=&w=&h=` | PNG screenshot of the live viewport |
| POST | `/api/browse/close` | close a session `{ }` (name via `?session=`) |

Prompts are asynchronous: the endpoint returns `202 { accepted }` while the
agent works. Poll `messages` for the reply, or use the SDK's `sendAndWait`.

### `/api/health` — relay retry state (P2-129)

`GET /api/health` keeps `relayConnected` and adds an additive `relayRetry`
field: `null` while the relay is connected, otherwise
`{ attempt, nextDelayMs }` — which retry is scheduled and the wait in ms until
the daemon dials again. Reconnects use exponential backoff with full jitter
(2s base, doubling per attempt, 30s cap) instead of a fixed 2s, so a fleet of
daemons no longer hammers a downed relay twice per second nor reconnects all
in lockstep; each reschedule also bumps the `ocr_relay_retries_total` counter
on the metrics endpoint.

### `/api/health` — upstream agent state (P2-135)

`GET /api/health` keeps the legacy `opencodeHealthy` boolean untouched and
adds an additive `opencode` object describing the last probe of the agent
server (opencode) in detail:

| Field | Shape | Meaning |
|---|---|---|
| `state` | `unknown` \| `ok` \| `unauthorized` \| `unreachable` \| `timeout` \| `unhealthy` | `unknown` until the first probe finishes, then the classified outcome |
| `reason` | string | short pt-BR description of what was observed |
| `hint` | string | actionable pt-BR next step ("" when nothing needs doing) — becomes the down-push body, prefixed with the machine name |
| `checkedAt` | string \| null | ISO timestamp of that probe; `null` before the first one |
| `binaryFound` | boolean | additive (P2-149): `true` when an executable `opencode` binary exists on this machine — resolved from `PATH` plus known install locations once at boot and refreshed at most once a minute while the upstream is unreachable |
| `binarySource` | `path` \| `known` \| null | additive (P2-149): where the binary was found (`"path"` = a `PATH` entry, `"known"` = a known install location); `null` when none is executable |

The probes (boot healthcheck + 60s watchdog) classify HTTP status, parsed
body and fetch errors: a 401/403 becomes `unauthorized`, connection-refused
`unreachable`, an aborted 5s probe `timeout`, and a 2xx with
`healthy: false` or a malformed body `unhealthy`. Since P2-149 the
connection-refused case splits by `binaryFound` (same `unreachable` state):
with a binary present the hint says to check whether the agent server is
running, without one it says to install opencode first. `reason`/`hint` are
static strings — the 401 case says the token was refused without ever quoting
it, and `binaryFound`/`binarySource` expose only the boolean and the origin,
so no secrets, tokens, passwords or absolute binary paths ever appear in the
health payload.

### Pairing state (P2-007)

Two read-only routes serve the desktop shell's first-run QR overlay; they are
the HTTP twin of the E2E `/__ocr` routes and never mutate anything:

| Method | Path | Description |
|---|---|---|
| GET | `/__ocr/pairing-uri` | `{ uri }` — the `opencode-remote://pair?v=2&…` URI built at boot (null before boot completes) |
| GET | `/__ocr/devices` | `{ devices }` — the current allowlist, fresh-read from the 0600 state file |

Both require the bearer token, are bound to `127.0.0.1` like every daemon
route, and answer `401` without a valid token.

### Browser self-driving (P2-011)

`/api/browse/*` drives a headless Chromium on the host (Playwright). Sessions
are named (`?session=`, default `main`), capped at 3 with a 5-minute idle
timeout, and only accept `http:`/`https:` targets — including loopback, since
screenshotting local services (dashboard, dev servers) is the point; callers
already hold the daemon token, so browse adds no privilege. The Chromium
renderer sandbox stays ON (any Chromium n-day must not become host compromise);
only set `OCR_BROWSE_NO_SANDBOX=1` on environments where the sandbox is
known-broken. Request bodies are capped at 64 KB. Audit entries land in the
same `audit.log` the app reviews; set `OCR_BROWSE_DISABLED=1` to turn the
surface off. The desktop app exposes the same routes through the **🌐 Browser**
pane (screenshot loop — page content never renders inside the app origin).

```bash
TOKEN=$(opencode-remote token)

# navigate + screenshot
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"url":"http://127.0.0.1:8792/dashboard"}' \
  http://127.0.0.1:8792/api/browse/open
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:8792/api/browse/screenshot -o shot.png
```

Agents (builder/reviewer of the pilot) have a tiny CLI for this:
`node tools/browse.mjs open <url> [shot.png]` — see `docs/PILOT.md`.

### Artifacts

The agent can hand documents to the app by writing them into
`~/.opencode-remote/artifacts/<sessionId>/` (html, md, csv, pdf…). The daemon
lists and serves them:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8792/api/artifacts
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8792/api/artifacts/file?session=ses_xxx&name=report.html" -o report.html
```

Paths are strictly validated (no traversal); unknown/invalid names answer 404.
The phone/desktop UI consumes the same data over the E2E tunnel
(`/__ocr/artifacts`) — the desktop app shows them in the **Artifacts pane**,
and chat messages that mention an artifact file name render an attached card.

### Mission Control / pilot forensics (P2-048)

Navigable post-mortem of the pilot's autonomous runs, parsed from the real
`logs/pilot.log` JSONL + `pilot/events.jsonl` (no invented data):

| Method | Path | Description |
|---|---|---|
| GET | `/api/pilot-forensic` | one card per agent task: `{ id, title, status (running/merged/failed), progress, rounds, gateFails, effortMin, etaMs, mergeSha, deploys[], shots[] }` |
| GET | `/api/pilot-forensic/timeline?task=<ID>` | ordered forensic entries for one task (`phase`, `decision`, `review`, `gate`, `deploy`, `result`, `scribe`) with gate tails |
| GET | `/api/pilot-shot?name=<file>.png` | a post-deploy capture from `pilot/shots/` (PNG; name strictly validated) |
| POST | `/api/pilot-takeover` | human takeover: `{ task }` — opens Terminal.app attached to the task's opencode builder session (`opencode -s ses_…`, ids read from the builder log) in its workspace clone. Log-derived values are strictly validated before any shell/AppleScript use: the directory must resolve under `~/.opencode-remote/pilot/repo-<n>` with no shell metacharacters, the session id must be `ses_<alnum>`; anything else falls back to the static pilot dir / plain `opencode` |

`etaMs` is an honest projection (mean duration of finished tasks minus
elapsed), never a guarantee; `effortMin` is wall-clock agent time. The desktop
app renders this feed in the **Mission Control** pane (⌘6); agents can reuse
the same endpoints via the SDK/curl.

## SDK (TypeScript/JS)

```js
import { createClient } from "@ocr/sdk";

const ocr = createClient({ token: process.env.OCR_TOKEN });

const { id } = await ocr.createSession();
await ocr.send(id, "quanto custa rodar isto?");
const reply = await ocr.sendAndWait(id, "agora explique em 1 frase");
console.log(reply);
```

Install from a checkout: `npm i github:caiovicentino/opencode-remote` and
import `@ocr/sdk` (workspace `packages/sdk`).

## curl examples

```bash
TOKEN=$(opencode-remote token)

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8792/api/health

curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"text":"ls do diretório atual"}' \
  http://127.0.0.1:8792/api/session/ses_xxx/message
```

## Security notes

- Localhost bind + bearer token: any local user/process with the token can
  drive the agent — treat the token like a password (state file is 0600).
- Every op is still tunneled through the same E2E proxy used by the phone;
  audit log records sensitive ops as usual.
