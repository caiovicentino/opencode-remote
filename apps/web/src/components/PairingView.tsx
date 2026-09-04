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
}

export default function PairingView({ phase, error, onPair, onRetry, onPairRemote, localMode }: Props) {
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

  if (scanning) {
    return (
      <QrScanner onScan={handleScan} onCancel={() => setScanning(false)} />
    );
  }

  // P2-112: in local mode the intro promises automatic pairing — showing the
  // full scan/paste ceremony right below contradicted it. The manual widgets
  // stay available for the explicit remote ceremony (pairRemote entry), not
  // as a first-contact dead weight.
  const ceremony = !localMode;

  // P2-106: the two pairing directions read as titled sections — "connect to
  // another machine" (this device as client: scan/paste) vs "pair a phone
  // with this machine" (this device as host). The error keeps the
  // locale-independent .pair-error hook the desktop-flow gate asserts on.
  return (
    <div className="screen pair-screen">
      <header>
        <h1 style={{ fontSize: "1rem", margin: 0 }}>OpenCode Remote</h1>
      </header>
      <p className="muted pair-intro">{t("pairIntro")}</p>
      {ceremony && (
        <section className="pair-section">
          <h2 className="pair-section-title">{t("pairConnectTitle")}</h2>
          <button
            className="primary"
            disabled={busy}
            onClick={() => setScanning(true)}
          >
            {t("scanQr")}
          </button>
          <p className="muted pair-or">{t("orPaste")}</p>
          <textarea
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
      {onPairRemote && (
        <section className="pair-section">
          <h2 className="pair-section-title">{t("pairHostTitle")}</h2>
          <button className="pair-remote-entry" onClick={onPairRemote} disabled={busy}>
            <b>{t("pairRemoteTitle")}</b>
            <span className="muted">{t("pairRemoteHint")}</span>
          </button>
        </section>
      )}
    </div>
  );
}
