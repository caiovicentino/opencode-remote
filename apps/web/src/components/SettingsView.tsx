import { useEffect, useState } from "react";
import { copyText } from "../lib/clipboard";
import { APP_VERSION } from "../version";
import { useT, setLang, getLang, type Lang } from "../lib/i18n";
import { timeAgo } from "../lib/time";
import { routineHistoryRows } from "../lib/routinehistoryview";
import { IconChevronDown } from "./icons";
import { getTtsLang, setTtsLang as persistTtsLang, type TtsLang } from "../lib/voice";
import { readinessRows, summarize, MACHINE_SEVERITY_DOT, BROWSE_STATES, DOC_STATES, VOICE_STATES, TTS_STATES } from "../lib/machinestate";
import type { UpstreamNotice } from "../lib/degraded";
import { applyTheme, FONT_KEY, readTheme, THEME_KEY, type ThemeChoice } from "../lib/theme";

/** P2-187: phone relay resolution from the desktop shell (mirrors
 * apps/desktop/src/preload.ts). origin says where the effective address comes
 * from; problems is non-empty when the UI must show the error. */
export interface RelaySetting {
  url: string;
  origin: "env" | "stored" | "default" | "stored-invalid";
  problems: string[];
}

export interface RelaySettingWriteResult extends RelaySetting {
  ok: boolean;
}

/** P2-328: verdict of the relay card's "Test connection" probe (mirrors
 * apps/desktop/src/preload.ts / apps/desktop/src/relayprobe.ts). state is one
 * of the documented relayprobe table values; message/messageEn are the static
 * phrases the module ships — the view picks by language and renders verbatim. */
export interface RelayProbeResult {
  state: string;
  message: string;
  messageEn: string;
}

/** P2-189: app address resolution from the desktop shell (mirrors
 * apps/desktop/src/preload.ts). origin says how the address was reached;
 * problems is non-empty when the UI must show the error instead of a QR. */
export interface WebAppSetting {
  url: string;
  origin: "stored" | "derived" | "unavailable";
  problems: string[];
}

export interface WebAppSettingWriteResult extends WebAppSetting {
  ok: boolean;
}

/** P2-289: machine-proxy owner choice from the desktop shell (mirrors
 * apps/desktop/src/preload.ts). mode is the stored choice (null = no choice
 * yet), origin says whether the ACTIVE boot mode came from the stored choice
 * or the machine environment. */
export interface ProxySetting {
  mode: "system" | "direct" | "fixed" | null;
  address: string | null;
  origin: "owner" | "environment";
  reason: string;
}

export interface ProxySettingWriteResult extends ProxySetting {
  ok: boolean;
}

interface Props {
  request: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
  onBack: () => void;
  /** P1-061: current wire — "local" loopback WS or the relay (PWA default). */
  transport?: "local" | "relay";
  /** P1-050: desktop shell only — full support bundle for "Copy diagnostic". */
  getDiagnostics?: () => Promise<string>;
  /** P3-407: desktop shell only — writes the same redacted bundle to a file
   * through the native save dialog. Status-only result: ok + the optional
   * user-cancel flag, never a path (the toast copy stays path-free too). */
  saveDiagnostics?: () => Promise<{ ok: boolean; canceled?: boolean }>;
  /** P1-070: desktop shell only — explicit "pair a remote phone" action that
   * turns the QR ceremony on (app:setRemotePairing). */
  onPairRemote?: () => void;
  /** P2-187: desktop shell only — phone relay address read + validated write. */
  getRelaySetting?: () => Promise<RelaySetting>;
  setRelayUrl?: (url: string | null) => Promise<RelaySettingWriteResult>;
  /** P2-328: desktop shell only — one /healthz probe of the address as typed
   * (the draft), so a typo is caught before the save restarts the daemon. */
  testRelay?: (url: string) => Promise<RelayProbeResult>;
  /** P2-189: desktop shell only — app address the phone opens, read + validated write. */
  getWebAppUrl?: () => Promise<WebAppSetting>;
  setWebAppUrl?: (url: string | null) => Promise<WebAppSettingWriteResult>;
  /** P2-289: desktop shell only — machine proxy read + validated write. */
  getProxySetting?: () => Promise<ProxySetting>;
  setProxyChoice?: (choice: { mode: "system" | "direct" | "fixed"; address?: string }) => Promise<ProxySettingWriteResult>;
  /** P2-138: upstream (opencode) notice — renders the help section the calm
   * card's secondary button links to; absent when the agent server is fine. */
  upstream?: UpstreamNotice | null;
}

interface Device {
  pub: string;
  addedAt: string;
  label?: string;
  /** P2-194: approximate last handshake — absent for pre-existing entries. */
  lastSeenAt?: string;
}

interface Routine {
  id: string;
  name: string;
  prompt: string;
  hour: number;
  minute: number;
  mode?: "daily" | "days" | "interval";
  days?: number[];
  intervalMinutes?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  /** P2-318: raw per-trigger history exactly as the route delivers it —
   * parsed tolerantly by lib/routinehistoryview.ts, never trusted. */
  history?: unknown;
}

const DAY_NAME_KEYS = ["daySun", "dayMon", "dayTue", "dayWed", "dayThu", "dayFri", "daySat"];
const DAY_LETTER_KEYS = ["dayLetter0", "dayLetter1", "dayLetter2", "dayLetter3", "dayLetter4", "dayLetter5", "dayLetter6"];

type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

function scheduleLabel(r: Routine, t: TranslateFn): string {
  const hm = `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`;
  if (r.mode === "interval") return t("routineEvery", { n: r.intervalMinutes ?? 0 });
  if (r.mode === "days")
    return `${(r.days ?? []).map((d) => t(DAY_NAME_KEYS[d] as string)).join(" ")} · ${hm}`;
  return t("routineDaily", { time: hm });
}

interface Skill {
  id: string;
  label: string;
  prompt: string;
}


interface McpServer {
  name: string;
  type: string;
  command?: string[];
  url?: string;
  enabled: boolean;
}

const VOICE_KEY = "ocr_voice";

export function getVoiceSettings(): { autoSend: boolean; lang: string } {
  try {
    return { autoSend: false, lang: "auto", ...JSON.parse(localStorage.getItem(VOICE_KEY) ?? "{}") };
  } catch {
    return { autoSend: false, lang: "auto" };
  }
}

/** Persisted theme choice: explicit override or follow the OS (P1-047).
 * P3-368: the type and the apply/persist logic moved to lib/theme.ts so the
 * offline card's theme select shares the exact same path. */

