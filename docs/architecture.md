# Architecture

```
[PWA (phone)] ⇄ [Relay] ⇄ [Daemon] ⇄ [opencode serve]
   passkey+QR     blind      E2E         localhost

[Desktop shell (same Mac)] ⇄ ws://127.0.0.1:8792/ws  (direct, no relay)
```

## Local direct mode (P1-061)

When the desktop shell and the daemon share a machine, the app dials
`ws://127.0.0.1:8792/ws?token=…` directly instead of routing every frame
through the relay. The daemon serves this WS on the same loopback server as
its API/metrics port and gates it on the `apiToken` from the 0600 state file,
a `remoteAddress` loopback re-check and a loopback-Origin allowlist (absent,
`file://`/`null` or loopback hosts — arbitrary web pages are rejected).
Frames are the exact same sealed `RelayFrame` envelopes used over the relay:
handshake, allowlist and replay guard are identical, so no plaintext route
exists. Deploy kickstarts of the relay no longer touch a local session, and a
daemon kickstart only costs a quick redial: on any reconnect the client
refetches the open conversation (stream resync), so messages produced during
the gap appear without a resend. Transport selection is local-first and
sticky, failing over to the relay after 2 consecutive local failures (PWA and
remote phones always use the relay). The current transport is visible in
Settings → About ("Connection: direct (local) / via relay").

## Components

### packages/protocol
Shared crypto and wire types. ECDH P-256 identities, HKDF → AES-256-GCM
session keys, sequence numbers bound as AAD (replay/reorder protection).
No trusted third party: the pairing QR carries the daemon's public key and
the handshake proves both sides possess the matching secret.

### apps/relay
A blind router. Forwards opaque `RelayFrame` envelopes between sockets that
share a room id. Deliberately cannot decrypt, forge or reorder payloads.
Room ids must match the daemon's grammar — a string of 8–128 chars from
`[A-Za-z0-9_-]` (the daemon generates `randomUUID` with hyphens stripped,
32 hex chars) — and a socket may occupy at most 8 distinct rooms at once
(re-joins of rooms it already holds are free). Frames with an invalid id or
from a socket over that cap are dropped without disconnecting and counted in
`rooms_rejected` on `/metrics` and `/healthz`; together with the per-socket
cap this keeps the rooms map bounded against memory DoS on the public relay.
Resource limits: 1MB/frame, 1000 sockets, 10 peers/room, a per-IP
live-connection cap (`RELAY_MAX_PER_IP`, default 20 — the
surplus connection is closed with 1013 "too many connections" and counted
in `rejects` on `/metrics`), and a per-connection
token bucket on message frames (600 msgs/min sustained, burst 1000 —
`RELAY_RATE_PER_MIN` / `RELAY_RATE_BURST`). The per-IP cap keys
on a normalized address (`normalizeIp`): IPv4-mapped IPv6
(`::ffff:a.b.c.d`) unmasks to the plain IPv4 and other IPv6 sources
aggregate by their /64 prefix, so one dual-stack host gets one budget
instead of 2^64 (IPv4 and `::1` are kept as-is). Defaults are sized to
pass the daemon's worst-case chunked transfer; a connection over budget is
disconnected with close code 4029 and counted in `rate_limited_total` on
`/metrics`. The budget applies to every frame including joins and
self-declared room owners: envelope metadata (`from`, `room`) is
client-controlled, so the relay grants no exemptions. Note the enforcement
point is the connection, not the handshake pub key — the key stays inside
the sealed E2E handshake, invisible to the relay by design. The bucket
resets on reconnect, so a device can trade a reconnect for a fresh budget;
total abuse stays bounded by the 1000-socket cap. A ws-level liveness sweep
(P2-067) pings every socket every `RELAY_PING_INTERVAL_S` (default 30)
and terminates peers silent for more than two cycles, so a
client that vanished without a close frame (phone lost wifi, laptop slept)
no longer holds a socket slot or its per-IP budget until restart — rooms
and IP slots release through the normal close path, and the sweep is
counted in `stale_terminated` on `/metrics`. All five tuning knobs
(`RELAY_RATE_PER_MIN`, `RELAY_RATE_BURST`, `RELAY_MAX_PER_IP`,
`RELAY_TRUST_PROXY_HOPS`, `RELAY_PING_INTERVAL_S`) are
validated fail-closed at boot (P2-171): a non-numeric, negative, fractional
or zero value (zero is valid only for the proxy hops) or a value above the
knob's documented ceiling refuses to start the relay instead of silently
keeping the default. `GET /healthz` is the one
public HTTP endpoint on the relay port — an unauthenticated liveness probe
answering `{ok, version, uptimeS, rooms, roomsRejected, roomsBudgetTerminated}`
(counters only, never room ids; the P2-243 room-budget counter is additive)
for load balancers in the hosted stage; `/metrics` stays
loopback-only. Optional TLS (`wss://`)
or termination via Caddy.
Note the per-IP cap reads (a normalized form of) `req.socket.remoteAddress`
— if you front the relay with a TLS-terminating proxy every connection
shares the proxy IP, so raise `RELAY_MAX_PER_IP` (or route TCP passthrough)
accordingly.

