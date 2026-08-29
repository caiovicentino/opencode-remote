import { useEffect, useRef, useState } from "react";
import type { EventEnvelope } from "@ocr/protocol";

interface Props {
  sessionId: string;
  events: EventEnvelope[];
  request: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
  onBack: () => void;
}

interface Bubble {
  role: "user" | "assistant";
  text: string;
}

interface PermissionAsk {
  permissionID: string;
  label: string;
}

function extractPermission(
  evt: EventEnvelope,
  sessionId: string,
): PermissionAsk | null {
  if (!evt.type.toLowerCase().includes("permission")) return null;
  const p = evt.properties as {
    sessionID?: string;
    id?: string;
    permissionID?: string;
    type?: string;
  };
  const id = p?.permissionID ?? p?.id;
  if (p?.sessionID && id && p.sessionID === sessionId) {
    return { permissionID: id, label: p.type ?? "action" };
  }
  return null;
}

export default function ChatView({ sessionId, events, request, onBack }: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", `/session/${sessionId}/message`);
        if (res.status !== 200) throw new Error(`GET messages -> ${res.status}`);
        const rows = (res.body as { info: { role?: string }; parts: { type: string; text?: string }[] }[]) ?? [];
        const out: Bubble[] = [];
        for (const row of rows) {
          const text = row.parts
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("\n");
          if (text) out.push({ role: row.info.role === "user" ? "user" : "assistant", text });
        }
        setBubbles(out);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [bubbles, sending]);

  // stream: rebuild the tail of the conversation from live part events
  const [liveText, setLiveText] = useState("");
  useEffect(() => {
    for (const evt of events) {
      const p = evt.properties as {
        sessionID?: string;
        part?: { type?: string; text?: string };
        type?: string;
      };
      if (p?.sessionID === sessionId && p.part?.type === "text" && p.part.text) {
        setLiveText(p.part.text);
      }
    }
  }, [events, sessionId]);

  const pending: PermissionAsk[] = [];
  for (const evt of events.slice(-50)) {
    const ask = extractPermission(evt, sessionId);
    if (ask) pending.push(ask);
  }

  async function respond(permissionID: string, response: "approve" | "reject") {
    await request("POST", `/session/${sessionId}/permissions/${permissionID}`, {
      response,
    });
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    setInput("");
    setBubbles((b) => [...b, { role: "user", text }]);
    try {
      const res = await request("POST", `/session/${sessionId}/message`, {
        parts: [{ type: "text", text }],
      });
      if (res.status !== 200) {
        setError(`opencode responded ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      } else {
        setLiveText("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="screen">
      <header>
        <button onClick={onBack}>←</button>
        <h1 style={{ fontSize: "0.9rem", margin: 0, flex: 1 }}>session</h1>
      </header>

      <div className="chat">
        <div className="messages">
          {bubbles.map((b, i) => (
            <div key={i} className={`msg ${b.role}`}>
              {b.text}
            </div>
          ))}
          {liveText && <div className="msg assistant">{liveText}▍</div>}
          {sending && <div className="muted">agent is working…</div>}
          <div ref={bottomRef} />
        </div>

        {pending.length > 0 && (
          <div className="card">
            {pending.map((p) => (
              <div key={p.permissionID} className="approval" style={{ marginBottom: 8 }}>
                <span style={{ flex: 1 }}>
                  Approve <b>{p.label}</b>?
                </span>
                <button className="primary" onClick={() => void respond(p.permissionID, "approve")}>
                  Approve
                </button>
                <button className="danger" onClick={() => void respond(p.permissionID, "reject")}>
                  Deny
                </button>
              </div>
            ))}
          </div>
        )}

        {error && <p style={{ color: "var(--danger)", margin: 0 }}>{error}</p>}

        <div className="composer">
          <textarea
            rows={1}
            placeholder="Message the agent…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="primary" onClick={() => void send()} disabled={sending}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
