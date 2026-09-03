import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { downloadFile, saveFile, type OcrRequest } from "../lib/files";
import { useT } from "../lib/i18n";

export default function FileCard({
  path,
  request,
  onError,
}: {
  path: string;
  request: OcrRequest;
  onError?: (msg: string) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  async function copyPath() {
    const ok = await copyText(path);
    if (ok) {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } else {
      onError?.(t("copyFailed"));
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
          background: "var(--preview-bg)",
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
        <button
          disabled={busy}
          style={{ padding: "6px 10px", minWidth: copied ? undefined : 34 }}
          title={t("copyPath")}
          aria-label={t("copyPath")}
          onClick={() => void copyPath()}
        >
          {copied ? t("copied") : "⧉"}
        </button>
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
const FENCE = /^```\w*\s*$/;

function codeBlock(code: string, lang: string, key: string): ReactElement {
  return (
    <pre
      key={key}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "8px 10px",
        overflowX: "auto",
        maxWidth: "100%", // P1-080: scroll inside the block, never the page
        fontSize: "0.78rem",
        lineHeight: 1.45,
        margin: "4px 0",
      }}
    >
      {lang && (
        <div
          style={{
            color: "var(--muted)",
            fontSize: "0.62rem",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            marginBottom: 4,
          }}
        >
          {lang}
        </div>
      )}
      <code style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre" }}>
        {code}
      </code>
    </pre>
  );
}

/** only http(s)/mailto — blocks javascript:, data:, vbscript: etc. */
function safeUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

const MD_LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/** minimal safe inline markdown: **bold**, *italic*, `code`, [label](url), bare URLs */
function inline(text: string, keyBase: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex =
    /(\[[^\]]+\]\([^)\s]+\)|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|https?:\/\/[^\s<>"]+)/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    const md = MD_LINK.exec(tok);
    if (md && safeUrl(md[2] ?? "")) {
      parts.push(
        <a
          key={`${keyBase}a${i}`}
          href={md[2]}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)", wordBreak: "break-all" }}
        >
          {md[1]}
        </a>,
      );
    } else if (tok.startsWith("**")) parts.push(<b key={`${keyBase}b${i}`}>{tok.slice(2, -2)}</b>);
    else if (tok.startsWith("`"))
      parts.push(
        <code key={`${keyBase}c${i}`} style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>
          {tok.slice(1, -1)}
        </code>,
      );
    else if (/^https?:\/\//.test(tok)) {
      // bare URL: don't swallow sentence punctuation or surrounding parens
      const url = tok.replace(/[.,;:!?)\]]+$/, "");
      const tail = tok.slice(url.length);
      parts.push(
        <a
          key={`${keyBase}u${i}`}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)", wordBreak: "break-all" }}
        >
          {url}
        </a>,
      );
      if (tail) parts.push(tail);
    } else if (tok.startsWith("[")) parts.push(tok); // md link with unsafe scheme — plain text
    else parts.push(<i key={`${keyBase}i${i}`}>{tok.slice(1, -1)}</i>);
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Renders a bubble: file-marker lines become cards, fenced code becomes blocks, the rest gets markdown. */
export function renderBubbleText(
  text: string,
  request: OcrRequest,
  onError?: (msg: string) => void,
): (string | ReactElement)[] {
  const out: (string | ReactElement)[] = [];
  const lines = text.split("\n");
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^```(\w*)\s*$/.exec(line.trim());
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test((lines[i] ?? "").trim())) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++;
      out.push(codeBlock(buf.join("\n"), lang, `k${k++}`));
      continue;
    }
    const m = FILE_MARKER.exec(line.trim());
    const p = m?.[1];
    if (p) {
      out.push(<FileCard key={`f${k++}`} path={p} request={request} onError={onError} />);
      i++;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const heading = h[2] ?? "";
      out.push(
        <div key={`h${k++}`} style={{ fontWeight: 700, marginTop: 6 }}>
          {inline(heading, String(k))}
        </div>,
      );
      i++;
      continue;
    }
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      const item = li[1] ?? "";
      out.push(
        <div key={`l${k++}`} style={{ paddingLeft: 12 }}>
          • {inline(item, String(k))}
        </div>,
      );
      i++;
      continue;
    }
    out.push(
      <span key={`t${k++}`}>
        {inline(line, String(k))}
        <br />
      </span>,
    );
    i++;
  }
  return out;
}
