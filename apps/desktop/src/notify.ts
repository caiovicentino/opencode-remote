// Pure decision logic for native daemon notifications (P3-013). Kept free of
// electron imports so scripts/unit.test.ts can exercise it (same pattern as
// tray.ts): the function receives the previous observed daemon state and the
// new one and decides whether — and what — to notify, deduping by transition
// so a stable state never re-notifies on every 3s poll.

/** Observed daemon health, fed by the pairing watcher's 3s poll in main.ts. */
export type DaemonHealth = "down" | "healthy";

/** What the shell should surface to the user after a poll. */
export type NotifyKind = "none" | "down" | "back";

export interface NotifyDecision {
  notify: NotifyKind;
}

/** Native notification shown when the sidecar give-up is detected. */
export const NOTIFY_TITLE = "OpenCode Remote";
/** Body for the healthy→down transition (give-up definitive do sidecar). */
export const NOTIFY_DOWN_BODY = "daemon parou — reabra o OpenCode Remote";
/** Body for the down→healthy transition (daemon answering again). */
export const NOTIFY_BACK_BODY = "daemon de volta";

/**
 * Decide whether a poll transition deserves a native notification:
 * healthy→down ⇒ "down", down→healthy ⇒ "back", stable state or the first
 * observation (prev null, no transition seen yet) ⇒ "none".
 */
export function daemonNotify(prev: DaemonHealth | null, next: DaemonHealth): NotifyDecision {
  if (prev === null || prev === next) return { notify: "none" };
  return { notify: next === "down" ? "down" : "back" };
}
