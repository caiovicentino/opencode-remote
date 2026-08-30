import { useEffect, useState } from "react";
import { downloadFile, mimeFor, saveFile, type OcrRequest } from "../lib/files";

interface RemoteFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "html" | "none";

interface Preview {
  path: string;
  name: string;
  url: string;
  kind: PreviewKind;
  text?: string;
}

function fmtSize(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function kindOf(mime: string, name: string): PreviewKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html" || /\.html?$/i.test(name)) return "html";
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    /\.(md|txt|json|csv|log|ts|tsx|js|mjs|py|sh|yml|yaml|toml)$/i.test(name)
  )
    return "text";
  return "none";
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
  const [preview, setPreview] = useState<Preview | null>(null);

  function load() {
    void (async () => {
      const res = await request("GET", "/__ocr/files");
      if (res.status === 200) setFiles((res.body as { files?: RemoteFile[] }).files ?? []);
      else setError(`list failed (${res.status})`);
    })();
  }

  useEffect(load, []);

  useEffect(() => {
    return () => {
      if (preview?.url) URL.revokeObjectURL(preview.url);
    };
  }, [preview?.url]);

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

  function openPreview(f: RemoteFile) {
    if (busy || preview) return;
    setError("");
    setBusy(f.path);
    void (async () => {
      try {
        const file = await downloadFile(request, f.path);
        const mime = file.type || mimeFor(f.name);
        const kind = kindOf(mime, f.name);
        if (kind === "none") {
          setError(`no preview for ${mime || "this file type"} — use Save`);
          return;
        }
        if (kind === "text") {
          const full = await file.text();
          setPreview({
            path: f.path,
            name: f.name,
            url: "",
            kind,
            text: full.length > 200_000 ? full.slice(0, 200_000) + "\n… truncated" : full,
          });
        } else {
          setPreview({ path: f.path, name: f.name, url: URL.createObjectURL(file), kind });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    })();
  }

  function closePreview() {
    if (preview?.url) URL.revokeObjectURL(preview.url);
    setPreview(null);
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
        {files.map((f) => {
          const kind = kindOf(mimeFor(f.name), f.name);
          const tappable = kind !== "none";
          return (
            <div key={f.path} className="card" style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
              <div
                style={{ flex: 1, minWidth: 0, cursor: tappable ? "pointer" : "default" }}
                onClick={() => tappable && openPreview(f)}
                role={tappable ? "button" : undefined}
              >
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {busy === f.path ? "…" : f.name}
                </div>
                <div className="muted" style={{ fontSize: "0.72rem" }}>
                  {fmtSize(f.size)} · {new Date(f.mtime).toLocaleString()}
                </div>
              </div>
              <button className="primary" disabled={busy === f.path} onClick={() => save(f)}>
                {busy === f.path ? "…" : "Save"}
              </button>
            </div>
          );
        })}
      </div>

      {preview && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.94)",
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            padding: 12,
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={closePreview} aria-label="Close preview">
              ✕
            </button>
            <div
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontWeight: 600,
                fontSize: "0.9rem",
              }}
            >
              {preview.name}
            </div>
            <button
              className="primary"
              onClick={() => save({ path: preview.path, name: preview.name, size: 0, mtime: 0 })}
            >
              Save
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {preview.kind === "image" && (
              <img
                src={preview.url}
                alt={preview.name}
                style={{ margin: "auto", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 8 }}
              />
            )}
            {preview.kind === "video" && (
              <video src={preview.url} controls autoPlay style={{ margin: "auto", maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }} />
            )}
            {preview.kind === "audio" && <audio src={preview.url} controls style={{ margin: "auto", width: "100%" }} />}
            {preview.kind === "pdf" && (
              <div style={{ margin: "auto", textAlign: "center", display: "flex", flexDirection: "column", gap: 12 }}>
                <p className="muted" style={{ margin: 0 }}>
                  PDFs open in the system viewer.
                </p>
                <button className="primary" onClick={() => window.open(preview.url, "_blank")}>
                  Open PDF
                </button>
              </div>
            )}
            {preview.kind === "html" && (
              <iframe
                src={preview.url}
                sandbox=""
                title={preview.name}
                style={{ flex: 1, border: "none", borderRadius: 8, background: "#fff" }}
              />
            )}
            {preview.kind === "text" && (
              <pre
                style={{
                  flex: 1,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: "0.8rem",
                  margin: 0,
                }}
              >
                {preview.text}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
