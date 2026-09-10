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
| GET | `/api/artifacts?session=<id>` | list agent artifacts (all sessions, or one), newest first, capped at the 500 most recent (P2-173); carries `total` (real count before the cap), `truncated` and — on the global listing — `titles: { sessionId: conversationTitle }` |
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

Since P2-156 the `relayRetry` object also carries an additive `lastClose`:
`null` until the relay socket has ever closed, otherwise
`{ code, kind }` — the numeric close code and the triage kind of the most
recent close (`capacity`, `rate-limited`, `draining`, `normal` or
`transient`). A `capacity` (1013) or `rate-limited` (4029) close floors the
reconnect wait at 30s/60s respectively, so a saturated relay is not hammered
as if the network had dropped; `transient` keeps the bare P2-129 curve. The
raw close reason is never exposed.

Since P2-260 the same object also carries an additive `lastDial`: `null`
until the first dial failure, otherwise `{ kind, hint }` — the classified
cause of the most recent failed dial to the relay (`unresolved-name`,
`refused`, `timed-out`, `cert-expired`, `cert-untrusted`,
`cert-name-mismatch`, `cert-other` or `transient`) plus one static pt-BR
operator hint. A permanent cause floors the next reconnect wait at 60s (bad
address) or 5min (bad certificate); `transient` keeps the P2-129 curve. The
raw Node error message, which embeds the relay host and port, is neither
logged in free text nor exposed here.

