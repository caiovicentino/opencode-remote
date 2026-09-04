import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
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
import { localPairing } from "../../desktop/src/pairing";
import { gateVerify, gateEnroll } from "./lib/gate";
import { useT } from "./lib/i18n";
import {
  activeSlots,
  initialViewState,
  isPaneOpen,
  topSlot,
  viewReducer,
  type Slot,
} from "./lib/viewState";
import PairingView from "./components/PairingView";
import PairingOverlay from "./components/PairingOverlay";
import SessionsView from "./components/SessionsView";
import SidebarAccount from "./components/SidebarAccount";
import ChatView from "./components/ChatView";
import HomeView from "./components/HomeView";
import { agentForMode } from "./lib/home";
import { setDraft } from "./lib/drafts";
import SettingsView, { applyTheme } from "./components/SettingsView";
import FilesView from "./components/FilesView";
import ArtifactsView from "./components/ArtifactsView";
import SendToAgentView from "./components/SendToAgentView";
import BrowserView, { type BrowseFn } from "./components/BrowserView";
import { previewFromEvent } from "./lib/preview";
import type { ArtifactMeta } from "./lib/artifacts";
import MissionControlView, { type DaemonApiFn } from "./components/MissionControlView";
import ErrorBoundary from "./components/ErrorBoundary";
import CommandPalette from "./components/CommandPalette";
import DegradedView from "./components/DegradedView";
import ReconnectButton from "./components/ReconnectButton";
import { degradedKind, sawHealthyDaemon, sidecarExitNotice, upstreamNotice, type SidecarExitHealth, type UpstreamHealth } from "./lib/degraded";
import {
  IconAlert,
  IconChat,
  IconFolder,
  IconGlobe,
  IconLayers,
  IconRadar,
  IconRefresh,
  IconSettings,
} from "./components/icons";

type Phase = "unpaired" | "connecting" | "paired" | "error";

type TabId = "sessions" | "files" | "settings";

/** P2-112: once a live daemon answered on this machine, a later outage is an
 * incident (red banner); before that, every outage is a first contact. */
const DAEMON_SEEN_KEY = "ocr_daemon_seen";

/** Mirrors apps/desktop/src/preload.ts PairingState (kept in sync by tests). */
interface PairingState {
  /** P1-070: "local" (auto-connected to the daemon on this machine, uri/qr
   * always null), "remote" (explicit QR ceremony) or undefined (legacy). */
  mode?: "local" | "remote";
  uri: string | null;
  qrDataUrl: string | null;
  devices: number;
  phonePaired: boolean;
  /** P2-017: sidecar respawn budget exhausted (desktop shell only). */
  daemonDown?: boolean;
  /** P1-053: adopted daemon lost, shell still probing (desktop shell only). */
  reconnecting?: boolean;
  /** P1-053: failed reconnect probes since the loss was detected. */
  reconnectAttempts?: number;
  /** P3-054: shell + live daemon versions and the mismatch verdict (desktop). */
  appVersion?: string | null;
  daemonVersion?: string | null;
  versionMismatch?: boolean;
  /** P2-138: upstream (opencode) health detail from the daemon's /api/health. */
  opencode?: UpstreamHealth;
  /** P2-140: why the local daemon died (desktop shell only). */
  sidecarExit?: SidecarExitHealth;
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
  /** P1-053: one-click recovery from the daemon-down banner. */
  reconnectDaemon?: () => Promise<boolean>;
  /** P1-061/P1-070: loopback WS credentials (+ room/ecdhPub) for the direct
   * local transport and the zero-ceremony local pairing. */
  getLocalLink?: () => Promise<{ port: number; token: string; room?: string; ecdhPub?: string } | null>;
  /** P1-070: explicit remote-pairing opt-in/out (Settings + overlay dismiss). */
  setRemotePairing?: (on: boolean) => Promise<boolean>;
  /** P2-048: narrow /api/pilot-* bridge for the Mission Control pane. */
  daemonApi?: DaemonApiFn;
  /** P1-046: Go-menu accelerators (Cmd+T/K/1..5) pushed from the main process. */
  onMenuAction?: (cb: (id: string) => void) => () => void;
  /** P1-050: Settings "Copy diagnostic" support bundle (text, no secrets). */
  getDiagnostics?: () => Promise<string>;
}

