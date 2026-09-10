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
  wipeLocalIdentity,
  type Pairing,
  type Status,
} from "./lib/client";
import { REAUTH_ERROR, REJECTED_ERROR } from "./lib/reauth";
import { NotConnected } from "./lib/errors";
import { classifyPairError, pairErrorCopy } from "./lib/pairerror";
import { activeDrawerRow, hasUnreadDot, RECENTS_LIMIT, recentRows, type DrawerDest, type RecentRow } from "./lib/drawer";
import { loadPinned, notifyPins, savePinned, subscribePins, togglePinned } from "./lib/pins";
import Drawer from "./components/Drawer";
import ReauthView from "./components/ReauthView";
import ConnStrip from "./components/ConnStrip";
import MachinePicker from "./components/MachinePicker";
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
import PairingOverlay, { type WebAppInfo } from "./components/PairingOverlay";
import SessionsView from "./components/SessionsView";
import SidebarAccount from "./components/SidebarAccount";
import ChatView, { type MicAccessVerdict } from "./components/ChatView";
import { type CameraAccessVerdict } from "./components/QrScanner";
import HomeView from "./components/HomeView";
import GateHint from "./components/GateHint";
import { setDraft, markSendOnOpen } from "./lib/drafts";
import SettingsView, {
  type RelaySetting,
  type RelaySettingWriteResult,
  type WebAppSetting,
  type WebAppSettingWriteResult,
  type ProxySetting,
  type ProxySettingWriteResult,
} from "./components/SettingsView";
import { applyTheme } from "./lib/theme";
import { readGateQueue, clearGateQueue } from "./lib/gatequeue";
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
import WelcomeView from "./components/WelcomeView";
import ReconnectButton from "./components/ReconnectButton";
import { autoConnectAllowed, degradedKind, nextShellLocal, sawHealthyDaemon, sidecarExitNotice, sidecarWedgeNotice, upstreamNotice, type SidecarExitHealth, type UpstreamHealth } from "./lib/degraded";
import { WELCOME_DONE, WELCOME_KEY, shouldShowWelcome } from "./lib/welcome";
import {
  INSTALL_HINT_DISMISSED_KEY,
  installHintVerdict,
  parseInstallHintDismissed,
  serializeInstallHintDismissed,
} from "./lib/installhint";
import {
  IconAlert,
  IconChat,
  IconGlobe,
  IconLayers,
  IconMenu,
  IconPhone,
  IconPlus,
  IconRadar,
  IconRefresh,
  IconSettings,
} from "./components/icons";

type Phase = "unpaired" | "connecting" | "paired" | "error";

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
  /** Bug 1: `keyExpired` — frames from this device failed auth in the last 24h. */
  deviceList?: { label: string; addedAt?: string; keyExpired?: boolean }[];
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
  /** P2-324: wedged-daemon probe verdict (desktop shell only, additive) —
   * absent while the daemon answers; observe renders nothing. */
  sidecarWedge?: { state: string; message: string };
  /** P2-189: step one — the address the phone opens (desktop shell only). */
  webApp?: WebAppInfo;
  /** P2-193: the combined pair link — app address + credential in the
   * URL fragment (desktop shell only, additive). */
  pairLink?: { url: string; qrDataUrl: string | null; problems: string[] };
  /** P2-197: reach verdict for the app address (desktop shell only,
   * additive) — absent means unknown, which renders nothing. */
  reach?: { state: string; message: string };
  /** P2-199: daemon↔relay link verdict (desktop shell only, additive) —
   * absent only when the health call failed or the overlay cannot be needed;
   * a legacy daemon travels as the discreet unknown line instead. */
  relayLink?: { state: string; message: string };
  /** P2-211: install-location verdict (desktop shell only, additive) —
   * absent = unknown, which renders nothing. Never blocks pairing. */
  installLocation?: { state: string; message: string };
  /** P2-214: clock-skew verdict (desktop shell only, additive) —
   * absent = unknown, which renders nothing. Never blocks pairing. */
  clock?: { state: string; message: string };
  /** P2-218: login-item verdict (desktop shell only, additive) —
   * absent = unknown, which renders nothing. Never blocks pairing. */
  startup?: { state: string; message: string };
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
  /** P2-197: pairing overlay "test again" — re-runs the pairing tick, which
   * re-probes the app address (desktop shell only). */
  recheckWebApp?: () => Promise<void>;
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
  /** P2-187: phone relay address — Settings card (desktop shell only). */
  getRelaySetting?: () => Promise<RelaySetting>;
  setRelayUrl?: (url: string | null) => Promise<RelaySettingWriteResult>;
  /** P2-189: app address the phone opens — Settings card (desktop shell only). */
  getWebAppUrl?: () => Promise<WebAppSetting>;
  setWebAppUrl?: (url: string | null) => Promise<WebAppSettingWriteResult>;
  /** P2-289: machine proxy — Settings card (desktop shell only). */
  getProxySetting?: () => Promise<ProxySetting>;
  setProxyChoice?: (choice: { mode: "system" | "direct" | "fixed"; address?: string }) => Promise<ProxySettingWriteResult>;
  /** P2-312: microphone-permission verdict (desktop shell only, mirrored in ChatView). */
  getMicAccess?: () => Promise<MicAccessVerdict | null>;
  /** P2-319: camera-permission verdict (desktop shell only, mirrored in QrScanner). */
  getCamAccess?: () => Promise<CameraAccessVerdict | null>;
}

