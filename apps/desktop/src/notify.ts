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
/** Body for the healthy→down transition (give-up definitive do sidecar).
 * P1-053: points to the banner's recovery button instead of relaunching. */
export const NOTIFY_DOWN_BODY = "daemon parou — use “Reconectar agora” no OpenCode Remote";
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

/** AppUserModelID for Windows toasts — must match the appId declared in
 * electron-builder.yml or win32 notifications silently drop (P3-020). */
export const WINDOWS_APP_ID = "com.culturabuilder.opencode-remote";

/** Pure appId resolution: Windows needs the AUMID wired at runtime; macOS
 * resolves through the Info.plist and Linux has no AUMID concept at all. */
export function appIdForPlatform(platform: string): string | null {
  return platform === "win32" ? WINDOWS_APP_ID : null;
}

/** Wire the AUMID into the app, tolerating an id-less (non-win32) target as a
 * no-op. Electron-free signature so unit tests can pass a fake app. */
export function applyAppUserModelId(app: { setAppUserModelId(id: string): void }, platform: string): boolean {
  const id = appIdForPlatform(platform);
  if (id === null) return false;
  app.setAppUserModelId(id);
  return true;
}
