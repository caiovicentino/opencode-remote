import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

interface Props {
  onScan: (text: string) => void;
  onCancel: () => void;
}

/** iOS getUserMedia wraps permission dismissal and camera races in
 * AbortError — translate to what the user should actually do. */
function friendlyError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError") return "Camera permission denied. Allow camera access for this site (Settings → Safari → Camera) and try again.";
  if (name === "NotFoundError") return "No camera found on this device.";
  if (name === "NotReadableError") return "Camera is in use by another app. Close it and try again.";
  if (name === "AbortError") return "Camera was interrupted. Tap Scan again — iOS sometimes aborts the first attempt.";
  return err instanceof Error ? err.message : "camera unavailable";
}

/** In-app QR scanner built on getUserMedia + jsQR. Works on iOS Safari. */
export default function QrScanner({ onScan, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
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
        setError(friendlyError(err));
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
        <button onClick={onCancel}>←</button>
        <h1 style={{ fontSize: "0.9rem", margin: 0, flex: 1 }}>Scan pairing code</h1>
      </header>
      {error ? (
        <>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <button onClick={onCancel}>Back to manual pairing</button>
        </>
      ) : (
        <video
          ref={videoRef}
          style={{ width: "100%", maxHeight: "60vh", objectFit: "cover", borderRadius: 12 }}
        />
      )}
      <p className="muted">Point the camera at the QR code shown by the daemon.</p>
    </div>
  );
}
