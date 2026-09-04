// P2-123: chunked audio transcription shared by the ChatView mic and the home
// composer mic — one implementation of the /__ocr/transcribe flow so the two
// entry points cannot drift.
import { getVoiceSettings } from "../components/SettingsView";

const CHUNK = 500_000;

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown }>;

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
