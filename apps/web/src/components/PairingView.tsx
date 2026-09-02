import { useCallback, useState } from "react";
import QrScanner from "./QrScanner";
import { useT } from "../lib/i18n";

interface Props {
  phase: "unpaired" | "connecting" | "error" | "paired";
  error: string;
  onPair: (uri: string) => void;
  onRetry: () => void;
}

export default function PairingView({ phase, error, onPair, onRetry }: Props) {
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

  return (
    <div className="screen">
      <header>
        <h1 style={{ fontSize: "1rem", margin: 0 }}>OpenCode Remote</h1>
      </header>
      <p className="muted">{t("pairIntro")}</p>
      <button
        className="primary"
        disabled={busy}
        onClick={() => setScanning(true)}
      >
        {t("scanQr")}
      </button>
      <p className="muted" style={{ alignSelf: "center" }}>{t("orPaste")}</p>
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
        {busy ? t("connecting") : t("pairBtn")}
      </button>
      {phase === "error" && (
        <>
          <p className="pair-error" style={{ color: "var(--danger)" }}>{error}</p>
          <button onClick={onRetry}>{t("retry")}</button>
        </>
      )}
    </div>
  );
}
