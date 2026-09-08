// Bug 1 (P0, "silent crypto death"): the daemon used to log "undecryptable
// frame (auth failure)" and DROP the frame. The phone rendered its own
// message locally and then heard nothing — no error, no recovery path. This
// pure module holds every decision behind the structured reply the daemon
// now sends back: the clear `session-reauth-required` control frame, the
// per-sender reply throttle, the 24h "key expired" ledger the devices routes
// expose to the desktop, and the attribution of a failed frame to an
// allowlisted device.
//
// Pure on purpose — no node:fs, node:http, node:crypto, ws or fetch — because
// index.ts runs main() on import and unit tests must never boot a daemon
// (same hygiene as devicestale.ts, devicetouch.ts, pairwindow.ts).
//
// CONSTITUTION BOUNDARY: nothing here revokes, writes daemon.json, touches
// the handshake or the replay guard. The ledger is in-memory insight only
// and dies with the process (documented: after a restart every device reads
// as "key ok" until it fails again). Attribution is derived from the clear
// public key the sender itself presented (hello.clientPub / the session's
// pub) and the `from` id is attacker-writable at the relay, so a forged
// garbage frame CAN stamp a real device as "key expired" — the cost is one
// misleading info-only hint on the desktop, never a wipe, never a revoke,
// and the client side verifies every reauth hint before acting on it.
//
// Phrases are static pt-BR and never contain a public key, key prefix,
// label, address, port, path or secret (P2-140/P2-182).

import type { ReauthRequired } from "@ocr/protocol";

/** Wire type of the clear control frame. Mirrors framegate.ts on the client. */
export const REAUTH_CONTROL_TYPE = "session-reauth-required";

/** A device whose frames failed auth inside this window reads as "key expired". */
export const AUTH_FAILURE_WINDOW_MS = 24 * 60 * 60_000;

/** At most one reauth reply per sender id per interval — a client that keeps
 * sealing with the wrong key would otherwise get one clear frame per op. */
export const REAUTH_REPLY_MIN_INTERVAL_MS = 2_000;

/** Same prefix length the daemon already logs/audits for public keys. */
export const DEVICE_ID_PREFIX_LEN = 16;

/** Bounded ledger: newest 256 devices by last failure; older entries evict. */
export const AUTH_FAILURE_LEDGER_CAP = 256;

/** Short, non-secret device id from a public key (never the full key). */
export function deviceIdOf(pub: unknown): string | null {
  if (typeof pub !== "string" || pub.trim() === "") return null;
  return pub.slice(0, DEVICE_ID_PREFIX_LEN);
}

export type AuthFailureKind = "known-stale" | "unknown";

/**
 * Attribute an auth failure: the sender presented (or the session carries) a
 * public key that IS in the allowlist — so the device is known and its keys
 * merely went stale — or it is not (never paired / revoked / garbage).
 */
export function classifyAuthFailure(allowlistPubs: readonly string[], pub: string | null): AuthFailureKind {
  if (!pub) return "unknown";
  return allowlistPubs.includes(pub) ? "known-stale" : "unknown";
}

/** The clear control frame body. `pub` null → deviceId null (unknown sender). */
export function reauthControl(pub: string | null): ReauthRequired {
  return { type: REAUTH_CONTROL_TYPE, deviceId: deviceIdOf(pub) };
}

/** Per-sender throttle: reply when no reply went out inside the interval. */
export function reauthReplyDecision(
  lastReplyAt: number | undefined,
  now: number,
  minIntervalMs: number,
): "reply" | "suppress" {
  if (!Number.isFinite(now)) throw new TypeError("reauthReplyDecision: non-finite 'now' refused (fail-closed)");
  if (lastReplyAt === undefined || !Number.isFinite(lastReplyAt)) return "reply";
  return now - lastReplyAt >= minIntervalMs ? "reply" : "suppress";
}

/** In-memory "last auth failure per public key" — bounded, process-lived. */
export class AuthFailureLedger {
  private readonly last = new Map<string, number>();

  constructor(private readonly cap: number = AUTH_FAILURE_LEDGER_CAP) {}

  record(pub: string, now: number): void {
    if (!pub || !Number.isFinite(now)) return;
    // re-insert so Map order stays "oldest first" for eviction
    this.last.delete(pub);
    this.last.set(pub, now);
    while (this.last.size > this.cap) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
  }

  lastFailureAt(pub: string): number | undefined {
    return this.last.get(pub);
  }

  get size(): number {
    return this.last.size;
  }
}

export interface KeyExpiredReport {
  /** True when a frame from this device failed auth inside the window. */
  keyExpired: boolean;
  /** ISO stamp of the newest failure (absent when keyExpired is false). */
  authFailedAt?: string;
  /** Static pt-BR phrase (absent when keyExpired is false). */
  keyPhrase?: string;
}

const KEY_EXPIRED_PHRASE = "Chave expirada — pareie de novo.";

/**
 * Additive devices-route verdict. Rules, in order: no recorded failure →
 * not expired; a non-finite `now` is refused; a failure stamp in the future
 * counts as just-now (clock ahead of itself, P2-214); inside the window →
 * expired with stamp + phrase; strictly above the window → not expired.
 */
export function keyExpiredVerdict(
  lastFailureAt: number | undefined,
  now: number,
  windowMs: number,
): KeyExpiredReport {
  if (lastFailureAt === undefined || !Number.isFinite(lastFailureAt)) return { keyExpired: false };
  if (!Number.isFinite(now)) throw new TypeError("keyExpiredVerdict: non-finite 'now' refused (fail-closed)");
  const age = Math.max(0, now - lastFailureAt);
  if (age > windowMs) return { keyExpired: false };
  return {
    keyExpired: true,
    authFailedAt: new Date(lastFailureAt).toISOString(),
    keyPhrase: KEY_EXPIRED_PHRASE,
  };
}
