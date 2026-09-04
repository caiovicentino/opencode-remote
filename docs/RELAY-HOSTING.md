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
| `RELAY_METRICS_PORT` | unset (off) | Leave unset in containers unless a scraper needs it. When set, the endpoint serves counters on `/metrics` (JSON, or Prometheus text with `?format=prom`). |
| `RELAY_METRICS_BIND` | `127.0.0.1` | Keep the loopback default unless your scraper sits outside the container (k8s sidecars share the network namespace and don't need it). Any non-loopback address **requires** `RELAY_METRICS_TOKEN` — the relay refuses to boot the metrics endpoint on a network-exposed interface without one (fail-closed) and logs the reason instead. |
| `RELAY_METRICS_TOKEN` | unset (no auth) | Required whenever `RELAY_METRICS_BIND` leaves loopback. Scrapers must send `Authorization: Bearer <token>`; every other request gets an empty `401`. The endpoint exposes envelope counters only — no plaintext, no key material, no room ids. |
| `RELAY_MAX_PER_IP` | `20` | Keep the default. Raise it only when many devices legitimately share one egress IP (office NAT, corporate VPN). `0` disables the cap. |
| `RELAY_TRUST_PROXY_HOPS` | `0` | Leave `0` on direct exposure. Set it **only** to the exact number of trusted proxy layers in front of the relay (e.g. `1` for a single provider load balancer doing TLS termination) — see the section below. |
| `RELAY_TLS_CERT` | unset | Leave unset — TLS belongs to the provider's load balancer; the relay then serves plain `ws://` internally and the outside world dials `wss://`. |
| `RELAY_TLS_KEY` | unset | Leave unset. Set `RELAY_TLS_CERT` + `RELAY_TLS_KEY` **together** only when the relay terminates TLS itself (no LB in front): both files must be readable by the `node` user, and the relay serves `wss://` directly. |

The relay also accepts `RELAY_RATE_PER_MIN`, `RELAY_RATE_BURST` (per-connection
token bucket) and `RELAY_PING_INTERVAL_S` (stale-socket sweep). The defaults
are already sized to pass the daemon's worst-case chunked transfer — leave them
alone unless you have a specific abuse pattern.

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

## Liveness probe

`GET /healthz` answers `200` with a counter-only JSON body and is safe to
expose publicly (no room ids, no per-peer metadata):

```json
{"ok":true,"version":"0.2.0","uptimeS":42,"rooms":1,"roomsRejected":0}
```

The image's `HEALTHCHECK` polls it locally every 30s; load balancers should
use the same path as the HTTP health check.

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

`SIGTERM` triggers a graceful drain: the relay stops accepting, closes every
websocket with code `1001` (clients reconnect with backoff), and exits `0`
within ~3s — so `docker stop` / redeploy loops are safe. Deploy order does
not matter: daemons and PWAs reconnect to the new relay automatically.
