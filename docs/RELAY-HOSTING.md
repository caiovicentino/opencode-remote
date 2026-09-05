# Hosted relay — deploy runbook

Stage 4 of the platform vision: the relay runs somewhere always-on so a phone
can reach the daemon without keeping the home machine's own TLS story. The
relay ships as a small multi-stage image built from `deploy/relay/Dockerfile`
(node 22 slim, tsc-compiled, non-root, self-probing via `HEALTHCHECK`).

The constitutional property is unchanged and load-bearing: **the relay is a
blind router**. It forwards sealed frames between peers of a room and can
neither decrypt nor authenticate them — it never sees plaintext, keys, or
room semantics, so hosting it on infrastructure you do not fully trust does
not weaken the E2E guarantees. (`apps/relay` is AGPL-3.0-only: hosting it for
others means shipping its source.)

## Pull the published image

Every release tag builds `deploy/relay/Dockerfile` in CI (the `relay-image`
job in `.github/workflows/release.yml`), **boots the built image and probes
it before any push** (P2-196), and only then pushes two references to GHCR —
the bare semver and `latest`:

```bash
docker pull ghcr.io/caiovicentino/opencode-remote:0.2.0
docker run -d --name relay \
  -p 8787:8787 \
  --restart unless-stopped \
  ghcr.io/caiovicentino/opencode-remote:0.2.0
```

Pin the version tag instead of `latest`: `latest` moves with every release
and a casual `pull` can land you on a version you never tested. Publishing
is opt-in fail-closed — the workflow only pushes when the repository variable
`PUBLISH_RELAY_IMAGE` is `true`; without it the job still builds the image on
every tag (a broken Dockerfile fails the release) but publishes nothing.
The image carries no secrets — every setting enters through `docker run -e`
or `--env-file` at start time — and the constitutional property is untouched:
the relay is a blind router that never sees plaintext or key material, so the
published image adds no crypto surface of its own.

### Every tag boots the image before anything is published (P2-196)

Since P2-196 the `relay-image` job never pushes an image it has not executed.
Between the build and the push, the workflow starts the just-built image with
`docker run -d` on an ephemeral loopback port (with `RELAY_WEB_DIR` exactly as
embedded), waits up to **30 attempts, 1s apart** for `/healthz` to answer, and
runs the smoke battery of `scripts/relay-image-smoke.ts` against the live
container (5s fetch timeout per probe):

- `/healthz` answers `200` with today's counter body (`ok`, `version`,
  `uptimeS`, `rooms`, `roomsRejected`);
- `/` answers `200` with `text/html` and every security header P2-192
  introduced (CSP, referrer/permissions policies, framing, COOP/CORP);
- the content-hashed bundle asset referenced by the entry document answers
  `200`;
- a dotfile path answers `404` (the static-route allowlist holds);
- a non-GET request answers `405`;
- the process inside the container is not running as root.

Probes run **all at once** — a red smoke lists every failure, not just the
first. The container is removed no matter how the step ends.

**What a red smoke means for the operator:** the tag's image never reached
GHCR — neither the version tag nor `latest` was pushed, so what you already
pull stays whatever you had pinned before. Do not hand-push or re-tag to
force it: the smoke failure is the signal the image cannot boot (or lost its
web bundle, or its preflight refuses the environment); check the job log for
the `- problem(s) found` list and the container's own JSONL boot log, fix the
image, and let the next tag go green through the same gate. When
`PUBLISH_RELAY_IMAGE` is not `true` the smoke still runs — a red smoke fails
the release run even though nothing would have been published.

## Build and run

```bash
docker build -f deploy/relay/Dockerfile -t opencode-remote/relay .
docker run -d --name relay \
  -p 8787:8787 \
  --restart unless-stopped \
  opencode-remote/relay
```

The image has no secrets, needs no volumes, and runs as the non-root `node`
user. `docker compose` users: the `relay` service in `docker-compose.yml`
builds this same image (the `caddy` profile adds TLS termination on top).

## Environment variables

