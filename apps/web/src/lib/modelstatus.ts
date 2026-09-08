// P2-210: model-readiness probe shared by the chat composer and the home
// composer — one implementation of the /__ocr/model/status flow so the two
// entry points cannot drift (same shape as the stt probe in transcribe.ts).
import { useEffect, useState } from "react";

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
 * P2-210: probe the host's model-readiness verdict with the same retry
 * pattern as the stt probe (mount once, retry inside the hook). An "unknown"
 * answer usually means the daemon has not observed the provider catalog yet
 * (nobody fetched /provider since boot), so unknown keeps retrying inside the
 * same budget a silent probe gets instead of freezing the neutral phrase on
 * screen. Callers fail open and keep sending available, because blocking the
 * conversation on a probe that can be silent would be worse than the late
 * upstream failure this hint replaces.
 */
export function useModelStatus(request: RequestFn): ModelStatus | null {
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
    // Same lifecycle as the stt probe: mount once, retry inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return status;
}
