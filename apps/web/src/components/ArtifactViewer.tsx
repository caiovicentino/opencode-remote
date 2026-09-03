import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArtifactTooLarge, b64ToBlob, fetchArtifact, fmtBytes, saveBlob, type ArtifactMeta } from "../lib/artifacts";
import { parseMarkdown, type Inline, type MdBlock } from "../lib/md";
import { parseCsv } from "../lib/csv";
import type { OcrRequest } from "../lib/files";

interface ViewState {
  loading: boolean;
  error?: string;
  text?: string;
  truncated?: boolean;
  url?: string;
  mime?: string;
  size?: number;
  blob?: Blob;
  /** P2-097: the read was refused by the daemon's size cap (no bytes to save) */
  tooLarge?: boolean;
}

const TEXTISH = new Set(["html", "md", "csv", "text"]);

function inlineNodes(inline: Inline[], keyBase: string): ReactNode[] {
  return inline.map((seg, i) => {
    if (typeof seg === "string") return <span key={`${keyBase}s${i}`}>{seg}</span>;
    if (seg.kind === "bold") return <b key={`${keyBase}b${i}`}>{seg.text}</b>;
    if (seg.kind === "italic") return <i key={`${keyBase}i${i}`}>{seg.text}</i>;
    if (seg.kind === "code")
      return (
        <code
          key={`${keyBase}c${i}`}
          style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}
        >
          {seg.text}
        </code>
      );
    return (
      <a
        key={`${keyBase}a${i}`}
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--accent)", wordBreak: "break-all" }}
      >
        {seg.text}
      </a>
    );
  });
}