/** P2-287/P2-297: deterministic-evidence hatch (the P2-218 lesson, web
 * edition) — localStorage overrides force capability verdicts for
 * screenshots WITHOUT touching any network path, one key per capability:
 * `ocr.browseStateOverride`, `ocr.docsStateOverride`, `ocr.voiceStateOverride`,
 * `ocr.ttsStateOverride` (P2-305),
 * `ocr.relayStateOverride` (value "down") and `ocr.agentStateOverride` (value
 * "missing"). Fail-closed twice over: only the DEGRADED states of the tables
 * owned by machinestate.ts are honored — never "ready"/"complete", never
 * ok/binaryFound — so the hatch can never fabricate an approval for a machine
 * that never measured one, and the real payload always wins when it exists.
 * No phrase is ever forced or invented (the label alone carries the row).
 * Documented in docs/troubleshooting.md beside the daemon hatches. */
const HATCH_STATES: readonly string[] = BROWSE_STATES.filter((s) => s !== "ready");
const DOCS_HATCH_STATES: readonly string[] = DOC_STATES.filter((s) => s !== "complete");
const VOICE_HATCH_STATES: readonly string[] = VOICE_STATES.filter((s) => s !== "ready");
const TTS_HATCH_STATES: readonly string[] = TTS_STATES.filter((s) => s !== "ready");

function forcedBrowseState(): string | undefined {
  const forced = localStorage.getItem("ocr.browseStateOverride") ?? "";
  return HATCH_STATES.includes(forced) ? forced : undefined;
}

function forcedDocsState(): string | undefined {
  const forced = localStorage.getItem("ocr.docsStateOverride") ?? "";
  return DOCS_HATCH_STATES.includes(forced) ? forced : undefined;
}

function forcedVoiceState(): string | undefined {
  const forced = localStorage.getItem("ocr.voiceStateOverride") ?? "";
  return VOICE_HATCH_STATES.includes(forced) ? forced : undefined;
}

function forcedTtsState(): string | undefined {
  const forced = localStorage.getItem("ocr.ttsStateOverride") ?? "";
  return TTS_HATCH_STATES.includes(forced) ? forced : undefined;
}

/** The boolean verdicts have a single degraded value each: a relay this
 * machine cannot reach and an agent binary nobody found. */
function forcedRelayOk(): boolean | undefined {
  return localStorage.getItem("ocr.relayStateOverride") === "down" ? false : undefined;
}

function forcedAgentFound(): boolean | undefined {
  return localStorage.getItem("ocr.agentStateOverride") === "missing" ? false : undefined;
}

