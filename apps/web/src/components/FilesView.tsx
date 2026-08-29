import { useEffect, useState } from "react";
import { saveFile, type OcrRequest } from "../lib/files";

interface RemoteFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

function fmtSize(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export default function FilesView({
  request,
  onBack,
}: {
  request: OcrRequest;
  onBack: () => void;
}) {
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  function load() {
    void (async () => {
      const res = await request("GET", "/__ocr/files");
      if (res.status === 200) setFiles((res.body as { files?: RemoteFile[] }).files ?? []);
      else setError(`list failed (${res.status})`);
    })();
  }

  useEffect(load, []);

  function save(f: RemoteFile) {
    if (busy) return;
    setBusy(f.path);
    setError("");
    void (async () => {
      try {
        await saveFile(request, f.path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    })();
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>Files on {""}this machine</h1>
        <button onClick={load} aria-label="Refresh">
          ↻
        </button>
      </header>
      <div className="list">
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {files.length === 0 && !error && <p className="muted">No files yet.</p>}
        {files.map((f) => (
          <div key={f.path} className="card" style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
              <div className="muted" style={{ fontSize: "0.72rem" }}>
                {fmtSize(f.size)} · {new Date(f.mtime).toLocaleString()}
              </div>
            </div>
            <button className="primary" disabled={busy === f.path} onClick={() => save(f)}>
              {busy === f.path ? "…" : "Save"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
