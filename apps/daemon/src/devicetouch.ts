// P2-194: stable device labels + last-access touch. Pure module — no
// node:fs, node:http or ws imports on purpose, because index.ts runs main()
// on import and unit tests must never boot a daemon (same pattern as
// pairwindow.ts / relayurl.ts).
//
// Two phones paired back in the "first" era looked identical in the devices
// list: same label, no activity signal — revoking a lost device was a guess
// between public-key prefixes. This module owns the two fixes:
//
// - nextDeviceLabel(): every new pairing gets a stable, personal-data-free
//   label ("Telefone 1", "Telefone 2", ...) that skips numbers already in
//   use, replacing the hardcoded "first".
// - touchDecision(): the allowlist stores each client's last successful
//   handshake, but daemon.json must NOT be rewritten once per frame — the
//   state file is 0600 safety-critical and an SSD is not a telemetry buffer.
//   The stamp is therefore throttled: it only persists when the previous
//   value is older than the documented interval. That makes the timestamp
//   intentionally approximate ("last seen within the hour"), which is
//   exactly what a human revoking a lost device needs — and it keeps the
//   write amplification at one tiny rewrite per client per interval.

/** Minimum documented gap between last-seen writes for one client: 1 hour. */
export const DEVICE_TOUCH_INTERVAL_MS = 60 * 60_000;

export type TouchDecision = "write" | "skip";

/**
 * Should this handshake persist a fresh last-seen stamp? Pure: `now` is
 * injected, never read from the clock.
 *
 * - Missing/empty/unparseable/non-string stamp → write (never seen or
 *   unreadable state must converge to a real stamp on the next handshake).
 * - Stamp in the future → skip: a clock ahead of itself must never force a
 *   write loop; the stamp stays until real time catches up.
 * - Stamp at least `intervalMs` old → write; anything fresher → skip.
 */
export function touchDecision(previous: unknown, now: number, intervalMs: number): TouchDecision {
  if (typeof previous !== "string") return "write";
  if (previous.trim() === "") return "write";
  const ts = Date.parse(previous);
  if (Number.isNaN(ts)) return "write";
  if (ts > now) return "skip";
  if (now - ts >= intervalMs) return "write";
  return "skip";
}

/**
 * Next stable device label: "Telefone" followed by the smallest positive
 * number not already taken by a "Telefone <n>" label in the list. Contains
 * no personal data and no timestamps — it only has to be stable and
 * distinguishable, so Settings can say "Telefone 2" instead of asking the
 * owner to compare public-key prefixes.
 */
export function nextDeviceLabel(existingLabels: string[]): string {
  const used = new Set<number>();
  for (const label of existingLabels) {
    const m = /^Telefone (\d+)$/.exec(label ?? "");
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n++;
  return `Telefone ${n}`;
}
