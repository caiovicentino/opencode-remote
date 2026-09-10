import { useEffect, useRef, useState } from "react";
import { feedVerdict } from "../lib/qrFeed";
import { torchConstraint, torchSupported } from "../lib/camshot";
import { useT } from "../lib/i18n";
import { errorReason, type CameraAccessVerdict, type ScanReason } from "./QrScanner";
import { IconCamera, IconSwitchCamera, IconX, IconZap } from "./icons";

interface Props {
  onClose: () => void;
  /** Shutter: the current frame as a JPEG File, ready for the attach pipeline
   * (ChatView attachImage → downscale ≤1568px → chunked ocr-upload://). */
  onCapture: (file: File) => void;
  /** Send the typed question — the attachments staged via onCapture ride the
   * same composer state, so the message carries photo + text in one part list. */
  onSend: (question: string) => void;
  /** P3-402: camera-permission verdict (desktop shell only, same bridge the
   * QrScanner uses). Absent on the phone — the dictionary copy stays. */
  getCamAccess?: () => Promise<CameraAccessVerdict | null>;
  /** Chat is uploading an attachment or sending — gates shutter + send. */
  busy?: boolean;
  /** The composer has something to send (text typed or attachment staged). */
  canSend?: boolean;
  /** Last chat/send error — surfaced here as the vision-degradation card. */
  error?: string;
}

/** P3-402 camera-ask v1 ("Olho"): a live viewfinder over the SAME proven
 * getUserMedia state machine as QrScanner (facingMode environment,
 * playsinline+muted before srcObject, one 400ms retry on the iOS AbortError,
 * dead-feed watchdog via lib/qrfeed). Nothing streams: the frame leaves the
 * device only when the shutter is pressed — the privacy line in the UI says
 * exactly that, and the sheet stays open after sending so a follow-up
 * question never reopens the camera. */
