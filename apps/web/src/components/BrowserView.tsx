import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeHttpUrl } from "../lib/preview";

/**
 * Browser pane (P2-011, P1-072): in the desktop shell it renders a real,
 * sandboxed Electron <webview> — scroll, click and edit work like a browser.
 * In the PWA (no desktop bridge) it falls back to driving the host browser
 * through the daemon's /api/browse surface (Playwright screenshots), which
 * stays the reviewer-driving path (tools/browse.mjs).
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

/** Methods of the Electron <webview> tag (webviewTag: true in the shell). */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): void;
  reload(): void;
  getURL(): string;
}

// P1-072: webpreferences is Electron-webview-only and missing from React types.
declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface WebViewHTMLAttributes<T> {
    webpreferences?: string | undefined;
  }
}

function isDesktopShell(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as { ocrDesktop?: unknown }).ocrDesktop);
}

export default function BrowserView({
  browse,
  onBack,
  previewUrl,
  maximized,
  onToggleMaximize,
}: {
  browse: BrowseFn | null;
  onBack: () => void;
  previewUrl?: string | null;
  maximized?: boolean;
  onToggleMaximize?: () => void;
}) {
  if (isDesktopShell()) {
    return (
      <WebViewPane
        previewUrl={previewUrl}
        maximized={maximized}
        onToggleMaximize={onToggleMaximize}
        onBack={onBack}
      />
    );
  }
  return <ScreenshotBrowser browse={browse} onBack={onBack} />;
}

/* ── interactive webview mode (desktop shell) ─────────────────────────────── */

function WebViewPane({
  previewUrl,
  maximized,
  onToggleMaximize,
  onBack,
}: {
  previewUrl?: string | null;
  maximized?: boolean;
  onToggleMaximize?: () => void;
  onBack: () => void;
}) {
  const [src, setSrc] = useState<string>(() => previewUrl ?? DEFAULT_URL);
  const [input, setInput] = useState(() => previewUrl ?? DEFAULT_URL);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const wvRef = useRef<WebviewElement | null>(null);

  // Auto-preview: every new URL the daemon emits takes over the pane.
  useEffect(() => {
    if (!previewUrl) return;
    setInput(previewUrl);
    setError("");
    const wv = wvRef.current;
    if (wv) wv.loadURL(previewUrl);
    else setSrc(previewUrl); // not mounted yet — the attribute drives the first load
  }, [previewUrl]);

  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const urlOf = (e: Event): string => {
      const u = (e as unknown as { url?: string }).url;
      return typeof u === "string" ? u : "";
    };
    const onNavigate = (e: Event) => {
      const u = urlOf(e);
      if (u) setInput(u);
      setError("");
      setLoading(false);
    };
    const onStart = () => setLoading(true);
    const onStop = () => setLoading(false);
    const onFail = (e: Event) => {
      const d = e as unknown as { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      // -3 = aborted navigation (user clicked elsewhere) — not a failure
      if (d.isMainFrame === false || d.errorCode === -3) return;
      setError(d.errorDescription || "Não foi possível carregar a página.");
      setLoading(false);
    };
    const onCrashed = () => setError("O renderizador da página caiu — recarregue.");
    wv.addEventListener("did-navigate", onNavigate);
    wv.addEventListener("did-navigate-in-page", onNavigate);
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("did-fail-load", onFail);
    wv.addEventListener("crashed", onCrashed);
    return () => {
      wv.removeEventListener("did-navigate", onNavigate);
      wv.removeEventListener("did-navigate-in-page", onNavigate);
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
      wv.removeEventListener("did-fail-load", onFail);
      wv.removeEventListener("crashed", onCrashed);
    };
  }, []);

  function go(target: string) {
    // only http/https reach the webview — file:// and friends are rejected
    const normalized = normalizeHttpUrl(target.trim());
    if (!normalized) {
      setError("URL inválida — use http(s)://…");
      return;
    }
    setError("");
    setInput(normalized);
    const wv = wvRef.current;
    if (wv) wv.loadURL(normalized);
    else setSrc(normalized);
  }

  function reload() {
    const wv = wvRef.current;
    if (!wv) return;
    setError("");
    try {
      wv.reload();
    } catch {
      wv.loadURL(wv.getURL() || DEFAULT_URL);
    }
  }

  return (
    <div className="browser-pane">
      <header className="browser-header">
        <button onClick={onBack} aria-label="Voltar ao chat">←</button>
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>Browser</h1>
        {onToggleMaximize && (
          <button
            onClick={onToggleMaximize}
            aria-label={maximized ? "Restaurar painel" : "Maximizar painel"}
            title={maximized ? "Restaurar painel" : "Maximizar painel"}
          >
            {maximized ? "⤡" : "⤢"}
          </button>
        )}
      </header>
      <div className="browser-bar">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && go(input)}
          placeholder="http://localhost:3000"
          spellCheck={false}
          style={{ flex: 1 }}
        />
        <button onClick={reload} aria-label="Recarregar" title="Recarregar">↻</button>
      </div>
      {error && <p className="browser-error">{error}</p>}
      <div className="browser-frame">
        {/* allowpopups stays at its default (off); the page never escapes the pane */}
        <webview
          ref={(el) => {
            wvRef.current = el as WebviewElement | null;
          }}
          src={src}
          webpreferences="contextIsolation=yes, sandbox=yes"
        />
        {loading && <div className="browser-loading" aria-hidden="true" />}
      </div>
    </div>
  );
}

/* ── screenshot mode (PWA fallback, unchanged P2-011 behavior) ────────────── */

function ScreenshotBrowser({ browse, onBack }: { browse: BrowseFn | null; onBack: () => void }) {
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
                background: "var(--scrim-soft)",
                display: "grid",
                placeItems: "center",
                color: "var(--on-scrim)",
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
