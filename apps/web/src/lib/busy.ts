// P3-409: derives the set of busy agent sessions from the event stream the
// App already receives in bumpUnread, so the desktop shell can decide whether
// to hold the machine awake (apps/desktop/src/awakeplan.ts). Pure: no DOM,
// no Electron, no timers — the caller supplies `now`, and only the COUNT
// travels to the shell over its own ocr:busy preload channel, mirroring the
// best-effort push design of lib/unread.ts and lib/asks.ts.
//
// Membership is decided EXCLUSIVELY by three event types:
//   - session.status with properties.status.type "busy"  → busy
//   - session.status with properties.status.type "idle"  → not busy
//   - session.idle / session.error                       → not busy
// Any other event from a session that is already busy is liveness only: it
// refreshes the entry's timestamp so the documented expiry never releases a
// session that is still producing events. Entries older than the expiry are
// stale (a vanished renderer, a dead stream) and stop counting — the shell's
// own 4h ceiling (AWAKE_HOLD_CEILING_MS) is the backstop when no event ever
// arrives again.

/** Documented expiry (ms): a busy entry whose session produced no event for
 * this long is stale and stops counting. A working session emits events far
 * more often than this. */
export const BUSY_EXPIRY_MS = 15 * 60 * 1000;

/** sessionID → last instant (ms) the session proved busy/alive. */
export type BusyState = Record<string, number>;

/** Minimal structural event (the protocol's EventEnvelope is compatible). */
export interface BusyEvent {
  type: string;
  properties?: unknown;
}

interface BusyProps {
  sessionID?: string;
  info?: { sessionID?: string };
  status?: { type?: unknown };
}

function sidOf(evt: BusyEvent): string | null {
  const p = (evt.properties ?? {}) as BusyProps;
  const sid = p.sessionID ?? p.info?.sessionID;
  return typeof sid === "string" && sid ? sid : null;
}

/** Copy-without-sid that keeps the same reference when the key is absent. */
function omit(state: BusyState, sid: string): BusyState {
  if (!(sid in state)) return state;
  const { [sid]: _drop, ...rest } = state;
  return rest;
}

/** Drop entries that expired at `now`; keeps the same reference when nothing
 * expired so a React caller can distinguish real changes. */
function prune(state: BusyState, now: number): BusyState {
  let stale = false;
  for (const ts of Object.values(state)) {
    if (now - ts >= BUSY_EXPIRY_MS) {
      stale = true;
      break;
    }
  }
  if (!stale) return state;
  const out: BusyState = {};
  for (const [sid, ts] of Object.entries(state)) {
    if (now - ts < BUSY_EXPIRY_MS) out[sid] = ts;
  }
  return out;
}

/**
 * Fold one event into the busy state. Pure: the same (state, event, now)
 * triple always produces the same result, and calls that change nothing
 * return the same reference.
 */
export function reduceBusy(state: BusyState, evt: BusyEvent, now: number): BusyState {
  const sid = sidOf(evt);
  if (!sid) return state;
  if (evt.type === "session.status") {
    const status = ((evt.properties ?? {}) as BusyProps).status?.type;
    if (status === "busy") {
      return { ...prune(state, now), [sid]: now };
    }
    if (status === "idle") {
      return prune(omit(state, sid), now);
    }
    return prune(state, now);
  }
  if (evt.type === "session.idle" || evt.type === "session.error") {
    return prune(omit(state, sid), now);
  }
  // Liveness: a busy session that keeps emitting events is still working.
  if (sid in state) {
    return { ...prune(state, now), [sid]: now };
  }
  return state;
}

/** How many sessions are busy at `now` (stale entries don't count). */
export function busyCount(state: BusyState, now: number): number {
  let n = 0;
  for (const ts of Object.values(state)) {
    if (now - ts < BUSY_EXPIRY_MS) n++;
  }
  return n;
}

/** Pushes the current busy count through the desktop shell bridge (preload
 * P3-409). Absent in plain browsers, and any bridge failure is swallowed —
 * the keep-awake signal is a convenience and must never break the chat. */
export function sendBusyCountToShell(count: number): void {
  try {
    const bridge = (window as unknown as {
      ocrDesktop?: { sendBusy?: (n: number) => void };
    }).ocrDesktop;
    bridge?.sendBusy?.(count);
  } catch {
    // no shell, or the bridge rejected — the verdict falls back to release
  }
}
