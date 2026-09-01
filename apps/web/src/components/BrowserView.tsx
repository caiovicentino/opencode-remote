import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser pane (P2-011): drives the host browser through the daemon's
 * /api/browse surface (Playwright). The page itself never renders inside this
 * app — we show live screenshots and map clicks back to page coordinates, so
 * arbitrary web content stays outside the app's origin (same trust model as
 * the artifacts viewer: never execute agent/hostile HTML locally).
 */
export type BrowseFn = (
  req: { path: string; method?: string; body?: unknown },
) => Promise<{ status: number; contentType: string; body: string } | null>;

interface BrowseInfo {
  url: string;
  title: string;
  text?: string;
}

const DEFAULT_URL = "http://127.0.0.1:8792/dashboard";

export default function BrowserView({ browse, onBack }: { browse: BrowseFn | null; onBack: () => void }) {
  const [input, setInput] = useState(DEFAULT_URL);
  const [info, setInfo] = useState<BrowseInfo | null>(null);
  const [shot, setShot] = useState("");
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showText, setShowText] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const decode = useCallback(
    async (r: { status: number; contentType: string; body: string } | null) => {
      if (!r) throw new Error("daemon unreachable");
      if (r.contentType.includes("image/png")) return { png: r.body } as const;
      const buf = window.atob(r.body);
      const bytes = new Uint8Array(buf.length);
      for (let i = 0; i < buf.length; i++) bytes[i] = buf.charCodeAt(i);
      const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      if (r.status >= 400 || json.error) throw new Error(String(json.error ?? `HTTP ${r.status}`));
      return { json } as const;
    },
    [],
  );

  /** JSON request to /api/browse; throws with the daemon's error message. */
  const callJson = useCallback(
    async (path: string, method?: string, body?: unknown): Promise<Record<string, unknown>> => {
      if (!browse) throw new Error("desktop only");
      const r = await decode(await browse({ path, method, ...(body !== undefined ? { body } : {}) }));
      if (!r.json) throw new Error("unexpected response");
      return r.json;
    },
    [browse, decode],
  );

  const refresh = useCallback(async () => {
    if (!browse) return;
    const r = await decode(await browse({ path: "/api/browse/screenshot" }));
    if (r.png) {
      setShot(`data:image/png;base64,${r.png}`);
      setError("");
    }
  }, [browse, decode]);

  const open = useCallback(
    async (target: string) => {
      setBusy(true);
      setError("");
      try {
        const j = await callJson("/api/browse/open", "POST", { url: target });
        setInfo({
          url: String(j.url ?? ""),
          title: String(j.title ?? ""),
          text: typeof j.text === "string" ? j.text : undefined,
        });
        const vp = j.viewport as { width?: unknown; height?: unknown } | undefined;
        if (vp && Number.isFinite(Number(vp.width)) && Number.isFinite(Number(vp.height))) {
          setViewport({ width: Number(vp.width), height: Number(vp.height) });
        }
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [callJson, refresh],
  );

  // First paint: open the default page so the pane is never empty.
  useEffect(() => {
    if (browse) void open(DEFAULT_URL);
  }, [browse]);

  function onClickImage(e: React.MouseEvent<HTMLImageElement>) {
    const img = imgRef.current;
    if (!img || !viewport || busy) return;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * viewport.width;
    const y = ((e.clientY - rect.top) / rect.height) * viewport.height;
    setBusy(true);
    void (async () => {
      try {
        await callJson("/api/browse/click", "POST", { x, y });
        const t = await callJson("/api/browse/text");
        setInfo({
          url: String(t.url ?? ""),
          title: String(t.title ?? ""),
          text: typeof t.text === "string" ? t.text : undefined,
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>Browser</h1>
        <button onClick={() => setShowText((v) => !v)} aria-label="Toggle text">
          ≡
        </button>
        <button onClick={() => void refresh()} aria-label="Refresh screenshot">
          ↻
        </button>
      </header>
      <div style={{ display: "flex", gap: 6, padding: "8px 10px" }}>
        <input
          style={{ flex: 1 }}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void open(input)}
          placeholder="https://…"
          spellCheck={false}
        />
        <button onClick={() => void open(input)} disabled={busy}>
          Go
        </button>
      </div>
      <div className="list" style={{ overflow: "auto" }}>
        {error && <p style={{ color: "var(--danger)", padding: "0 10px" }}>{error}</p>}
        <div style={{ position: "relative" }}>
          {shot ? (
            <img
              ref={imgRef}
              src={shot}
              alt="host browser"
              style={{ width: "100%", display: "block", cursor: "crosshair" }}
              onClick={onClickImage}
            />
          ) : (
            <p className="muted" style={{ padding: 10 }}>
              {busy ? "Loading…" : "No page loaded."}
            </p>
          )}
          {busy && shot && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(0,0,0,.35)",
                display: "grid",
                placeItems: "center",
                color: "#fff",
                fontSize: 13,
              }}
            >
              …
            </div>
          )}
        </div>
        {info && (
          <p className="muted" style={{ padding: "4px 10px", fontSize: 12, wordBreak: "break-all" }}>
            {info.title} — {info.url}
          </p>
        )}
        {showText && info?.text && (
          <pre
            style={{
              margin: "0 10px 10px",
              whiteSpace: "pre-wrap",
              fontSize: 12,
              background: "var(--surface)",
              padding: 8,
              borderRadius: 8,
            }}
          >
            {info.text}
          </pre>
        )}
      </div>
    </div>
  );
}
