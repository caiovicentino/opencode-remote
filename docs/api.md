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
| GET | `/api/artifacts?session=<id>` | list agent artifacts (all sessions, or one) |
| GET | `/api/artifacts/file?session=<id>&name=<file>` | raw artifact bytes |
| GET | `/api/browse` | list live browser sessions |
| POST | `/api/browse/open` | navigate `{ url, session?, width?, height? }` |
| POST | `/api/browse/click` | click by `{ selector }`, `{ text }` or `{ x, y }` |
| GET | `/api/browse/text?session=` | extract visible text `{ title, url, text }` |
| GET | `/api/browse/screenshot?session=&w=&h=` | PNG screenshot of the live viewport |
| POST | `/api/browse/close` | close a session `{ }` (name via `?session=`) |

Prompts are asynchronous: the endpoint returns `202 { accepted }` while the
agent works. Poll `messages` for the reply, or use the SDK's `sendAndWait`.

### Browser self-driving (P2-011)

`/api/browse/*` drives a headless Chromium on the host (Playwright). Sessions
are named (`?session=`, default `main`), capped at 3 with a 5-minute idle
timeout, and only accept `http:`/`https:` targets. Audit entries land in the
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
