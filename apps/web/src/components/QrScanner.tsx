import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { useT } from "../lib/i18n";

interface Props {
  onScan: (text: string) => void;
  onCancel: () => void;
}

/** iOS getUserMedia wraps permission dismissal and camera races in
 * AbortError — map to the dict key the user should actually read.
 * P2-118: copy lives in the i18n dictionary so the scanner screen follows
 * the app locale like the rest of the connection flow. Returns null for
 * unknown errors (the raw browser message is shown instead). */
function cameraErrorKey(err: unknown): string | null {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError") return "camDenied";
  if (name === "NotFoundError") return "camNotFound";
  if (name === "NotReadableError") return "camBusy";
  if (name === "AbortError") return "camInterrupted";
  return null;
}

/** Resolve at render time (not catch time) so a language switch mid-error
 * still re-renders in the new locale. Unknown errors keep the raw browser
 * message; the fallback line is localized. */
function cameraError(err: unknown, t: (key: string) => string): string {
  const key = cameraErrorKey(err);
  if (key) return t(key);
  return err instanceof Error ? err.message : t("camUnavailable");
}

/** In-app QR scanner built on getUserMedia + jsQR. Works on iOS Safari. */
export default function QrScanner({ onScan, onCancel }: Props) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<unknown>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;

    async function start(retry: boolean) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        // iOS: attributes must be set before srcObject
        video.setAttribute("playsinline", "true");
        video.muted = true;
        video.srcObject = stream;
        await video.play();

        const tick = () => {
          if (doneRef.current) return;
          if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(img.data, img.width, img.height);
              if (code?.data && !doneRef.current) {
                doneRef.current = true;
                onScan(code.data);
                return;
              }
            }
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      } catch (err) {
        // iOS aborts the first getUserMedia in some flows (permission
        // prompt dismissal, rapid restart). One retry resolves it.
        if ((err as { name?: string })?.name === "AbortError" && retry) {
          await new Promise((r) => setTimeout(r, 400));
          if (!cancelled) return start(false);
          return;
        }
        setError(err);
      }
    }

    void start(true);
    return () => {
      cancelled = true;
      doneRef.current = false;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  return (
    <div className="screen">
      <header>
        <button onClick={onCancel} aria-label={t("scanBackManual")}>←</button>
        <h1 style={{ fontSize: "0.9rem", margin: 0, flex: 1 }}>{t("scanPairingTitle")}</h1>
      </header>
      {error ? (
        <>
          <p style={{ color: "var(--danger)" }}>{cameraError(error, t)}</p>
          <button onClick={onCancel}>{t("scanBackManual")}</button>
        </>
      ) : (
        <video
          ref={videoRef}
          style={{ width: "100%", maxHeight: "60vh", objectFit: "cover", borderRadius: 12 }}
        />
      )}
      <p className="muted">{t("scanPointCamera")}</p>
    </div>
  );
}
