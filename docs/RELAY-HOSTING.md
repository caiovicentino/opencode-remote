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
| `RELAY_METRICS_PORT` | unset (off) | Leave unset in containers: the metrics endpoint binds `127.0.0.1` on purpose, which is unreachable from outside the container. Enable it only for a scraper sharing the network namespace (e.g. k8s sidecar). |
| `RELAY_MAX_PER_IP` | `20` | Keep the default. Raise it only when many devices legitimately share one egress IP (office NAT, corporate VPN). `0` disables the cap. |
| `RELAY_TLS_CERT` | unset | Leave unset — TLS belongs to the provider's load balancer; the relay then serves plain `ws://` internally and the outside world dials `wss://`. |
| `RELAY_TLS_KEY` | unset | Leave unset. Set `RELAY_TLS_CERT` + `RELAY_TLS_KEY` **together** only when the relay terminates TLS itself (no LB in front): both files must be readable by the `node` user, and the relay serves `wss://` directly. |

The relay also accepts `RELAY_RATE_PER_MIN`, `RELAY_RATE_BURST` (per-connection
token bucket) and `RELAY_PING_INTERVAL_S` (stale-socket sweep). The defaults
are already sized to pass the daemon's worst-case chunked transfer — leave them
alone unless you have a specific abuse pattern.

## Liveness probe

`GET /healthz` answers `200` with a counter-only JSON body and is safe to
expose publicly (no room ids, no per-peer metadata):

```json
{"ok":true,"version":"0.2.0","uptimeS":42,"rooms":1,"roomsRejected":0}
```

The image's `HEALTHCHECK` polls it locally every 30s; load balancers should
use the same path as the HTTP health check.

## Pointing a daemon at the hosted relay

The daemon picks its relay from `RELAY_URL` at install time:

```bash
RELAY_URL="wss://relay.example.com" ./deploy/install.sh
# or an existing install:
node cli.mjs setup --relay=wss://relay.example.com
```

Re-install / re-run setup with the new `RELAY_URL` and restart the daemon
service. The URL the daemon prints is the one embedded in pairing codes.

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
