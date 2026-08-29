import { useEffect, useState } from "react";

interface Props {
  request: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
  onBack: () => void;
}

interface Device {
  pub: string;
  addedAt: string;
  label?: string;
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

export function applyTheme() {
  const theme = localStorage.getItem(THEME_KEY) ?? "dark";
  const font = localStorage.getItem(FONT_KEY) ?? "normal";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.fontSize = font === "small" ? "14px" : font === "large" ? "19px" : "16.5px";
}

export default function SettingsView({ request, onBack }: Props) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [name, setName] = useState("");
  const [notify, setNotify] = useState({ permission: true, idle: true });
  const [voice, setVoice] = useState(getVoiceSettings());
  const [style, setStyle] = useState<Record<string, unknown>>({});
  const [theme, setTheme] = useState(localStorage.getItem(THEME_KEY) ?? "dark");
  const [font, setFont] = useState(localStorage.getItem(FONT_KEY) ?? "normal");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    void (async () => {
      const d = await request("GET", "/__ocr/devices");
      if (d.status === 200) setDevices((d.body as { devices?: Device[] }).devices ?? []);
      const s = await request("GET", "/__ocr/settings");
      if (s.status === 200) {
        setName((s.body as { name?: string }).name ?? "");
        setNotify((s.body as { notify?: { permission: boolean; idle: boolean } }).notify ?? { permission: true, idle: true });
      }
      const cs = await request("GET", "/__ocr/clip-style");
      if (cs.status === 200) setStyle((cs.body as Record<string, unknown>) ?? {});
    })();
  }, []);

  async function saveSettings(patch: { name?: string; notify?: { permission?: boolean; idle?: boolean } }) {
    const res = await request("PATCH", "/__ocr/settings", patch);
    if (res.status === 200) setMsg("saved");
  }

  function saveVoice(v: { autoSend: boolean; lang: string }) {
    setVoice(v);
    localStorage.setItem(VOICE_KEY, JSON.stringify(v));
  }

  function saveTheme(t: string, f: string) {
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

        <div className="card">
          <h3>Machine</h3>
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
            Permission requests
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
            Agent finished
          </label>
        </div>

        <div className="card">
          <h3>Voice</h3>
          <label style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={voice.autoSend}
              onChange={(e) => saveVoice({ ...voice, autoSend: e.target.checked })}
            />{" "}
            Auto-send after transcription
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
            <select value={theme} onChange={(e) => saveTheme(e.target.value, font)}>
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
          <h3>Paired devices ({devices.length})</h3>
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
      </div>
    </div>
  );
}
