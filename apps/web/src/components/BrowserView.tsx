import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeHttpUrl } from "../lib/preview";
import { useT } from "../lib/i18n";
import { IconGlobe } from "./icons";

/**
 * Browser pane (P2-011, P1-072): in the desktop shell it renders a real,
 * sandboxed Electron <webview> — scroll, click and edit work like a browser.
 * In the PWA (no desktop bridge) it falls back to driving the host browser
 * through the daemon's /api/browse surface (Playwright screenshots), which
 * stays the reviewer-driving path (tools/browse.mjs).
 *
 * P3-379: the pane's first paint is a designed empty state — it never
 * auto-navigates on the user's behalf (the old default URL silently reached
 * the host daemon's dashboard from unpaired first boots). Nothing loads until
 * the user types an address or a preview event arrives.
 */
export type BrowseFn = (
  req: { path: string; method?: string; body?: unknown },
) => Promise<{ status: number; contentType: string; body: string } | null>;

interface BrowseInfo {
  url: string;
  title: string;
  text?: string;
}

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

type TFn = (key: string, vars?: Record<string, string | number>) => string;

// P3-382: known internal throws resolve to their own dict key; a daemon-
// provided message rides the {msg} detail of one localized sentence — the
// pane never paints a bare English literal again.
function browserErrorText(raw: string, t: TFn): string {
  if (/unreachable/i.test(raw)) return t("browserErrUnreachable");
  if (/desktop only/i.test(raw)) return t("browserErrDesktopOnly");
  if (/unexpected response/i.test(raw)) return t("browserErrUnexpected");
  return t("browserErrGeneric", { msg: raw });
}

/** P3-378: classifies a rejected address-bar target. A URL that parses but
 * isn't http(s) (file://, data:…) is a deliberate sandbox rejection and gets
 * its own explanation; unparseable input is the generic typo case. */