| Variable | Default | Recommended in production (provider TLS in front) |
|---|---|---|
| `RELAY_PORT` | `8787` | Keep `8787` on the container's private network and publish it only to the TLS terminator. Set it if you map a different host port. |
| `RELAY_MAX_SOCKETS` | `1000` | Total concurrent websocket ceiling. Raise it only on an instance sized for the load (a stage-4 scale-out can grow this without recompiling). |
| `RELAY_MAX_PER_ROOM` | `10` | Peer ceiling per room. Must not exceed `RELAY_MAX_SOCKETS`. |
| `RELAY_MAX_FRAME_BYTES` | `1000000` | Largest accepted frame in bytes (ws `maxPayload`). Hard ceiling is `16777216` (16 MiB, the int32 `maxPayload` bound); sealed op payloads are far smaller. |
| `RELAY_BUFFER_CAP_BYTES` | `4194304` | Per-socket ceiling on accumulated outgoing bytes (P2-217): when a target's own queue plus the next frame passes it, that target is closed with close code `1013` and the reason `consumidor lento: buffer de saida acima do teto` instead of buffering forever. Ceiling `67108864` (64 MiB); a non-numeric, zero, negative, fractional or above-ceiling value refuses the boot (fail-closed). Raise it only on an instance whose peers legitimately buffer multi-megabyte bursts. |
| `RELAY_METRICS_PORT` | unset (off) | Leave unset in containers unless a scraper needs it. When set, the endpoint serves counters on `/metrics` (JSON, or Prometheus text with `?format=prom`). |
| `RELAY_METRICS_BIND` | `127.0.0.1` | Keep the loopback default unless your scraper sits outside the container (k8s sidecars share the network namespace and don't need it). Any non-loopback address **requires** `RELAY_METRICS_TOKEN` — the relay refuses to boot the metrics endpoint on a network-exposed interface without one (fail-closed) and logs the reason instead. |
| `RELAY_METRICS_TOKEN` | unset (no auth) | Required whenever `RELAY_METRICS_BIND` leaves loopback. Scrapers must send `Authorization: Bearer <token>`; every other request gets an empty `401`. The endpoint exposes envelope counters only — no plaintext, no key material, no room ids. |
| `RELAY_MAX_PER_IP` | `20` | Keep the default. Raise it only when many devices legitimately share one egress IP (office NAT, corporate VPN). Ceiling `1000`; a zero, negative, fractional or above-ceiling value refuses the boot (fail-closed) instead of disabling the cap. |
| `RELAY_TRUST_PROXY_HOPS` | `0` | Leave `0` on direct exposure. Set it **only** to the exact number of trusted proxy layers in front of the relay (e.g. `1` for a single provider load balancer doing TLS termination) — see the section below. Ceiling `8`; a non-numeric, negative, fractional or above-ceiling value refuses the boot (fail-closed). |
| `RELAY_DRAIN_GRACE_MS` | `0` | Extra window between the moment a `SIGTERM` marks the instance as draining (`/healthz` flips to `503`) and the moment the live sockets are closed. Default `0` keeps the historical behavior; raise it (max `2000`) when your load balancer polls `/healthz` too rarely to notice the 503 before `docker stop` proceeds. See the sections below. |
| `RELAY_TLS_CERT` | unset | Leave unset for provider TLS in front (the default layout). Set **only together with `RELAY_TLS_KEY`** — the two form a mandatory pair — when the relay terminates TLS itself; both files must be readable by the `node` user and the relay serves `wss://` directly. |
| `RELAY_TLS_KEY` | unset | See `RELAY_TLS_CERT`. Either variable alone, a set-but-blank value, or an unreadable file **refuses the boot** (fail-closed) — the relay never silently downgrades a public host to plain HTTP. |
| `RELAY_LOG_LEVEL` | `info` | Log verbosity: `error`, `warn`, `info` or `debug` (case-insensitive). Keep `info`: only `debug` writes the per-frame `frame in` line, and on a public host that line reconstructs who talked to whom and when out of retained provider logs. An unknown or non-string value **refuses the boot** (fail-closed) instead of falling back to the default. See the section below. |
| `RELAY_WEB_DIR` | unset (off) | Directory with the static PWA bundle to serve over HTTP (the image ships it at `/app/apps/web/dist`). Leave unset to answer `404` on every non-probe HTTP path, exactly as before P2-188. Set it to a directory that is missing, not a directory, unreadable, or without a readable `index.html` and the relay **refuses the boot** (fail-closed). See the section below. |
| `RELAY_WEB_CSP` | unset (default policy) | Override for the `content-security-policy` served with every 200 document of the static route. Must declare `default-src`, stay free of newlines/control bytes and within 1024 characters — anything else **refuses the boot** (fail-closed). See the section below. |
| `RELAY_WEB_RATE_PER_MIN` | `120` | Sustained static-route requests per minute, per client identity (see the budget section below). Ceiling `10000`; a non-numeric, negative, zero, fractional or above-ceiling value **refuses the boot** (fail-closed). |
| `RELAY_WEB_BURST` | `60` | Token-bucket burst for the static route, per client identity — how many back-to-back requests a cold page load may cost before throttling. Ceiling `10000`; invalid values **refuse the boot** (fail-closed) exactly like the rate knob. |

The relay also accepts `RELAY_RATE_PER_MIN` and `RELAY_RATE_BURST`
(per-connection token bucket, defaults `600` and `1000`, ceilings `60000` and
`100000`) and `RELAY_PING_INTERVAL_S` (stale-socket sweep, default `30`,
ceiling `3600`). The defaults are already sized to pass the daemon's
worst-case chunked transfer — leave them alone unless you have a specific
abuse pattern.

### Tuning knobs are fail-closed too (P2-171)

The five tuning knobs — `RELAY_RATE_PER_MIN`, `RELAY_RATE_BURST`,
`RELAY_MAX_PER_IP`, `RELAY_TRUST_PROXY_HOPS` and `RELAY_PING_INTERVAL_S` —
are validated at boot exactly like the admission ceilings above: a
non-numeric, negative, fractional or zero value (zero remains legitimate
**only** for `RELAY_TRUST_PROXY_HOPS`, the documented direct-exposure
default), or a value above the knob's ceiling, is a boot **problem**. If any
problem exists the relay never opens its listener — every reason is logged
once at boot (JSONL, `invalid relay knob, refusing to start`) and the process
exits with code `1`. An absent or blank variable keeps the documented
default, so an empty env reproduces the historical values exactly: a typo can
no longer silently re-cap a public relay's rate ceiling, per-IP budget or
proxy-hop count. The `relay listening` line carries the resolved values
(`ratePerMin`, `rateBurst`, `maxPerIp`, `trustProxyHops`, `pingIntervalS`)
and never echoes the raw env.

### Limit validation is fail-closed

The three ceilings above (`RELAY_MAX_SOCKETS`, `RELAY_MAX_PER_ROOM`,
`RELAY_MAX_FRAME_BYTES`) are validated at boot: a non-numeric, zero or
negative value, a per-room cap larger than the socket cap, or a frame cap
above the 16 MiB ceiling are all boot **problems**. If any problem exists the
relay never opens its listener — every reason is logged once at boot (JSONL,
`invalid relay limit, refusing to start`) and the process exits with code `1`.
An absent or blank variable keeps the documented default, so an empty env
reproduces the historical limits exactly. Nothing about the blind-router
property changes with the configured values: the relay still never reads
plaintext or key material.

### Backpressure: the relay closes who does not read (P2-217)

Before P2-217 the only memory defense on the forwarding path was the
per-frame size cap: a target that simply stopped reading — a phone whose TCP
window froze on a bad 4G link, a browser tab suspended by the OS — kept
accepting frames into its outgoing socket buffer, growing the relay process's
memory without bound until the process died and took every room's
conversation down at once, with no log line explaining why. On a hosted
multi-tenant relay, one dead connection could consume everyone's memory.

The relay now consults a per-socket verdict **before every send**: the
target's own accumulated outgoing bytes (`bufferedAmount`) plus the next
frame may not pass `RELAY_BUFFER_CAP_BYTES` (default 4 MiB, ceiling 64 MiB).
In other words, the relay closes who does not read instead of accumulating
memory. A peer over the line is closed **alone** — close code `1013` ("try
again later") with the reason `consumidor lento: buffer de saida acima do
teto` — while the sender and every other peer of the room keep routing
uninterrupted. Each such close increments the additive
`slow_consumers_total` counter (`relay_slow_consumers_total` in the
Prometheus text format) and writes one `warn` JSONL line carrying only the
counter and the reason — never a room id, a client address or any payload
content.

Two properties are deliberate, not incidental:

- **Frames are never dropped or queued out of order.** The relay is blind —
  it cannot re-send what it discards — so silently swallowing a frame would
  corrupt the end-to-end stream while both ends still look healthy. Closing
  the slow socket is the honest signal: daemons and phones already reconnect
  with backoff and resend their state.
- **The verdict fails open.** If a socket implementation cannot report its
  accumulated bytes (missing, negative or non-finite count), the frame is
  sent: a peer without that accounting must never have a good connection
  closed because of it.

The knob is validated fail-closed at boot like every other relay knob
(`invalid relay buffer cap, refusing to start`, exit 1, no listener), and the
`relay listening` line carries the resolved value as an additive
`bufferCapBytes` field.

### The TLS pair is mandatory together and fail-closed (P2-154)

`RELAY_TLS_CERT` and `RELAY_TLS_KEY` are validated as a pair before any
listener opens. Exactly two configurations boot:

- **Both variables unset** — plain `ws://` internally. This is valid **only**
  behind a proxy that terminates TLS (the documented container layout: the
  provider's load balancer owns the certificate and the outside world dials
  `wss://`).
- **Both variables set, non-blank, and both files readable by the relay
  user** — the relay serves `wss://` itself (browsers refuse `ws://` from
  `https://` pages).

Everything else refuses to boot — one variable without the other, a
set-but-blank value, or a file the relay cannot read. Each reason is logged
once (JSONL, `invalid relay TLS pair, refusing to start`) and the process
exits with code `1` before **any** listener opens, metrics included: a
half-configured relay never silently downgrades a public host to plain HTTP,
and an unreadable certificate never crashes the boot with a stack trace.
Problem messages cite the offending variable (`RELAY_TLS_CERT` /
`RELAY_TLS_KEY`) and never contain the file path — log shippers get no
host-local detail. The `relay listening` line carries an additive
`tlsSource` field (`env` when the relay terminates TLS itself, `none` behind
a terminator); no pre-existing field changed meaning, and no log line ever
prints certificate or key material.

### The log level is fail-closed too (P2-177)

`RELAY_LOG_LEVEL` selects which JSONL lines the relay writes. The four
accepted values, from least to most verbose, are `error`, `warn`, `info` and
`debug` (case-insensitive). The default is `info`, and an absent or blank
variable keeps it: an empty env reproduces the historical behavior exactly.

What `info` (the default) logs: lifecycle lines (`relay listening`,
`connection open/closed`, shutdown) and every rejection — per-IP cap,
rate limit, invalid room id, room cap, room capacity, stale sockets — all at
`warn`. What it does **not** log: the per-frame `frame in` line. That line
exists only at `debug` and must stay off on any public host: a line per
routed message, retained for months by the provider, reconstructs who talked
to whom and when — the exact metadata-leak class the relay's blind-router
contract exists to prevent (P2-174 closed the same class for client
addresses) — and multiplies log volume and cost by traffic. Debug is for a
short-lived local reproduction, never for production.

The value is validated fail-closed at boot like every other relay knob: an
unknown word or a non-string value is a boot **problem** — each reason is
logged once (`invalid relay log level, refusing to start`), the process exits
with code `1` and **no listener opens** — instead of silently falling back to
the default with a typo'd level. The `relay listening` line carries the
resolved value as an additive `logLevel` field; no pre-existing field changed
name or meaning, and admission, caps, rate limiting, room validation,
routing and the `relay_frames_routed` counter are untouched — only what is
written to stdout changed.

### The static web root is fail-closed too (P2-188)

`RELAY_WEB_DIR` points at a directory of static files the relay serves over
plain HTTP so a phone can open the app from the relay's own URL — no dev
server, no tailscale origin, no terminal. The image sets it to
`/app/apps/web/dist` (the PWA bundle compiled into the image); unset keeps
the historical behavior byte for byte: every HTTP path other than `/healthz`
answers `404`.

Only static files are ever served — the relay stays a blind router and this
route never touches frames, keys or plaintext. The rules, in order:

- `GET /healthz` keeps priority and its exact body; the WebSocket upgrade
  path is untouched.
- Only `GET` and `HEAD` are served (`405` otherwise, `Allow: GET, HEAD`).
- While draining (P2-145) the static route answers `503` like the probe, so
  the load balancer pulls the instance from rotation regardless of route.
- Path resolution is allowlisted in code: no traversal (`..` in any
  encoding), no dotfiles, no backslashes, no percent-escape trickery, no
  extension outside the static allowlist (html, js, css, map, json, svg, png,
  jpg, webp, ico, woff2, txt, webmanifest), and the resolved file must stay
  inside the configured root (realpath-checked, so a symlink planted inside
  the root pointing outside it is rejected too). Anything else is `404`.
- Extension-less routes fall back to the app's `index.html` (single-page
  application routing); a missing asset with an extension is always `404`,
  never the document. Hashed assets (`app-<hash>.js`) are served
  `cache-control: immutable`; the entry document is `no-store`.

The variable is validated fail-closed at boot like every other relay knob.
A configured value whose directory is missing, is not a directory, cannot be
read, or does not contain a readable `index.html` is a boot **problem**: each
reason is logged once (JSONL, `invalid relay web root, refusing to start`)
and the process exits with code `1` before **any** listener opens. Problem
text cites `RELAY_WEB_DIR` and never the configured path — log shippers get
no host-local detail. The `relay listening` line carries an additive
`webRoot: true|false` field; no path is ever logged.

### The served page ships locked down: security headers (P2-192)

The document the static route serves is the page where the user's end-to-end
keys live in the phone's browser, so every 200 response — a resolved asset and
the single-page fallback alike — carries a fixed set of security headers
(resolved by the pure `webheaders.ts` module, applied by the handler):

| Header | Value | Why |
|---|---|---|
| `content-security-policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' wss: https:; base-uri 'self'; frame-ancestors 'none'; form-action 'none'; object-src 'none'` | Same-origin pinning for scripts, fonts and the document base; inline style stays allowed because the generated bundle injects style tags; `data:`/`blob:` images cover canvas and preview rendering; `wss:`/`https:` in `connect-src` because the app dials the relay, which may be a different origin than the one serving the page. Framing, form submission and plugins are shut off entirely. |
| `referrer-policy` | `no-referrer` | The browser must never send the room URL — or any part of the app address — as a referrer to an external destination. |
| `permissions-policy` | `geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=()` | The PWA needs none of the powerful platform features; each is denied explicitly. |
| `x-frame-options` | `DENY` | No third party may frame the page (clickjacking); mirrored by `frame-ancestors 'none'` in the CSP. |
| `cross-origin-opener-policy` | `same-origin` | Isolates the app's browsing context from any cross-origin opener. |
| `cross-origin-resource-policy` | `same-origin` | Other origins may not embed the relay's resources. |
| `strict-transport-security` | `max-age=31536000` | **Present only when the request arrived under TLS** (the relay checks the socket, not a forgeable header). Announcing HSTS on an `http://` origin would lock out an operator who is still bringing the service up — browsers would refuse the plain-HTTP origin before it terminates TLS. `includeSubDomains` is deliberately absent: the operator's other subdomains are out of this relay's reach and must stay so. |

The `404`, `405` and `503` responses carry none of these headers, the `429`
of the request budget below carries all of them, and the `/healthz` body and
headers are byte-for-byte what they were before: a load balancer reading the
probe must not change behavior because of them. The override variable
`RELAY_WEB_CSP` replaces the `content-security-policy`
value only — it is validated fail-closed at boot (a non-string value, a
newline or control byte, a value above the 1024-character ceiling, or a
policy that does not declare the `default-src` directive refuses the boot:
`invalid relay web content policy, refusing to start`, exit 1, no listener).
The relay stays a blind router: these are static header values, and none of
the route's decisions ever touch frames, keys or plaintext.

### The static route has a request budget (P2-195)

Before P2-195 the static route answered file for any number of GETs from any
origin: a single client looping against the bundle consumed file descriptors,
disk reads and bandwidth of the same process that routes everyone's E2E
frames. The route is now guarded by a per-identity token bucket (the pure
`webbudget.ts` module):

- **Every non-probe request consumes one token** — 404s and 405s cost stat
  calls too, so they are budgeted as well. An over-budget identity answers
  **`429`** with a `retry-after` header (whole seconds until one token
  refills), a short `text/plain` body and the same security header set the
  200 documents carry (P2-192).
- **The identity is the derived tag, never the address.** The budget keys on
  the same derivation the WebSocket upgrade path uses — `clientIp()`
  honoring `RELAY_TRUST_PROXY_HOPS` — tagged by the P2-174 `ipTag`
  (irreversible per-process hash). The bucket map never holds a raw client
  address, and no IP is ever logged by the budget.
- **`GET /healthz` is never counted and never barred.** The probe answers
  before the budget is consulted: a load balancer cannot be starved out of
  its own probe no matter how full the bucket of the identity it probes
  from. The WebSocket upgrade path is untouched — per-connection frame rate
  limits and the per-IP admission cap work exactly as before.
- **Buckets cannot leak memory.** Entries idle for more than 15 minutes are
  dropped by the liveness sweep (the same `RELAY_PING_INTERVAL_S` sweep that
  reaps stale sockets; with the sweep disabled the entry cap alone bounds the
  map), and the map never holds more than **4096 entries** — when the cap is
  reached the entry seen longest ago is discarded, so an active client keeps
  its bucket and an abandoned one does not cost anything.

Defaults: `RELAY_WEB_RATE_PER_MIN=120` and `RELAY_WEB_BURST=60` — a cold PWA
load is about a dozen requests, so a refresh storm fits the burst and the
sustained rate comfortably serves the few paired devices a personal relay
has. Both knobs are validated fail-closed at boot like every other relay
knob: a non-numeric, negative, zero, fractional or above-ceiling value
(`10000` for both) is logged once (`invalid relay web budget, refusing to
start`) and the process exits `1` before any listener opens. Absent or blank
keeps the defaults. The `relay listening` line carries the resolved values as
an additive `webBudget` field when the web root is enabled.

### The static route compresses with gzip (P2-198)

A phone opening the app over the relay's own URL used to download every asset
uncompressed: the raw bytes a vite build reports are several times the gzip
size, on first load and on every cache miss, through the same process that
routes everyone's sealed E2E frames. The static route now negotiates content
encoding — decided by the pure `webencoding.ts` module, no new dependency —
and answers `content-encoding: gzip` whenever the client's `accept-encoding`
header allows it:

- **Only text-like assets are compressible**: html, js, css, map, json, svg,
  txt and webmanifest. `png`, `jpg`, `webp`, `ico` and `woff2` are already
  compressed formats and are **never** compressed, whatever the header says;
  anything outside the static allowlist is never served anyway.
- **Two documented size thresholds bound the decision.** Bodies below
  **1024 bytes** gain nothing from gzip (the gzip framing overhead can exceed
  the savings) and stay `identity`; bodies above **8 MiB** are refused
  compression for a single request, so no request ever pins a large
  input+output buffer pair. In between, the header decides.
- **The header is parsed leniently but strictly on quality.** `gzip` and
  `GZIP` are the same, whitespace is ignored, the `*` wildcard counts as
  accepting gzip, an explicit `gzip` element beats the wildcard, and
  `gzip;q=0` — or any malformed header (a q value that is not a number or
  outside 0..1) — means `identity`.
- **Both variants carry `vary: accept-encoding`** — gzip and identity alike
  — so a shared intermediate cache never mixes the two variants of a
  compressible asset. A resource that can never vary (already-compressed
  format, size out of range) carries no vary at all.
- **Compressed bytes are memoized in memory**, keyed by absolute path +
  size + mtime (a redeployed file never answers with a previous build's
  bytes), capped at **64 entries / 32 MiB total**; the entry inserted longest
  ago is discarded when either cap is reached. The same bundle is therefore
  compressed at most once per process, and a burst inside the request budget
  above never becomes a CPU amplifier.
- **The 404, 405 and `/healthz` answers are byte-for-byte what they were**:
  no compression, no vary, no changed behavior for a load balancer reading
  the probe. The identity variant of a 200 document streams through the same
  sender as before, plus the vary header.

The relay stays a blind router: this path only ever touches public static
assets from the allowlisted web root — no sealed frame, key material or
plaintext flows through it. The WebSocket path gains no compression on
purpose: sealed frames are incompressible, and per-message deflate would only
add CPU and memory per peer.

### Conditional requests: etag and 304 (P2-200)

A phone revalidating the app used to re-download the whole bundle on every
reload of the entry document, which by contract cannot be cached immutably.
The static route now speaks RFC 7232 conditional requests, decided by the
pure `webcond.ts` module — no new dependency:

- **Every 200 of the static route carries a strong `etag`**, compressed and
  identity variants alike. The validator is derived from the same stat the
  gzip negotiation already took (size + mtime, no extra disk access) plus the
  chosen encoding — so **the gzip and identity validators always differ** and
  a shared cache can never serve compressed bytes to a client that asked for
  identity. The same size, mtime and encoding always produce the same tag,
  across process restarts too.
- **A request whose `if-none-match` revalidates is answered `304` with no
  body**: the file is not read, not compressed, not touched. The 304 carries
  the etag, `cache-control`, `vary: accept-encoding` (whenever the
  corresponding 200 would carry it) and every P2-192 security header — and
  never `content-encoding`, `content-length` or `content-type`.
- **The `if-none-match` comparison is lenient on structure, strict on
  match**: comma-separated lists are honored (a match by any element
  revalidates), whitespace and extra commas are ignored, the `*` wildcard
  revalidates, the weak `W/` prefix is ignored in the comparison, and a
  missing, empty or malformed header simply sends the body — a conditional
  may only ever make the answer cheaper, never change the answer.
- **The 404, 405 and `/healthz` answers stay byte-for-byte what they were**:
  no validator, no conditional handling. A load balancer reading the probe
  sees nothing new. The per-identity request budget above is still charged
  before the conditional decision — a cheap 304 is still a request.
- **The relay stays blind**: only public static assets from the allowlisted
  web root participate in this path — no plaintext, no keys, no room ids,
  and no sealed frame is ever cached or validated.

## Behind a proxy: `x-forwarded-for` and the per-IP cap

`x-forwarded-for` is forgeable by any client, so the relay ignores it by
default: with `RELAY_TRUST_PROXY_HOPS=0` (the default) the per-IP cap keys on
the TCP peer address alone. Behind a provider TLS terminator this collapses —
every connection arrives from the load balancer's IP, and `RELAY_MAX_PER_IP`
stops being a per-client cap and becomes a global admission cap: the first 20
sockets lock everyone else out.

If — and only if — you host the relay behind a known proxy chain, set
`RELAY_TRUST_PROXY_HOPS` to the number of layers in **your own** chain (a
single load balancer → `1`, LB + internal proxy → `2`). The relay then uses
the Nth entry counting from the right of `x-forwarded-for` as the cap key,
which is the address the nearest trusted proxy observed. A chain shorter than
the configured hops, a missing header, or a malformed entry falls back to the
TCP peer address, so a degraded proxy never produces a bogus key. Both
miss-configurations are bad in opposite directions: too few hops re-creates
the global-cap collapse above; too many hops lets a client shift the selected
entry into attacker-chosen values and rotate its per-IP budget. The header is
envelope metadata only — the relay never reads frame or key material, and the
end-to-end encryption guarantees are unaffected either way.

## Logs carry a derived IP tag, not the raw address (P2-174)

The relay writes no personal data to its JSONL log except one field: when a
connection is rejected by the per-IP cap, the `connection rejected:
per-IP cap exceeded` line carries `ipTag` — **not** the client's address.
The tag is the first 12 hex digits of `sha256(salt || address)`, where the
salt is 32 fresh random bytes generated once when the process boots. What
that means in practice:

- **Same tag inside one process ⇒ same origin.** Two rejections with the
  same `ipTag` while this instance is running came from the same source, so
  triage and per-source correlation keep working.
- **The tag changes at every restart.** A new process mints a new salt, so
  tags from yesterday match nothing today: cross-restart (and cross-provider)
  correlation of the same user is not possible from the log alone.
- **The tag is irreversible.** Inverting it would require guessing the
  process's random salt; the raw address is never written anywhere.

Admission, capping, proxy-hop resolution and rate limiting are untouched —
the raw address remains the internal cap key; only what reaches a log line
changed. No other relay log line ever carries a client address.

## Liveness probe

`GET /healthz` answers `200` with a counter-only JSON body and is safe to
expose publicly (no room ids, no per-peer metadata):

```json
{"ok":true,"version":"0.2.0","uptimeS":42,"rooms":1,"roomsRejected":0}
```

The image's `HEALTHCHECK` polls it locally every 30s; load balancers should
use the same path as the HTTP health check.

### During the drain: 503 on purpose (P2-145)

When the relay receives `SIGTERM` it enters a drain window (≤3s) and
`/healthz` deliberately answers **`503`** with `ok:false` and the additive
`draining:true` field — every pre-existing field keeps its name and meaning:

```json
{"ok":false,"version":"0.2.0","uptimeS":42,"rooms":1,"roomsRejected":0,"draining":true}
```

The 503 tells the load balancer to stop routing NEW daemons and phones to
this instance; WebSocket upgrades are refused the same way (plain-HTTP 503,
socket destroyed) instead of admitting a room that would die milliseconds
later with close `1001`. By design the container `HEALTHCHECK` therefore
sees the instance as **unhealthy during the drain** — that is the signal
that stops the balancer, not a defect. `RELAY_DRAIN_GRACE_MS` (default `0`,
ceiling `2000`) widens this window: after the signal the relay marks itself
draining, waits that many milliseconds *before* closing the live sockets, so
a balancer with a coarse polling interval has time to notice the 503 and
pull the instance out of rotation. An empty env reproduces the historical
shutdown sequence exactly.

## Metrics endpoint

`GET /metrics` (counters as JSON; add `?format=prom` for Prometheus text
format) is **off by default** and, when enabled via `RELAY_METRICS_PORT`,
binds `127.0.0.1` unless `RELAY_METRICS_BIND` says otherwise. Exposing it on
the network requires setting `RELAY_METRICS_TOKEN`: without a token the relay
refuses to start the listener on a non-loopback address and logs the reason
once at boot. With a token configured, requests without a matching
`Authorization: Bearer <token>` header receive a `401` with no body. Like
`/healthz`, the payload is counter-only — the relay is a blind router and the
metrics never carry plaintext or key material.

## Pointing a daemon at the hosted relay

The daemon picks its relay from `RELAY_URL` at install time:

```bash
RELAY_URL="wss://relay.example.com" ./deploy/install.sh
# or an existing install:
node cli.mjs setup --relay=wss://relay.example.com
```

Re-install / re-run setup with the new `RELAY_URL` and restart the daemon
service. The URL the daemon prints is the one embedded in pairing codes.

The daemon validates `RELAY_URL` at boot, fail-closed: only `ws://` and
`wss://` URLs are accepted, and plain `ws://` pointing at a non-loopback host
is refused — room metadata and pairing traffic would cross the network without
TLS. Loopback `ws://` (the `ws://127.0.0.1:8787` default) keeps working for
local installs. When validation fails the daemon does not dial the relay at
all: it logs the reason **once** at boot (no per-retry noise), `GET /api/health`
gains an additive `relay` field — `{ url, ok, reason }` while `relayConnected`
and `relayRetry` keep their shape — and the pairing QR is withheld (not
printed, and `/__ocr/pairing-uri` serves `null`), because a QR the phone can
never use is worse than none. The desktop app's local mode does not depend on
the relay and keeps working while the relay URL is invalid.

## Pointing the PWA at the hosted relay

The PWA is relay-only and gets the relay URL from the pairing code — there is
no separate setting. After switching relays, regenerate the pairing QR
(`node cli.mjs qr`) and pair the phone again; every previously paired device
keeps dialing the old relay until re-paired. Use `wss://` (never `ws://`) in
any public URL — browsers refuse `ws://` from `https://` pages.

## Upgrades and shutdown

`SIGTERM` triggers a graceful drain: the relay immediately marks itself as
draining (`/healthz` → 503, upgrades refused — see above), optionally waits
`RELAY_DRAIN_GRACE_MS`, closes every websocket with code `1001` (clients
reconnect with backoff), and exits `0` within ~3s — so `docker stop` /
redeploy loops are safe. Deploy order does not matter: daemons and PWAs
reconnect to the new relay automatically.
