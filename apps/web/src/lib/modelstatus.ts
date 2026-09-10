// P2-210: model-readiness probe shared by the chat composer and the home
// composer — one implementation of the /__ocr/model/status flow so the two
// entry points cannot drift (same shape as the stt probe in transcribe.ts).
import { useEffect, useState } from "react";

/** P3-396: how long the "check again" action may stay in its transient
 * checking state before landing in the terminal "still not ready" line —
 * the P3-327 lesson: a recovery action never ends on a permanent spinner. */
export const MODEL_RECHECK_TIMEOUT_MS = 8_000;

/** P3-396: official provider-credential instructions, opened through the
 * shell's external-open gate (apps/desktop/src/extlink.ts — https passes).
 * The providers page is where the docs publish `opencode auth login`. */
export const MODEL_DOCS_URL = "https://opencode.ai/docs/providers";

/** P3-396: the official agent login command per platform family, copied to
 * the clipboard by the credential journey. Unlike the P3-392 install
 * one-liner (curl vs PowerShell) the opencode CLI is uniform — the docs
 * publish exactly `opencode auth login` for every platform — but the
 * per-family table keeps the seam the eval battery pins, so a future
 * platform-specific variant lands in a tested table, never a raw literal
 * inside the component. Pure so the battery pins the exact payload. */
const AUTH_COMMANDS: { windows: string; mac: string; linux: string } = {
  windows: "opencode auth login",
  mac: "opencode auth login",
  linux: "opencode auth login",
};

/** P3-396: platform family → official login command (see AUTH_COMMANDS).
 * Unknown/empty platforms resolve to the unix family — the command is the
 * same everywhere today, and a made-up platform must never break the copy. */
export function authCommandFor(platform: string): string {
  const p = platform.toLowerCase();
  const family = p.startsWith("win")
    ? "windows"
    : p.startsWith("darwin") || p.startsWith("mac")
      ? "mac"
      : "linux";
  return AUTH_COMMANDS[family];
}

/**
 * P3-396: which copy the model hint resolves to. Lesson P3-394: one key must
 * never render on two surfaces — on the desktop shell the no-provider and
 * no-model verdicts resolve to dedicated desktop keys (the person reading the
 * hint IS the machine manager the daemon phrase would otherwise address);
 * everywhere else (phone, ready, unknown) the hint keeps the daemon's own
 * sentence and no actions. Returns the i18n key or null for "keep the
 * daemon's message".
 */
export function modelHintKey(state: string, desktopShell: boolean): string | null {
  if (!desktopShell) return null;
  if (state === "no-provider") return "modelMissingProviderDesktop";
  if (state === "no-model") return "modelMissingModelDesktop";
  return null;
}

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown }>;

/** P2-210: the daemon's model-readiness verdict. */
export interface ModelStatus {
  /** "ready" | "no-provider" | "no-model" | "unknown" */
  state: string;
  /** Short actionable pt-BR sentence — no paths, no URLs, no provider ids. */
  message: string;
}

/**
 * P3-210: probe the host's model-readiness verdict with the same retry
 * pattern as the stt probe (mount once, retry inside the hook). An "unknown"
 * answer usually means the daemon has not observed the provider catalog yet
 * (nobody fetched /provider since boot), so unknown keeps retrying inside the
 * same budget a silent probe gets instead of freezing the neutral phrase on
 * screen. Callers fail open and keep sending available, because blocking the
 * conversation on a probe that can be silent would be worse than the late
 * upstream failure this hint replaces.
 *
 * P3-396: `recheckSignal` re-runs the whole probe when it changes — the
 * "check again" action bumps it. The previous attempt is abandoned (alive
 * guard) and the retry budget starts fresh; the caller keeps rendering the
 * last verdict until the new one lands.
 */
export function useModelStatus(request: RequestFn, recheckSignal = 0): ModelStatus | null {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const probe = () => {
      if (!alive) return;
      attempts++;
      void request("GET", "/__ocr/model/status")
        .then((res) => {
          if (!alive) return;
          if (res.status === 200) {
            const body = res.body as { state?: string; message?: string };
            if (body.state) {
              setStatus({ state: body.state, message: body.message ?? "" });
              if (body.state === "unknown" && attempts < 10) window.setTimeout(probe, 1500);
            } else if (attempts < 10) {
              window.setTimeout(probe, 1500);
            }
          } else if (attempts < 10) {
            window.setTimeout(probe, 1500);
          }
        })
        .catch(() => {
          if (alive && attempts < 10) window.setTimeout(probe, 1500);
        });
    };
    probe();
    return () => {
      alive = false;
    };
    // Same lifecycle as the stt probe: mount once, retry inside. The only
    // re-run is the P3-396 recheck signal — `request` stays capture-once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheckSignal]);
  return status;
}