function rejectMessage(t: TFn, target: string): string {
  try {
    new URL(target);
    return t("browserLocalFile");
  } catch {
    return t("browserInvalidUrl");
  }
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
  const t = useT();
  // P3-379: "" means "new tab" — no src attribute is rendered, so the pane
  // never reaches a host service before the user asks for one.
  const [src, setSrc] = useState<string>(() => previewUrl ?? "");
  const [input, setInput] = useState(() => previewUrl ?? "");
  // A real page is (or was) loaded: the empty state only paints before that.
  const [started, setStarted] = useState(() => Boolean(previewUrl));
  const [error, setError] = useState("");
  // P3-378: the bar itself flags a rejected typed URL (red border) — the lone
  // red line under it was too easy to miss over a still-loaded page.
  const [rejected, setRejected] = useState(false);
  const [loading, setLoading] = useState(false);
  const wvRef = useRef<WebviewElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // P2-092: the pane changes size without a remount (maximize toggle, window
  // resize, hidden⇄shown flips). The Electron guest view sizes itself from the
  // internal shadow iframe, so a missed layout sync shows up as content
  // painted in a stale strip — re-assert the element box whenever the frame
  // resizes.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const ro = new ResizeObserver(() => {
      const wv = wvRef.current;
      if (!wv) return;
      const { width, height } = frame.getBoundingClientRect();
      if (width < 1 || height < 1) return; // pane hidden — keep the last box
      wv.style.width = `${width}px`;
      wv.style.height = `${height}px`;
    });
    ro.observe(frame);
    return () => ro.disconnect();
  }, []);

  // Auto-preview: every new URL the daemon emits takes over the pane.
  useEffect(() => {
    if (!previewUrl) return;
    setStarted(true);
    setInput(previewUrl);
    setError("");
    setRejected(false);
    const wv = wvRef.current;
    if (!wv) {
      setSrc(previewUrl); // not mounted yet — the attribute drives the first load
      return;
    }
    try {
      wv.loadURL(previewUrl);
    } catch {
      // P2-091: a mobile⇄desk flip remounts this pane while the preview URL
      // stays set — the fresh <webview> is not dom-ready yet and Electron
      // throws on loadURL. The src attribute carries the navigation instead.
      setSrc(previewUrl);
    }
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
      // about:blank is the guest's idle page — it never un-hides the empty
      // state and never dirties the address bar
      if (!u || u === "about:blank") return;
      setStarted(true);
      setInput(u);
      setError("");
      setRejected(false);
      setLoading(false);
    };
    const onStart = () => setLoading(true);
    const onStop = () => setLoading(false);
    const onFail = (e: Event) => {
      const d = e as unknown as { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      // -3 = aborted navigation (user clicked elsewhere) — not a failure
      if (d.isMainFrame === false || d.errorCode === -3) return;
      setError(d.errorDescription || t("browserLoadFailed"));
      setLoading(false);
    };
    const onCrashed = () => setError(t("browserCrashed"));
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
      setRejected(true);
      setError(rejectMessage(t, target.trim()));
      return;
    }
    setRejected(false);
    setError("");
    setInput(normalized);
    setStarted(true);
    const wv = wvRef.current;
    if (!wv) {
      setSrc(normalized);
      return;
    }
    try {
      wv.loadURL(normalized);
    } catch {
      // P3-379: from the new-tab empty state the guest has no dom-ready yet and
      // Electron throws on loadURL — the src attribute carries the first load
      // (same escape as the preview effect above, P2-091).
      setSrc(normalized);
    }
  }

  function reload() {
    const wv = wvRef.current;
    if (!wv) return;
    setError("");
    setRejected(false);
    try {
      wv.reload();
    } catch {
      // P3-379: a guest with no page yet (fresh empty pane, remount race) has
      // nothing to reload — the empty state (or pending src) stays as-is.
    }
  }

  return (
    <div className="browser-pane">
      <header className="browser-header">
        <button onClick={onBack} aria-label={t("browserBack")}>←</button>
        <h1 className="pane-title">{t("navBrowser")}</h1>
        {onToggleMaximize && (
          <button
            onClick={onToggleMaximize}
            aria-label={maximized ? t("browserRestore") : t("browserMaximize")}
            title={maximized ? t("browserRestore") : t("browserMaximize")}
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
          aria-invalid={rejected || undefined}
          style={{ flex: 1 }}
        />
        <button onClick={reload} aria-label={t("browserReload")} title={t("browserReload")}>↻</button>
      </div>
      {error && <p className="browser-error">{error}</p>}
      <div className="browser-frame" ref={frameRef}>
        {/* allowpopups stays at its default (off); the page never escapes the pane */}
        <webview
          ref={(el) => {
            wvRef.current = el as WebviewElement | null;
          }}
          src={src || undefined}
          webpreferences="contextIsolation=yes, sandbox=yes"
        />
        {!started && (
          <div className="browser-empty">
            <span className="browser-empty-icon" aria-hidden="true">
              <IconGlobe />
            </span>
            <p className="browser-empty-title">{t("browserNoPage")}</p>
            <p className="browser-empty-hint">{t("browserEmptyHint")}</p>
          </div>
        )}
        {loading && <div className="browser-loading" aria-hidden="true" />}
      </div>
    </div>
  );
}

/* ── screenshot mode (PWA fallback, unchanged P2-011 behavior) ────────────── */

function ScreenshotBrowser({ browse, onBack }: { browse: BrowseFn | null; onBack: () => void }) {
  const t = useT();
  const [input, setInput] = useState("");
  const [info, setInfo] = useState<BrowseInfo | null>(null);
  const [shot, setShot] = useState("");
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // P3-378: mirrors the webview pane — the bar flags a rejected typed URL
  const [rejected, setRejected] = useState(false);
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
      // P3-378: same client-side rejection as the webview pane — a non-http(s)
      // target (file://…) never reaches the daemon, whose raw 400 would only
      // ride the generic {msg} sentence.
      const normalized = normalizeHttpUrl(target.trim());
      if (!normalized) {
        setRejected(true);
        setError(rejectMessage(t, target.trim()));
        return;
      }
      setRejected(false);
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
    [callJson, refresh, t],
  );

  // P3-379: first paint stays on the empty state — the pane must not silently
  // drive the host browser to a service (the old default URL) without the
  // user asking for it.

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
        <button onClick={onBack} aria-label={t("back")}>←</button>
        <h1 className="pane-title">{t("navBrowser")}</h1>
        <button onClick={() => setShowText((v) => !v)} aria-label={t("browserToggleText")}>
          ≡
        </button>
        <button onClick={() => void refresh()} aria-label={t("browserRefreshShot")}>
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
          aria-invalid={rejected || undefined}
        />
        <button onClick={() => void open(input)} disabled={busy}>
          {t("browserGo")}
        </button>
      </div>
      <div className="list" style={{ overflow: "auto" }}>
        {error && <p style={{ color: "var(--danger)", padding: "0 10px" }}>{browserErrorText(error, t)}</p>}
        <div style={{ position: "relative" }}>
          {shot ? (
            <img
              ref={imgRef}
              src={shot}
              alt={t("browserShotAlt")}
              style={{ width: "100%", display: "block", cursor: "crosshair" }}
              onClick={onClickImage}
            />
          ) : (
            <p className="muted" style={{ padding: 10 }}>
              {busy ? t("browserLoading") : t("browserNoPage")}
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
