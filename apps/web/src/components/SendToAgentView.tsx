import { useEffect, useState } from "react";
import type { OcrRequest } from "../lib/files";

/** eval-10: the shared OcrRequest plus the op timeout App's request accepts */
type ShareRequest = (...args: [...Parameters<OcrRequest>, timeoutMs?: number]) => ReturnType<OcrRequest>;
// P3-452: header actions speak the shared SVG icon language (like the rail);
// the icon-only back button needs its accessible name from the dict.
import { useT } from "../lib/i18n";
import { SEND_TIMEOUT_MS } from "../lib/sendfail";
import { IconArrowLeft } from "./icons";

interface Payload {
  title?: string;
  text?: string;
  url?: string;
}

function composeMessage(p: Payload, extra: string): string {
  const lines: string[] = [];
  const shared = [p.title, p.url, p.text].filter(Boolean).join("\n");
  if (shared) lines.push(shared);
  if (extra.trim()) lines.push("", extra.trim());
  lines.push("— compartilhado do iPhone via opencode-remote");
  return lines.join("\n");
}

export default function SendToAgentView({
  request,
  payload,
  onBack,
  onOpenSession,
}: {
  request: ShareRequest;
  payload: Payload;
  onBack: () => void;
  onOpenSession: (id: string) => void;
}) {
  const t = useT();
  const [sessions, setSessions] = useState<{ id: string; title?: string }[]>([]);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", "/session");
        const list = (Array.isArray(res.body) ? res.body : []) as {
          id: string;
          title?: string;
          updatedAt?: string;
        }[];
        list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
        setSessions(list.slice(0, 8));
      } catch {
        setError(t("shareListFailed"));
      }
    })();
  }, []);

  async function send(sessionId: string, fresh = false) {
    if (busy) return;
    setBusy(sessionId);
    setError("");
    try {
      if (fresh) {
        const created = await request("POST", "/session", { title: t("shareSessionTitle") });
        sessionId = (created.body as { id?: string }).id ?? sessionId;
      }
      // eval-10: the daemon answers the prompt op only when the agent's turn
      // ends — the default 60 s op timeout turned any longer turn into an
      // error here (and a second tap into a duplicate prompt)
      const res = await request(
        "POST",
        `/session/${sessionId}/message`,
        { parts: [{ type: "text", text: composeMessage(payload, extra) }] },
        undefined,
        SEND_TIMEOUT_MS,
      );
      if (res.status !== 200) throw new Error(String(res.status));
      onOpenSession(sessionId);
    } catch {
      setError(t("shareSendFailed")); // eval-10: localized, never the raw body
      setBusy(null);
    }
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack} aria-label={t("back")}><IconArrowLeft /></button>
        <h1 className="pane-title">{t("shareTitle")}</h1>
      </header>
      <div className="list">
        <div className="card">
          <p className="muted" style={{ margin: "0 0 6px" }}>{t("shareContent")}</p>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.8rem" }}>
            {payload.title && <div style={{ fontWeight: 600 }}>{payload.title}</div>}
            {payload.url && (
              <div className="muted" style={{ wordBreak: "break-all" }}>
                {payload.url}
              </div>
            )}
            {payload.text && <div style={{ marginTop: 4 }}>{payload.text.slice(0, 400)}</div>}
            {!payload.title && !payload.url && !payload.text && <div>{t("shareEmpty")}</div>}
          </div>
        </div>
        <textarea
          rows={3}
          placeholder={t("shareExtraPlaceholder")}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        />
        <button className="primary" onClick={() => void send(crypto.randomUUID(), true)}>
          {t("shareNewSession")}
        </button>
        <p className="muted" style={{ margin: 0 }}>{t("shareOrExisting")}</p>
        {sessions.map((s) => (
          <div
            key={s.id}
            className="card"
            style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px", cursor: "pointer" }}
            onClick={() => void send(s.id)}
          >
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.title || s.id.slice(0, 12)}
            </span>
            {busy === s.id && <span className="muted">{t("shareSending")}</span>}
          </div>
        ))}
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
    </div>
  );
}
