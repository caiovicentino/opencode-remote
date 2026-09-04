import { useCallback, useState } from "react";
import QrScanner from "./QrScanner";
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
}

export default function PairingView({ phase, error, onPair, onRetry, onPairRemote, localMode, preferPaste }: Props) {
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
    return <QrScanner onScan={handleScan} onCancel={() => setScanning(false)} onPaste={backToPaste} />;
  }

  const scanButton = (
    <button
      className={preferPaste ? "pair-scan-entry" : "primary pair-scan-entry"}
      disabled={busy}
      onClick={() => setScanning(true)}
    >
      {t("scanQr")}
    </button>
  );

  return (
    <div className="screen">
      <header>
        <h1 style={{ fontSize: "1rem", margin: 0 }}>OpenCode Remote</h1>
      </header>
      <p className="muted pair-intro">{t("pairIntro")}</p>
      {preferPaste ? (
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
            className="pair-submit primary"
            disabled={busy || !code.trim()}
            onClick={() => onPair(code)}
          >
            {busy ? (localMode ? t("localConnecting") : t("connecting")) : t("pairBtn")}
          </button>
          <p className="muted" style={{ alignSelf: "center" }}>{t("orScan")}</p>
          {scanButton}
        </>
      ) : (
        <>
          {scanButton}
          <p className="muted" style={{ alignSelf: "center" }}>{t("orPaste")}</p>
          <textarea
            className="pair-code"
            rows={4}
            placeholder="opencode-remote://pair?v=2&relay=…"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={busy}
          />
          <button
            className="pair-submit"
            disabled={busy || !code.trim()}
            onClick={() => onPair(code)}
          >
            {busy ? (localMode ? t("localConnecting") : t("connecting")) : t("pairBtn")}
          </button>
        </>
      )}
      {phase === "error" && (
        <>
          <p className="pair-error" style={{ color: "var(--danger)" }}>{error}</p>
          <button onClick={onRetry}>{t("retry")}</button>
        </>
      )}
      {onPairRemote && (
        <button className="pair-remote-entry" onClick={onPairRemote} disabled={busy}>
          <b>{t("pairRemoteTitle")}</b>
          <span className="muted">{t("pairRemoteHint")}</span>
        </button>
      )}
    </div>
  );
}
