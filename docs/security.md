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

## Threat notes

- A compromised relay can DoS you (drop frames) but cannot read, alter or
  forge content.
- Malicious image attachments are downscaled and re-encoded by the browser
  canvas before reaching the daemon; session history is rendered as text
  with sandboxed iframes for HTML previews.
- The daemon executes whatever opencode's permission system allows. The
  remote adds a biometric gate on top — approvals should still be read
  (use the diff preview).

## Key rotation

Delete `~/.opencode-remote/daemon.json` (or `manage.ts revoke-all`) and
re-pair: a fresh daemon identity invalidates every previously paired client.
