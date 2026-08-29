import { useCallback, useState } from "react";
import QrScanner from "./QrScanner";

interface Props {
  phase: "unpaired" | "connecting" | "error" | "paired";
  error: string;
  onPair: (uri: string) => void;
  onRetry: () => void;
}

export default function PairingView({ phase, error, onPair, onRetry }: Props) {
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
      <p className="muted">
        Run the daemon on your machine and scan the QR code it prints, or paste
        the pairing code. Traffic is end-to-end encrypted; the relay cannot read it.
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={() => setScanning(true)}
      >
        Scan QR code
      </button>
      <p className="muted" style={{ alignSelf: "center" }}>— or paste manually —</p>
      <textarea
        rows={4}
        placeholder="opencode-remote://pair?v=2&relay=…"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={busy}
      />
      <button
        disabled={busy || !code.trim()}
        onClick={() => onPair(code)}
      >
        {busy ? "Connecting…" : "Pair"}
      </button>
      {phase === "error" && (
        <>
          <p style={{ color: "var(--danger)" }}>{error}</p>
          <button onClick={onRetry}>Retry</button>
        </>
      )}
    </div>
  );
}
