import { useCallback, useState } from "react";
import QrScanner, { type CameraAccessVerdict } from "./QrScanner";
import { useT } from "../lib/i18n";

interface Props {
  phase: "unpaired" | "connecting" | "error" | "paired";
  error: string;
  onPair: (uri: string) => void;
  onRetry: () => void;
  /** P1-070: desktop shell only — explicit "pair a remote phone" action that
   * turns the QR ceremony back on (app:setRemotePairing). */
  onPairRemote?: () => void;
  /** P1-070: the shell is auto-connecting to the daemon on this machine. */
  localMode?: boolean;
  /** P2-117: desktop shells lead with the paste form — pointing a camera at
   * another desktop's QR is a circular flow. Camera stays available as an
   * option; on the phone the scan button remains primary. */
  preferPaste?: boolean;
  /** P2-319: camera-permission verdict (desktop shell only) — the scanner's
   * permission refusal becomes an actionable system-panel call to action. */
  getCamAccess?: () => Promise<CameraAccessVerdict | null>;
  /** P3-331: quiet return to the calm degraded card — the manual escape must
   * never be a one-way door. Absent in flows without a surface behind it. */
  onBack?: () => void;
}

export default function PairingView({ phase, error, onPair, onRetry, onPairRemote, localMode, preferPaste, getCamAccess, onBack }: Props) {
  const t = useT();
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);
  const busy = phase === "connecting";

  const handleScan = useCallback(
    (text: string) => {
      setScanning(false);
      onPair(text);
    },
    [onPair],
  );

  // P2-117: the scanner's paste CTA returns to the primary form, focused —
  // the camera being unavailable must never dead-end the pairing flow.
  const backToPaste = useCallback(() => {
    setScanning(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".pair-code")?.focus());
  }, []);

  if (scanning) {
    return <QrScanner onScan={handleScan} onCancel={() => setScanning(false)} onPaste={backToPaste} getCamAccess={getCamAccess} />;
  }

  // P2-112: in local mode the intro promises automatic pairing — showing the
  // full scan/paste ceremony right below contradicted it. The manual widgets
  // stay available for the explicit remote ceremony (pairRemote entry), not
  // as a first-contact dead weight.
  const ceremony = !localMode;

  // P2-106: the two pairing directions read as titled sections — "pair a phone
  // with this machine" (this device as host) and "connect to another machine"
  // (this device as client: scan/paste). The error keeps the
  // locale-independent .pair-error hook the desktop-flow gate asserts on.

  // P2-117: paste-first on the desktop (the camera path is the option);
  // scan-first on the phone.
  const pasteForm = (
    <>
      <textarea
        className="pair-code"
        rows={4}
        placeholder="opencode-remote://pair?v=2&relay=…"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={busy}
      />
      <button
        className={preferPaste ? "pair-submit primary" : "pair-submit"}
        disabled={busy || !code.trim()}
        onClick={() => onPair(code)}
      >
        {busy ? (localMode ? t("localConnecting") : t("connecting")) : t("pairBtn")}
      </button>
    </>
  );

  const scanButton = (
    <button
      className={preferPaste ? "pair-scan-entry" : "primary pair-scan-entry"}
      disabled={busy}
      onClick={() => setScanning(true)}
    >
      {t("scanQr")}
    </button>
  );

  // P2-106: the two pairing directions read as titled sections — "pair a phone
  // with this machine" (this device as host) and "connect to another machine"
  // (this device as client: scan/paste). The error keeps the
  // locale-independent .pair-error hook the desktop-flow gate asserts on.

  // P3-334: on the desktop the host section leads — pairing a phone is the
  // primary story on this machine, so the client ceremony reads as the
  // secondary option. The phone never renders the host section (no
  // onPairRemote), so its scan/paste flow is untouched.
  return (
    <div className="screen pair-screen">
      <header>
        <h1 className="brand-wordmark">OpenCode Remote</h1>
      </header>
      <p className="muted pair-intro">{t("pairIntro")}</p>
      {onPairRemote && (
        <section className="pair-section">
          <h2 className="pair-section-title">{t("pairHostTitle")}</h2>
          <button className="pair-remote-entry" onClick={onPairRemote} disabled={busy}>
            <span className="pair-remote-copy">
              <b>{t("pairRemoteTitle")}</b>
              <span className="muted">{t("pairRemoteHint")}</span>
            </span>
            <svg
              className="pair-remote-chevron"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </section>
      )}
      {ceremony && (
        <section className="pair-section">
          <h2 className="pair-section-title">{t("pairConnectTitle")}</h2>
          {preferPaste ? (
            <>
              {pasteForm}
              <p className="muted pair-or">{t("orScan")}</p>
              {scanButton}
            </>
          ) : (
            <>
              {scanButton}
              <p className="muted pair-or">{t("orPaste")}</p>
              {pasteForm}
            </>
          )}
        </section>
      )}
      {phase === "error" && (
        <div className="pair-error" role="alert" aria-live="assertive">
          <p className="pair-error-msg">{error}</p>
          {error === t("invalidCode") && (
            <p className="pair-error-hint">{t("invalidCodeHint")}</p>
          )}
          <button className="pair-error-retry" onClick={onRetry}>{t("retry")}</button>
        </div>
      )}
      {onBack && (
        <button className="pair-back" onClick={onBack}>
          {t("pairBack")}
        </button>
      )}
    </div>
  );
}
