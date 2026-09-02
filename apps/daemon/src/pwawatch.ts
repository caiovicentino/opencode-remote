// P2-075: PWA origin watchdog — the phone's tailnet origin proxies
// 127.0.0.1:5173 (com.ocr.pwa, static apps/web/dist). A dead origin is a
// silent white screen on the phone only (the desktop shell loads the bundle
// straight from disk), so the daemon probes /healthz on a fixed interval and
// surfaces transitions as dashboard events + pushes.
// Pure helpers live here per the P1-072 lesson; index.ts owns the impure wiring.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { metrics } from "./metrics.js";

export const DEFAULT_PWA_HEALTHZ_URL = "http://127.0.0.1:5173/healthz";
export const PWA_PROBE_INTERVAL_MS = 60_000;
export const PWA_PROBE_TIMEOUT_MS = 5_000;
export const PWA_EVENT_TASK = "pwa";
export const PWA_EVENT_PHASE = "origin";

export interface PwaEventLike {
  task?: string;
  phase?: string;
  ok?: boolean;
  detail?: string;
}

/**
 * Newest pwa-origin verdict across the (full, unsorted) dashboard feed.
 * Null = the watchdog never reported yet — the dashboard chip stays dark.
 */
export function pwaOriginAlert(events: PwaEventLike[]): { down: boolean; detail: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.task === PWA_EVENT_TASK && e.phase === PWA_EVENT_PHASE) {
      return { down: e.ok === false, detail: e.detail ?? "" };
    }
  }
  return null;
}

/**
 * The watchdog only makes sense on the host that serves the PWA: enabled when
 * the environment (or the launchd plist installed by deploy/install.sh) says
 * so. Keeps daemon sidecars on other machines from crying wolf.
 */
export function pwaWatchEnabled(envUrl: string | undefined, plistPath: string): boolean {
  return Boolean(envUrl) || existsSync(plistPath);
}

export function defaultPwaPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.ocr.pwa.plist");
}

export async function probePwaOrigin(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(PWA_PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface PwaWatchDeps {
  probe?: () => Promise<boolean>;
  onTransition?: (down: boolean, detail: string) => void;
  intervalMs?: number;
  initialDelayMs?: number;
}

/**
 * Fixed-interval probe loop that fires onTransition only when the answer
 * flips (noise-free: a flapping origin alerts at most once per flip). The
 * first probe assumes "up" — a healthy origin never emits an event.
 * Returns a stop function (tests / shutdown).
 */
export function startPwaWatch(deps: PwaWatchDeps = {}): () => void {
  const probe =
    deps.probe ?? (() => probePwaOrigin(process.env.PWA_HEALTHZ_URL ?? DEFAULT_PWA_HEALTHZ_URL));
  const onTransition = deps.onTransition ?? (() => {});
  const intervalMs = deps.intervalMs ?? PWA_PROBE_INTERVAL_MS;
  let down = false;
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void (async () => {
      const healthy = await probe();
      if (stopped) return;
      metrics.gauge("ocr_pwa_origin_healthy", healthy ? 1 : 0);
      if (healthy === down) {
        down = !healthy;
        onTransition(
          !healthy,
          healthy
            ? "PWA origin answering again (127.0.0.1:5173 /healthz ok)"
            : "PWA origin down — phone sees a white screen; check com.ocr.pwa (launchctl kickstart -k gui/$(id -u)/com.ocr.pwa)",
        );
      }
    })();
  };
  const first = setTimeout(run, deps.initialDelayMs ?? 10_000);
  const timer = setInterval(run, intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
