# Security model

Trust anchor = the QR code shown by *your* daemon on *your* machine. No
identity servers, no accounts.

## Properties

1. **Non-extractable client identity.** The PWA generates an ECDH P-256 key
   with `extractable: false` in IndexedDB. Malicious scripts can use the key
   through WebCrypto while the page lives but cannot export it.
2. **Biometric gate.** WebAuthn with `userVerification: "required"` is
   enforced before the identity key may be used (Face ID / Touch ID / PIN).
   Enrollment is optional; verification activates on first use.
3. **Mutually authenticated handshake.** The client seals a token with the
   session key it derived from the daemon's public key; only the daemon that
   owns the private key can open it. No MITM without the QR's key material.
4. **Replay/reorder protection.** Every frame's sequence number is bound as
   AES-GCM AAD together with the sender id. The relay cannot reorder, replay
   or recombine frames without breaking authentication.
5. **Blind relay.** Ciphertext plus room id. Host it anywhere — VPS, a
   friend's box — the E2E guarantees are unaffected.
6. **Allowlist.** First pairing bootstraps it; afterwards only listed client
   keys connect. Revocation is instant (state file re-read per handshake) and
   available from the app or `manage.ts revoke-all`.
7. **Least-privilege file delivery.** Downloads are restricted to explicit
   roots (`~/.opencode-remote/uploads`, Desktop, Downloads, Documents, repo
   cwd) and resolved against real paths before serving.
8. **Audit trail.** Pairing, rejection, connection, revocation and expiry
   events land in `~/.opencode-remote/audit.log` and surface in
   Settings → Security log.
9. **Local direct mode (P1-061).** The desktop shell reads the `apiToken`
   from the 0600 state file in the (privileged) main process and hands it to
   the sandboxed renderer so it can dial the daemon's loopback WS
   (`ws://127.0.0.1:8792/ws`). This deliberately relaxes the old "renderer
   never sees the apiToken" rule: the renderer is a same-user process, the
   token is only valid on loopback, the upgrade additionally enforces a
   loopback-Origin allowlist (arbitrary web pages cannot hold local sockets),
   and every application payload stays E2E-sealed end to end — the local WS
   speaks the exact same sealed-frame protocol as the relay. The token is
   never logged and the daemon never logs the upgrade URL.
   **Local auto-connect (P1-070).** The same read now also surfaces `room` +
   `ecdhPub` to the renderer so it can derive the local pairing itself and
   boot straight into the chat with no QR ceremony. The trust domain is
   unchanged: same 0600 file, loopback-only credentials, same-user renderer.
   The local pairing is re-derived on every boot and never persisted to
   localStorage, and the pairing URI/QR hunt stays disabled unless the user
   explicitly opts into remote pairing.

## Threat notes

- A compromised relay can DoS you (drop frames) but cannot read, alter or
  forge content.
- A rogue device cannot sustain a flood through the relay: message frames are
  token-bucketed per connection (600 msgs/min, burst 1000, tunable via env)
  and the over-budget socket is dropped with close code 4029. Every frame
  counts — joins and self-declared room owners included — because envelope
  metadata is attacker-controllable. The budget resets on reconnect, so a
  determined flooder can trade reconnects for fresh bursts; total abuse is
  bounded by the relay's 1000-socket cap. The relay stays blind — limits use
  only envelope metadata, never payload content.
- Malicious image attachments are downscaled and re-encoded by the browser
  canvas before reaching the daemon; session history is rendered as text
  with sandboxed iframes for HTML previews.
- The daemon executes whatever opencode's permission system allows. The
  remote adds a biometric gate on top — approvals should still be read:
  the approval card previews the first lines of the requested
  command/patch, and the diff button opens the full file changes.

## Key rotation

Delete `~/.opencode-remote/daemon.json` (or `manage.ts revoke-all`) and
re-pair: a fresh daemon identity invalidates every previously paired client.
