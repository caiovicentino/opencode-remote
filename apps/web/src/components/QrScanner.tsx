import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

interface Props {
  onScan: (text: string) => void;
  onCancel: () => void;
}

/**
 * In-app QR scanner built on getUserMedia + jsQR.
 *
 * Works on iOS Safari (iPhone) and every other browser: no BarcodeDetector
 * dependency. The video must be muted + playsinline or iOS refuses playback.
 */
export default function QrScanner({ onScan, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const doneRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        video.muted = true;
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
        setError(
          err instanceof Error
            ? `${err.name}: ${err.message}`
            : "camera unavailable",
        );
      }
    }

    void start();
    return () => {
      doneRef.current = true;
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
