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
Resource limits: 1MB/frame, 1000 sockets, 10 peers/room, and a per-connection
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
total abuse stays bounded by the 1000-socket cap. Optional TLS (`wss://`)
or termination via Caddy.

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
notification taps to hash deep-links.

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

- Session keys are re-derived on every handshake; daemon restart invalidates
  them by design (clients auto-rehandshake transparently)
- The relay learns room ids and traffic volume, nothing else
- Uploads live in memory until consumed (30min TTL) or persisted to
  `~/.opencode-remote/uploads` when sent as `kind: "file"`
