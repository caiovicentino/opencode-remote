// P2-187: the phone relay address as a shell setting. The daemon sidecar used
// to always dial the compile-time default (ws://127.0.0.1:8787 — this
// machine's own loopback), so the QR shown on a packaged app pointed the phone
// at itself. This module is the pure decision core for the new Settings
// surface: it validates a raw relay address and resolves which address wins
// (env > stored > default), fail-closed. Same module hygiene as extlink.ts /
// permissions.ts / webviewguard.ts: NO electron, NO node:fs, no I/O — main.ts
// injects the environment and the persisted value at runtime, and
// scripts/unit.test.ts exercises every branch without booting a shell.
//
// Fail-closed in the P2-139 spirit: apps/daemon/src/relayurl.ts stays the
// FINAL authority on the address the daemon actually dials (it re-validates at
// boot and withholds the pairing URI on any problem). This module only
// decides what the shell hands to the sidecar and what the UI shows — a
// stored value that fails relayUrlProblems is never silently replaced by the
// default: the "stored-invalid" origin propagates so the app shows the error
// instead of minting a QR that lies.

/** Byte-for-byte the daemon's historical default (apps/daemon/src/index.ts). */
export const DEFAULT_RELAY_URL = "ws://127.0.0.1:8787";

/** Documented ceiling for a stored relay address — generous for a URL, small
 * enough to keep relay.json (and the Settings input) honest. */
export const RELAY_URL_MAX_LEN = 512;

/** Where the resolved address came from, surfaced verbatim in the UI. */
export type RelayUrlOrigin = "env" | "stored" | "default" | "stored-invalid";

export interface RelayUrlResolution {
  /** The address to hand to the sidecar spawn env (may be "" for a non-string
   * stored-invalid value — the daemon's own preflight then fails closed). */
  url: string;
  origin: RelayUrlOrigin;
  /** Empty means valid. Non-empty means: show the error, never a QR. */
  problems: string[];
}

/**
 * True only for provably loopback hosts — the SAME strict rule as
 * isLoopbackHost in apps/daemon/src/relayurl.ts (the boot authority):
 * "localhost", IPv6 ::1, or 127.0.0.0/8 matched as a STRICT dotted-quad with
 * octets <= 255. Duplicated on purpose (a workspace import would run the
 * daemon's main() at import time); scripts/unit.test.ts proves parity on a
 * shared host table.
 */
export function isLoopbackHost(host: string): boolean {
  // non-special schemes (ws/wss) keep the IPv6 brackets in URL.hostname
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost" || h === "::1") return true;
  const quad = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!quad) return false;
  return quad.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Validate a raw relay address (any type — the value may come from disk, from
 * the renderer over IPC or from the environment, so nothing is trusted).
 * Empty problems = valid. Messages are English, log-safe and never echo the
 * raw value (it may embed credentials).
 */
export function relayUrlProblems(raw: unknown): string[] {
  if (typeof raw !== "string") return ["RELAY_URL must be a string"];
  if (raw.trim() === "") return ["RELAY_URL is empty"];
  if (raw.length > RELAY_URL_MAX_LEN) {
    return [`RELAY_URL is longer than the documented ceiling of ${RELAY_URL_MAX_LEN} characters`];
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return ["RELAY_URL is not a valid URL: refusing to use it (fail-closed)"];
  }
  const problems: string[] = [];
  // WHATWG URL already lowercases the protocol; compare lowercase anyway so a
  // future refactor stays correct (P2-178 lesson: scheme confusion).
  const scheme = url.protocol.toLowerCase();
  if (scheme !== "ws:" && scheme !== "wss:") {
    problems.push(
      `RELAY_URL scheme ${JSON.stringify(scheme)} is not supported — only ws:// and wss:// are accepted`,
    );
  }
  if (scheme === "ws:" && !isLoopbackHost(url.hostname)) {
    problems.push(
      `RELAY_URL points at non-loopback host ${JSON.stringify(url.host)} over plain ws:// — ` +
        "pairing traffic would cross the network without TLS",
    );
  }
  if (url.username !== "" || url.password !== "") {
    problems.push("RELAY_URL embeds user/password credentials — remove them (fail-closed)");
  }
  return problems;
}

/**
 * Precedence for the address handed to every sidecar spawn:
 * 1. env.RELAY_URL (present and non-empty) ALWAYS wins — the operator/dev
 *    path is preserved byte-for-byte; problems are UI surface only, the
 *    daemon's own boot preflight stays the final gatekeeper.
 * 2. A valid stored value comes next (trimmed).
 * 3. A present-but-INVALID stored value NEVER falls back silently to the
 *    default — origin "stored-invalid" with problems filled, so the app can
 *    show the error instead of generating a lying QR.
 * 4. Nothing set → the historical loopback default, unchanged.
 */
export function resolveRelayUrl(env: { RELAY_URL?: string }, stored: unknown): RelayUrlResolution {
  const fromEnv = env.RELAY_URL;
  if (typeof fromEnv === "string" && fromEnv !== "") {
    return { url: fromEnv, origin: "env", problems: relayUrlProblems(fromEnv) };
  }
  if (typeof stored === "string") {
    const problems = relayUrlProblems(stored);
    if (problems.length === 0) {
      return { url: stored.trim(), origin: "stored", problems: [] };
    }
    // Fail-closed: never pretend the default is in effect.
    return { url: stored, origin: "stored-invalid", problems };
  }
  if (stored !== null && stored !== undefined) {
    return { url: "", origin: "stored-invalid", problems: relayUrlProblems(stored) };
  }
  return { url: DEFAULT_RELAY_URL, origin: "default", problems: [] };
}
