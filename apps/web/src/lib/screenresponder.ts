// Screen-peek responder (P3-404): the desktop shell's answer to a phone's
// "Ver a tela" request. IO is injected — the module only orchestrates:
//
//   event screen.capture-requested → capture (bridge IPC) → PNG → JPEG
//   (canvas, ≤1568px) → chunked upload → /__ocr/screen/frames → the daemon
//   stores the single frame and broadcasts screen.frame to every client.
//
// The capture ALWAYS happens in the shell (the TCC-responsible context,
// apps/desktop/src/main.ts) — never in the launchd daemon. A refusal
// (system permission verdict or empty capture) is reported through
// /__ocr/screen/failed so the phone shows the mapped verdict sentence
// instead of waiting for a frame that never comes.

import { captureRequestVerdict, type CaptureRequestVerdict } from "./screenpeek";
import { uploadBytesChunked, type UploadRequestFn } from "./upload";

export interface ScreenSourceInfo {
  id: string;
  name: string;
  type: "screen" | "window";
}

export interface ScreenCaptureResult {
  ok: boolean;
  bytes?: Uint8Array;
  width?: number;
  height?: number;
  name?: string;
  verdict?: { verdict: string; phrase: string; settingsTarget: string | null };
  reason?: string;
}

export interface ScreenResponderBridge {
  captureScreen?: (req: { sourceId?: string }) => Promise<ScreenCaptureResult | null>;
  listScreens?: () => Promise<ScreenSourceInfo[]>;
}

export type ResponderOutcome = "fulfilled" | "failed" | "ignored";

export interface ResponderResult {
  outcome: ResponderOutcome;
  /** Source list for the shell's picker overlay (fulfilled only). */
  sources?: ScreenSourceInfo[];
  /** Frame metadata for the shell indicator (fulfilled only). */
  at?: number;
  name?: string;
}

/** Longest source list the picker overlay renders — a window farm must not
 * build an endless column of buttons. */
export const SCREEN_SOURCES_MAX = 8;

/** PNG bytes → JPEG (≤1568px, q0.75) — the same envelope the attachment
 * pipeline uses for photos, so the stored frame stays small on the tunnel. */
async function pngToJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    // copy into a plain ArrayBuffer: the IPC transfer arrives as
    // Uint8Array<ArrayBufferLike>, which BlobPart rejects
    const buf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buf).set(bytes);
    const bmp = await createImageBitmap(new Blob([buf]));
    const max = 1568;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.75));
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null;
  }
}

async function reportFailed(request: UploadRequestFn, requestId: string, reason: string): Promise<void> {
  try {
    await request("POST", "/__ocr/screen/failed", { requestId, reason });
  } catch {
    // the phone's own wait timeout is the backstop — nothing else to do
  }
}

/**
 * Capture one frame and fulfill the request. Used by the event-driven
 * responder AND by the shell picker's manual recapture (any requestId — the
 * daemon only matches ids it knows).
 */
export async function captureAndFulfill(
  request: UploadRequestFn,
  bridge: ScreenResponderBridge,
  requestId: string,
): Promise<{ ok: boolean; at?: number; name?: string }> {
  if (!bridge.captureScreen) {
    await reportFailed(request, requestId, "no-bridge");
    return { ok: false };
  }
  let captured: ScreenCaptureResult | null = null;
  try {
    captured = await bridge.captureScreen({});
  } catch {
    captured = null;
  }
  if (!captured?.ok || !captured.bytes?.length) {
    const reason = captured?.verdict?.verdict || captured?.reason || "unknown";
    await reportFailed(request, requestId, reason);
    return { ok: false };
  }
  const jpeg = await pngToJpeg(captured.bytes);
  if (!jpeg) {
    await reportFailed(request, requestId, "capture-failed");
    return { ok: false };
  }
  try {
    const uploadId = await uploadBytesChunked(request, jpeg, "image/jpeg", `tela-${Date.now()}.jpg`);
    const res = await request("POST", "/__ocr/screen/frames", { requestId, uploadId });
    if (res.status !== 200) {
      await reportFailed(request, requestId, "capture-failed");
      return { ok: false };
    }
    const body = res.body as { at?: number };
    return { ok: true, at: body.at, name: captured.name };
  } catch {
    await reportFailed(request, requestId, "capture-failed");
    return { ok: false };
  }
}

/** Event-driven entry: decide, capture, fulfill. Never throws. */
export async function respondToCaptureRequest(
  request: UploadRequestFn,
  bridge: ScreenResponderBridge,
  props: unknown,
  desktopShell: boolean,
  now: number,
): Promise<ResponderResult> {
  const verdict: CaptureRequestVerdict = captureRequestVerdict(props, desktopShell, now);
  if (verdict !== "capture" || typeof (props as { requestId?: unknown })?.requestId !== "string") {
    return { outcome: "ignored" };
  }
  const done = await captureAndFulfill(request, bridge, (props as { requestId: string }).requestId);
  if (!done.ok) return { outcome: "failed" };
  let sources: ScreenSourceInfo[] = [];
  if (bridge.listScreens) {
    try {
      sources = ((await bridge.listScreens()) ?? []).slice(0, SCREEN_SOURCES_MAX);
    } catch {
      sources = [];
    }
  }
  return { outcome: "fulfilled", sources, at: done.at, name: done.name };
}
