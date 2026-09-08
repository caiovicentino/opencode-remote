// P2-123: chunked audio transcription shared by the ChatView mic and the home
// composer mic — one implementation of the /__ocr/transcribe flow so the two
// entry points cannot drift.
import { useEffect, useState } from "react";
import { getVoiceSettings } from "../components/SettingsView";

const CHUNK = 500_000;

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown }>;

/** P2-201: the daemon's speech-to-text capability verdict. */
export interface SttStatus {
  /** "ready" | "missing-binary" | "missing-model" */
  state: string;
  /** Short actionable pt-BR sentence — no paths, no script names. */
  message: string;
}

/**
 * P2-201: probe the host's speech-to-text verdict with the same retry pattern
 * as ChatView's tts probe (a one-shot probe on mount always races the first
 * WS connect). Null while the verdict is unknown — callers fail open and
 * keep the mic usable, because blocking on a silent probe is worse than the
 * late failure this replaces.
 */
export function useSttStatus(request: RequestFn): SttStatus | null {
  const [stt, setStt] = useState<SttStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let attempts = 0;
    const probe = () => {
      if (!alive) return;
      attempts++;
      void request("GET", "/__ocr/voice/stt-status")
        .then((res) => {
          if (!alive) return;
          if (res.status === 200) {
            const body = res.body as { state?: string; message?: string };
            if (body.state) setStt({ state: body.state, message: body.message ?? "" });
          } else if (attempts < 10) window.setTimeout(probe, 1500);
        })
        .catch(() => {
          if (alive && attempts < 10) window.setTimeout(probe, 1500);
        });
    };
    probe();
    return () => {
      alive = false;
    };
    // Same lifecycle as the tts probe: mount once, retry inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return stt;
}

function b64Of(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

/** Record → WAV blob → chunked upload → transcription text. Same endpoint
 * flow the ChatView mic always used, now in one place. */
export async function transcribeBlob(request: RequestFn, blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const id = crypto.randomUUID();
  for (let i = 0; i * CHUNK < bytes.length || i === 0; i++) {
    const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
    const res = await request("POST", "/__ocr/transcribe/chunk", {
      id,
      idx: i,
      data: b64Of(slice),
    });
    if (res.status !== 200) throw new Error("audio upload failed");
  }
  const res = await request(
    "POST",
    "/__ocr/transcribe",
    { id, lang: getVoiceSettings().lang },
    undefined,
    180_000,
  );
  if (res.status !== 200) {
    throw new Error(String((res.body as { error?: string }).error ?? "transcription failed"));
  }
  return String((res.body as { text?: string }).text ?? "");
}