### apps/daemon
Runs next to `opencode serve`. Responsibilities:
- **Tunnel**: HTTP-shaped ops (`OpRequest`) proxied to the opencode server,
  responses sealed back. Oversized bodies are split into `res-chunk` frames
  and reassembled client-side.
- **Event pump**: SSE `/event` → broadcast to every paired client; permission
  requests and idle turns become web pushes (VAPID).
- **Media**: chunked uploads (images become data URLs; videos are persisted
  for the agent's ffmpeg), whisper transcription, file delivery with an
  allowlist of roots (uploads dir, Desktop, Downloads, Documents, repo cwd).
- **Routines**: local-time scheduled prompts, result saved as markdown and
  pushed with deep-link.
- **Skills**: saved prompts rendered as 1-tap chips in the composer.
- **Security**: client allowlist (first QR pairing bootstraps it, 0600
  state file, fresh read per handshake), audit log of pairing events
  (0600, capped at ~1 MB with rotation to `audit.log.1`), opencode watchdog.

### apps/web
React PWA. Non-extractable ECDH key in IndexedDB (XSS can use it while the
page lives, never exfiltrate it), WebAuthn biometric gate before use,
offline queue for outbound messages, chunked-download file previews,
multi-machine switcher. Service worker keeps an installable shell and routes
notification taps to hash deep-links. On the desktop shell (served over
`file://`) the service worker is not registered and Web Push stays
unavailable — registration there can only reject.

### apps/desktop
Electron shell around the same web build. Since P2-276 the native menu bar
and the tray follow the language chosen inside the app: the renderer pushes
its saved choice over a one-way IPC channel (`ocr:shell-lang`), the pure
verdict in `src/shelllang.ts` resolves it (a supported preference always
wins; without one, the OS locale decides; anything else falls back to en)
and the shell rebuilds both surfaces from that module's static label tables —
ids, order and accelerators never move.

### PWA static origin (deploy/pwa-server.mjs + launchd, P2-075)
The phone's origin is **not** a dev server: `deploy/install.sh` installs
`com.ocr.pwa`, a launchd service (`RunAtLoad` + `KeepAlive`) that runs
`deploy/pwa-server.mjs` — a dependency-free node http server binding
`127.0.0.1:5173` and serving `apps/web/dist` (the same build the desktop
shell loads). `tailscale serve` proxies the tailnet hostname to that port, so
a clean reboot leaves the PWA reachable at
`https://<host>.ts.net` with no manual step. Details:

- **Health probe**: `GET /healthz` answers `{"ok":true}` unauthenticated on
  the loopback port (it leaks nothing — a fixed literal).
- **Watchdog**: the daemon probes `/healthz` every 60s (only on hosts where
  `PWA_HEALTHZ_URL` is set or the `com.ocr.pwa` plist exists — sidecars on
  other machines stay silent) and on flip appends a `[pwa] origin` event to
  the dashboard feed, lights the red "📵 PWA ORIGIN DOWN" chip and pushes the
  paired phones. Recovery clears the chip.
- **Deploys**: after `npm run build`, the pilot's deploy kickstarts
  `com.ocr.relay`, `com.ocr.daemon` and `com.ocr.pwa` (the last one
  best-effort: the service only exists after `deploy/install.sh` ran once).
  Static files are read per request, so even without a kickstart the origin
  serves the new build; hashed `/assets/*` are `immutable`, the shell files
  are `no-cache`.

## Data flow (one op)

1. PWA seals `{ type: "op", req }` with the session key + AAD(sender, seq)
2. Relay reads `room`, forwards to sockets in the room — content opaque
3. Daemon opens the seal (AAD check = replay/reorder guard), executes the op
   against `opencode serve` or its own `/__ocr/*` endpoints
4. Response sealed back with AAD(daemon room, seq); bodies >900KB travel as
   `res-chunk` frames the client reassembles byte-exact
5. Client state machine (`connecting → paired`) drives the heartbeat: 20s
   app-level ping/pong, forced reconnect on resume-from-background

## Constraints worth knowing

- SIGTERM/SIGINT trigger a graceful daemon shutdown (P2-020): new API
  connections stop, relay/client websockets are closed with code 1001, a
  ≤3s drain timer bounds the wait and the process exits 0; a second signal
  exits immediately. Clients auto-rehandshake on the next boot.
- The relay has the same graceful shutdown (P2-023): `launchctl kickstart -k`
  on deploy stops new admissions (`server.close`), sends every ws client a
  close 1001 ("server shutting down"), logs a final JSONL line with uptime
  and closed connections, and exits 0 within the ≤3s drain window; a second
  signal exits immediately.
- Session keys are re-derived on every handshake; daemon restart invalidates
  them by design (clients auto-rehandshake transparently)
- The relay learns room ids and traffic volume, nothing else
- Uploads live in memory until consumed (30min TTL) or persisted to
  `~/.opencode-remote/uploads` when sent as `kind: "file"`