export default function SettingsView({ request, onBack, transport, getDiagnostics, saveDiagnostics, onPairRemote, getRelaySetting, setRelayUrl, testRelay, getWebAppUrl, setWebAppUrl, getProxySetting, setProxyChoice, upstream }: Props) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [name, setName] = useState("");
  const [notify, setNotify] = useState({ permission: true, idle: true });
  const [autoMode, setAutoMode] = useState(false);
  const [lang, setLangState] = useState<Lang>(getLang());
  const [ttsLang, setTtsLangState] = useState<TtsLang>(getTtsLang());
  const t = useT();
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [configFile, setConfigFile] = useState("");
  const [newMcp, setNewMcp] = useState({ name: "", type: "local", value: "" });
  const [voice, setVoice] = useState(getVoiceSettings());
  const [style, setStyle] = useState<Record<string, unknown>>({});
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const [font, setFont] = useState(localStorage.getItem(FONT_KEY) ?? "normal");
  const [msg, setMsg] = useState("");
  const [pushTesting, setPushTesting] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [pushSubs, setPushSubs] = useState(0);
  const [routines, setRoutines] = useState<Routine[]>([]);
  // P2-318: which routine history panels are expanded (id → open), closed by
  // default — a calm collapsible per PRODUCT.md principle 2.
  const [openHistory, setOpenHistory] = useState<Record<string, boolean>>({});
  const [nrName, setNrName] = useState("");
  const [nrTime, setNrTime] = useState("07:00");
  const [nrPrompt, setNrPrompt] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [nsLabel, setNsLabel] = useState("");
  const [nsPrompt, setNsPrompt] = useState("");
  const [auditEntries, setAuditEntries] = useState<{ ts: string; event: string; data?: Record<string, unknown> }[]>([]);
  const [daemonVersion, setDaemonVersion] = useState("");
  // P2-213: version readiness of the opencode on the machine hosting the
  // daemon — rides the existing /__ocr/settings read (additive field).
  const [opencodeVersion, setOpencodeVersion] = useState<{ state?: string; message?: string } | null>(null);
  // P2-215: disk-space verdict for the volume hosting the daemon's state dir —
  // same channel as above (additive `disk` field on /__ocr/settings).
  const [disk, setDisk] = useState<{ state?: string; message?: string } | null>(null);
  // P2-287: browse-readiness verdict (site opening) — additive fields on
  // /__ocr/settings; daemons do not send them yet (the daemon-side mirror is
  // the registered continuation), so the read yields no browse row until
  // then and only the documented evidence hatch below can force one,
  // fail-closed.
  const [browse, setBrowse] = useState<{ state?: string; message?: string } | null>(null);
  // P2-297: the remaining capability groups — the relay link, the agent
  // binary, doc conversion and voice transcription — ride the SAME
  // /__ocr/settings read (the daemon's P2-292/P2-296 mirror publishes them):
  // still no new route, no new request, no new poll, no new timer. Same
  // tolerant read as browse above — an absent field is null and therefore
  // no row.
  // NAMING (P2-297): the voice-readiness state below CANNOT be called
  // `voice` — that identifier is already the voice PREFERENCES state (the
  // getVoiceSettings() draft at the `const [voice, setVoice]` line above)
  // and the collision would silently break both. It is `voiceVerdict`; do
  // not "simplify" it back.
  const [relayVerdict, setRelayVerdict] = useState<{ ok?: boolean; reason?: string | null } | null>(null);
  const [agentVerdict, setAgentVerdict] = useState<{ binaryFound?: boolean; binarySource?: string | null } | null>(null);
  const [docsVerdict, setDocsVerdict] = useState<{ state?: string; message?: string } | null>(null);
  const [voiceVerdict, setVoiceVerdict] = useState<{ state?: string; message?: string } | null>(null);
  // NAMING (P2-305): the spoken-reply verdict is `ttsVerdict` — deliberately
  // NOT `voice*`, that family is the transcription verdict (voiceVerdict)
  // and the voice PREFERENCES state above; the daemon's pair is
  // ttsState/ttsMessage and the view keeps the same names.
  const [ttsVerdict, setTtsVerdict] = useState<{ state?: string; message?: string } | null>(null);
  const [nrMode, setNrMode] = useState<"daily" | "days" | "interval">("daily");
  const [nrDays, setNrDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [nrInterval, setNrInterval] = useState(60);
  // P2-187: phone relay address (desktop shell only). The draft mirrors the
  // input; `relay` is the main-process resolution (origin + problems).
  const [relay, setRelay] = useState<RelaySetting | null>(null);
  const [relayDraft, setRelayDraft] = useState("");
  // P2-328: the "Test connection" probe — a boolean testing state and a
  // result that is ALWAYS terminal (a final verdict phrase, never a spinner
  // line); the Save action is never blocked by a running test.
  const [relayTesting, setRelayTesting] = useState(false);
  const [relayTestResult, setRelayTestResult] = useState<RelayProbeResult | null>(null);
  // P2-189: app address the phone opens (desktop shell only) — same
  // draft/resolution discipline as the relay setting above.
  const [webApp, setWebApp] = useState<WebAppSetting | null>(null);
  const [webAppDraft, setWebAppDraft] = useState("");
  // P2-289: machine proxy (desktop shell only) — the radio choice, the fixed
  // address draft and the module's static refusal reason (rendered verbatim).
  const [proxy, setProxy] = useState<ProxySetting | null>(null);
  const [proxyMode, setProxyMode] = useState<"system" | "direct" | "fixed">("system");
  const [proxyAddress, setProxyAddress] = useState("");
  const [proxyRefusal, setProxyRefusal] = useState("");

  useEffect(() => {
    if (!getRelaySetting) return;
    void getRelaySetting()
      .then((s) => {
        setRelay(s);
        setRelayDraft(s.url);
      })
      .catch(() => {});
    // Mount-time read only: the bridge is stable for the app's lifetime.
  }, []);

  useEffect(() => {
    if (!getProxySetting) return;
    void getProxySetting()
      .then((s) => {
        setProxy(s);
        if (s.mode) setProxyMode(s.mode);
        setProxyAddress(s.address ?? "");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!getWebAppUrl) return;
    void getWebAppUrl()
      .then((s) => {
        setWebApp(s);
        setWebAppDraft(s.url);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await request("GET", "/__ocr/routines");
      if (r.status === 200) setRoutines((r.body as { routines?: Routine[] }).routines ?? []);
      const sk = await request("GET", "/__ocr/skills");
      if (sk.status === 200) setSkills((sk.body as { skills?: Skill[] }).skills ?? []);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const d = await request("GET", "/__ocr/devices");
      if (d.status === 200) setDevices((d.body as { devices?: Device[] }).devices ?? []);
      const s = await request("GET", "/__ocr/settings");
      if (s.status === 200) {
        setName((s.body as { name?: string }).name ?? "");
        setNotify((s.body as { notify?: { permission: boolean; idle: boolean } }).notify ?? { permission: true, idle: true });
        setAutoMode((s.body as { autoMode?: boolean }).autoMode === true);
        setDaemonVersion((s.body as { version?: string }).version ?? "");
        setOpencodeVersion((s.body as { opencodeVersion?: { state?: string; message?: string } }).opencodeVersion ?? null);
        setDisk((s.body as { disk?: { state?: string; message?: string } }).disk ?? null);
        setBrowse((s.body as { browseState?: string; browseMessage?: string }).browseState !== undefined
          ? {
              state: (s.body as { browseState?: string }).browseState,
              message: (s.body as { browseMessage?: string }).browseMessage,
            }
          : null);
        // P2-297: same read, same tolerant shape — the relay object and the
        // agent binary pair are object-typed fields (a non-object payload
        // entry is null and therefore no row); the doc and voice pairs are
        // flat state+message pairs read exactly like browse above.
        const relayField = (s.body as { relay?: { ok?: boolean; reason?: string | null } }).relay;
        setRelayVerdict(relayField && typeof relayField === "object" ? relayField : null);
        const agentField = (s.body as { opencode?: { binaryFound?: boolean; binarySource?: string | null } }).opencode;
        setAgentVerdict(agentField && typeof agentField === "object" ? agentField : null);
        setDocsVerdict((s.body as { docConvertState?: string }).docConvertState !== undefined
          ? {
              state: (s.body as { docConvertState?: string }).docConvertState,
              message: (s.body as { docConvertMessage?: string }).docConvertMessage,
            }
          : null);
        setVoiceVerdict((s.body as { voiceState?: string }).voiceState !== undefined
          ? {
              state: (s.body as { voiceState?: string }).voiceState,
              message: (s.body as { voiceMessage?: string }).voiceMessage,
            }
          : null);
        // P2-305: the spoken-reply pair rides the SAME mount read, read
        // exactly like the voice pair above — absent field is null and
        // therefore no row.
        setTtsVerdict((s.body as { ttsState?: string }).ttsState !== undefined
          ? {
              state: (s.body as { ttsState?: string }).ttsState,
              message: (s.body as { ttsMessage?: string }).ttsMessage,
            }
          : null);
      }
      const cs = await request("GET", "/__ocr/clip-style");
      if (cs.status === 200) setStyle((cs.body as Record<string, unknown>) ?? {});
      const m = await request("GET", "/__ocr/mcp");
      if (m.status === 200) {
        setMcpServers((m.body as { servers?: McpServer[] }).servers ?? []);
        setConfigFile((m.body as { configFile?: string }).configFile ?? "");
      }
      const al = await request("GET", "/__ocr/audit");
      if (al.status === 200) setAuditEntries((al.body as { entries?: typeof auditEntries }).entries ?? []);
    })();
  }, []);

  async function saveSettings(patch: { name?: string; notify?: { permission?: boolean; idle?: boolean }; autoMode?: boolean }) {
    const res = await request("PATCH", "/__ocr/settings", patch);
    if (res.status === 200) setMsg(t("saved"));
  }

  /** P2-187: apply the drafted relay address in the main process (validated
   * there) and adopt the returned resolution — never trust local state. */
  async function saveRelay() {
    if (!setRelayUrl) return;
    try {
      const res = await setRelayUrl(relayDraft);
      setRelay(res);
      setRelayDraft(res.url);
      setMsg(res.ok ? t("saved") : t("relayInvalid"));
    } catch {
      setMsg(t("relayInvalid"));
    }
  }

  /** P2-328: probe the DRAFTED relay address (never saved, never restarts the
   * daemon) and render the verdict — every outcome is a terminal state. */
  async function testRelayNow() {
    if (!testRelay || relayTesting) return;
    setRelayTesting(true);
    setRelayTestResult(null);
    try {
      setRelayTestResult(await testRelay(relayDraft));
    } catch {
      // Terminal fallback copy rides the dict (P2-275) — the module's own
      // phrases cover every verdict the IPC actually returns.
      setRelayTestResult({ state: "unreachable", message: t("relayTestFailed"), messageEn: t("relayTestFailed") });
    } finally {
      setRelayTesting(false);
    }
  }

  /** P2-187: "use the local relay" — clears the stored setting (the env still
   * wins when exported; the resolution returned by main says which origin). */
  async function resetRelay() {
    if (!setRelayUrl) return;
    try {
      const res = await setRelayUrl(null);
      setRelay(res);
      setRelayDraft(res.url);
      setMsg(t("saved"));
    } catch {
      setMsg(t("relayInvalid"));
    }
  }

  /** P2-189: apply the drafted app address in the main process (validated
   * there) and adopt the returned resolution — never trust local state. */
  async function saveWebApp() {
    if (!setWebAppUrl) return;
    try {
      const res = await setWebAppUrl(webAppDraft);
      setWebApp(res);
      setWebAppDraft(res.url);
      setMsg(res.ok ? t("saved") : t("webAppInvalid"));
    } catch {
      setMsg(t("webAppInvalid"));
    }
  }

  /** P2-189: clear the stored app address — the resolution falls back to the
   * one derived from the relay (or to "unavailable"). */
  async function resetWebApp() {
    if (!setWebAppUrl) return;
    try {
      const res = await setWebAppUrl(null);
      setWebApp(res);
      setWebAppDraft(res.url);
      setMsg(t("saved"));
    } catch {
      setMsg(t("webAppInvalid"));
    }
  }

  /** P2-289: apply the drafted proxy choice in the main process (validated
   * there, fail-closed) — the live session is never reconfigured; the choice
   * takes effect at the next app start. A refusal renders the module's own
   * static reason, verbatim. */
  async function saveProxy() {
    if (!setProxyChoice) return;
    setProxyRefusal("");
    try {
      const res = await setProxyChoice(
        proxyMode === "fixed" ? { mode: "fixed", address: proxyAddress } : { mode: proxyMode },
      );
      if (res.ok) {
        setProxy(res);
        setMsg(t("proxySaved"));
      } else {
        setProxyRefusal(res.reason || t("proxyInvalid"));
      }
    } catch {
      setProxyRefusal(t("proxyInvalid"));
    }
  }

  async function saveMcp(name: string, config?: Partial<McpServer>, remove = false) {
    const res = await request("PUT", "/__ocr/mcp", remove ? { name, remove: true } : { name, config });
    if (res.status === 200) {
      setMsg(t("saved"));
      setMcpServers((res.body as { servers?: McpServer[] }).servers ?? []);
    } else {
      setMsg(t("saveError", { msg: JSON.stringify(res.body).slice(0, 100) }));
    }
  }

  function saveVoice(v: { autoSend: boolean; lang: string }) {
    setVoice(v);
    localStorage.setItem(VOICE_KEY, JSON.stringify(v));
  }

  function saveTheme(t: ThemeChoice, f: string) {
    setTheme(t);
    setFont(f);
    localStorage.setItem(THEME_KEY, t);
    localStorage.setItem(FONT_KEY, f);
    applyTheme();
  }

  async function saveStyle(patch: Record<string, unknown>) {
    const next = { ...style, ...patch };
    setStyle(next);
    await request("PUT", "/__ocr/clip-style", next);
    setMsg(t("captionSaved"));
  }

  async function revoke(pub: string) {
    await request("DELETE", "/__ocr/devices", { pub });
    setDevices((prev) => prev.filter((d) => d.pub !== pub));
  }

  // P2-232: machine readiness rows from the SAME /__ocr/settings object this
  // view already fetches on mount — no new request, no new poll. The module
  // ignores absent or malformed verdicts, so a legacy daemon yields the calm
  // empty state. The daemon's phrases render verbatim; the app never rewrites
  // them and never invents its own.
  // P2-287: the browse verdict turns into the site-browsing row from the
  // same read.
  // P2-297: every capability is wired — relay, agent binary, docs and voice
  // join version, disk and browse, all from that one mount read (the
  // P2-292/P2-296 mirror publishes them). The hatch below only fills
  // verdicts the payload does not carry, and only in its degraded states.
  // P2-305: spoken replies (ttsState/ttsMessage) ride the same read.
  const machineRows = readinessRows({
    relay: {
      ok: relayVerdict?.ok ?? forcedRelayOk(),
      reason: relayVerdict?.reason ?? null,
    },
    opencode: {
      binaryFound: agentVerdict?.binaryFound ?? forcedAgentFound(),
      versionState: opencodeVersion?.state,
      versionMessage: opencodeVersion?.message,
    },
    diskState: disk?.state,
    diskMessage: disk?.message,
    docConvertState: docsVerdict?.state ?? forcedDocsState(),
    docConvertMessage: docsVerdict?.message,
    browseState: browse?.state ?? forcedBrowseState(),
    browseMessage: browse?.message,
    voiceState: voiceVerdict?.state ?? forcedVoiceState(),
    voiceMessage: voiceVerdict?.message,
    ttsState: ttsVerdict?.state ?? forcedTtsState(),
    ttsMessage: ttsVerdict?.message,
  });
  const machineSummary = summarize(machineRows);

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 className="pane-title">{t("navSettings")}</h1>
      </header>

      <div className="list">
        {msg && <p className="muted">{msg}</p>}

        {upstream && (
          <div className="card settings-help">
            <h3>{t("upstreamHelpTitle")}</h3>
            <p className="settings-help-title">{t(upstream.titleKey)}</p>
            <p className="muted" style={{ margin: "2px 0 0" }}>
              {t(upstream.actionKey)}
            </p>
            {/* Daemon detail as secondary text — never rendered as HTML. */}
            {(upstream.reason || upstream.hint) && (
              <p className="muted settings-help-detail" style={{ margin: "6px 0 0", fontSize: "var(--font-size-sm)" }}>
                {[upstream.reason, upstream.hint].filter(Boolean).join(" — ")}
              </p>
            )}
          </div>
        )}

        <div className="card">
          <h3>{t("aboutTitle")}</h3>
          <p className="muted" style={{ margin: 0 }}>
            {t("aboutVersions", { app: APP_VERSION, daemon: daemonVersion || "?" })}
            {daemonVersion && daemonVersion !== APP_VERSION && (
              <span style={{ color: "var(--danger)" }}>
                {" "}
                {t("versionMismatch")}
              </span>
            )}
          </p>
          <p className="muted" style={{ margin: "2px 0 0" }}>
            {transport === "local" ? t("connLocal") : t("connRelay")}
          </p>
        </div>

        <div className="card machine-state">
          <h3>{t("machineStateTitle")}</h3>
          <p className="machine-state-summary">{t(machineSummary.titleKey)}</p>
          {machineRows.map((row) => (
            <div className="machine-row" key={row.key}>
              <span className={`status-dot ${MACHINE_SEVERITY_DOT[row.severity]}`} aria-hidden="true" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: "var(--font-size-sm)" }}>{t(row.labelKey)}</b>
                {row.message && <p className="muted machine-row-msg">{row.message}</p>}
              </div>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t("diagTitle")}</h3>
          <div className="diag-actions">
            <button
              className="primary"
              onClick={() =>
                void (async () => {
                  if (!getDiagnostics) return;
                  try {
                    const ok = await copyText(await getDiagnostics());
                    setMsg(ok ? t("diagCopied") : t("diagCopy"));
                  } catch {
                    setMsg(t("diagCopy"));
                  }
                })()
              }
            >
              {t("diagCopy")}
            </button>
            {/* P3-407: save twin, shell bridge only — the browser/PWA has no
            file surface, so the button simply never renders there. */}
            {saveDiagnostics && (
              <button
                className="diag-save"
                onClick={() =>
                  void (async () => {
                    try {
                      const res = await saveDiagnostics();
                      // Terminal states only (P3-327): a static success or
                      // failure line — never a path, a spinner or limbo.
                      if (res.ok && !res.canceled) setMsg(t("diagSaved"));
                      else if (!res.ok) setMsg(t("diagSaveFailed"));
                    } catch {
                      setMsg(t("diagSaveFailed"));
                    }
                  })()
                }
              >
                {t("diagSave")}
              </button>
            )}
          </div>
        </div>

        {onPairRemote && (
          <div className="card">
            <h3>{t("pairRemoteTitle")}</h3>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              {t("pairRemoteHint")}
            </p>
            <button className="pair-remote-entry" onClick={onPairRemote}>
              {t("pairRemoteAction")}
              <svg
                className="pair-remote-chevron"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
        )}

        {/* P2-187: phone relay address — desktop shell only (the PWA pairs */}
        {/* with the machine it is served by; the ceremony lives in the shell). */}
        {getRelaySetting && setRelayUrl && relay && (
          <div className="card relay-setting">
            <h3>{t("relayTitle")}</h3>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              {t("relayHint")}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={relayDraft}
                readOnly={relay.origin === "env"}
                onChange={(e) => {
                  setRelayDraft(e.target.value);
                  // P2-328: a verdict about a previous draft says nothing
                  // about the address now in the field — drop it.
                  setRelayTestResult(null);
                }}
                placeholder="wss://relay.example.com:8788"
                aria-label={t("relayTitle")}
                spellCheck={false}
              />
              {relay.origin !== "env" && (
                <>
                  <button className="primary" onClick={() => void saveRelay()}>
                    {t("relaySave")}
                  </button>
                  {/* P2-328: test the address as typed BEFORE saving — the
                  probe never persists, never restarts the daemon and never
                  blocks Save; every outcome lands in the terminal line below. */}
                  {testRelay && (
                    <button onClick={() => void testRelayNow()} disabled={relayTesting}>
                      {relayTesting ? t("relayTesting") : t("relayTest")}
                    </button>
                  )}
                </>
              )}
            </div>
            {relayTestResult && (
              <p
                className="muted relay-test-result"
                style={{
                  margin: "6px 0 0",
                  color: relayTestResult.state === "ok" || relayTestResult.state === "draining" ? undefined : "var(--danger)",
                }}
              >
                {lang === "en" ? relayTestResult.messageEn : relayTestResult.message}
              </p>
            )}
            {relay.problems.length > 0 && (
              <p className="muted" style={{ margin: "6px 0 0", color: "var(--danger)" }}>
                {t("relayInvalid")}
              </p>
            )}
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {relay.origin === "env"
                ? t("relayOriginEnv")
                : relay.origin === "stored"
                  ? t("relayOriginStored")
                  : relay.origin === "stored-invalid"
                    ? t("relayOriginInvalid")
                    : t("relayOriginDefault")}
            </p>
            {(relay.origin === "stored" || relay.origin === "stored-invalid") && (
              <button style={{ marginTop: 6 }} onClick={() => void resetRelay()}>
                {t("relayReset")}
              </button>
            )}
          </div>
        )}

        {/* P2-189: app address the phone opens — desktop shell only, rendered
            right beside the relay card it derives from. */}
        {getWebAppUrl && setWebAppUrl && webApp && (
          <div className="card webapp-setting">
            <h3>{t("webAppTitle")}</h3>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              {t("webAppHint")}
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                style={{ flex: 1 }}
                value={webAppDraft}
                onChange={(e) => setWebAppDraft(e.target.value)}
                placeholder="https://relay.example.com:8788"
                aria-label={t("webAppTitle")}
                spellCheck={false}
              />
              <button className="primary" onClick={() => void saveWebApp()}>
                {t("relaySave")}
              </button>
            </div>
            {webApp.problems.length > 0 && (
              <p className="muted" style={{ margin: "6px 0 0", color: "var(--danger)" }}>
                {t("webAppInvalid")}
              </p>
            )}
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {webApp.origin === "stored"
                ? t("webAppOriginStored")
                : webApp.origin === "derived"
                  ? t("webAppOriginDerived")
                  : t("webAppOriginUnavailable")}
            </p>
            {webApp.origin === "stored" && (
              <button style={{ marginTop: 6 }} onClick={() => void resetWebApp()}>
                {t("webAppReset")}
              </button>
            )}
          </div>
        )}

        {/* P2-289: machine proxy — desktop shell only; the PWA has no shell
            bridge, so the section simply never renders there. */}
        {getProxySetting && setProxyChoice && proxy && (
          <div className="card proxy-setting">
            <h3>{t("proxyTitle")}</h3>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              {t("proxyHint")}
            </p>
            {(["system", "direct", "fixed"] as const).map((m) => (
              <label key={m} style={{ display: "block" }}>
                <input
                  type="radio"
                  name="proxy-mode"
                  checked={proxyMode === m}
                  onChange={() => setProxyMode(m)}
                />{" "}
                {t(m === "system" ? "proxyModeSystem" : m === "direct" ? "proxyModeDirect" : "proxyModeFixed")}
              </label>
            ))}
            {proxyMode === "fixed" && (
              <input
                style={{ width: "100%", marginTop: 6 }}
                value={proxyAddress}
                onChange={(e) => setProxyAddress(e.target.value)}
                placeholder="proxy.exemplo.corp"
                aria-label={t("proxyAddressLabel")}
                spellCheck={false}
              />
            )}
            {proxyRefusal && (
              <p className="muted" style={{ margin: "6px 0 0", color: "var(--danger)" }}>
                {proxyRefusal}
              </p>
            )}
            <button className="primary" style={{ marginTop: 8 }} onClick={() => void saveProxy()}>
              {t("proxySave")}
            </button>
            <p className="muted" style={{ margin: "6px 0 0" }}>
              {t("proxyNextStart")}
            </p>
            <p className="muted" style={{ margin: "2px 0 0" }}>
              {proxy.origin === "owner" ? t("proxyOriginOwner") : t("proxyOriginEnvironment")}
            </p>
          </div>
        )}

        <div className="card">
          <h3>{t("language")}</h3>
          <select
            value={lang}
            onChange={(e) => {
              const next = e.target.value as Lang;
              setLang(next);
              setLangState(next);
            }}
          >
            <option value="en">English</option>
            <option value="pt">Português</option>
          </select>
        </div>

        <div className="card">
          <h3>{t("settingsMachine")}</h3>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ flex: 1 }}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("machineNamePlaceholder")}
            />
            <button className="primary" onClick={() => void saveSettings({ name })}>
              {t("save")}
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            {t("settingsNotifications")}
          </p>
          {/* P2-213: version readiness is advice about the machine hosting the
              daemon, never a gate — a probe that can flip must not lock the
              conversation, so this deliberately fails open: only too-old says
              anything (ok/unknown stay silent) and no control is ever disabled
              or hidden here. */}
          {opencodeVersion?.state === "too-old" && (
            <p className="muted opencode-version-hint" style={{ margin: "8px 0 0", color: "var(--warn)" }}>
              {opencodeVersion.message ?? ""}
            </p>
          )}
          {/* P2-215: disk-space readiness is advice about the machine hosting
              the daemon, never a gate — blocking the conversation because of a
              disk reading would be worse than the raw failure it warns about,
              so this deliberately fails open: only low/critical say anything
              (ok/unknown stay silent) and no control is ever disabled or
              hidden because of it. */}
          {(disk?.state === "low" || disk?.state === "critical") && (
            <p className="muted disk-hint" style={{ margin: "8px 0 0", color: "var(--warn)" }}>
              {disk?.message ?? ""}
            </p>
          )}
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={notify.permission}
              onChange={(e) => {
                const n = { ...notify, permission: e.target.checked };
                setNotify(n);
                void saveSettings({ notify: n });
              }}
            />{" "}
            {t("notifPermission")}
          </label>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={notify.idle}
              onChange={(e) => {
                const n = { ...notify, idle: e.target.checked };
                setNotify(n);
                void saveSettings({ notify: n });
              }}
            />{" "}
            {t("notifIdle")}
          </label>
        </div>

        <div className="card">
          <h3>{t("mcp")}</h3>
          <p className="muted" style={{ margin: "0 0 6px" }}>
            {t("mcpHint", { file: configFile.split("/").pop() ?? "" })}
          </p>
          {mcpServers.length === 0 && <p className="muted" style={{ margin: 0 }}>{t("mcpNone")}</p>}
          {mcpServers.map((s) => (
            <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => void saveMcp(s.name, { ...s, enabled: e.target.checked })}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b style={{ fontSize: "0.85rem" }}>{s.name}</b>{" "}
                <span className="muted" style={{ fontSize: "0.75rem" }}>
                  {s.type === "remote" ? s.url : (s.command ?? []).join(" ")}
                </span>
              </div>
              <button className="danger" aria-label={t("remove")} onClick={() => void saveMcp(s.name, undefined, true)}>
                ✕
              </button>
            </div>
          ))}
          <details style={{ marginTop: 6 }}>
            <summary className="muted">{t("mcpAdd")}</summary>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input style={{ flex: 1 }} placeholder={t("mcpName")} value={newMcp.name} onChange={(e) => setNewMcp({ ...newMcp, name: e.target.value })} />
              <select value={newMcp.type} onChange={(e) => setNewMcp({ ...newMcp, type: e.target.value })}>
                <option value="local">{t("mcpTypeLocal")}</option>
                <option value="remote">{t("mcpTypeRemote")}</option>
              </select>
            </div>
            <input
              style={{ width: "100%", marginTop: 6 }}
              placeholder={newMcp.type === "remote" ? t("mcpUrl") : t("mcpCommand")}
              value={newMcp.value}
              onChange={(e) => setNewMcp({ ...newMcp, value: e.target.value })}
            />
            <button
              className="primary"
              style={{ marginTop: 6 }}
              disabled={!newMcp.name.trim() || !newMcp.value.trim()}
              onClick={() => {
                const cfg =
                  newMcp.type === "remote"
                    ? { type: "remote", url: newMcp.value.trim(), enabled: true }
                    : { type: "local", command: newMcp.value.trim().split(/\s+/), enabled: true };
                void saveMcp(newMcp.name.trim(), cfg);
                setNewMcp({ name: "", type: "local", value: "" });
              }}
            >
              {t("mcpAddBtn")}
            </button>
          </details>
        </div>

        <div className="card">
          <h3>{t("autoMode")}</h3>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              className="automode-toggle"
              checked={autoMode}
              onChange={(e) => {
                setAutoMode(e.target.checked);
                void saveSettings({ autoMode: e.target.checked });
              }}
            />{" "}
            {t("autoModeLabel")}
          </label>
          <p className="muted" style={{ marginBottom: 0 }}>
            {t("autoModeHint")}
          </p>
        </div>

        <div className="card">
          <h3>{t("voice")}</h3>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={voice.autoSend}
              onChange={(e) => saveVoice({ ...voice, autoSend: e.target.checked })}
            />{" "}
            {t("voiceAutoSend")}
          </label>
          <label style={{ display: "block", marginTop: 8 }}>
            {t("voiceInLang")}:{" "}
            <select value={voice.lang} onChange={(e) => saveVoice({ ...voice, lang: e.target.value })}>
              <option value="auto">{t("voiceLangAuto")}</option>
              <option value="pt">{t("voiceLangPt")}</option>
              <option value="en">{t("voiceLangEn")}</option>
              <option value="es">{t("voiceLangEs")}</option>
              <option value="fr">{t("voiceLangFr")}</option>
            </select>
          </label>
          <label style={{ display: "block", marginTop: 8 }}>
            {t("voiceOutLang")}:{" "}
            <select
              value={ttsLang}
              onChange={(e) => {
                const next = e.target.value as TtsLang;
                persistTtsLang(next);
                setTtsLangState(next);
              }}
            >
              <option value="pt-BR">{t("ttsVoicePt")}</option>
              <option value="en-US">{t("ttsVoiceEn")}</option>
              <option value="es-ES">{t("ttsVoiceEs")}</option>
            </select>
          </label>
        </div>

        <div className="card">
          <h3>{t("captionStyleTitle")}</h3>
          {(
            [
              ["font", t("captionFont")],
              ["fontSize", t("captionFontSize")],
              ["primary", t("captionPrimary")],
              ["secondary", t("captionHighlight")],
              ["outlineColor", t("captionOutline")],
              ["marginV", t("captionMargin")],
            ] as [string, string][]
          ).map(([k, label]) => (
            <label key={k} style={{ display: "block", marginBottom: 6 }}>
              {label}
              <input
                style={{ width: "100%" }}
                value={String(style[k] ?? "")}
                onChange={(e) => setStyle((s) => ({ ...s, [k]: e.target.value }))}
                placeholder={k}
              />
            </label>
          ))}
          <button className="primary" onClick={() => void saveStyle({})}>
            {t("captionSave")}
          </button>
        </div>

        <div className="card">
          <h3>{t("appearanceTitle")}</h3>
          <label style={{ display: "block" }}>
            {t("themeLabel")}:{" "}
            <select
              value={theme}
              onChange={(e) => saveTheme(e.target.value as ThemeChoice, font)}
            >
              <option value="system">{t("themeSystem")}</option>
              <option value="dark">{t("themeDark")}</option>
              <option value="light">{t("themeLight")}</option>
            </select>
          </label>
          <label style={{ display: "block", marginTop: 8 }}>
            {t("fontLabel")}:{" "}
            <select value={font} onChange={(e) => saveTheme(theme, e.target.value)}>
              <option value="small">{t("fontSmall")}</option>
              <option value="normal">{t("fontNormal")}</option>
              <option value="large">{t("fontLarge")}</option>
            </select>
          </label>
        </div>

        <div className="card">
          <h3>{t("pushTitle")}</h3>
          <button
            className="primary"
            disabled={pushTesting}
            onClick={() =>
              void (async () => {
                setPushTesting(true);
                setPushMsg("");
                try {
                  const res = await request("POST", "/__ocr/push/test");
                  const { results } = res.body as {
                    results?: { endpoint: string; ok: boolean; status?: number; error?: string }[];
                  };
                  if (!results?.length) setPushMsg(t("pushNoDevices"));
                  else {
                    const bad = results.filter((r) => !r.ok);
                    setPushMsg(
                      bad.length === 0
                        ? t("pushSentOk")
                        : bad
                            .map(
                              (r) =>
                                `endpoint …${r.endpoint.slice(-12)}: HTTP ${r.status ?? "?"} ${
                                  r.error ?? ""
                                }`.slice(0, 160),
                            )
                            .join(" | "),
                    );
                  }
                  const st = await request("GET", "/__ocr/push/status");
                  setPushSubs((st.body as { subscribers?: number }).subscribers ?? 0);
                } catch (err) {
                  setPushMsg(err instanceof Error ? err.message : String(err));
                } finally {
                  setPushTesting(false);
                }
              })()
            }
          >
            {pushTesting ? t("pushSending") : t("pushSendTest")}
          </button>
          <button
            style={{ marginLeft: 8 }}
            onClick={() =>
              void (async () => {
                setPushMsg("");
                try {
                  const { enablePush } = await import("../lib/push");
                  await enablePush(request);
                  setPushMsg(t("pushSubscribed"));
                  const st = await request("GET", "/__ocr/push/status");
                  setPushSubs((st.body as { subscribers?: number }).subscribers ?? 0);
                } catch (err) {
                  setPushMsg(err instanceof Error ? err.message : String(err));
                }
              })()
            }
          >
            {t("pushResubscribe")}
          </button>
          {pushMsg && <p className="muted" style={{ marginBottom: 0 }}>{pushMsg}</p>}
          <p className="muted" style={{ marginBottom: 0 }}>
            {t("pushSubsCount", { n: pushSubs })}
          </p>
        </div>

        <div className="card">
          <h3>{t("shareTitle")}</h3>
          <p className="muted" style={{ margin: 0 }}>
            <b>{t("shareAndroidLabel")}</b>: {t("shareAndroidBody")}
            <br />
            <b>{t("shareIosLabel")}</b>: {t("shareIosBody")}
          </p>
        </div>

        <div className="card">
          <h3>{t("skillsTitle")}</h3>
          {skills.map((s) => (
            <div key={s.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{s.label}</b>
                <div
                  className="muted"
                  style={{
                    fontSize: "0.72rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.prompt}
                </div>
              </span>
              <button
                className="danger"
                onClick={() =>
                  void (async () => {
                    await request("DELETE", "/__ocr/skills", { id: s.id });
                    setSkills((prev) => prev.filter((x) => x.id !== s.id));
                  })()
                }
              >
                {t("delete")}
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input
              style={{ flex: 1, minWidth: 0 }}
              placeholder={t("skillLabelPlaceholder")}
              value={nsLabel}
              onChange={(e) => setNsLabel(e.target.value)}
              maxLength={40}
            />
          </div>
          <textarea
            rows={2}
            placeholder={t("skillPromptPlaceholder")}
            style={{ width: "100%", marginTop: 6 }}
            value={nsPrompt}
            onChange={(e) => setNsPrompt(e.target.value)}
          />
          <button
            className="primary"
            onClick={() =>
              void (async () => {
                const res = await request("POST", "/__ocr/skills", {
                  label: nsLabel,
                  prompt: nsPrompt,
                });
                if (res.status === 200) {
                  const { skill } = res.body as { skill: Skill };
                  setSkills((prev) => [...prev, skill]);
                  setNsLabel("");
                  setNsPrompt("");
                  setMsg(t("skillAdded"));
                } else {
                  setMsg(t("skillRejected"));
                }
              })()
            }
          >
            {t("skillAdd")}
          </button>
        </div>

        <div className="card">
          <h3>{t("routinesTitle")}</h3>
          {routines.map((r) => {
            const rows = routineHistoryRows(r.history, Date.now(), t);
            const open = !!openHistory[r.id];
            return (
              <div key={r.id} style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>{scheduleLabel(r, t)}</b> · {r.name}
                    <div className="muted" style={{ fontSize: "0.72rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.prompt}
                    </div>
                  </span>
                  <span
                    title={r.lastError ? t("routineLastError", { err: r.lastError }) : r.lastStatus === "ok" ? t("routineLastOk") : t("routineNeverRan")}
                    style={{ fontSize: "0.85rem" }}
                  >
                    <span
                      className={`status-dot ${r.lastStatus === "ok" ? "ok" : r.lastStatus === "error" ? "err" : "idle"}`}
                    />
                  </span>
                  <button
                    className="danger"
                    onClick={() =>
                      void (async () => {
                        await request("DELETE", "/__ocr/routines", { id: r.id });
                        setRoutines((prev) => prev.filter((x) => x.id !== r.id));
                      })()
                    }
                  >
                    {t("delete")}
                  </button>
                </div>
                {rows.length === 0 ? (
                  <p className="routine-history-empty">{t("routineHistoryEmpty")}</p>
                ) : (
                  <>
                    <button
                      type="button"
                      className="routine-history-head"
                      aria-expanded={open}
                      onClick={() => setOpenHistory((prev) => ({ ...prev, [r.id]: !prev[r.id] }))}
                    >
                      <span className={`routine-history-chevron${open ? " open" : ""}`} aria-hidden>
                        <IconChevronDown size={14} />
                      </span>
                      {t("routineHistoryToggle", { n: rows.length })}
                    </button>
                    {open && (
                      <ul className="routine-history-list">
                        {rows.map((row, i) => (
                          <li key={`${row.at}-${i}`}>
                            <span className="routine-history-when">{row.whenLabel}</span>
                            <span className={`routine-history-outcome ${row.outcome}`}>{row.outcomeLabel}</span>
                            <span className="routine-history-dur">{row.durationLabel}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <select
              value={nrMode}
              onChange={(e) => setNrMode(e.target.value as typeof nrMode)}
              aria-label={t("routineModeLabel")}
            >
              <option value="daily">{t("routineEveryDay")}</option>
              <option value="days">{t("routineSpecificDays")}</option>
              <option value="interval">{t("routineLoop")}</option>
            </select>
            {nrMode !== "interval" ? (
              <input style={{ width: 90 }} type="time" value={nrTime} onChange={(e) => setNrTime(e.target.value)} />
            ) : (
              <input
                style={{ width: 110 }}
                type="number"
                min={5}
                max={10080}
                value={nrInterval}
                onChange={(e) => setNrInterval(Number(e.target.value))}
                aria-label={t("routineIntervalLabel")}
              />
            )}
            <input style={{ width: 90, flexGrow: 1 }} placeholder={t("routineNamePlaceholder")} value={nrName} onChange={(e) => setNrName(e.target.value)} />
          </div>
          {nrMode === "days" && (
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              {DAY_LETTER_KEYS.map((key, i) => (
                <button
                  key={i}
                  onClick={() =>
                    setNrDays((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort()))
                  }
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    padding: 0,
                    border: nrDays.includes(i) ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: nrDays.includes(i) ? "var(--accent)" : "transparent",
                    color: nrDays.includes(i) ? "var(--on-accent)" : "inherit",
                  }}
                  aria-label={t(DAY_NAME_KEYS[i] as string)}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          )}
          {nrMode === "interval" && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.72rem" }}>
              {t("routineIntervalHint")}
            </p>
          )}
          <textarea
            rows={2}
            placeholder={t("routinePromptPlaceholder")}
            style={{ width: "100%", marginTop: 6 }}
            value={nrPrompt}
            onChange={(e) => setNrPrompt(e.target.value)}
          />
          <button
            className="primary"
            onClick={() =>
              void (async () => {
                const [h, m] = nrTime.split(":").map(Number);
                const res = await request("POST", "/__ocr/routines", {
                  name: nrName,
                  prompt: nrPrompt,
                  hour: h,
                  minute: m,
                  mode: nrMode,
                  days: nrMode === "days" ? nrDays : undefined,
                  intervalMinutes: nrMode === "interval" ? nrInterval : undefined,
                });
                if (res.status === 200) {
                  const { routine } = res.body as { routine: Routine };
                  setRoutines((prev) => [...prev, routine]);
                  setNrName("");
                  setNrPrompt("");
                  setMsg(t("routineAdded"));
                } else {
                  setMsg(t("routineRejected"));
                }
              })()
            }
          >
            {t("routineAdd")}
          </button>
        </div>

        <div className="card">
          <h3>{t("pairedDevices", { n: devices.length })}</h3>
          {devices.map((d) => (
            <div key={d.pub} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span style={{ flex: 1 }}>
                {d.label ?? t("deviceFallback")} · …{d.pub.slice(-6)}
                <br />
                <span style={{ opacity: 0.6, fontSize: 12 }}>
                  {d.lastSeenAt
                    ? t("lastSeen", { when: timeAgo(d.lastSeenAt, t("justNow")) })
                    : t("neverSeen")}{" "}
                  · {new Date(d.addedAt).toLocaleDateString()}
                </span>
              </span>
              <button className="danger" onClick={() => void revoke(d.pub)}>
                {t("revoke")}
              </button>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>{t("securityLog")}</h3>
          {auditEntries.length === 0 && <p className="muted" style={{ margin: 0 }}>{t("noAudit")}</p>}
          {auditEntries.map((e, i) => (
            <div key={i} className="muted" style={{ fontSize: "0.72rem", marginBottom: 4 }}>
              {new Date(e.ts).toLocaleString()} · {e.event}
              {e.data?.fp
                ? ` · ${String(e.data.fp)}`
                : e.data?.pub
                  ? ` · …${String(e.data.pub).slice(-6)}`
                  : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
