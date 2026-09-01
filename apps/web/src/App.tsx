import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  OcrClient,
  loadState,
  saveState,
  setActiveRoom,
  getActiveRoom,
  removePairing,
  loadPairings,
  parsePairingUri,
  getOrCreateIdentity,
  type Pairing,
  type Status,
} from "./lib/client";
import type { OpResponse, EventEnvelope } from "@ocr/protocol";
import { gateVerify, gateEnroll } from "./lib/gate";
import { useT } from "./lib/i18n";
import PairingView from "./components/PairingView";
import PairingOverlay from "./components/PairingOverlay";
import SessionsView from "./components/SessionsView";
import ChatView from "./components/ChatView";
import SettingsView, { applyTheme } from "./components/SettingsView";
import FilesView from "./components/FilesView";
import ArtifactsView from "./components/ArtifactsView";
import SendToAgentView from "./components/SendToAgentView";
import BrowserView, { type BrowseFn } from "./components/BrowserView";

type Phase = "unpaired" | "connecting" | "paired" | "error";

type TabId = "sessions" | "files" | "settings";

/** Mirrors apps/desktop/src/preload.ts PairingState (kept in sync by tests). */
interface PairingState {
  uri: string | null;
  qrDataUrl: string | null;
  devices: number;
  phonePaired: boolean;
  /** P2-017: sidecar respawn budget exhausted (desktop shell only). */
  daemonDown?: boolean;
}

/** Electron bridge from apps/desktop/src/preload.ts (absent in the browser). */
interface DesktopBridge {
  getPairUrl?: () => Promise<string | null>;
  approveClient?: (pub: string) => Promise<boolean>;
  daemonBrowse?: (req: { path: string; method?: string; body?: unknown }) => Promise<{
    status: number;
    contentType: string;
    body: string;
  } | null>;
  /** P2-007: first-run QR overlay state (desktop shell only). */
  getPairingState?: () => Promise<PairingState | null>;
  onPairingState?: (cb: (state: PairingState | null) => void) => () => void;
  /** P3-014: opencode-remote:// pair link handed over by the OS (validated in the shell). */
  getDeepLink?: () => Promise<string | null>;
  onDeepLink?: (cb: (uri: string) => void) => () => void;
}

function desktopBridge(): DesktopBridge | null {
  const bridge = (window as unknown as { ocrDesktop?: DesktopBridge }).ocrDesktop;
  return bridge && typeof bridge.getPairUrl === "function" ? bridge : null;
}

