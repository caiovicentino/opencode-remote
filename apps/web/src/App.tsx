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
  type Pairing,
  type Status,
} from "./lib/client";
import type { OpResponse, EventEnvelope } from "@ocr/protocol";
import { gateVerify, gateEnroll } from "./lib/gate";
import { useT } from "./lib/i18n";
import PairingView from "./components/PairingView";
import SessionsView from "./components/SessionsView";
import ChatView from "./components/ChatView";
import SettingsView, { applyTheme } from "./components/SettingsView";
import FilesView from "./components/FilesView";
import SendToAgentView from "./components/SendToAgentView";

type Phase = "unpaired" | "connecting" | "paired" | "error";

type TabId = "sessions" | "files" | "settings";

/** Electron bridge from apps/desktop/src/preload.ts (absent in the browser). */
interface DesktopBridge {
  getPairUrl?: () => Promise<string | null>;
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

export default function App() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("unpaired");
  const [error, setError] = useState("");
  const [machineName, setMachineName] = useState("");
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const clientRef = useRef<OcrClient | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [filesView, setFilesView] = useState(false);
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
      if (h === "#/files" && clientRef.current) setFilesView(true);
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
    bridge
      .getPairUrl()
      .then((uri) => {
        if (!uri) return;
        const pairing = parsePairingUri(uri);
        if (pairing) void connect(pairing, true);
      })
      .catch(() => {
        /* no URI or unparsable URI → PairingView fallback */
      });
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
    if (!session && !settings && !filesView && !share) return;
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

  if (addingMachine) {
    return (
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
    );
  }

  if (phase !== "paired") {
    return (
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
    );
  }

  return (
    <div
      ref={appRootRef}
      className={`app-root${session ? "" : " has-tabbar"}`}
      data-nav={navDir}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{ height: "100%" }}
    >
      {session ? (
        <ChatView
          sessionId={session}
          request={request}
          events={events}
          connStatus={connStatus}
          voice={clientRef.current?.caps?.transcribe === true}
          onBack={goBack}
        />
      ) : settings ? (
        <SettingsView request={request} onBack={goBack} />
      ) : filesView ? (
        <FilesView request={request} onBack={goBack} />
      ) : share ? (
        <SendToAgentView
          request={request}
          payload={share}
          onBack={goBack}
          onOpenSession={(id) => {
            setShare(null);
            setSession(id);
          }}
        />
      ) : (
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
        />
      )}
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
    </div>
  );
}