Since P2-303 the `relay` object also carries an additive machine-proxy
verdict of the dial: `relayProxyState` is `direct` (today's path — no proxy
variables, a loopback relay, a `NO_PROXY` match or a discarded address) or
`tunnel` (the dial crosses the machine's http/https proxy via an HTTP
CONNECT tunnel — over a TLS session when the proxy address is `https://`),
and `relayProxyReason` is one static pt-BR phrase for the
state. The proxy address itself never rides — the reason is address-free
copy, and the tunnel's host/port stay inside the daemon. Since P2-311 the
same object also carries the additive `relayProxyAuth` with exactly two
values, `none` and `basic`: only the PRESENCE of a usable proxy credential.
The credential's secret never rides this surface, is never logged and is
never persisted — a proxy that answers the CONNECT with 407 surfaces through
the existing `lastDial` classification with its own pt-BR hint ("o proxy
pediu autenticação e recusou a credencial"), still classified `refused`.

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
| `binaryFound` | boolean | additive (P2-149): `true` when an executable `opencode` binary exists on this machine — resolved from `PATH` plus known install locations once at boot and refreshed at most once a minute while the upstream is unreachable; since P3-395 the known locations include the bun/pnpm/npm-global/volta/`~/.local/bin` managers plus the node versions nvm and mise expose (npm under `APPDATA` and pnpm under `LOCALAPPDATA` on Windows), so a Finder-launched app with a minimal inherited `PATH` still finds a terminal-visible install |
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

### `/api/health` — bootstrap pairing window (P2-190)

`GET /api/health` adds an additive `pairingWindowOpen` boolean (no existing
field is removed or renamed): `true` while a virgin daemon (empty allowlist)
would still auto-pair the first client that completes the handshake — the
bootstrap pairing window from docs/security.md. `false` once the window
closed (or was never opened); reopen the pairing screen in the desktop app
or restart the daemon to pair.

### `/api/health` — capability last-checked instants (P2-250)

`GET /api/health` adds two additive fields carrying WHEN each capability
verdict was last probed (ISO instant, `null` before the first probe):
`docConvertCheckedAt` at the top level and `versionCheckedAt` inside the
`opencode` object. Every state/message field the payload already had keeps
its exact shape.

The verdicts themselves are no longer frozen at the boot probe: the daemon
re-probes a capability lazily, right before it answers with a refusal
(voice transcription 501) or serves the verdict (health route: doc conversion,
version and voice; `/__ocr/settings`: version, doc conversion, browse and
voice), at most once per
`OCR_READINESS_MIN_MS` per capability (whole milliseconds, default 60000,
ceiling 3600000; invalid values fail the boot, fail-closed). A verdict that
already works is never re-probed and a probe in flight is never duplicated.
Set `OCR_READINESS_DISABLE=off|0|false` to turn revalidation off entirely;
`on|1|true` is the documented enable value and anything else fails the boot.
Each actually re-done probe logs exactly one line with the capability name
and the resulting state — never a path, a resolved binary or env content.

### `/api/health` — browse-readiness verdict (P2-284)

`GET /api/health` adds three additive fields for the browse capability (no
existing field is removed, renamed or repositioned): `browseState`
(`ready` | `no-browser` | `disabled` | `unknown`), `browseMessage` (short
pt-BR sentence, same register as the other verdicts) and `browseCheckedAt`
(ISO instant, `null` before the first probe). The verdict is probed once at
boot on the same readiness hook as the other capabilities and re-probed
lazily on this route under the same `OCR_READINESS_MIN_MS` /
`OCR_READINESS_DISABLE` policy — so a machine announces whether it knows how
to open sites BEFORE the user asks, and installing the Playwright browser
afterwards is picked up without a restart. No phrase ever carries a path,
port, address, environment variable or the raw error tail.

### `/api/health` — voice-transcription readiness (P2-296)

`GET /api/health` adds three additive fields for the voice capability (no
existing field is removed, renamed or repositioned): `voiceState`
(`ready` | `missing-binary` | `missing-model`), `voiceMessage` (short pt-BR
sentence, same register as the other verdicts) and `voiceCheckedAt` (ISO
instant, `null` before the first probe). The verdict is probed once at boot on
the same readiness hook as the other capabilities and re-probed lazily on this
route and on the settings read under the same `OCR_READINESS_MIN_MS` /
`OCR_READINESS_DISABLE` policy — the machine no longer claims all-clear while
it cannot hear, and installing whisper or its model afterwards is picked up
without a restart. The documented `OCR_STT_BLOCK=1` hatch keeps forcing the
missing-binary verdict for these fields too. No phrase ever carries an
absolute path, a model file name, an install script name, a port, an address,
a raw environment variable or a secret.

### Voice replies — spoken-reply verdict (P2-298)

`GET /__ocr/voice/tts-status` keeps its `available`, `voice`, `voices` and
`langs` fields exactly as they were and adds two additive fields from the same
pure verdict the other capability routes serve: `state` (`ready` |
`missing-tool`) and `message` (short pt-BR sentence, same register as the
other verdicts). The `POST /__ocr/voice/tts` refusal (501) now carries that
same actionable phrase instead of a raw English install instruction. The
verdict is re-probed lazily at both points under the same
`OCR_READINESS_MIN_MS` / `OCR_READINESS_DISABLE` policy — an edge-tts install
made after boot is picked up without a restart — and the documented
`OCR_TTS_BLOCK=1` hatch forces the missing-tool verdict for deterministic
screenshots. No phrase ever carries a path, a tool or script name, a port, an
address, a raw environment variable or a secret.

### `/api/health` — spoken-reply readiness (P2-300)

`GET /api/health` adds three additive fields for the speech capability (no
existing field is removed, renamed or repositioned): `ttsState` (`ready` |
`missing-tool`), `ttsMessage` (short pt-BR sentence, same register as the
other verdicts) and `ttsCheckedAt` (ISO instant, `null` before the first
probe). The identifier is `ttsState` — deliberately NOT `voiceState`, which
has named the voice-TRANSCRIPTION pair since P2-296. The verdict is probed
once at boot on the same readiness hook as the other capabilities and
re-probed lazily on this route and on the settings read under the same
`OCR_READINESS_MIN_MS` / `OCR_READINESS_DISABLE` policy — the machine no
longer claims all-clear while it cannot speak, and installing edge-tts
afterwards is picked up without a restart. The documented `OCR_TTS_BLOCK=1`
hatch keeps forcing the missing-tool verdict for these fields too.

### `/__ocr/model/status` — lazy model-readiness revalidation (P3-397)

`GET /__ocr/model/status` keeps its `{ available, state, message }` shape
exactly as it was. The verdict is no longer frozen at the last catalog fetch
that already happened (the context ruler's on-miss refresh and the /provider
passthrough): right before the route answers and ONLY while the current
verdict is not `ready`, the daemon re-observes the already-existing opencode
`/provider` catalog — with the same forwarded credential and the same upstream
probe timeout every other upstream read uses — at most once per
`OCR_MODEL_READINESS_MIN_MS` (whole
milliseconds, default 60000, ceiling 3600000; invalid values fail the boot,
fail-closed). A verdict that already says `ready` is never re-observed and a
re-observation in flight is never duplicated. Set
`OCR_MODEL_READINESS_DISABLE=off|0|false` to turn model revalidation off
entirely; `on|1|true` is the documented enable value and anything else fails
the boot. A re-observation that fails never throws and never accuses: it
degrades to the neutral `unknown` with a single log line carrying a coarse
reason — never a path, never a secret. No new route, no new port, no new
listener, no periodic timer, and the route itself fires no fetch outside the
ceiling gate. The documented `OCR_MODEL_BLOCK=1` hatch keeps its forced
no-provider verdict (never re-observed away).

### `/__ocr/settings` — machine-readiness mirror (P2-288)

`GET /__ocr/settings` carries the document-conversion and site-navigation
verdicts additively — `docConvertState`, `docConvertMessage`, `browseState`,
`browseMessage` — the same names and values `GET /api/health` publishes, so
the Settings **Machine state** panel renders both lines from the channel it
already reads (no new route, no new request, no new poll, no periodic timer).
Both capabilities are re-probed lazily at this point under the same
`OCR_READINESS_MIN_MS` / `OCR_READINESS_DISABLE` policy as the version
verdict; a capability that was never measured stays silent instead of
announcing readiness. Since P2-292 the relay and agent verdicts ride this
same channel additively — `relay` (`ok` + `reason`, the health relay object
minus the address, which never rides) and `opencode` (`binaryFound` +
`binarySource`) — so the panel's first two lines reach a lay user, and no
line besides these two stays pending. Since P2-296 the voice pair rides the
same rules too — `voiceState` / `voiceMessage` — and since P2-300 the
spoken-reply pair rides them as well — `ttsState` / `ttsMessage` (the
identifier deliberately not `voiceState`, which is transcription), appended
last. Since P2-297
apps/web reads every group on this same channel, so the Settings
**Machine state** panel renders all eight lines (P2-305 appended the
spoken-replies row: `ready` → ok, `missing-tool` → unavailable, any other
value silent) and no line stays pending a future channel. No existing field
of the response is renamed, removed or repositioned.

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
Since P2-284 the browse error paths answer with the short pt-BR readiness
phrase instead of a raw English error: a failed browser launch keeps status
502 and the kill switch keeps 503, both carrying the `browseMessage` verdict
from `/api/health`.

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

Both listing routes (`/api/artifacts` and the tunnel's `/__ocr/artifacts`) return
artifacts sorted newest → oldest, capped at the **500 most recent**
(`MAX_ARTIFACTS_LISTED`): the body carries the trimmed `artifacts` array plus
additive `total` (real number of artifacts found) and `truncated` flags. Clients
that ignore unknown fields keep working unchanged; the conversation-title map is
resolved only for the sessions present in the trimmed list.

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

## Request body limit (P2-180)

Every JSON request body on the daemon's `/api/*` routes is capped at
**1,000,000 bytes (1 MB) of real UTF-8 bytes** by default. A larger body is
refused the moment the limit is crossed — the bytes never finish buffering in
memory — with:

```
HTTP/1.1 413
{"error": "request body too large (1MB limit)"}
```

The refusal is logged with the route and the refused size only — never body
content, token or session ids.

The ceiling is configurable with the `OCR_MAX_BODY_BYTES` environment variable
(whole number of bytes, up to a documented maximum of 100,000,000). A missing
or blank value keeps the 1 MB default. **The boot is fail-closed:** a
non-numeric, negative, zero, fractional or above-ceiling value does NOT fall
back to the default — the daemon logs one error line per problem and exits
with code 1 without opening any listener. Fix the variable and start again.
(File uploads are unaffected by that JSON body path: `/__ocr/upload/*` has its
own staging ceilings below.)

## Chunked upload staging limits (P2-181)

Chunked uploads ride the E2E tunnel as frames (`/__ocr/upload/chunk`,
`/__ocr/transcribe/chunk`), so they never pass through the JSON body reader
above. Their staging area is bounded up front instead of only at completion:

- **Staging cap per id** — derived from the decoded ceiling
  `OCR_UPLOAD_MAX_MB` (default **200 MB**, whole megabytes, documented maximum
  **2000**): staged base64 bytes per id are capped at the decoded ceiling plus
  the one-third base64 expansion and a fixed 1 MiB margin, so a legitimate
  max-size upload still passes chunk by chunk. Crossing the cap answers
  **413** and drops the whole staged entry — a truncated body must never
  complete as a silently corrupt audio/file.
- **Concurrent ids** — at most **8** upload ids staged at once; a new id
  beyond that answers **429** (`too many concurrent uploads`).
- **Chunk index** — must be a whole number between 0 and **100,000**;
  anything else answers **400**.
- **Expiration** — an upload id untouched for **5 minutes** is swept on the
  next chunk arrival (before admitting new work), so abandoned uploads cannot
  linger in memory forever.

All three refusals use the daemon's standard `{ "error": ... }` body. The
completion route (`/__ocr/upload/complete`) keeps its decoded
`OCR_UPLOAD_MAX_MB` check unchanged. An invalid `OCR_UPLOAD_MAX_MB` (non-numeric,
negative, zero, fractional or above the 2000 MB ceiling) is fail-closed at
boot: one error line per problem, exit code 1, no listener. Refusal log lines
carry only the route and the refused size — never chunk content, full ids,
tokens or session ids.

## Download start limits (P2-314)

Starting a download (`POST /__ocr/download/start`) is bounded before any
identifier is created, with the same fail-closed shape as the upload path
above:

- **File ceiling** — `OCR_DOWNLOAD_MAX_MB` (default **200 MB**, whole
  megabytes, documented maximum **2000** — the same default and ceiling as
  `OCR_UPLOAD_MAX_MB`). A file whose measured size is above the ceiling
  answers **413** with a short static pt-BR phrase
  (`Arquivo grande demais para transferir por aqui.`) that never contains the
  path, the file name or the measured size.
- **Open downloads** — at most **8** entries in the open-downloads map; a
  start beyond that answers **429** with a short static pt-BR phrase
  (`Muitas transferências abertas ao mesmo tempo — tente de novo em
  instantes.`). A download already in progress is never interrupted by
  another start — the newcomer is the one refused.
- **Entries ceiling** — on top of the existing 30-minute age prune, the
  open-downloads map never holds more than the 8 documented entries; if it
  ever does, the oldest registrations are discarded first. The age prune runs
  **before** admission — the same sweep-then-admit order as the upload
  staging route — so aged-out registrations never count as live and the
  endpoint can never wedge at 429 after 30 idle minutes.
- **Fail-closed boot** — an invalid `OCR_DOWNLOAD_MAX_MB` (non-numeric,
  negative, zero, fractional or above the 2000 MB ceiling) is refused at
  boot exactly like `OCR_UPLOAD_MAX_MB`: one error line per problem, exit
  code 1, no listener.

The chunk route (`GET /__ocr/download/chunk`) and the 500,000-byte chunk
count are untouched. Refusal log lines carry only the static reason — never
the path, file name or size.

## Scheduled routines — per-routine execution history (P2-316)

`GET /__ocr/routines` keeps returning the scheduled routines and now each
routine carries an optional `history` field beside the `lastRun` mark it
already had — one record per trigger, **newest first**, so a routine that has
been failing every day is visible instead of leaving no trace anywhere:

```json
{
  "id": "…",
  "name": "Bom dia",
  "lastRun": "2026-09-07",
  "history": [
    { "at": "2026-09-07T10:00:02.123Z", "durationMs": 2141, "outcome": "completed", "sessionId": "ses_…" },
    { "at": "2026-09-06T10:00:01.004Z", "durationMs": 187, "outcome": "failed" },
    { "at": "2026-09-05T10:00:00.900Z", "durationMs": 0, "outcome": "skipped" }
  ]
}
```

- **Record fields (only these four, ever)** — `at`: trigger start instant in
  ISO form; `durationMs`: trigger duration in milliseconds; `outcome`: a
  closed set — `completed` (the run finished and produced its result),
  `failed` (the fire failed, the agent run errored, or the run was released
  by the 2 h lease), `skipped` (the day was closed without a fire — machine
  off past the 30-minute window or the retry ceiling reached); and
  `sessionId`: the identifier of the session created for the run, when there
  is one.
- **Cap** — at most **30 records per routine** (`ROUTINE_HISTORY_CAP` in
  `apps/daemon/src/routinehistory.ts`), always the newest ones: appending
  never refuses a record, the oldest is discarded to make room, and the cap
  is re-applied on every load, so the file cannot grow without bound.
- **Privacy guarantee** — a record never carries the routine prompt text,
  an agent reply or error text, an absolute path, or user data of any other
  kind. The history answers whether the routine ran, how long a trigger took
  and whether it failed — nothing about the content that flowed through it.
  The contract lives in the `routinehistory.ts` header and is pinned by unit
  tests.
- **Persistence and tolerance** — the history is stored on the routine in the
  same `routines.json` file (no new file, same atomic 0600 write). A load
  tolerates an old file without the field, a missing or truncated history and
  malformed records: only the invalid record is discarded — never the routine,
  never the whole list. Routines without history simply omit the field.

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