function blocks(nodes: MdBlock[]): ReactNode[] {
  return nodes.map((b, i) => {
    switch (b.type) {
      case "heading": {
        const sizes = ["1.3rem", "1.15rem", "1rem"];
        return (
          <div key={i} style={{ fontWeight: 700, fontSize: sizes[b.level - 1], marginTop: i ? 10 : 0 }}>
            {inlineNodes(b.inline, `h${i}`)}
          </div>
        );
      }
      case "li":
        return (
          <div key={i} style={{ paddingLeft: 14 }}>
            • {inlineNodes(b.inline, `l${i}`)}
          </div>
        );
      case "code":
        return (
          <pre
            key={i}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "8px 10px",
              overflowX: "auto",
              maxWidth: "100%", // P1-080: scroll inside the block, never the page
              fontSize: "0.78rem",
              lineHeight: 1.45,
            }}
          >
            <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre" }}>
              {b.text}
            </code>
          </pre>
        );
      case "table": {
        const cell = { padding: "4px 8px", borderBottom: "1px solid var(--border)", textAlign: "left" } as const;
        return (
          <div key={i} style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: "0.82rem", margin: "6px 0" }}>
              <thead>
                <tr>
                  {b.header.map((h, j) => (
                    <th key={j} style={{ ...cell, fontWeight: 700 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>
                    {r.map((c, k) => (
                      <td key={k} style={cell}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      default:
        return (
          <p key={i} style={{ margin: "6px 0", wordBreak: "break-word" }}>
            {inlineNodes(b.inline, `p${i}`)}
          </p>
        );
    }
  });
}

/**
 * Artifact viewer: html in a sandboxed iframe, md/tables with the light
 * renderer, pdf/image inline, everything else via open/save links.
 * Two variants (P2-062): "overlay" covers the whole screen (mobile, Artifacts
 * pane); "panel" fills its parent flex box for the chat's side-by-side preview.
 */
export default function ArtifactViewer({
  meta,
  request,
  onClose,
  variant = "overlay",
}: {
  meta: ArtifactMeta;
  request: OcrRequest;
  onClose: () => void;
  /** "overlay" (default) renders fixed full-screen; "panel" fills its parent */
  variant?: "overlay" | "panel";
}) {
  const [state, setState] = useState<ViewState>({ loading: true });
  const viewRef = useRef<ViewState>({ loading: true });
  viewRef.current = state;

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    void (async () => {
      try {
        const c = await fetchArtifact(request, meta.sessionId, meta.name);
        if (!alive) return;
        if (!c) {
          setState({ loading: false, error: "artifact not found" });
          return;
        }
        const blob = b64ToBlob(c.data, c.mime);
        const url = TEXTISH.has(c.kind) ? undefined : URL.createObjectURL(blob);
        const full = TEXTISH.has(c.kind) ? await blob.text() : undefined;
        const truncated = full !== undefined && full.length > 500_000;
        const text = truncated ? full!.slice(0, 500_000) : full;
        setState({ loading: false, url, text, truncated, mime: c.mime, size: c.size, blob });
      } catch (err) {
        if (alive)
          setState({
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            tooLarge: err instanceof ArtifactTooLarge,
          });
      }
    })();
    return () => {
      alive = false;
      const url = viewRef.current.url;
      if (url) URL.revokeObjectURL(url);
    };
  }, [meta, request]);

  function save() {
    const mime = state.mime ?? "application/octet-stream";
    const blob = state.blob ?? new Blob([state.text ?? ""], { type: mime });
    saveBlob(blob, meta.name);
  }

  return (
    <div
      style={
        variant === "panel"
          ? {
              flex: 1,
              minWidth: 0,
              background: "var(--bg)",
              display: "flex",
              flexDirection: "column",
            }
          : {
              position: "fixed",
              inset: 0,
              zIndex: 1000,
              background: "var(--bg)",
              display: "flex",
              flexDirection: "column",
            }
      }
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
        <button onClick={onClose} aria-label="Close">
          ←
        </button>
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "0.85rem",
          }}
        >
          {meta.name}
          {state.size ? <span className="muted"> · {fmtBytes(state.size)}</span> : null}
        </span>
        {/* P2-097: with the content refused there are no bytes to save — an
           honest header hides the action instead of writing an empty file */}
        {!state.tooLarge && (
          <button className="primary" onClick={save}>
            Save
          </button>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: state.text ? 14 : 0 }}>
        {state.loading && <p className="muted">…</p>}
        {state.error && <p style={{ color: "var(--danger)" }}>{state.error}</p>}
        {!state.loading && !state.error && (
          <>
            {state.truncated && (
              <p className="muted" style={{ margin: "0 0 8px" }}>
                Large file — showing the first 500 KB. Use Save to get it whole.
              </p>
            )}
            {meta.kind === "html" && (
              <iframe
                title={meta.name}
                sandbox="allow-scripts"
                srcDoc={state.text ?? ""}
                style={{ width: "100%", height: "100%", border: "none", background: "var(--preview-bg)" }}
              />
            )}
            {meta.kind === "md" && (
              <div style={{ maxWidth: "min(900px, 100%)", overflowWrap: "anywhere" }}>
                {blocks(parseMarkdown(state.text ?? ""))}
              </div>
            )}
            {meta.kind === "csv" && <CsvTable text={state.text ?? ""} />}
            {meta.kind === "text" && (
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxWidth: "100%",
                  overflowWrap: "anywhere",
                  fontSize: "0.8rem",
                  margin: 0,
                }}
              >
                {state.text}
              </pre>
            )}
            {meta.kind === "pdf" && (
              <iframe
                title={meta.name}
                src={state.url}
                // P2-097: blob is same-origin — allow-same-origin keeps the
                // browser's PDF viewer working while scripts/forms/popups stay
                // blocked (the blob is created here, never attacker-navigable)
                sandbox="allow-same-origin"
                style={{ width: "100%", height: "100%", border: "none" }}
              />
            )}
            {meta.kind === "image" && (
              <img
                src={state.url}
                alt={meta.name}
                style={{ maxWidth: "100%", maxHeight: "100%", display: "block", margin: "auto" }}
              />
            )}
            {meta.kind === "binary" && (
              <div style={{ textAlign: "center", padding: 40 }}>
                <p className="muted">No inline preview for this file type.</p>
                <button className="primary" onClick={save}>
                  Save
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text);
  if (!rows.length) return <p className="muted">(empty)</p>;
  const [header, ...rest] = rows;
  const cell = { padding: "4px 8px", borderBottom: "1px solid var(--border)", textAlign: "left" } as const;
  return (
    <table style={{ borderCollapse: "collapse", fontSize: "0.82rem" }}>
      <thead>
        <tr>
          {(header ?? []).map((h, i) => (
            <th key={i} style={{ ...cell, fontWeight: 700 }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rest.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} style={cell}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
