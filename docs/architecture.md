# Architecture

```
[PWA (phone)] ⇄ [Relay] ⇄ [Daemon] ⇄ [opencode serve]
   passkey+QR     blind      E2E         localhost
```

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
live-connection cap (`RELAY_MAX_PER_IP`, default 20, 0 disables — the
surplus connection is closed with 1013 "too many connections" and counted
in `rejects` on `/metrics`), and a per-connection
token bucket on message frames (600 msgs/min sustained, burst 1000 —
`RELAY_RATE_PER_MIN` / `RELAY_RATE_BURST`, 0 disables). Defaults are sized to
pass the daemon's worst-case chunked transfer; a connection over budget is
disconnected with close code 4029 and counted in `rate_limited_total` on
`/metrics`. The budget applies to every frame including joins and
self-declared room owners: envelope metadata (`from`, `room`) is
client-controlled, so the relay grants no exemptions. Note the enforcement
point is the connection, not the handshake pub key — the key stays inside
the sealed E2E handshake, invisible to the relay by design. The bucket
resets on reconnect, so a device can trade a reconnect for a fresh budget;
total abuse stays bounded by the 1000-socket cap. `GET /healthz` is the one
public HTTP endpoint on the relay port — an unauthenticated liveness probe
answering `{ok, version, uptimeS, rooms, roomsRejected}` (counters only,
never room ids) for load balancers in the hosted stage; `/metrics` stays
loopback-only. Optional TLS (`wss://`)
or termination via Caddy.
Note the per-IP cap reads `req.socket.remoteAddress` — if you front the relay
with a TLS-terminating proxy every connection shares the proxy IP, so raise
`RELAY_MAX_PER_IP` (or route TCP passthrough) accordingly.

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
  state file, fresh read per handshake), audit log of pairing events,
  opencode watchdog.

### apps/web
React PWA. Non-extractable ECDH key in IndexedDB (XSS can use it while the
page lives, never exfiltrate it), WebAuthn biometric gate before use,
offline queue for outbound messages, chunked-download file previews,
multi-machine switcher. Service worker keeps an installable shell and routes
notification taps to hash deep-links. On the desktop shell (served over
`file://`) the service worker is not registered and Web Push stays
unavailable — registration there can only reject.

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
- Session keys are re-derived on every handshake; daemon restart invalidates
  them by design (clients auto-rehandshake transparently)
- The relay learns room ids and traffic volume, nothing else
- Uploads live in memory until consumed (30min TTL) or persisted to
  `~/.opencode-remote/uploads` when sent as `kind: "file"`
