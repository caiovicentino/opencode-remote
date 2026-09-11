// Chunked binary upload to the daemon (P3-404). Extracted verbatim from
// ChatView's uploadBytes so the screen-peek responder and the composer share
// ONE implementation of the 500KB-chunk staging flow — two copies would drift
// (lesson from the P2-326/P3-393 reviews). Same wire shape as
// lib/transcribe.ts: base64 chunks, then a complete call that returns either
// the ocr-upload:// id (kind "inline", default) or the persisted path
// (kind "file").

export type UploadRequestMethod = "GET" | "POST" | "DELETE" | "PATCH" | "PUT";

export type UploadRequestFn = (
  method: UploadRequestMethod,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown }>;

/** Chunk size on the wire (base64 rides inside JSON tunnel frames). */
export const UPLOAD_CHUNK = 500_000;

function b64Of(bytes: Uint8Array): string {
  let s = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(s);
}

export async function uploadBytesChunked(
  request: UploadRequestFn,
  bytes: Uint8Array,
  mime: string,
  filename: string,
  kind?: "inline" | "file",
): Promise<string> {
  const id = crypto.randomUUID();
  for (let i = 0; i * UPLOAD_CHUNK < bytes.length || i === 0; i++) {
    const slice = bytes.subarray(i * UPLOAD_CHUNK, (i + 1) * UPLOAD_CHUNK);
    const res = await request("POST", "/__ocr/upload/chunk", { id, idx: i, data: b64Of(slice) });
    if (res.status !== 200) throw new Error("upload failed");
  }
  const res = await request("POST", "/__ocr/upload/complete", { id, mime, filename, kind });
  if (res.status !== 200) {
    throw new Error(String((res.body as { error?: string }).error ?? "upload failed"));
  }
  const body = res.body as { url?: string; path?: string };
  return kind === "file" ? body.path! : body.url!.replace(/^ocr-upload:\/\/+/, "");
}
