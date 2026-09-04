import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { feedVerdict } from "../lib/qrFeed";
import { useT } from "../lib/i18n";

interface Props {
  onScan: (text: string) => void;
  onCancel: () => void;
  /** P2-117: paste-the-code CTA for the unavailable state — on desktop, pasting
   * the pairing URI is the primary path (a camera pointed at another screen is
   * a circular flow); the scanner must always offer the way back. */
  onPaste: () => void;
}

export type ScanPhase = "looking" | "preview" | "unavailable";
export type ScanReason = "permission" | "no-device" | "busy" | "interrupted" | "no-signal" | "generic";

/** getUserMedia failure names → the reason the state machine reports. */
function errorReason(err: unknown): ScanReason {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError") return "permission";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no-device";
  if (name === "NotReadableError") return "busy";
  if (name === "AbortError") return "interrupted";
  return "generic";
}

/** In-app QR scanner built on getUserMedia + jsQR. Works on iOS Safari.
 * Renders a visible state machine — looking → preview → unavailable — so the
 * screen never degrades to an empty black box with a single gray caption. */
export default function QrScanner({ onScan, onCancel, onPaste }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<ScanPhase>("looking");
  const [reason, setReason] = useState<ScanReason>("generic");
  const doneRef = useRef(false);
  const t = useT();

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let frames = 0;
    const startedAt = performance.now();

    function fail(r: ScanReason) {
      if (cancelled || doneRef.current) return;
      setReason(r);
      setPhase("unavailable");
      stream?.getTracks().forEach((tr) => tr.stop());
      stream = null;
      if (watchdog) clearInterval(watchdog);
    }

    /** Empty-feed detector (P2-117): a capture device with no input shows its
     * own "NO SIGNAL" OSD in the video element — never render that. A feed
     * with no decodable frames past the grace period is unavailable. */
    function startWatchdog() {
      watchdog = setInterval(() => {
        const video = videoRef.current;
        if (!video) return;
        const ended = stream?.getVideoTracks()[0]?.readyState === "ended";
        const verdict = feedVerdict({
          frames,
          videoWidth: video.videoWidth,
          trackEnded: ended,
          elapsedMs: performance.now() - startedAt,
        });
        if (verdict === "empty") fail("no-signal");
      }, 500);
    }

    async function start(retry: boolean) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        stream.getVideoTracks()[0]?.addEventListener("ended", () => fail("no-signal"));
        const video = videoRef.current;
        if (!video) return;
        // iOS: attributes must be set before srcObject
        video.setAttribute("playsinline", "true");
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        startWatchdog();

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
              frames++;
              if (frames === 1) {
                if (!cancelled) setPhase("preview");
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
        fail(errorReason(err));
      }
    }

    void start(true);
    return () => {
      cancelled = true;
      doneRef.current = false;
      cancelAnimationFrame(raf);
      if (watchdog) clearInterval(watchdog);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [onScan]);

  return (
    <div
      className="screen qr-scanner"
      data-state={phase}
      data-reason={phase === "unavailable" ? reason : undefined}
    >
      <header>
        <button onClick={onCancel} aria-label={t("scanBack")}>←</button>
        <h1 style={{ fontSize: "0.9rem", margin: 0, flex: 1 }}>{t("scanTitle")}</h1>
      </header>
      {phase === "unavailable" ? (
        <div className="qr-unavailable" role="alert">
          <p className="qr-unavailable-title">{t(`scanErr_${reason}`)}</p>
          <button className="primary qr-paste-cta" onClick={onPaste}>
            {t("scanPasteCta")}
          </button>
        </div>
      ) : (
        <div className="qr-stage">
          <video ref={videoRef} className="qr-video" />
          {phase === "looking" && (
            <div className="qr-looking" role="status">
              <span className="qr-spinner" aria-hidden="true" />
              <span>{t("scanLooking")}</span>
            </div>
          )}
        </div>
      )}
      <p className="muted qr-hint">{t("scanHint")}</p>
    </div>
  );
}
