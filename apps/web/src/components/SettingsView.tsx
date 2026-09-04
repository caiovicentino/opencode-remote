import { useEffect, useState } from "react";
import { APP_VERSION } from "../version";
import { useT, setLang, getLang, type Lang } from "../lib/i18n";
import { getTtsLang, setTtsLang as persistTtsLang, type TtsLang } from "../lib/voice";
import type { UpstreamNotice } from "../lib/degraded";

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
  /** P1-070: desktop shell only — explicit "pair a remote phone" action that
   * turns the QR ceremony on (app:setRemotePairing). */
  onPairRemote?: () => void;
  /** P2-138: upstream (opencode) notice — renders the help section the calm
   * card's secondary button links to; absent when the agent server is fine. */
  upstream?: UpstreamNotice | null;
}

interface Device {
  pub: string;
  addedAt: string;
  label?: string;
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
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function scheduleLabel(r: Routine): string {
  const hm = `${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`;
  if (r.mode === "interval") return `every ${r.intervalMinutes}m`;
  if (r.mode === "days")
    return `${(r.days ?? []).map((d) => DAY_NAMES[d]).join(" ")} · ${hm}`;
  return `daily ${hm}`;
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
const THEME_KEY = "ocr_theme";
const FONT_KEY = "ocr_font";

export function getVoiceSettings(): { autoSend: boolean; lang: string } {
  try {
    return { autoSend: false, lang: "auto", ...JSON.parse(localStorage.getItem(VOICE_KEY) ?? "{}") };
  } catch {
    return { autoSend: false, lang: "auto" };
  }
}

/** Persisted theme choice: explicit override or follow the OS (P1-047). */
type ThemeChoice = "dark" | "light" | "system";

/** MediaQueryList of the active `(prefers-color-scheme: light)` probe while
 * the theme is "system", so a live OS switch flips the shell without reload.
 * Re-calling applyTheme() always drops the previous listener — no leaks. */
let schemeQuery: MediaQueryList | null = null;

function onSchemeChange() {
  document.documentElement.dataset.theme = schemeQuery?.matches ? "light" : "dark";
}

export function applyTheme() {
  const theme = (localStorage.getItem(THEME_KEY) as ThemeChoice | null) ?? "system";
  const font = localStorage.getItem(FONT_KEY) ?? "normal";
  if (schemeQuery) {
    schemeQuery.removeEventListener("change", onSchemeChange);
    schemeQuery = null;
  }
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  } else {
    schemeQuery = window.matchMedia("(prefers-color-scheme: light)");
    onSchemeChange();
    schemeQuery.addEventListener("change", onSchemeChange);
  }
  document.documentElement.style.fontSize = font === "small" ? "14px" : font === "large" ? "19px" : "16.5px";
}

export default function SettingsView({ request, onBack, transport, getDiagnostics, onPairRemote, upstream }: Props) {
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
  const [theme, setTheme] = useState<ThemeChoice>(
    (() => {
      const stored = localStorage.getItem(THEME_KEY);
      return stored === "dark" || stored === "light" ? stored : "system";
    })(),
  );
  const [font, setFont] = useState(localStorage.getItem(FONT_KEY) ?? "normal");
  const [msg, setMsg] = useState("");
  const [pushTesting, setPushTesting] = useState(false);
  const [pushMsg, setPushMsg] = useState("");
  const [pushSubs, setPushSubs] = useState(0);
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [nrName, setNrName] = useState("");
  const [nrTime, setNrTime] = useState("07:00");
  const [nrPrompt, setNrPrompt] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [nsLabel, setNsLabel] = useState("");
  const [nsPrompt, setNsPrompt] = useState("");
  const [auditEntries, setAuditEntries] = useState<{ ts: string; event: string; data?: Record<string, unknown> }[]>([]);
  const [daemonVersion, setDaemonVersion] = useState("");
  const [nrMode, setNrMode] = useState<"daily" | "days" | "interval">("daily");
  const [nrDays, setNrDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [nrInterval, setNrInterval] = useState(60);

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

  async function saveMcp(name: string, config?: Partial<McpServer>, remove = false) {
    const res = await request("PUT", "/__ocr/mcp", remove ? { name, remove: true } : { name, config });
    if (res.status === 200) {
      setMsg("salvo");
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
    setMsg("caption style saved");
  }

  async function revoke(pub: string) {
    await request("DELETE", "/__ocr/devices", { pub });
    setDevices((prev) => prev.filter((d) => d.pub !== pub));
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>Settings</h1>
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
          <h3>About</h3>
          <p className="muted" style={{ margin: 0 }}>
            app {APP_VERSION} · daemon {daemonVersion || "?"}
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

        <div className="card">
          <h3>{t("diagTitle")}</h3>
          <button
            className="primary"
            onClick={() =>
              void (async () => {
                if (!getDiagnostics) return;
                try {
                  const { copyText } = await import("../lib/clipboard");
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
        </div>

        {onPairRemote && (
          <div className="card">
            <h3>{t("pairRemoteTitle")}</h3>
            <p className="muted" style={{ margin: "0 0 6px" }}>
              {t("pairRemoteHint")}
            </p>
            <button className="pair-remote-entry" onClick={onPairRemote}>
              {t("pairRemoteAction")}
            </button>
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
              placeholder="machine name"
            />
            <button className="primary" onClick={() => void saveSettings({ name })}>
              Save
            </button>
          </div>
          <p className="muted" style={{ marginBottom: 0 }}>
            Notifications
          </p>
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
          <h3>MCP</h3>
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
              <button className="danger" aria-label="Remove" onClick={() => void saveMcp(s.name, undefined, true)}>
                ✕
              </button>
            </div>
          ))}
          <details style={{ marginTop: 6 }}>
            <summary className="muted">{t("mcpAdd")}</summary>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <input style={{ flex: 1 }} placeholder={t("mcpName")} value={newMcp.name} onChange={(e) => setNewMcp({ ...newMcp, name: e.target.value })} />
              <select value={newMcp.type} onChange={(e) => setNewMcp({ ...newMcp, type: e.target.value })}>
                <option value="local">local</option>
                <option value="remote">remote</option>
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
          <h3>AutoMode</h3>
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
            Language:{" "}
            <select value={voice.lang} onChange={(e) => saveVoice({ ...voice, lang: e.target.value })}>
              <option value="auto">Auto-detect</option>
              <option value="pt">Portuguese</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
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
              <option value="pt-BR">Português (Antonio)</option>
              <option value="en-US">English (Andrew)</option>
              <option value="es-ES">Español (Alvaro)</option>
            </select>
          </label>
        </div>

        <div className="card">
          <h3>Caption style (clips)</h3>
          {(
            [
              ["font", "Font (e.g. Helvetica Bold)"],
              ["fontSize", "Size"],
              ["primary", "Primary color (&H..)"],
              ["secondary", "Highlight color (&H..)"],
              ["outlineColor", "Outline color (&H..)"],
              ["marginV", "Bottom margin"],
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
            Save style
          </button>
        </div>

        <div className="card">
          <h3>Appearance</h3>
          <label style={{ display: "block" }}>
            Theme:{" "}
            <select
              value={theme}
              onChange={(e) => saveTheme(e.target.value as ThemeChoice, font)}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label style={{ display: "block", marginTop: 8 }}>
            Font size:{" "}
            <select value={font} onChange={(e) => saveTheme(theme, e.target.value)}>
              <option value="small">Small</option>
              <option value="normal">Normal</option>
              <option value="large">Large</option>
            </select>
          </label>
        </div>

        <div className="card">
          <h3>Push notifications</h3>
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
                  if (!results?.length) setPushMsg("no device subscribed — tap Re-subscribe");
                  else {
                    const bad = results.filter((r) => !r.ok);
                    setPushMsg(
                      bad.length === 0
                        ? "sent OK — check the phone"
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
            {pushTesting ? "Sending…" : "Send test notification"}
          </button>
          <button
            style={{ marginLeft: 8 }}
            onClick={() =>
              void (async () => {
                setPushMsg("");
                try {
                  const { enablePush } = await import("../lib/push");
                  await enablePush(request);
                  setPushMsg("subscribed");
                  const st = await request("GET", "/__ocr/push/status");
                  setPushSubs((st.body as { subscribers?: number }).subscribers ?? 0);
                } catch (err) {
                  setPushMsg(err instanceof Error ? err.message : String(err));
                }
              })()
            }
          >
            Re-subscribe
          </button>
          {pushMsg && <p className="muted" style={{ marginBottom: 0 }}>{pushMsg}</p>}
          <p className="muted" style={{ marginBottom: 0 }}>
            {pushSubs} device(s) subscribed · iOS: app must be on the Home Screen
          </p>
        </div>

        <div className="card">
          <h3>Share to agent</h3>
          <p className="muted" style={{ margin: 0 }}>
            <b>Android/desktop</b>: the system share sheet offers "OpenCode Remote" directly.
            <br />
            <b>iOS</b>: copy the link anywhere, open the app, long-press the message field → Colar,
            add your instruction and send. Or create a Shortcut (Shortcuts app) that copies the
            shared text and opens "OpenCode Remote".
          </p>
        </div>

        <div className="card">
          <h3>Skills (1-tap prompts)</h3>
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
                Delete
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <input
              style={{ flex: 1, minWidth: 0 }}
              placeholder="label (e.g. Daily report)"
              value={nsLabel}
              onChange={(e) => setNsLabel(e.target.value)}
              maxLength={40}
            />
          </div>
          <textarea
            rows={2}
            placeholder="prompt sent to the agent on tap"
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
                  setMsg("skill added");
                } else {
                  setMsg("skill rejected — label and prompt required");
                }
              })()
            }
          >
            Add skill
          </button>
        </div>

        <div className="card">
          <h3>Scheduled routines</h3>
          {routines.map((r) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{scheduleLabel(r)}</b> · {r.name}
                <div className="muted" style={{ fontSize: "0.72rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.prompt}
                </div>
              </span>
              <span
                title={r.lastError ? `last error: ${r.lastError}` : r.lastStatus === "ok" ? "last run: ok" : "never ran"}
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
                Delete
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            <select
              value={nrMode}
              onChange={(e) => setNrMode(e.target.value as typeof nrMode)}
              aria-label="Schedule mode"
            >
              <option value="daily">Every day</option>
              <option value="days">Specific days</option>
              <option value="interval">Loop every N min</option>
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
                aria-label="Interval in minutes"
              />
            )}
            <input style={{ width: 90, flexGrow: 1 }} placeholder="name" value={nrName} onChange={(e) => setNrName(e.target.value)} />
          </div>
          {nrMode === "days" && (
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              {DAY_LABELS.map((d, i) => (
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
                  aria-label={DAY_NAMES[i]}
                >
                  {d}
                </button>
              ))}
            </div>
          )}
          {nrMode === "interval" && (
            <p className="muted" style={{ margin: "6px 0 0", fontSize: "0.72rem" }}>
              runs immediately, then every N minutes while the daemon is up (min 5)
            </p>
          )}
          <textarea
            rows={2}
            placeholder="prompt for the agent (e.g. summarize crypto news and save a report)"
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
                  setMsg("routine added");
                } else {
                  setMsg("routine rejected — check fields");
                }
              })()
            }
          >
            Add routine
          </button>
        </div>

        <div className="card">
          <h3>{t("pairedDevices", { n: devices.length })}</h3>
          {devices.map((d) => (
            <div key={d.pub} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <span style={{ flex: 1 }}>
                {d.label ?? "device"} · …{d.pub.slice(-6)} · {new Date(d.addedAt).toLocaleDateString()}
              </span>
              <button className="danger" onClick={() => void revoke(d.pub)}>
                Revoke
              </button>
            </div>
          ))}
        </div>

        <div className="card">
          <h3>Security log</h3>
          {auditEntries.length === 0 && <p className="muted" style={{ margin: 0 }}>{t("noAudit")}</p>}
          {auditEntries.map((e, i) => (
            <div key={i} className="muted" style={{ fontSize: "0.72rem", marginBottom: 4 }}>
              {new Date(e.ts).toLocaleString()} · {e.event}
              {e.data?.pub ? ` · …${String(e.data.pub).slice(-6)}` : ""}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
