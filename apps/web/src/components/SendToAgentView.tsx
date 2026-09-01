import { useEffect, useState } from "react";
import type { OcrRequest } from "../lib/files";

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
  request: OcrRequest;
  payload: Payload;
  onBack: () => void;
  onOpenSession: (id: string) => void;
}) {
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
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  async function send(sessionId: string, fresh = false) {
    if (busy) return;
    setBusy(sessionId);
    setError("");
    try {
      if (fresh) {
        const created = await request("POST", "/session", { title: "Shared from phone" });
        sessionId = (created.body as { id?: string }).id ?? sessionId;
      }
      const res = await request("POST", `/session/${sessionId}/message`, {
        parts: [{ type: "text", text: composeMessage(payload, extra) }],
      });
      if (res.status !== 200) {
        throw new Error(`send failed (${res.status}): ${JSON.stringify(res.body).slice(0, 140)}`);
      }
      onOpenSession(sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 style={{ fontSize: "1rem", margin: 0, flex: 1 }}>Send to agent</h1>
      </header>
      <div className="list">
        <div className="card">
          <p className="muted" style={{ margin: "0 0 6px" }}>Shared content</p>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: "0.8rem" }}>
            {payload.title && <div style={{ fontWeight: 600 }}>{payload.title}</div>}
            {payload.url && (
              <div className="muted" style={{ wordBreak: "break-all" }}>
                {payload.url}
              </div>
            )}
            {payload.text && <div style={{ marginTop: 4 }}>{payload.text.slice(0, 400)}</div>}
            {!payload.title && !payload.url && !payload.text && <div>(empty)</div>}
          </div>
        </div>
        <textarea
          rows={3}
          placeholder="Optional: instructions for the agent (e.g. 'resume this in portuguese')"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        />
        <button className="primary" onClick={() => void send(crypto.randomUUID(), true)}>
          + New session & send
        </button>
        <p className="muted" style={{ margin: 0 }}>…or send to an existing session:</p>
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
            {busy === s.id && <span className="muted">sending…</span>}
          </div>
        ))}
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      </div>
    </div>
  );
}