function desktopBridge(): DesktopBridge | null {
  const bridge = (window as unknown as { ocrDesktop?: DesktopBridge }).ocrDesktop;
  return bridge && typeof bridge.getPairUrl === "function" ? bridge : null;
}

/** Slot each Cmd+1..6 accelerator (and Go menu item) maps to. */
const PANE_ACCELERATORS = ["chat", "artifacts", "browser", "files", "settings", "mission"] as const;

/** P3-362: i18n key naming the Go action the gate toast was triggered by —
 * the toast says "… para abrir Artifacts" instead of one generic sentence for
 * every item (the explorer dead-end: nothing said WHICH pane was requested).
 * Keys ride existing nav / palette copy so the toast names things exactly as
 * the rail and palette do. */
const GATE_ACTION_LABELS: Record<string, string> = {
  "newChat": "paletteNewChat",
  "palette": "paletteName",
  "pane:chat": "navConversations",
  "pane:artifacts": "navArtifacts",
  "pane:browser": "navBrowser",
  "pane:files": "navFiles",
  "pane:settings": "navSettings",
  "pane:mission": "navMission",
};

/** P3-362: panes the gate shell opens pre-pairing — the rail's non-chat
 * buttons as shipped by P3-365 (Files has no rail button; its Go action keeps
 * the toast, now naming it). The Go menu must match this set exactly. */
