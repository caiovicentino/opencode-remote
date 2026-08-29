import { useState, type ReactElement, type ReactNode } from "react";
import { downloadFile, saveFile, type OcrRequest } from "../lib/files";

export default function FileCard({
  path,
  request,
  onError,
}: {
  path: string;
  request: OcrRequest;
  onError?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url?: string; html?: string } | null>(null);
  const name = path.split("/").pop() ?? path;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const kind = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext)
    ? "image"
    : ext === "pdf"
      ? "pdf"
      : ext === "html" || ext === "htm"
        ? "html"
        : null;

  async function loadPreview() {
    setBusy(true);
    try {
      const file = await downloadFile(request, path);
      setPreview(
        kind === "image" || kind === "pdf"
          ? { url: URL.createObjectURL(file) }
          : { html: await file.text() },
      );
    } catch (err) {
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // fullscreen viewer: "View" opens the document full-bleed, "← Chat" returns
  if (preview?.html || (preview?.url && kind === "pdf")) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          background: "#fff",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            background: "var(--surface)",
            color: "var(--text)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <button onClick={() => setPreview(null)}>← Chat</button>
          <span
            style={{
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "0.85rem",
            }}
          >
            {name}
          </span>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                try {
                  await saveFile(request, path);
                } catch (err) {
                  onError?.(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {busy ? "…" : "Save"}
          </button>
        </div>
        {preview.url ? (
          <iframe
            title={name}
            src={preview.url}
            style={{ flex: 1, border: "none", width: "100%" }}
          />
        ) : (
          <iframe
            title={name}
            sandbox="allow-scripts"
            srcDoc={preview.html}
            style={{ flex: 1, border: "none", width: "100%" }}
          />
        )}
      </div>
    );
  }

  return (
    <div style={{ margin: "4px 0" }}>
      <div
        className="card"
        style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 10px" }}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "0.85rem",
          }}
        >
          {name}
        </span>
        {kind && !preview && (
          <button disabled={busy} style={{ padding: "6px 10px" }} onClick={() => void loadPreview()}>
            {busy ? "…" : "View"}
          </button>
        )}
        <button
          className="primary"
          disabled={busy}
          style={{ padding: "6px 12px" }}
          onClick={() =>
            void (async () => {
              setBusy(true);
              try {
                await saveFile(request, path);
              } catch (err) {
                onError?.(err instanceof Error ? err.message : String(err));
              } finally {
                setBusy(false);
              }
            })()
          }
        >
          {busy ? "…" : "Save"}
        </button>
      </div>
      {preview?.url && (
        <img src={preview.url} alt={name} style={{ maxWidth: "100%", borderRadius: 8, marginTop: 4 }} />
      )}
    </div>
  );
}

const FILE_MARKER = /^\[file: (.+)\]$/;

/** minimal safe inline markdown: **bold**, *italic*, `code` */
function inline(text: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) parts.push(<b key={`${keyBase}b${i}`}>{tok.slice(2, -2)}</b>);
    else if (tok.startsWith("`"))
      parts.push(
        <code key={`${keyBase}c${i}`} style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>
          {tok.slice(1, -1)}
        </code>,
      );
    else parts.push(<i key={`${keyBase}i${i}`}>{tok.slice(1, -1)}</i>);
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Renders a bubble: file-marker lines become cards, the rest gets markdown. */
export function renderBubbleText(
  text: string,
  request: OcrRequest,
  onError?: (msg: string) => void,
): (string | ReactElement)[] {
  return text.split("\n").map((line, i) => {
    const m = FILE_MARKER.exec(line.trim());
    const p = m?.[1];
    if (p) return <FileCard key={i} path={p} request={request} onError={onError} />;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const heading = h[2] ?? "";
      return (
        <div key={i} style={{ fontWeight: 700, marginTop: 6 }}>
          {inline(heading, String(i))}
        </div>
      );
    }
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const item = li[1] ?? "";
      return (
        <div key={i} style={{ paddingLeft: 12 }}>
          • {inline(item, String(i))}
        </div>
      );
    }
    return (
      <span key={i}>
        {inline(line, String(i))}
        <br />
      </span>
    );
  });
}
