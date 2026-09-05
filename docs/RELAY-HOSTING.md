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
job in `.github/workflows/release.yml`) and pushes two references to GHCR —
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