const GATE_SHELL_PANES = new Set<string>(["artifacts", "browser", "mission", "settings"]);

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
  // EVAL4-F1: actionable next step under a pairing error (lib/pairerror.ts)
  const [errorHint, setErrorHint] = useState("");
  // EVAL4-F1b: kind of the last pairing failure — a timeout/relay drop on a
  // STORED pairing is an outage, so the pairing screen counts down and retries
  // the auto-pair instead of stranding the user on the wall.
  const [errorKind, setErrorKind] = useState<ReturnType<typeof classifyPairError>>("unknown");
  // EVAL4-F2: the daemon answered not-allowed on a live session (device
  // revoked / pairing reset) — same full-screen card family as `expired`.
  const [rejected, setRejected] = useState(false);
  // EVAL4-F4: real dials since the drop, for the mobile connection strip
  // (components/ConnStrip.tsx owns the escalation timer — P2-220 pins
  // App.tsx to zero timers).
  const [connAttempts, setConnAttempts] = useState(0);
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
  // Bug 1: the daemon refused our handshake twice in a row (stale keys) —
  // the full-screen "pair again" card takes over every other surface.
  const [expired, setExpired] = useState(false);
  // Bug 2 (PWA shell): slide-in drawer + the machine picker it opens, and the
  // recents it lists (fetched when the drawer opens, never polled).
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [recentSessions, setRecentSessions] = useState<{ id: string; title?: string; updatedAt?: string | number; time?: { updated?: string } }[]>([]);
  // navigation direction drives the slide-in animation of the next screen
  const [navDir, setNavDir] = useState<"fwd" | "back">("fwd");
  const [paletteOpen, setPaletteOpen] = useState(false);
  // P3-328: Go-menu actions stay enabled at the pairing gate but have no
  // target yet — pressing one bumps this trigger so the <GateHint> toast
  // explains why (the timer lives in the component; p2-220 keeps timers out
  // of App).
  const [gateHintTick, setGateHintTick] = useState(0);
  const [gateHintAt, setGateHintAt] = useState(0);
  // P3-362: i18n key of the Go action that triggered the current toast —
  // the toast names the requested pane/action instead of a generic line.
  const [gateHintWhat, setGateHintWhat] = useState<string | null>(null);
  // P3-357b: the drawer's Recents pin against the same device-local set —
  // kept live through the pins pub-sub so a SessionsView toggle reorders here.
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => loadPinned());
  useEffect(() => subscribePins(setPinnedIds), []);
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
  // P1-056: the "Celular" nav item is an EXPLICIT pairing request — it must
  // open the QR even if the user once dismissed the boot-time overlay.
  const [phonePairing, setPhonePairing] = useState(false);
  // P3-331: once the shell bridge reports a local daemon the verdict is sticky
  // for the session (nextShellLocal) — poll gaps and degraded pushes must not
  // resurrect the "connect to another machine" ceremony on a local machine.
  const [shellLocal, setShellLocal] = useState(false);
  // P3-331: single landing path for every shell pairing-state delivery (pull,
  // push, auto-pair prefetch) so the sticky verdict can never miss one.
  function observePairingState(s: PairingState | null) {
    pairingStateRef.current = s;
    setPairingState(s);
    setShellLocal((cur) => nextShellLocal(cur, s));
  }
  const localMode = shellLocal && pairingState?.mode !== "remote";
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

  // P3-360: the gate's offline queue becomes the first message. Whatever the
  // user saved on the calm card while the daemon was down is sent as soon as
  // the shell is paired — reusing the home composer's send-on-open flow
  // (markSendOnOpen + createSession(prefill)). The queue only clears after
  // the creation SUCCEEDS: a daemon that flaps again right after pairing
  // loses nothing, and the next pairing consumes the queue for real.
  useEffect(() => {
    if (phase !== "paired") return;
    const queued = readGateQueue(localStorage);
    if (!queued) return;
    void (async () => {
      markSendOnOpen(queued);
      const err = await createSession(queued);
      if (!err) clearGateQueue(localStorage);
    })();
  }, [phase]);

  // P2-148: first-run welcome (desktop shell only). The pure decision reads
  // the persisted flag and the stored pairing — a corrupted flag counts as
  // absent, and anyone with a stored pairing never sees the onboarding.
  const [showWelcome, setShowWelcome] = useState(() => {
    if (!desktopBridge()) return false;
    let flag: string | null = null;
    try {
      flag = localStorage.getItem(WELCOME_KEY);
    } catch {
      flag = null;
    }
    return shouldShowWelcome(flag, loadPairings().length > 0 || !!loadState());
  });

  // P2-220: iOS Safari sweeps the script-writable storage (IndexedDB +
  // localStorage) of a website that was never installed to the Home Screen
  // after ~7 days of no use — the private key in IndexedDB dies with it.
  // The risky context is detected ONCE on mount, inside this initializer:
  // no new listeners, no timers, no per-render reads (pinned by
  // scripts/unit.test.ts).
  const [installHintEnv] = useState(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as { standalone?: boolean }).standalone === true;
    let dismissed = false;
    try {
      dismissed = parseInstallHintDismissed(localStorage.getItem(INSTALL_HINT_DISMISSED_KEY));
    } catch {
      dismissed = false;
    }
    return {
      userAgent: navigator.userAgent,
      // P2-220 reviewer round 3: iPadOS 13+ defaults to a Macintosh UA — the
      // touch indicator is what makes the hint reach default-config iPads.
      maxTouchPoints: navigator.maxTouchPoints,
      standalone,
      dismissed,
      desktopShell: desktopBridge() !== null,
      // documented test hatch (P2-220): ?installhint=1 forces the hint so
      // visual evidence is deterministic; persists nothing
      forced: new URLSearchParams(location.search).get("installhint") === "1",
    };
  });
  const [installHintDismissed, setInstallHintDismissed] = useState(installHintEnv.dismissed);

  // P2-148: finishing (or skipping) stamps the flag in the renderer's
  // localStorage — no IPC, no main-process change, no second banner.
  function finishWelcome() {
    try {
      localStorage.setItem(WELCOME_KEY, WELCOME_DONE);
    } catch {}
    setShowWelcome(false);
  }

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.getPairingState) return;
    let alive = true;
    bridge.getPairingState().then((s) => {
      if (alive) observePairingState(s);
    }).catch(() => {});
    const un = bridge.onPairingState?.((s) => {
      if (alive) observePairingState(s);
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
    setErrorHint("");
    try {
      // biometric gate before the identity key may be used
      if (!(await gateVerify())) {
        throw new Error("Biometric unlock failed");
      }
      const client = await OcrClient.connect(pairing, {
        getLocalLink: desktopBridge()?.getLocalLink,
      });
      client.onStatus = (s) => {
        setConnStatus(s);
        setConnAttempts(client.attempts);
        // Bug 1: terminal expiry of a live session (daemon rekeyed under us)
        if (s === "expired") setExpired(true);
        // EVAL4-F2: terminal rejection of a live session (device revoked)
        if (s === "rejected") setRejected(true);
      };
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
      setMachineName(pairing.name ?? t("machineFallbackName")); // EVAL4-F1: was a literal "machine"
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
      const message = err instanceof Error ? err.message : String(err);
      // Bug 1: the very first dial was refused twice — same card, no raw error
      if (message === REAUTH_ERROR) {
        setExpired(true);
        return;
      }
      // EVAL4-F1: the client's failure messages are English internals (one of
      // them a CLI instruction) — the screen shows the localized sentence plus
      // a next step; unknown messages still surface verbatim, never blank.
      const kind = message === REJECTED_ERROR ? "rejected" : classifyPairError(message);
      const copy = pairErrorCopy(kind);
      setError(copy.msgKey ? t(copy.msgKey) : message);
      setErrorHint(copy.hintKey ? t(copy.hintKey) : "");
      setErrorKind(kind);
      setPhase("error");
    }
  }

  // Bug 1: the ONE button of the expired card — wipe this device's identity
  // (keys + pairing state, preferences kept) and land on the fresh pairing
  // flow. In the desktop shell the auto-pair re-approves the new identity
  // through the existing host self-approval; the PWA shows PairingView.
  async function pairAgain() {
    clientRef.current?.close();
    clientRef.current = null;
    await wipeLocalIdentity();
    setMachines([]);
    setEvents([]);
    setUnread({});
    setError("");
    setErrorHint("");
    setExpired(false);
    setRejected(false);
    setConnStatus("connecting");
    dispatchView({ type: "reset" });
    setPhase("unpaired");
    tryAutoPair();
  }

  // EVAL4-F6: the card's PRIMARY action. Forgets only the machine the card is
  // about (its stale pairing card would otherwise linger as a dead duplicate)
  // and re-enters the pairing flow with the identity and every other machine
  // intact. A fresh identity buys nothing: the daemon re-admits this one on
  // the bootstrap path (or the desktop self-approval) exactly the same way.
  // pairAgain() above stays as the explained secondary "reset this device".
  async function forgetAndPair() {
    clientRef.current?.close();
    clientRef.current = null;
    const room = getActiveRoom();
    if (room) setMachines(removePairing(room));
    setActiveRoom(null);
    setEvents([]);
    setError("");
    setErrorHint("");
    setExpired(false);
    setRejected(false);
    setConnStatus("connecting");
    dispatchView({ type: "reset" });
    setPhase("unpaired");
    tryAutoPair();
  }

  // deep-link routing: notifications open #/session/<id>, #/files, #/artifacts
  // or the #/send share target. P1-046: routes dispatch reducer actions — the
  // chat is no longer destroyed by an incoming deep link.
  useEffect(() => {
    function applyHash() {
      const h = location.hash;
      // #/pair?<query> — the combined pair link (P2-193): the app address with
      // the pairing credential in the fragment. Rebuilds the canonical URI and
      // routes through the SAME parsePairingUri as paste-pairing — zero new
      // crypto. The fragment is consumed on the spot (history.replaceState)
      // so the credential leaves the address bar AND the browser history;
      // no browser ever sends a fragment to a server, so the relay stays
      // blind either way. An invalid fragment lands on today's paste screen
      // with the localized error — never a blank page.
      if (h.startsWith("#/pair")) {
        const q = h.includes("?") ? h.slice(h.indexOf("?") + 1) : "";
        let pairing: Pairing | null = null;
        try {
          pairing = parsePairingUri(`opencode-remote://pair?${q}`);
        } catch {
          pairing = null;
        }
        history.replaceState(null, "", location.pathname + location.search);
        if (pairing) {
          void connect(pairing, true);
        } else {
          setError(t("invalidCode"));
          setPhase("error");
        }
        return;
      }
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
          observePairingState(state);
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
  // P3-331: the decision lives in the pure autoConnectAllowed — a failed
  // AUTO-connect (phase "error") now retries too, once the daemon answers
  // again, so a slow first boot can never dead-end behind the manual wall;
  // a manual paste mid-edit (pairManual/addingMachine) is never yanked.
  const sawOutageRef = useRef(false);
  // Round 2 (review): error-phase re-arms ride the 3s pairing-state poll —
  // a half-up daemon would be connect-hammered forever. A time backoff (never
  // a hard cap) keeps the recovery loop alive without the burst.
  const lastAutoRetryRef = useRef(0);
  useEffect(() => {
    if (pairingState?.reconnecting || pairingState?.daemonDown) {
      sawOutageRef.current = true;
      return;
    }
    if (
      autoConnectAllowed(phase, {
        localMode,
        sawOutage: sawOutageRef.current,
        pairManual,
        addingMachine,
        hasStoredPairing: !!loadState(),
      })
    ) {
      if (phase === "error" && Date.now() - lastAutoRetryRef.current < 15_000) return;
      lastAutoRetryRef.current = Date.now();
      sawOutageRef.current = false;
      tryAutoPair();
    }
  }, [pairingState, phase, localMode, pairManual, addingMachine]);

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

  // Bug 2: the drawer's Recents — one fetch per open (and per tick while
  // open), never a poll; failures leave the previous list in place.
  useEffect(() => {
    if (phase !== "paired" || isDesktop || !drawerOpen) return;
    let alive = true;
    void (async () => {
      try {
        const res = await request("GET", "/session");
        if (alive && res.status === 200 && Array.isArray(res.body)) {
          setRecentSessions(res.body as typeof recentSessions);
        }
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [phase, isDesktop, drawerOpen, tick]);

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
    timeoutMs?: number,
  ): Promise<OpResponse> {
    const client = clientRef.current;
    // P3-375: the sentinel error for "no live client" (first boot, machine
    // switch) — expected state; surfaces branch on the class, not the prose.
    if (!client) throw new NotConnected();
    return client.request(method as "GET", path, body, query, timeoutMs);
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

  // P3-362: the gate shell (P3-365's degraded first-boot journey) is the one
  // gate surface with real pane targets. One boolean shared by the menu
  // handler below and the gate render further down, so the Go menu and the
  // rail can never disagree about what is openable pre-pairing. (A boolean,
  // not the raw inputs, keeps the menu subscription from re-arming on every
  // 3s pairing-state push.)
  const gateShellUp =
    phase !== "paired" &&
    !!desktopBridge() &&
    !pairManual &&
    pairingState?.mode !== "remote" &&
    !loadState() &&
    isDesktop;

  // P1-046: keyboard navigation. Inside the Electron shell the Go menu pushes
  // ocr:menu-action (accelerators are OS-level there); in the plain browser a
  // keydown fallback covers the same keys. Registered only when the bridge is
  // absent so actions never fire twice inside Electron.
  useEffect(() => {
    function runMenuAction(id: string) {
      if (phase !== "paired") {
        // P3-362: at the gate shell the offline panes have a target — the Go
        // menu matches the rail and opens them, instead of demanding pairing
        // for a pane the rail already opens (the circular first-boot dead
        // end: "pair first" with a QR the down daemon would have to mint).
        const slot = id.startsWith("pane:") ? (id.slice(5) as Slot) : null;
        if (slot && gateShellUp && GATE_SHELL_PANES.has(slot)) {
          openPane(slot);
          return;
        }
        // P3-328: no target — never silent. P3-362: the toast names WHAT was
        // requested (the label map falls back to the generic line).
        setGateHintTick((n) => n + 1);
        setGateHintAt(Date.now());
        setGateHintWhat(GATE_ACTION_LABELS[id] ?? null);
        return;
      }
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
  }, [phase, session, creating, gateShellUp]);

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
    (phonePairing || (!pairingDismissed && !pairingState?.phonePaired)) && pairingState?.qrDataUrl ? (
      <PairingOverlay
        qrDataUrl={pairingState.qrDataUrl}
        deviceList={phonePairing ? pairingState?.deviceList : undefined}
        webApp={pairingState?.webApp ?? null}
        pairLink={pairingState?.pairLink ?? null}
        reach={pairingState?.reach ?? null}
        relayLink={pairingState?.relayLink ?? null}
        installLocation={pairingState?.installLocation ?? null}
        clock={pairingState?.clock ?? null}
        startup={pairingState?.startup ?? null}
        onReachRetry={() => {
          // Optional chaining: in a plain browser there is no desktop bridge.
          void desktopBridge()?.recheckWebApp?.();
        }}
        onDismiss={() => {
          setPairingDismissed(true);
          setPhonePairing(false);
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
  // P2-324: the daemon wedged alive — null unless the shell attached a wedge
  // verdict. Same calm card, below the exit notice in precedence (exit wins).
  const sidecarWedge = sidecarWedgeNotice(pairingState?.sidecarWedge);
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

  // Bug 1: the expired-session card owns the whole screen — no banner, no
  // overlay, no chat underneath (the session is dead; the only way forward
  // is the button). Rendered before every other surface on purpose.
  if (expired || rejected) {
    return (
      <div className="pair-wrap" data-phase={phase} data-expired>
        <ReauthView
          variant={rejected ? "revoked" : "expired"}
          machineName={machineName}
          onPairAgain={forgetAndPair}
          onResetDevice={pairAgain}
        />
      </div>
    );
  }

  // P3-328: dropped Go-menu action on ANY gate screen (welcome, add machine,
  // help, pairing/degraded) — the GateHint toast says why nothing opened.
  // P3-358 round 2: the bump carries its wall-clock timestamp so the 4s
  // window survives a GateHint remount (gate phase churn used to swallow it).
  // P3-367: the toast carries its own labeled exit into the manual pairing
  // ceremony — per surface, the same jump its screen's own manual escape
  // makes. On "add machine" the paste/scan ceremony IS the screen, so no
  // action (a button that navigates nowhere is the dead-end class again).
  const gateHintNode = (
    <GateHint
      trigger={gateHintTick}
      at={gateHintAt}
      what={gateHintWhat ? t(gateHintWhat) : null}
      onDismiss={() => setGateHintAt(0)}
      onPairNow={
        showWelcome
          ? () => {
              finishWelcome();
              setPairManual(true);
            }
          : helpOpen
            ? () => {
                setHelpOpen(false);
                setPairManual(true);
              }
            : addingMachine
              ? undefined
              : () => setPairManual(true)
      }
    />
  );



  // P3-365: pane nodes live ABOVE the gate returns — the unpaired gate shell
  // mounts the same panes the paired shell does, so Mission Control, the
  // artifact list and Settings are reachable on first boot (P1-071) with no
  // daemon client yet.
  function settingsView(req: Parameters<typeof SettingsView>[0]["request"]) {
    return (
      <SettingsView
        request={req}
        onBack={goBack}
        transport={clientRef.current?.transport}
        getDiagnostics={desktopBridge()?.getDiagnostics}
        onPairRemote={desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined}
        getRelaySetting={desktopBridge()?.getRelaySetting}
        setRelayUrl={desktopBridge()?.setRelayUrl}
        getWebAppUrl={desktopBridge()?.getWebAppUrl}
        setWebAppUrl={desktopBridge()?.setWebAppUrl}
        getProxySetting={desktopBridge()?.getProxySetting}
        setProxyChoice={desktopBridge()?.setProxyChoice}
        upstream={upstream}
      />
    );
  }
  const settingsNode = settingsView(request);
  // P2-138's quiet stub: every daemon-backed fetch becomes a no-op while the
  // purely-local settings (language, theme) keep working.
  const gateSettingsNode = settingsView(() => Promise.resolve({ status: 0, body: {} }));
  // P3-327: the gate shell's artifact list runs on the same quiet stub as the
  // gate Settings — every daemon fetch answers empty, so the pane shows its
  // calm "no artifacts yet" copy instead of the paired-world red "not paired"
  // error for a machine nothing has paired yet.
  const gateArtifactsNode = (
    <ArtifactsView
      request={() => Promise.resolve({ status: 0, body: {} })}
      onBack={goBack}
      onOpenInChat={openArtifactInChat}
    />
  );
  // P3-327: Mission Control behind the gate runs in pre-pairing mode — a dead
  // daemon is the EXPECTED first-boot state there, so the loaders answer with
  // the calm empty world instead of the red "daemon unreachable" line.
  const gateMissionNode = (
    <ErrorBoundary>
      <MissionControlView daemonApi={daemonApi} browse={browseFn} onBack={goBack} request={request} prePairing />
    </ErrorBoundary>
  );
  const filesNode = <FilesView request={request} onBack={goBack} />;
  const artifactsNode = <ArtifactsView request={request} onBack={goBack} onOpenInChat={openArtifactInChat} />;
  const browseNode = <BrowserView browse={browseFn} onBack={goBack} />;
  // EVAL4-B (instance B): `request` is the sealed fallback for the phone (no daemonApi bridge)
  const missionNode = <ErrorBoundary><MissionControlView daemonApi={daemonApi} browse={browseFn} onBack={goBack} request={request} /></ErrorBoundary>;
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
  // P2-220: the calm install hint — verdict recomputed from state that is
  // already in React (machines, dismissed flag); the environment probes it
  // wraps were read once at mount. ?installhint=1 forces it on for the
  // deterministic screenshot evidence, whatever the verdict says.
  const hint = installHintVerdict({
    userAgent: installHintEnv.userAgent,
    maxTouchPoints: installHintEnv.maxTouchPoints,
    standalone: installHintEnv.standalone,
    desktopShell: installHintEnv.desktopShell,
    hasPairing: machines.length > 0,
    dismissed: installHintDismissed,
  });
  // P2-220 reviewer round 3 (BLOCKING): the copy must follow the app locale —
  // the verdict's pt-BR message stays a pure-module constant; what renders is
  // the dict key (dict.pt.installHintBody is exactly that constant).
  const installHint = installHintEnv.forced || hint.show ? t("installHintBody") : null;
  function dismissInstallHint() {
    setInstallHintDismissed(true);
    try {
      localStorage.setItem(INSTALL_HINT_DISMISSED_KEY, serializeInstallHintDismissed());
    } catch {}
  }

  const sessionsNode = (
    <SessionsView
      request={request}
      events={events}
      unread={unread}
      onOpen={(id) => {
        setNavDir("fwd");
        dispatchView({ type: "openChat", sessionId: id });
      }}
      installHint={installHint}
      onDismissInstallHint={dismissInstallHint}
      tick={tick}
      creating={creating}
      onCreateSession={createSession}
      variant={isDesktop ? "rows" : "list"}
      activeSession={session}
    />
  );

  // P1-056: Claude-Desktop-style menu — vertical, quiet, no dead entries.
  // "files" left the rail (dead weight); "phone" opens the PWA pairing
  // ceremony (the pocket dispatch).
  const railButtons: { slot: Slot; label: string; icon: ReactNode; beta?: boolean }[] = [
    { slot: "chat", label: t("navConversations"), icon: <IconChat /> },
    { slot: "artifacts", label: t("navArtifacts"), icon: <IconLayers /> },
    { slot: "browser", label: t("navBrowser"), icon: <IconGlobe /> },
    { slot: "mission", label: t("navMission"), icon: <IconRadar />, beta: true },
    { slot: "settings", label: t("navSettings"), icon: <IconSettings /> },
  ];

  // P2-148: first-run onboarding — a single full-screen surface with no
  // banners and no pairing overlay (P2-108 single-surface rule). It covers
  // every phase: the local daemon may finish auto-connecting in the
  // background while the user walks the three steps.
  if (showWelcome) {
    return (
      <div className="pair-wrap" data-phase={phase}>
        {gateHintNode}
        <WelcomeView
          kind={kind}
          busy={phase === "connecting"}
          upstream={upstream}
          reconnect={reconnectBtn}
          qrDataUrl={pairingState?.qrDataUrl}
          phonePaired={pairingState?.phonePaired}
          onCancelPairRemote={() => void desktopBridge()?.setRemotePairing?.(false)}
          onPairRemote={desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined}
          onPairManually={() => {
            // P3-329: the stuck QR wait's labeled escape — leave the wizard
            // straight into the manual paste-code ceremony instead of making
            // the user find the unlabeled link one screen earlier.
            finishWelcome();
            setPairManual(true);
          }}
          onDone={finishWelcome}
        />
      </div>
    );
  }

  if (addingMachine) {
    return (
      <div className={banner ? "pair-wrap has-daemon-down" : "pair-wrap"} data-phase={phase}>
        {banner}
        {pairingOverlay}
        {gateHintNode}
        <PairingView
          phase="unpaired"
          error={error}
          hint={errorHint}
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
          // P3-332: adding a machine IS the manual remote ceremony — the
          // shell's local auto-connect mode must never hide the paste/scan
          // form here (it would leave no way to type a remote code).
          localMode={false}
          preferPaste={!!desktopBridge()}
          getCamAccess={desktopBridge()?.getCamAccess}
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
      {gateHintNode}
      <SettingsView
        request={() => Promise.resolve({ status: 0, body: {} })}
        onBack={() => setHelpOpen(false)}
        getDiagnostics={desktopBridge()?.getDiagnostics}
        onPairRemote={
          desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined
        }
        getRelaySetting={desktopBridge()?.getRelaySetting}
        setRelayUrl={desktopBridge()?.setRelayUrl}
        getWebAppUrl={desktopBridge()?.getWebAppUrl}
        setWebAppUrl={desktopBridge()?.setWebAppUrl}
        getProxySetting={desktopBridge()?.getProxySetting}
        setProxyChoice={desktopBridge()?.setProxyChoice}
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
    // P3-365: everything that is not the first-boot desktop journey keeps the
    // classic centered screen below (narrow windows, manual ceremony, remote
    // mode, stored-pairing errors). P3-362: `gateShellUp` is the SAME verdict
    // the Go menu handler uses — menu and rail never disagree here.
    if (!gateShellUp) {
      return (
        <div
          className={(degraded ? mismatchBanner : banner) ? "pair-wrap has-daemon-down" : "pair-wrap"}
          data-phase={phase}
        >
          {degraded ? mismatchBanner : banner}
          {pairingOverlay}
          {gateHintNode}
          {degraded ? (
            <DegradedView
              kind={kind}
              busy={phase === "connecting"}
              reconnectAttempts={pairingState?.reconnectAttempts}
              reconnect={reconnectBtn}
              onPairManually={() => setPairManual(true)}
              upstream={upstream}
              // P3-363: always reachable from the calm card — the escalation
              // block needs a diagnostics path even with no upstream notice.
              onOpenHelp={() => setHelpOpen(true)}
              sidecarExit={sidecarExit}
              sidecarWedge={sidecarWedge}
            />
          ) : (
            <PairingView
              // Round 2 (review): the degraded journey's "pair manually" escape
              // must always show the paste/scan ceremony — the sticky localMode
              // alone would render the auto-connect card with no way to type a
              // remote code (the P3-332 dead-end class, one screen later).
              // P3-329: reaching this screen through pairManual IS explicit
              // manual intent (wizard escape or degraded escape) — the local
              // auto-connect mode must never swallow the paste/scan ceremony
              // (same rule as "add machine", P3-332).
              localMode={localMode && !pairManual}
              onBack={pairManual ? () => setPairManual(false) : undefined}
              phase={phase}
              error={error}
              hint={errorHint}
              // P3-366: the desktop manual-ceremony escapes (degraded journey's
              // "pair manually", wizard escape) land here too — paste must lead
              // on desktop exactly like the "add machine" path (P2-117).
              preferPaste={!!desktopBridge()}
              // EVAL4-F1b: stored pairing + unreachable machine → 20 s countdown
              // into the same onRetry (auto-pair), never a dead pairing wall
              autoRetryMs={phase === "error" && !!loadState() && (errorKind === "timeout" || errorKind === "closed") ? 20_000 : undefined}
              getCamAccess={desktopBridge()?.getCamAccess}
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
                // Round 2 (review): a stored pairing reconnects verbatim — the
                // PWA has no auto-pair to re-arm (tryAutoPair is a no-op without
                // the shell bridge), so Retry must never lose this path.
                // P3-332: with no stored pairing the retry re-arms the auto-pair
                // (local link / deep link) — the live card's only way forward.
                const stored = loadState();
                if (stored) void connect(stored.pairing, false);
                else {
                  setPhase("unpaired");
                  tryAutoPair();
                }
              }}
              onPairRemote={desktopBridge()?.setRemotePairing ? () => void desktopBridge()?.setRemotePairing?.(true) : undefined}
            />
          )}
        </div>
      );
    }

    // P3-365: on a wide viewport the degraded journey renders the REAL shell
    // skeleton instead of a full-screen wall — the calm status card stays the
    // hero of the main column, while the sidebar and the offline-capable
    // panes (Mission Control, artifact list, Settings) stay reachable, so
    // first boot no longer dead-ends on one screen (P1-071).
    return (
      <div
        className={mismatchBanner ? "app-root has-daemon-down" : "app-root"}
        data-nav={navDir}
        data-phase={phase}
        style={{ height: "100%" }}
      >
        {mismatchBanner}
        <div className="desk">
          <aside className="desk-side">
            <div className="desk-side-top">
              {/* P3-380: the primary CTA is inert until pairing succeeds —
                  carry the same hint tooltip as the rail's Conversas slot and
                  let the disabled chrome gray it out, so the shell's most
                  natural first click explains itself instead of dying. */}
              <button className="primary desk-new" disabled title={t("gateSessionsHint")}>
                {t("newShort")}
              </button>
              <nav className="desk-nav">
                {railButtons.map((b) => (
                  <button
                    key={b.slot}
                    className={slots.has(b.slot) ? "active" : ""}
                    onClick={() => (b.slot === "chat" ? goChat() : openPane(b.slot))}
                    disabled={b.slot === "chat"}
                    title={b.slot === "chat" ? t("gateSessionsHint") : b.label}
                    data-pane={b.slot}
                  >
                    {b.icon}
                    <span>{b.label}</span>
                    {b.beta && <span className="beta-pill">Beta</span>}
                  </button>
                ))}
              </nav>
            </div>
            <div className="desk-side-scroll">
              <p className="muted gate-side-hint">{t("gateSessionsHint")}</p>
            </div>
            {/* P3-365: no account footer at the gate — the mode label would
                claim a pairing nothing has proven yet (P3-331's sticky local
                verdict needs a live daemon), and the hero card below already
                carries the labeled manual-pairing escape (P3-338: one exit
                per screen). */}
          </aside>
          <main className="desk-chat">
            <DegradedView
              kind={kind}
              busy={phase === "connecting"}
              reconnectAttempts={pairingState?.reconnectAttempts}
              reconnect={reconnectBtn}
              onPairManually={() => setPairManual(true)}
              upstream={upstream}
              // P3-363: always reachable from the calm card — the escalation
              // block needs a diagnostics path even with no upstream notice.
              onOpenHelp={() => setHelpOpen(true)}
              sidecarExit={sidecarExit}
              sidecarWedge={sidecarWedge}
              // P3-365: the rail beside this card opens Artifacts, Browser and
              // Mission Control pre-pairing — the hero's pane map must not
              // claim those panes are locked.
              panesReachable
            />
          </main>
          <section className="desk-pane" style={{ display: isPaneOpen(view) ? "block" : "none" }}>
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
            {top !== "browser" && top !== "mission" && (
              <div className="pane-view" key={top}>
                {top === "artifacts" && gateArtifactsNode}
                {top === "files" && filesNode}
                {top === "settings" && gateSettingsNode}
                {top === "share" && shareNode}
              </div>
            )}
            {top === "mission" && gateMissionNode}
          </section>
        </div>
        {gateHintNode}
        {pairingOverlay}
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
      getMicAccess={desktopBridge()?.getMicAccess}
      // EVAL4-F4: real dials + drop instant + "try now" for the in-chat banner
      // (ChatView declares the three as optional; instance B renders them)
      connAttempts={connAttempts}
      connSince={clientRef.current?.disconnectedSince ?? 0}
      onRetryNow={() => clientRef.current?.retryNow()}
    />
  );
  // (P3-365: settingsNode/filesNode/artifactsNode/browseNode/missionNode/
  // shareNode/sessionsNode and railButtons are defined above the gate returns
  // — the unpaired gate shell mounts the same nodes.)

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
              : top === "chats"
                ? sessionsNode
                : top === "share" && shareNode
                  ? shareNode
                  : null;

  // Bug 2 (PWA shell): drawer destinations map onto the view reducer — the
  // chats list is a slot like any pane; the empty stack is the home.
  function navigateDrawer(dest: DrawerDest) {
    setNavDir("fwd");
    dispatchView({ type: "open", slot: dest });
    if (dest === "settings") setTick((t) => t + 1);
  }
  const drawerActive = activeDrawerRow(top, !!session);
  const recents: RecentRow[] = recentRows(recentSessions, unread, session, RECENTS_LIMIT, pinnedIds);
  const unreadDot = hasUnreadDot(unread, session);
  // The shell bar (hamburger + title) shows on the home and the chats list;
  // every other mobile surface keeps its own header with a back button.
  const shellBar = !chatActive && (top === "chat" || top === "chats");
  const homeNode = (
    <HomeView
      machineName={machineName}
      request={request}
      voice={clientRef.current?.caps?.transcribe === true}
      creating={creating}
      onStart={(prompt) => createSession(prompt)}
      variant="mobile"
    />
  );

  return (
    <div
      ref={appRootRef}
      className={`app-root${isDesktop ? "" : " mobile"}${banner ? " has-daemon-down" : ""}`}
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
                    {b.beta && <span className="beta-pill">Beta</span>}
                  </button>
                ))}
                {desktopBridge()?.setRemotePairing && (
                  <button
                    onClick={() => {
                      setPhonePairing(true);
                      setPairingDismissed(false);
                      void desktopBridge()?.setRemotePairing?.(true);
                    }}
                    data-pane="phone"
                    title={t("navPhone")}
                  >
                    <IconPhone />
                    <span>{t("navPhone")}</span>
                  </button>
                )}
              </nav>
            </div>
            <div className="desk-side-scroll">{sessionsNode}</div>
            <SidebarAccount
              localMode={localMode}
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
                onStart={(prompt) => createSession(prompt)}
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
            {top !== "browser" && top !== "mission" && (
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
          {shellBar && (
            <header className="shell-bar">
              <button
                className="shell-menu"
                onClick={() => setDrawerOpen(true)}
                aria-label={t("drawerOpen")}
                aria-haspopup="dialog"
                aria-expanded={drawerOpen}
                data-unread={unreadDot ? "1" : undefined}
              >
                <IconMenu size={22} />
                {unreadDot && <span className="shell-menu-dot" aria-hidden />}
              </button>
              <span className="shell-title">{top === "chats" ? t("navConversations") : ""}</span>
              {top === "chats" ? (
                <button
                  className="shell-action"
                  disabled={creating}
                  onClick={() => void createSession()}
                  aria-label={t("newConversation").replace(/^\+\s*/, "")}
                >
                  <IconPlus size={22} />
                </button>
              ) : (
                <span className="shell-action" aria-hidden />
              )}
            </header>
          )}
          {/* EVAL4-F4: outside the chat the phone had NO surface saying the
              connection was gone (the shell banners need the desktop bridge,
              the drawer only has a colour dot). One strip, attempts counted
              as real dials, and after 45 s guidance + the two actions that
              actually help. Inside the chat ChatView's own .conn-banner
              speaks (P2-108: never two banners). */}
          {connStatus !== "paired" && !chatActive && (
            <ConnStrip
              machineName={machineName}
              attempts={connAttempts}
              since={clientRef.current?.disconnectedSince ?? 0}
              onRetry={() => clientRef.current?.retryNow()}
              onPairAgain={() => void forgetAndPair()}
            />
          )}
          {mainContent ?? homeNode}
          <Drawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            active={drawerActive}
            onNavigate={navigateDrawer}
            recents={recents}
            onOpenSession={(id) => {
              setNavDir("fwd");
              dispatchView({ type: "openChat", sessionId: id });
            }}
            onPinToggle={(id, pinned) => {
              const next = togglePinned(pinnedIds, id, pinned);
              setPinnedIds(next);
              savePinned(next);
              notifyPins(next);
            }}
            onNewChat={() => void createSession()}
            creating={creating}
            machineName={machineName}
            connStatus={connStatus}
            onSwitchMachine={() => {
              setDrawerOpen(false);
              setSwitching(true);
            }}
            onDisconnect={() => {
              setDrawerOpen(false);
              disconnect();
            }}
          />
          {switching && (
            <MachinePicker
              machines={machines}
              activeRoom={getActiveRoom()}
              onSwitch={(p) => {
                setSwitching(false);
                void switchMachine(p);
              }}
              onForget={(p) => forgetMachine(p)}
              onAddMachine={() => {
                setSwitching(false);
                setAddingMachine(true);
              }}
              onClose={() => setSwitching(false)}
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