export default function CameraSheet({
  onClose,
  onCapture,
  onSend,
  getCamAccess,
  busy,
  canSend,
  error,
}: Props) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<"looking" | "preview" | "unavailable">("looking");
  const [reason, setReason] = useState<ScanReason>("generic");
  const [camVerdict, setCamVerdict] = useState<CameraAccessVerdict | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [torchOn, setTorchOn] = useState(false);
  const [torchReady, setTorchReady] = useState(false);
  const [question, setQuestion] = useState("");
  const [flash, setFlash] = useState(false);
  const [lastShot, setLastShot] = useState("");
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const camAccessRef = useRef(getCamAccess);
  camAccessRef.current = getCamAccess;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let frames = 0;
    let startedAt = performance.now();

    function fail(r: ScanReason) {
      if (cancelled) return;
      setReason(r);
      setPhase("unavailable");
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
      stream = null;
      trackRef.current = null;
      if (watchdog) clearInterval(watchdog);
      // Same verdict path as the QrScanner: a permission refusal inside the
      // desktop shell asks the shell what the OS actually says.
      if (r === "permission") {
        camAccessRef.current
          ?.()
          .then((v) => {
            if (!cancelled) setCamVerdict(v ?? null);
          })
          .catch(() => {
            if (!cancelled) setCamVerdict(null);
          });
      }
    }

    /** Dead-feed detector — lib/qrfeed holds the contract (grace period, track
     * ended, no decoded frames → unavailable, never a black void). */
    function startWatchdog() {
      startedAt = performance.now();
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

    function stopTorch() {
      // switching cameras hands the constraint to a fresh track
      trackRef.current
        ?.applyConstraints(torchConstraint(false) as MediaTrackConstraints)
        .catch(() => {});
    }

    async function start(retry: boolean) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        const track = stream.getVideoTracks()[0];
        track?.addEventListener("ended", () => fail("no-signal"));
        trackRef.current = track ?? null;
        setTorchOn(false);
        setTorchReady(torchSupported(track?.getCapabilities?.() ?? null));
        const video = videoRef.current;
        if (!video) return;
        // iOS: attributes must be set before srcObject
        video.setAttribute("playsinline", "true");
        video.muted = true;
        video.srcObject = stream;
        await video.play();
        startWatchdog();

        // frame counter only — no decoding, the shutter reads the element
        const tick = () => {
          if (cancelled) return;
          if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
            frames++;
            if (frames === 1) setPhase("preview");
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
      cancelAnimationFrame(raf);
      if (watchdog) clearInterval(watchdog);
      stopTorch();
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [facing]);

  function toggleTorch() {
    const next = !torchOn;
    trackRef.current
      ?.applyConstraints(torchConstraint(next) as MediaTrackConstraints)
      .then(() => setTorchOn(next))
      .catch(() => setTorchOn(false));
  }

  function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || busy) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setLastShot(canvas.toDataURL("image/jpeg", 0.4));
        setFlash(true);
        setTimeout(() => setFlash(false), 220);
        onCapture(new File([blob], `shot-${Date.now()}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      0.9,
    );
  }

  const sendQuestion = () => {
    if (busy) return;
    const q = question.trim();
    if (!q && !canSend) return;
    setQuestion("");
    onSend(q);
  };

  // P3-402: the system-panel action only when the system is in the way —
  // same gating as the scanner's panel CTA (P2-319).
  const camPanel =
    phase === "unavailable" &&
    reason === "permission" &&
    camVerdict &&
    (camVerdict.verdict === "blocked-by-system" || camVerdict.verdict === "unknown")
      ? camVerdict.settingsTarget
      : null;

  return (
    <div className="cam-sheet" role="dialog" aria-modal="true" aria-label={t("camTitle")}>
      <header className="cam-head">
        <h1 className="cam-title">{t("camTitle")}</h1>
        <button className="cam-close" onClick={onClose} aria-label={t("camClose")}>
          <IconX size={18} />
        </button>
      </header>

      {phase === "unavailable" ? (
        <div className="cam-stage cam-unavailable" role="alert">
          <p className="cam-unavailable-title">
            {reason === "permission" && camVerdict?.phrase ? camVerdict.phrase : t(`scanErr_${reason}`)}
          </p>
          {camPanel && (
            <button
              className="cam-panel-cta"
              onClick={() => window.open(camPanel, "_blank", "noopener")}
            >
              {t("camOpenPanel")}
            </button>
          )}
        </div>
      ) : (
        <div className="cam-stage">
          <video ref={videoRef} className="cam-video" />
          {phase === "looking" && (
            <div className="cam-looking" role="status">
              <span className="qr-spinner" aria-hidden="true" />
              <span>{t("camStarting")}</span>
            </div>
          )}
          <span className={`cam-flash${flash ? " on" : ""}`} aria-hidden="true" />
        </div>
      )}

      {error && (
        <div className="cam-warn" role="alert">
          <p className="cam-warn-text">{error}</p>
          <p className="cam-warn-hint">{t("camVisionHint")}</p>
        </div>
      )}

      <div className="cam-controls">
        {torchReady ? (
          <button
            className={`cam-side${torchOn ? " on" : ""}`}
            onClick={toggleTorch}
            aria-label={t("camTorch")}
            aria-pressed={torchOn}
            title={t("camTorch")}
          >
            <IconZap size={18} />
          </button>
        ) : (
          <span className="cam-side-spacer" />
        )}
        <button
          className="cam-shutter"
          onClick={capture}
          disabled={phase !== "preview" || busy}
          aria-label={t("camCapture")}
          title={t("camCapture")}
        >
          <IconCamera size={22} />
        </button>
        <button
          className="cam-side"
          onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
          aria-label={t("camSwitch")}
          title={t("camSwitch")}
        >
          <IconSwitchCamera size={18} />
        </button>
      </div>

      <div className="cam-ask">
        {lastShot && <img src={lastShot} alt="" className="cam-shot-thumb" />}
        <input
          className="cam-question"
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendQuestion();
            }
          }}
          placeholder={t("camQuestionPlaceholder")}
          aria-label={t("camQuestionPlaceholder")}
        />
        <button
          className="primary cam-send"
          onClick={sendQuestion}
          disabled={busy || (!question.trim() && !canSend)}
        >
          {busy ? "…" : t("send")}
        </button>
      </div>

      <p className="cam-privacy">{t("camPrivacy")}</p>
    </div>
  );
}