function desktopBridge(): DesktopBridge | null {
  const bridge = (window as unknown as { ocrDesktop?: DesktopBridge }).ocrDesktop;
  return bridge && typeof bridge.getPairUrl === "function" ? bridge : null;
}

/** Slot each Cmd+1..6 accelerator (and Go menu item) maps to. */
const PANE_ACCELERATORS = ["chat", "artifacts", "browser", "files", "settings", "mission"] as const;

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
    { id: "sessions", label: t("tabSessions"), icon: <IconChat size={20} /> },
    { id: "files", label: t("tabFiles"), icon: <IconFolder size={20} /> },
    { id: "settings", label: t("tabSettings"), icon: <IconSettings size={20} /> },
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
  // P1-046: one reducer owns ALL navigation (the old five booleans are gone).
  const [view, dispatchView] = useReducer(viewReducer, initialViewState);
  const session = view.chatSession;
  const top = topSlot(view);
  const slots = activeSlots(view);
  // stable handle: the bridge returns a fresh fn each render, which would
  // re-trigger the BrowserView's open-on-mount effect forever
  const [browseFn] = useState<BrowseFn | null>(() => desktopBridge()?.daemonBrowse ?? null);
  // P2-048: stable Mission Control bridge (fresh fn per render would loop effects)
  const [daemonApi] = useState<DaemonApiFn | null>(() => desktopBridge()?.daemonApi ?? null);
  const [share, setShare] = useState<{ title?: string; text?: string; url?: string } | null>(null);
  const [tick, setTick] = useState(0);
  const [connStatus, setConnStatus] = useState<Status>("connecting");
  const [machines, setMachines] = useState<Pairing[]>(() => loadPairings());
  const [addingMachine, setAddingMachine] = useState(false);
  // navigation direction drives the slide-in animation of the next screen
  const [navDir, setNavDir] = useState<"fwd" | "back">("fwd");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const appRootRef = useRef<HTMLDivElement>(null);
  const swipe = useRef({ x: 0, y: 0, dx: 0, active: false });
  const [unread, setUnread] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("ocr_unread") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  // P1-072: auto-preview — URL the daemon's ocr.preview event pointed at, plus
  // the maximize state of the Browser pane and a client-side dedupe ref.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [browserMaximized, setBrowserMaximized] = useState(false);
  const lastPreviewUrlRef = useRef<string | null>(null);
  const activeSessionRef = useRef<string | null>(null);

  // P2-007: first-run pairing overlay (desktop shell only). The main process
  // polls the daemon every 3s and caches the state; we pull once on mount and
  // subscribe to pushes so the QR shows immediately and leaves as soon as a
  // phone pairs.
  const [pairingState, setPairingState] = useState<PairingState | null>(null);
  const [pairingDismissed, setPairingDismissed] = useState(false);
  // P1-070: tryAutoPair reads the latest pairing state synchronously (the
  // effect ref below would still be null on the very first mount run).
  const pairingStateRef = useRef<PairingState | null>(null);
  useEffect(() => {
    pairingStateRef.current = pairingState;
  }, [pairingState]);

  // P2-112: has this machine ever met a live daemon? Stamped only AFTER a
  // healthy observation lands (paired phase, healthy poll, mismatch verdict
  // or a proved local auto-connect) — never optimistically, so a first boot
  // with a dead daemon keeps the calm first-contact copy instead of an
  // accusatory "daemon fell" alert.
  const [everSeen, setEverSeen] = useState(() => localStorage.getItem(DAEMON_SEEN_KEY) === "1");
  useEffect(() => {
    if (phase !== "paired" && !sawHealthyDaemon(pairingState)) return;
    if (localStorage.getItem(DAEMON_SEEN_KEY) !== "1") localStorage.setItem(DAEMON_SEEN_KEY, "1");
    setEverSeen(true);
  }, [phase, pairingState]);

  // P2-112: the degraded first-boot journey replaces the pairing screen in the
  // desktop shell; this flag is the explicit escape hatch into manual pairing.
  const [pairManual, setPairManual] = useState(false);
  useEffect(() => {
    if (phase === "paired") setPairManual(false);
  }, [phase]);
  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.getPairingState) return;
    let alive = true;
    bridge.getPairingState().then((s) => {
      if (alive) {
        pairingStateRef.current = s;
        setPairingState(s);
      }
    }).catch(() => {});
    const un = bridge.onPairingState?.((s) => {
      if (alive) {
        pairingStateRef.current = s;
        setPairingState(s);
      }
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
      const client = await OcrClient.connect(pairing, {
        getLocalLink: desktopBridge()?.getLocalLink,
      });
      client.onStatus = (s) => setConnStatus(s);
      // connect() resolves once already paired — the "paired" status event
      // fired before this handler existed, so sync the current state (P2-055:
      // the header dot otherwise stays yellow forever after a fresh pair)
      setConnStatus(client.status);
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
        // P1-072: auto-preview — desktop shell only. In the PWA the event is
        // ignored: the Mac's localhost is unreachable from the phone anyway.
        const preview = previewFromEvent(evt);
        if (preview && browseFn && preview.url !== lastPreviewUrlRef.current) {
          lastPreviewUrlRef.current = preview.url;
          setBrowserMaximized(false);
          setPreviewUrl(preview.url);
          dispatchView({ type: "open", slot: "browser" });
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }

  // deep-link routing: notifications open #/session/<id>, #/files, #/artifacts
  // or the #/send share target. P1-046: routes dispatch reducer actions — the
  // chat is no longer destroyed by an incoming deep link.
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
          dispatchView({ type: "open", slot: "share" });
        }
        return;
      }
      const sid = /^#\/session\/([\w-]+)/.exec(h)?.[1];
      if (sid && clientRef.current) {
        dispatchView({ type: "openChat", sessionId: sid });
        return;
      }
      if (h === "#/files" && clientRef.current) {
        dispatchView({ type: "open", slot: "files" });
      }
      if (h === "#/artifacts" && clientRef.current) {
        dispatchView({ type: "open", slot: "artifacts" });
      }
    }
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, [phase]);

  // P1-053: auto-pair extracted from the mount effect so the recovery watcher
  // below can re-run it when an adopted daemon's health comes back — this is
  // what kills the eternal pairing screen after a daemon outage.
  const autoPairCleanupRef = useRef<(() => void) | null>(null);
  function tryAutoPair(): void {
    autoPairCleanupRef.current?.();
    autoPairCleanupRef.current = null;
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
    autoPairCleanupRef.current = offDeepLink ?? null;
    const getPairUrl = bridge.getPairUrl;
    void (async () => {
      try {
        const deep = await bridge.getDeepLink?.();
        if (applyDeepLink(deep)) return;
        // P1-070: local mode — the shell already proved the daemon's identity
        // (401 challenge + Bearer from the 0600 file), so no pairing ceremony
        // at all: derive the local pairing and connect. Nothing is persisted
        // (the loopback token stays out of localStorage; re-derived per boot).
        let state = pairingStateRef.current;
        if (!state && bridge.getPairingState) {
          state = (await bridge.getPairingState().catch(() => null)) ?? null;
          pairingStateRef.current = state;
        }
        if (state?.mode === "local" && bridge.getLocalLink) {
          const pairing = localPairing(await bridge.getLocalLink());
          if (pairing) {
            // Host self-approval (P0-003) applies to the local transport too:
            // a fresh daemon's allowlist doesn't know our sticky identity yet.
            // Additive only — nothing is ever removed or rewritten.
            if (bridge.approveClient) {
              const identity = await getOrCreateIdentity();
              await bridge.approveClient(identity.publicKey);
            }
            void connect(pairing, false);
            return;
          }
          // malformed state file → fall through to the legacy paths below
        }
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
  }

  useEffect(() => {
    tryAutoPair();
    return () => autoPairCleanupRef.current?.();
  }, []);

  // P1-053: when the daemon's health comes back (reconnecting/daemon-down
  // banner clears) while we are still sitting unpaired, retry the auto-pair
  // once — the pairing URI is reachable again and no user re-pairing is needed.
  // P1-070: a pairing state that lands (or degrades) with mode="local" also
  // re-runs the auto-pair — the mount-time run may have raced ahead of the
  // shell's first poll and found no state to decide on.
  const sawOutageRef = useRef(false);
  useEffect(() => {
    if (pairingState?.reconnecting || pairingState?.daemonDown) {
      sawOutageRef.current = true;
      return;
    }
    if (phase === "unpaired" && !loadState() && (pairingState?.mode === "local" || sawOutageRef.current)) {
      sawOutageRef.current = false;
      tryAutoPair();
    }
  }, [pairingState, phase]);

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
    dispatchView({ type: "reset" });
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
    dispatchView({ type: "reset" });
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

  // P1-046: session creation lifted out of SessionsView so Cmd+T and the
  // command palette reuse the exact same path as the "+ Nova conversa" button.
  const [creating, setCreating] = useState(false);
  async function createSession(prefill?: string): Promise<string | null> {
    if (creating) return null;
    setCreating(true);
    try {
      const res = await request("POST", "/session", {});
      const created = res.body as { id?: string };
      if (res.status === 200 && created.id) {
        // P2-123: a home idea/scratch prompt rides along as the new session's
        // first draft — set BEFORE the chat mounts so it opens pre-filled and
        // editable (never auto-sent).
        if (prefill) setDraft(created.id, prefill);
        dispatchView({ type: "openChat", sessionId: created.id });
        setTick((t) => t + 1); // refresh the sidebar list
        return null;
      }
      return `create failed (${res.status}): ${JSON.stringify(res.body).slice(0, 140)}`;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setCreating(false);
    }
  }

  function openPane(slot: Slot) {
    setNavDir("fwd");
    dispatchView({ type: "open", slot });
  }

  // P2-091: an artifact picked in the global Artifacts list opens beside the
  // chat (split-pane on wide viewports) instead of a full-screen detour.
  const [paneArtifact, setPaneArtifact] = useState<ArtifactMeta | null>(null);
  function openArtifactInChat(meta: ArtifactMeta) {
    setNavDir("fwd");
    // fresh object identity so ChatView re-adopts even for the same file
    setPaneArtifact({ ...meta });
    dispatchView({ type: "openChat", sessionId: meta.sessionId });
  }

  /** Rail "Conversas" button + Cmd+1: raise the chat, close any pane. */
  function goChat() {
    setNavDir("fwd");
    if (session) dispatchView({ type: "openChat", sessionId: session });
    else dispatchView({ type: "reset" });
  }

  function goBack() {
    setNavDir("back");
    if (top === "share") setShare(null);
    if (top === "settings") setTick((t) => t + 1);
    if (session) history.replaceState(null, "", "#/");
    dispatchView({ type: "back" });
  }

  // P1-046: keyboard navigation. Inside the Electron shell the Go menu pushes
  // ocr:menu-action (accelerators are OS-level there); in the plain browser a
  // keydown fallback covers the same keys. Registered only when the bridge is
  // absent so actions never fire twice inside Electron.
  useEffect(() => {
    function runMenuAction(id: string) {
      if (phase !== "paired") return; // no client yet — nothing to open
      if (id === "newChat") {
        void createSession();
        return;
      }
      if (id === "palette") {
        setPaletteOpen(true);
        return;
      }
      if (id === "pane:chat") {
        goChat();
        return;
      }
      if (id.startsWith("pane:")) {
        const slot = id.slice(5) as Slot;
        openPane(slot);
      }
    }
    const bridge = desktopBridge();
    if (bridge?.onMenuAction) {
      return bridge.onMenuAction(runMenuAction);
    }
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "t") {
        e.preventDefault();
        runMenuAction("newChat");
      } else if (k === "k") {
        e.preventDefault();
        runMenuAction("palette");
      } else if (k >= "1" && k <= "6") {
        e.preventDefault();
        runMenuAction(`pane:${PANE_ACCELERATORS[Number(k) - 1]}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, session, creating]);

  // iOS-style swipe-back: drag from the right edge slides the current screen;
  // releasing past the threshold pops the view.
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t || e.touches.length !== 1) return;
    if (view.stack.length === 0) return;
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
        onDismiss={() => {
          setPairingDismissed(true);
          // P1-070: leaving the overlay returns the shell to the quiet local
          // state on the next poll instead of hunting for pairing URIs.
          void desktopBridge()?.setRemotePairing?.(false);
        }}
      />
    ) : null;

  // P2-017: the shell gave up respawning the daemon sidecar — warn instead of
  // leaving the user with a silently disconnected app. P1-053: an adopted
  // daemon going missing is never terminal — show the active "reconnecting…"
  // state (yellow) with the attempt counter instead. P3-054: a healthy daemon
  // that is OLDER than the shell (or a different major) gets the non-blocking
  // mismatch banner — same recovery button, daemon keeps working meanwhile.
  // P2-112: the banner kinds that belong to the unpaired journey (down,
  // reconnecting, first contact) render inside the DegradedView status card
  // instead of a fixed strip — one status surface, never two copies of the
  // same sentence. Only the info-only mismatch banner still floats above it.
  const kind = degradedKind(pairingState, everSeen);
  const versionMismatch = !!pairingState?.versionMismatch && !!pairingState?.daemonVersion;
  // P2-138: upstream (opencode) verdict — null for ok/unknown/legacy payloads.
  // Rendered ONLY inside existing calm surfaces (degraded card, Settings help
  // section), never as a second banner (P2-108 single-surface rule).
  const upstream = upstreamNotice(pairingState?.opencode);
  // P2-140: why the local daemon died — null unless the shell attached an
  // exit verdict. Rendered ONLY inside the degraded calm card (P2-108 rule).
  const sidecarExit = sidecarExitNotice(pairingState?.sidecarExit);
  // P1-071: the Settings help section is reachable from the first-boot calm
  // card too — the stub request no-ops every fetch while no client exists.
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (phase === "paired") setHelpOpen(false);
  }, [phase]);
  const reconnectBtn = desktopBridge()?.reconnectDaemon
    ? () => desktopBridge()!.reconnectDaemon!()
    : undefined;
  const mismatchBanner = versionMismatch ? (
    <div className="daemon-version-mismatch" role="status">
      {t("daemonMismatch", {
        d: pairingState?.daemonVersion ?? "?",
        a: pairingState?.appVersion ?? "?",
      })}{" "}
      {reconnectBtn && <ReconnectButton reconnect={reconnectBtn} />}
    </div>
  ) : null;
  const banner =
    kind === "reconnecting" ? (
      <div className="daemon-reconnecting" role="status">
        <IconRefresh size={14} className="conn-banner-spin" aria-hidden />{" "}
        {t("reconnecting", { n: pairingState?.reconnectAttempts ?? 0 })}
      </div>
    ) : kind === "down" ? (
      <div className="daemon-down" role="alert">
        <IconAlert size={14} aria-hidden /> {t("daemonDown")}{" "}
        {reconnectBtn && <ReconnectButton reconnect={reconnectBtn} />}
      </div>
    ) : (
      mismatchBanner
    );

  if (addingMachine) {
    return (
      <div className={banner ? "pair-wrap has-daemon-down" : "pair-wrap"} data-phase={phase}>
        {banner}
        {pairingOverlay}
        <PairingView
          phase="unpaired"
          error={error}
          onPair={(uri) => {
            setAddingMachine(false);
            const pairing = parsePairingUri(uri);
            if (!pairing) {
              setError(t("invalidCode"));
              setPhase("error");
              return;
            }
            void connect(pairing, true);
          }}
          onRetry={() => setAddingMachine(false)}
          onPairRemote={desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined}
          localMode={pairingState?.mode === "local"}
          preferPaste={!!desktopBridge()}
        />
      </div>
    );
  }

  if (phase !== "paired" && helpOpen) {
    // P2-138: the calm card's secondary button lands here — the Settings help
    // section, reachable on first boot (P1-071) even with no daemon client.
    // The stub request makes every settings fetch a quiet no-op.
    return (
      <div className="pair-wrap" data-phase={phase}>
        <SettingsView
          request={() => Promise.resolve({ status: 0, body: {} })}
          onBack={() => setHelpOpen(false)}
          getDiagnostics={desktopBridge()?.getDiagnostics}
          onPairRemote={
            desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined
          }
          upstream={upstream}
        />
      </div>
    );
  }

  if (phase !== "paired") {
    // P2-112: in the desktop shell the unpaired screen is the degraded journey
    // (calm status + visible auto-retry + minimal local data) — never a
    // dead-end pairing wall. Only for a genuine first boot (nothing stored):
    // a user with a stored pairing keeps the classic screen with its error
    // detail and the status banners. The PWA always keeps PairingView (there
    // is no shell status to degrade on).
    const degraded =
      !!desktopBridge() && !pairManual && pairingState?.mode !== "remote" && !loadState();
    return (
      <div
        className={(degraded ? mismatchBanner : banner) ? "pair-wrap has-daemon-down" : "pair-wrap"}
        data-phase={phase}
      >
        {degraded ? mismatchBanner : banner}
        {pairingOverlay}
        {degraded ? (
          <DegradedView
            kind={kind}
            busy={phase === "connecting"}
            reconnectAttempts={pairingState?.reconnectAttempts}
            reconnect={reconnectBtn}
            onPairManually={() => setPairManual(true)}
            upstream={upstream}
            onOpenHelp={upstream ? () => setHelpOpen(true) : undefined}
            sidecarExit={sidecarExit}
          />
        ) : (
          <PairingView
            phase={phase}
            error={error}
            onPair={(uri) => {
              const pairing = parsePairingUri(uri);
              if (!pairing) {
                setError(t("invalidCode"));
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
            onPairRemote={desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined}
            localMode={pairingState?.mode === "local"}
            preferPaste={!!desktopBridge()}
          />
        )}
      </div>
    );
  }

  const chatActive = top === "chat" && !!session;
  const chatNode = (
    <ChatView
      sessionId={session!}
      request={request}
      events={events}
      connStatus={connStatus}
      voice={clientRef.current?.caps?.transcribe === true}
      browserActive={top === "browser"}
      onBack={goBack}
      paneArtifact={paneArtifact}
      onPaneArtifactConsumed={() => setPaneArtifact(null)}
      // P2-108: the shell strip (.daemon-reconnecting/.daemon-down) and the
      // in-chat .conn-banner say the same sentence — never show both.
      shellBannerVisible={kind === "reconnecting" || kind === "down"}
    />
  );
  const settingsNode = (
    <SettingsView
      request={request}
      onBack={goBack}
      transport={clientRef.current?.transport}
      getDiagnostics={desktopBridge()?.getDiagnostics}
      onPairRemote={desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined}
      upstream={upstream}
    />
  );
  const filesNode = <FilesView request={request} onBack={goBack} />;
  const artifactsNode = <ArtifactsView request={request} onBack={goBack} onOpenInChat={openArtifactInChat} />;
  const browseNode = <BrowserView browse={browseFn} onBack={goBack} />;
  const missionNode = <ErrorBoundary><MissionControlView daemonApi={daemonApi} browse={browseFn} onBack={goBack} /></ErrorBoundary>;
  const shareNode = share ? (
    <SendToAgentView
      request={request}
      payload={share}
      onBack={goBack}
      onOpenSession={(id) => {
        setShare(null);
        dispatchView({ type: "openChat", sessionId: id });
      }}
    />
  ) : null;
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
        dispatchView({ type: "openChat", sessionId: id });
      }}
      onDisconnect={disconnect}
      onEnablePush={async () => {
        const { enablePush } = await import("./lib/push");
        await enablePush(request);
      }}
      onOpenSettings={() => {
        setNavDir("fwd");
        dispatchView({ type: "open", slot: "settings" });
      }}
      onOpenFiles={() => {
        setNavDir("fwd");
        dispatchView({ type: "open", slot: "files" });
      }}
      tick={tick}
      creating={creating}
      onCreateSession={createSession}
      variant={isDesktop ? "rows" : "grid"}
      activeSession={session}
    />
  );

  // Mobile keeps a single main surface driven by the top of the view stack.
  const mainContent = chatActive
    ? chatNode
    : top === "settings"
      ? settingsNode
      : top === "artifacts"
        ? artifactsNode
        : top === "browser"
          ? browseNode
          : top === "files"
            ? filesNode
            : top === "mission"
              ? missionNode
              : top === "share" && shareNode
                ? shareNode
                : null;

  const railButtons: { slot: Slot; label: string; icon: ReactNode }[] = [
    { slot: "chat", label: t("navConversations"), icon: <IconChat /> },
    { slot: "artifacts", label: t("navArtifacts"), icon: <IconLayers /> },
    { slot: "browser", label: t("navBrowser"), icon: <IconGlobe /> },
    { slot: "files", label: t("navFiles"), icon: <IconFolder /> },
    { slot: "mission", label: t("navMission"), icon: <IconRadar /> },
    { slot: "settings", label: t("navSettings"), icon: <IconSettings /> },
  ];

  return (
    <div
      ref={appRootRef}
      className={`app-root${chatActive ? "" : " has-tabbar"}${banner ? " has-daemon-down" : ""}`}
      data-nav={navDir}
      data-phase={phase}
      onTouchStart={isDesktop ? undefined : onTouchStart}
      onTouchMove={isDesktop ? undefined : onTouchMove}
      onTouchEnd={isDesktop ? undefined : onTouchEnd}
      style={{ height: "100%" }}
    >
      {banner}
      {isDesktop ? (
        <div className="desk">
          <aside className="desk-side">
            {/* P2-124: Claude-style shell — primary action + section nav up
                top, conversations in the middle, account footer pinned down. */}
            <div className="desk-side-top">
              <button className="primary desk-new" disabled={creating} onClick={() => void createSession()}>
                {creating ? t("creating") : t("newShort")}
              </button>
              <nav className="desk-nav">
                {railButtons.map((b) => (
                  <button
                    key={b.slot}
                    className={slots.has(b.slot) ? "active" : ""}
                    onClick={() => (b.slot === "chat" ? goChat() : openPane(b.slot))}
                    data-pane={b.slot}
                    title={b.label}
                  >
                    {b.icon}
                    <span>{b.label}</span>
                  </button>
                ))}
              </nav>
            </div>
            <div className="desk-side-scroll">{sessionsNode}</div>
            <SidebarAccount
              localMode={pairingState?.mode === "local"}
              machineName={machineName}
              connStatus={connStatus}
              machines={machines}
              activeRoom={getActiveRoom()}
              onSwitch={(p) => void switchMachine(p)}
              onForget={(p) => forgetMachine(p)}
              onAddMachine={() => setAddingMachine(true)}
            />
          </aside>
          <main className="desk-chat">
            {/* P1-046: the chat is persistent — opening Artifacts/Browser/
                Files/Settings never unmounts it. */}
            {session ? chatNode : (
              <HomeView
                machineName={machineName}
                request={request}
                voice={clientRef.current?.caps?.transcribe === true}
                creating={creating}
                onStart={async (prompt, mode) => {
                  // the toggle wrote the same key; restate it so a start
                  // always matches the mode it was fired from
                  localStorage.setItem("ocr_agent", agentForMode(mode));
                  return createSession(prompt);
                }}
              />
            )}
          </main>
          <section
            className={`desk-pane${browserMaximized ? " maximized" : ""}`}
            style={{ display: isPaneOpen(view) ? "block" : "none" }}
          >
            {/* Browser pane stays mounted (hidden) so the user's current page,
                URL input and text panel survive tab switches. P1-072: it renders
                a real webview in the desktop shell and auto-opens on ocr.preview. */}
            {(browseFn || top === "browser") && (
              <div style={{ display: top === "browser" ? "block" : "none", height: "100%" }}>
                <BrowserView
                  browse={browseFn}
                  onBack={goBack}
                  previewUrl={previewUrl}
                  maximized={browserMaximized}
                  onToggleMaximize={() => setBrowserMaximized((v) => !v)}
                />
              </div>
            )}
            {top !== "browser" && (
              <div className="pane-view" key={top}>
                {top === "artifacts" && artifactsNode}
                {top === "files" && filesNode}
                {top === "settings" && settingsNode}
                {top === "share" && shareNode}
              </div>
            )}
            {/* Mission Control shows audit data — the motion pass (P3-087)
                keeps it animation-free by design */}
            {top === "mission" && missionNode}
          </section>
        </div>
      ) : (
        <>
          {mainContent ?? sessionsNode}
          {!chatActive && (
            <TabBar
              active={top === "settings" ? "settings" : top === "files" ? "files" : "sessions"}
              t={t}
              onSelect={(id) => {
                if (id === "sessions") {
                  if (top !== "chat") {
                    setNavDir("back");
                    dispatchView({ type: "reset" });
                  }
                  return;
                }
                setNavDir("fwd");
                dispatchView({ type: "replace", slot: id === "settings" ? "settings" : "files" });
                if (id === "settings") setTick((t) => t + 1);
              }}
            />
          )}
        </>
      )}
      {paletteOpen && (
        <CommandPalette
          request={request}
          events={events}
          onClose={() => setPaletteOpen(false)}
          onOpenSession={(id) => dispatchView({ type: "openChat", sessionId: id })}
          onNewChat={() => void createSession()}
          onOpenPane={(slot) => openPane(slot)}
        />
      )}
      {pairingOverlay}
    </div>
  );
}