function TabBar({
  active,
  onSelect,
  t,
}: {
  active: TabId;
  onSelect: (id: TabId) => void;
  t: (k: string) => string;
}) {
  const tabs: { id: TabId; label: string; icon: ReactNode }[] = [
    {
      id: "sessions",
      label: t("tabSessions"),
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
          <path d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2z" />
        </svg>
      ),
    },
    {
      id: "files",
      label: t("tabFiles"),
      icon: (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden>
          <path d="M3 5h6l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
        </svg>
      ),
    },
    {
      id: "settings",
      label: t("tabSettings"),
      icon: (
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
          <circle cx="7" cy="18" r="2" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((tb) => (
        <button
          key={tb.id}
          className={active === tb.id ? "active" : ""}
          onClick={() => onSelect(tb.id)}
          aria-label={tb.label}
        >
          {tb.icon}
          <span>{tb.label}</span>
        </button>
      ))}
    </nav>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export default function App() {
  const t = useT();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [phase, setPhase] = useState<Phase>("unpaired");
  const [error, setError] = useState("");
  const [machineName, setMachineName] = useState("");
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const clientRef = useRef<OcrClient | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [filesView, setFilesView] = useState(false);
  const [artifactsView, setArtifactsView] = useState(false);
  const [browserView, setBrowserView] = useState(false);
  // stable handle: the bridge returns a fresh fn each render, which would
  // re-trigger the BrowserView's open-on-mount effect forever
  const [browseFn] = useState<BrowseFn | null>(() => desktopBridge()?.daemonBrowse ?? null);
  const [share, setShare] = useState<{ title?: string; text?: string; url?: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [connStatus, setConnStatus] = useState<Status>("connecting");
  const [machines, setMachines] = useState<Pairing[]>(() => loadPairings());
  const [addingMachine, setAddingMachine] = useState(false);
  // navigation direction drives the slide-in animation of the next screen
  const [navDir, setNavDir] = useState<"fwd" | "back">("fwd");
  const appRootRef = useRef<HTMLDivElement>(null);
  const swipe = useRef({ x: 0, y: 0, dx: 0, active: false });
  const [unread, setUnread] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ocr_unread") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  const activeSessionRef = useRef<string | null>(null);

  // P2-007: first-run pairing overlay (desktop shell only). The main process
  // polls the daemon every 3s and caches the state; we pull once on mount and
  // subscribe to pushes so the QR shows immediately and leaves as soon as a
  // phone pairs.
  const [pairingState, setPairingState] = useState<PairingState | null>(null);
  const [pairingDismissed, setPairingDismissed] = useState(false);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.getPairingState) return;
    let alive = true;
    bridge.getPairingState().then((s) => {
      if (alive) setPairingState(s);
    }).catch(() => {});
    const un = bridge.onPairingState?.((s) => {
      if (alive) setPairingState(s);
    });
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  // keep the ref in sync for the event handler (which captures it once)
  useEffect(() => {
    activeSessionRef.current = session;
    if (session) setUnread((prev) => (prev[session] ? { ...prev, [session]: 0 } : prev));
  }, [session]);

  useEffect(() => {
    localStorage.setItem("ocr_unread", JSON.stringify(unread));
  }, [unread]);

  // WhatsApp-style unread: count turn-completions, errors and permission asks
  // for sessions that are not currently open on screen
  function bumpUnread(evt: EventEnvelope) {
    const p = (evt.properties ?? {}) as {
      sessionID?: string;
      info?: { sessionID?: string };
    };
    const sid = p.sessionID ?? p.info?.sessionID;
    if (!sid || sid === activeSessionRef.current) return;
    const worthy =
      evt.type === "session.idle" ||
      evt.type === "session.error" ||
      evt.type.toLowerCase().includes("permission");
    if (!worthy) return;
    setUnread((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }));
  }

  useEffect(() => {
    applyTheme();
  }, []);

  async function connect(pairing: Pairing, persist: boolean) {
    setPhase("connecting");
    setError("");
    try {
      // biometric gate before the identity key may be used
      if (!(await gateVerify())) {
        throw new Error("Biometric unlock failed");
      }
      const client = await OcrClient.connect(pairing);
      client.onStatus = (s) => setConnStatus(s);
      if (persist) {
        saveState(pairing);
        setMachines(loadPairings());
        void gateEnroll(); // best effort: offer Face ID lock on first pair
      }
      (window as unknown as { __ocrClient?: OcrClient }).__ocrClient = client;
      clientRef.current = client;
      setMachineName(pairing.name ?? "machine");
      setPhase("paired");
      client.onEvent((evt) => {
        setEvents((prev) => [...prev.slice(-500), evt]);
        bumpUnread(evt);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  // deep-link routing: notifications open #/session/<id> or #/files
  useEffect(() => {
    function applyHash() {
      const h = location.hash;
      // #/send?text=...&url=... — share ingestion via hash route
      if (h.startsWith("#/send")) {
        const qs = h.split("?")[1] ?? "";
        const sp = new URLSearchParams(qs);
        const payload = { title: sp.get("title") ?? "", text: sp.get("text") ?? "", url: sp.get("url") ?? "" };
        if (payload.title || payload.text || payload.url) {
          setShare(payload);
          setSession(null);
        }
        return;
      }
      const sid = /^#\/session\/([\w-]+)/.exec(h)?.[1];
      if (sid && clientRef.current) {
        setSession(sid);
        setFilesView(false);
        setSettings(false);
        return;
      }
      if (h === "#/files" && clientRef.current) {
        setFilesView(true);
        setSession(null);
        setSettings(false);
        setArtifactsView(false);
      }
      if (h === "#/artifacts" && clientRef.current) {
        setArtifactsView(true);
        setSession(null);
        setSettings(false);
        setFilesView(false);
      }
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [phase]);

  useEffect(() => {
    const stored = loadState();
    if (stored) {
      void connect(stored.pairing, false);
      return;
    }
    // Desktop shell, no stored pairing: pair with the local daemon sidecar
    // automatically (docs/VISION.md stage 3.1). The captured boot URI flows
    // through the exact same path as paste-pairing — parsePairingUri +
    // connect(persist=true) — so the manual screen only appears as fallback.
    const bridge = desktopBridge();
    if (!bridge?.getPairUrl) return;
    // P3-014: an opencode-remote:// pair link opened by the OS (install/invite
    // page) takes precedence and routes through the SAME parsePairingUri path
    // as paste-pairing — no new crypto, no new flow.
    let pairingStarted = false;
    const applyDeepLink = (uri: string | null | undefined): boolean => {
      const pairing = uri ? parsePairingUri(uri) : null;
      if (!pairing) return false;
      if (!pairingStarted) {
        pairingStarted = true;
        void connect(pairing, true);
      }
      return true;
    };
    const offDeepLink = bridge.onDeepLink?.((uri) => {
      // Only while still unpaired — a running session is never hijacked.
      if (!loadState()) applyDeepLink(uri);
    });
    const getPairUrl = bridge.getPairUrl;
    void (async () => {
      try {
        const deep = await bridge.getDeepLink?.();
        if (applyDeepLink(deep)) return;
        const uri = await getPairUrl();
        if (!uri) return;
        const pairing = parsePairingUri(uri);
        if (!pairing) return;
        // Host self-approval: register our (sticky) client identity pubkey in
        // the daemon allowlist before the handshake — the desktop owns the
        // state file, and the daemon re-reads it on every handshake.
        if (bridge.approveClient) {
          const identity = await getOrCreateIdentity();
          await bridge.approveClient(identity.publicKey);
        }
        void connect(pairing, true);
      } catch {
        /* no URI or unparsable URI → PairingView fallback */
      }
    })();
    return () => offDeepLink?.();
  }, []);

  // Web Share Target (Android/desktop Chrome): shared content arrives as query params
  useEffect(() => {
    const sp = new URLSearchParams(location.search);
    const payload = {
      title: sp.get("title") ?? "",
      text: sp.get("text") ?? "",
      url: sp.get("url") ?? "",
    };
    if (payload.title || payload.text || payload.url) {
      setShare(payload);
      history.replaceState(null, "", location.pathname);
    }
  }, []);

  // machine name is user-editable — refresh it from the daemon after connecting
  useEffect(() => {
    if (phase !== "paired") return;
    void (async () => {
      try {
        const res = await request("GET", "/__ocr/settings");
        const name = (res.body as { name?: string }).name;
        if (name) setMachineName(name);
      } catch {}
    })();
  }, [phase, tick]);

  function disconnect() {
    clientRef.current?.close();
    clientRef.current = null;
    setActiveRoom(null);
    setPhase("unpaired");
    setSession(null);
    setEvents([]);
    setTick((t) => t + 1);
  }

  function forgetMachine(p: Pairing) {
    setMachines(removePairing(p.room));
    if (getActiveRoom() === p.room) disconnect();
  }

  async function switchMachine(p: Pairing) {
    clientRef.current?.close();
    clientRef.current = null;
    setSession(null);
    setEvents([]);
    setActiveRoom(p.room);
    await connect(p, false);
  }

  async function request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<OpResponse> {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    return client.request(method as "GET", path, body, query);
  }

  function goBack() {
    setNavDir("back");
    if (session) {
      setSession(null);
      history.replaceState(null, "", "#/");
    } else if (settings) {
      setSettings(false);
      setTick((t) => t + 1);
    } else if (artifactsView) {
      setArtifactsView(false);
    } else if (browserView) {
      setBrowserView(false);
    } else if (filesView) {
      setFilesView(false);
    } else if (share) {
      setShare(null);
    }
  }

  // iOS-style swipe-back: drag from the right edge slides the current screen;
  // releasing past the threshold pops the view.
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t || e.touches.length !== 1) return;
    if (!session && !settings && !filesView && !artifactsView && !share) return;
    swipe.current = { x: t.clientX, y: t.clientY, dx: 0, active: t.clientX > window.innerWidth - 28 };
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!swipe.current.active) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - swipe.current.x;
    const dy = t.clientY - swipe.current.y;
    if (Math.abs(dy) > Math.abs(dx)) {
      // vertical scroll wins — abort the gesture
      swipe.current.active = false;
      const el = appRootRef.current;
      if (el) el.classList.remove("dragging");
      return;
    }
    swipe.current.dx = Math.max(0, dx);
    const el = appRootRef.current;
    if (el) {
      el.style.setProperty("--drag-x", `${Math.min(swipe.current.dx, 80)}px`);
      el.classList.add("dragging");
    }
  }
  function onTouchEnd() {
    if (!swipe.current.active) return;
    swipe.current.active = false;
    const el = appRootRef.current;
    const went = swipe.current.dx;
    if (el) {
      el.classList.remove("dragging");
      el.style.removeProperty("--drag-x");
    }
    if (went > 72) goBack();
  }

  const pairingOverlay =
    !pairingDismissed && pairingState?.qrDataUrl && !pairingState.phonePaired ? (
      <PairingOverlay
        qrDataUrl={pairingState.qrDataUrl}
        onDismiss={() => setPairingDismissed(true)}
      />
    ) : null;

  // P2-017: the shell gave up respawning the daemon sidecar — warn instead of
  // leaving the user with a silently disconnected app.
  const daemonDown = !!pairingState?.daemonDown;
  const daemonDownBanner = daemonDown ? (
    <div className="daemon-down" role="alert">
      ⚠︎ {t("daemonDown")}
    </div>
  ) : null;

  if (addingMachine) {
    return (
      <div className={daemonDown ? "pair-wrap has-daemon-down" : "pair-wrap"}>
        {daemonDownBanner}
        {pairingOverlay}
        <PairingView
          phase="unpaired"
          error={error}
          onPair={(uri) => {
            setAddingMachine(false);
            const pairing = parsePairingUri(uri);
            if (!pairing) {
              setError("Invalid pairing code");
              setPhase("error");
              return;
            }
            void connect(pairing, true);
          }}
          onRetry={() => setAddingMachine(false)}
        />
      </div>
    );
  }

  if (phase !== "paired") {
    return (
      <div className={daemonDown ? "pair-wrap has-daemon-down" : "pair-wrap"}>
        {daemonDownBanner}
        {pairingOverlay}
        <PairingView
          phase={phase}
          error={error}
          onPair={(uri) => {
            const pairing = parsePairingUri(uri);
            if (!pairing) {
              setError("Invalid pairing code");
              setPhase("error");
              return;
            }
            void connect(pairing, true);
          }}
          onRetry={() => {
            const stored = loadState();
            if (stored) void connect(stored.pairing, false);
            else setPhase("unpaired");
          }}
        />
      </div>
    );
  }

  const chatNode = (
    <ChatView
      sessionId={session!}
      request={request}
      events={events}
      connStatus={connStatus}
      voice={clientRef.current?.caps?.transcribe === true}
      onBack={goBack}
    />
  );
  const settingsNode = <SettingsView request={request} onBack={goBack} />;
  const filesNode = <FilesView request={request} onBack={goBack} />;
  const artifactsNode = <ArtifactsView request={request} onBack={goBack} />;
  const browseNode = <BrowserView browse={browseFn} onBack={goBack} />;
  const shareNode = (
    <SendToAgentView
      request={request}
      payload={share!}
      onBack={goBack}
      onOpenSession={(id) => {
        setShare(null);
        setSession(id);
      }}
    />
  );
  const sessionsNode = (
    <SessionsView
      request={request}
      machineName={machineName}
      events={events}
      unread={unread}
      connStatus={connStatus}
      machines={machines}
      activeRoom={getActiveRoom()}
      onSwitch={(p) => void switchMachine(p)}
      onForget={(p) => forgetMachine(p)}
      onAddMachine={() => setAddingMachine(true)}
      onOpen={(id) => {
        setNavDir("fwd");
        setSession(id);
      }}
      onDisconnect={disconnect}
      onEnablePush={async () => {
        const { enablePush } = await import("./lib/push");
        await enablePush(request);
      }}
      onOpenSettings={() => {
        setNavDir("fwd");
        setSettings(true);
      }}
      onOpenFiles={() => {
        setNavDir("fwd");
        setFilesView(true);
      }}
      tick={tick}
      variant={isDesktop ? "rows" : "grid"}
    />
  );
  const mainContent = session
    ? chatNode
    : settings
      ? settingsNode
      : artifactsView
        ? artifactsNode
        : browserView
          ? browseNode
          : filesView
            ? filesNode
            : share
              ? shareNode
              : null;

  return (
    <div
      ref={appRootRef}
      className={`app-root${session ? "" : " has-tabbar"}${daemonDown ? " has-daemon-down" : ""}`}
      data-nav={navDir}
      onTouchStart={isDesktop ? undefined : onTouchStart}
      onTouchMove={isDesktop ? undefined : onTouchMove}
      onTouchEnd={isDesktop ? undefined : onTouchEnd}
      style={{ height: "100%" }}
    >
      {daemonDownBanner}
      {isDesktop ? (
        <div className="desk">
          <aside className="desk-side">
            <div className="desk-side-scroll">{sessionsNode}</div>
            <div className="desk-nav">
              <button
                className={!settings && !filesView && !artifactsView && !browserView ? "active" : ""}
                onClick={() => {
                  setSettings(false);
                  setFilesView(false);
                  setArtifactsView(false);
                  setBrowserView(false);
                  setSession(null);
                }}
                title="Conversas"
              >
                <span>💬</span>
                <span>Conversas</span>
              </button>
              <button
                className={artifactsView ? "active" : ""}
                onClick={() => {
                  setNavDir("fwd");
                  setArtifactsView(true);
                  setSession(null);
                  setSettings(false);
                  setFilesView(false);
                  setBrowserView(false);
                }}
                title="Artifacts"
              >
                <span>🗂️</span>
                <span>Artifacts</span>
              </button>
              <button
                className={browserView ? "active" : ""}
                onClick={() => {
                  setNavDir("fwd");
                  setBrowserView(true);
                  setSession(null);
                  setSettings(false);
                  setFilesView(false);
                  setArtifactsView(false);
                }}
                title="Browser"
              >
                <span>🌐</span>
                <span>Browser</span>
              </button>
              <button
                className={filesView ? "active" : ""}
                onClick={() => {
                  setNavDir("fwd");
                  setFilesView(true);
                  setBrowserView(false);
                }}
                title="Arquivos"
              >
                <span>📁</span>
                <span>Arquivos</span>
              </button>
              <button
                className={settings ? "active" : ""}
                onClick={() => {
                  setNavDir("fwd");
                  setSettings(true);
                  setBrowserView(false);
                }}
                title="Config"
              >
                <span>⚙️</span>
                <span>Configurações</span>
              </button>
            </div>
          </aside>
          <main className="desk-main">
            {/* Browser pane stays mounted (hidden) so the user's current page,
                URL input and text panel survive tab switches. */}
            {browseFn && (
              <div style={{ display: browserView ? "block" : "none", height: "100%" }}>
                <BrowserView browse={browseFn} onBack={goBack} />
              </div>
            )}
            {!browserView &&
              (mainContent ?? (
                <div className="desk-empty">
                  <div>
                    <div className="desk-greet-mark">✻</div>
                    <h2>olá{machineName ? `, ${machineName.toLowerCase()}` : ""}!</h2>
                    <p>Selecione uma conversa na barra lateral</p>
                  </div>
                </div>
              ))}
          </main>
        </div>
      ) : (
        <>
          {mainContent ?? sessionsNode}
          {!session && (
            <TabBar
              active={settings ? "settings" : filesView ? "files" : "sessions"}
              t={t}
              onSelect={(id) => {
                if (id === "sessions") {
                  if (settings || filesView) {
                    setNavDir("back");
                    setSettings(false);
                    setFilesView(false);
                    setTick((t) => t + 1);
                  }
                  return;
                }
                setNavDir("fwd");
                setSettings(id === "settings");
                setFilesView(id === "files");
                if (id === "settings") setTick((t) => t + 1);
              }}
            />
          )}
        </>
      )}
      {pairingOverlay}
    </div>
  );
}
