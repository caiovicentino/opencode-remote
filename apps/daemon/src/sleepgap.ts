// P2-349: sleep/wake detection for a daemon running WITHOUT the desktop
// shell (CLI boot, or the shell that has not come up yet). The shell reacts
// to `powerMonitor` wake events and asks the daemon to redial (P2-327); with
// no shell there is no such signal, and a Mac that slept left the relay
// socket dead without a close event — the phone stayed "connecting" until
// the dead socket timed out. This module reads the one signal every daemon
// already has: its own 60 s upstream-probe tick. A gap between two ticks far
// above the expected interval means the process was suspended — the machine
// slept and woke, and the tick that fires right after the wake should
// anticipate the relay reconnect wait.
//
// Pure on purpose — no network, no fs, no timers, no imports at all:
// index.ts runs main() on import, so unit tests must never boot a daemon
// (same pattern as relayclose.ts / relayredial.ts / relayretry.ts).

/** The closed set of tick-gap verdicts. */
export type SleepGapVerdict = "steady" | "woke";

/**
 * Classify the gap between two ticks of a periodic probe.
 *
 * `woke` requires a clock gap STRICTLY above three expected intervals —
 * three missed ticks in a row is the documented wake threshold (a healthy
 * tick lands within one interval; a brief hiccup or a busy event loop
 * reaching two is still steady). Fail-closed by construction: a clock that
 * moves backwards (NTP correction, VM resume) or ANY non-finite input
 * (including a non-positive or non-finite interval) returns `steady` — a
 * meaningless signal never triggers a redial.
 */
export function sleepGapVerdict(
  expectedTickIntervalMs: number,
  lastTickInstant: number,
  currentInstant: number,
): SleepGapVerdict {
  if (
    !Number.isFinite(expectedTickIntervalMs) ||
    !Number.isFinite(lastTickInstant) ||
    !Number.isFinite(currentInstant)
  ) {
    return "steady";
  }
  // A non-positive interval makes the threshold meaningless (every gap
  // would exceed it) — invalid configuration never reports a wake.
  if (expectedTickIntervalMs <= 0) return "steady";
  // Clock went backwards: a wake verdict on a rewound clock would redial on
  // every NTP correction — never.
  if (currentInstant < lastTickInstant) return "steady";
  return currentInstant - lastTickInstant > expectedTickIntervalMs * 3 ? "woke" : "steady";
}
