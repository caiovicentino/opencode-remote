import { useEffect, useState } from "react";
import type { EventEnvelope } from "@ocr/protocol";

interface Session {
  id: string;
  title?: string;
  updatedAt?: string | number;
}

interface Props {
  machineName: string;
  events: EventEnvelope[];
  request: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
  onOpen: (sessionId: string) => void;
  onDisconnect: () => void;
  onEnablePush: () => Promise<void>;
  tick: number;
}

export default function SessionsView({
  machineName,
  events,
  request,
  onOpen,
  onDisconnect,
  onEnablePush,
  tick,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled">("idle");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const res = await request("GET", "/session");
      if (res.status !== 200) throw new Error(`GET /session -> ${res.status}`);
      setSessions((res.body as Session[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [tick]);

  async function createSession() {
    const res = await request("POST", "/session", { title: "Remote session" });
    if (res.status === 200) void load();
  }

  return (
    <div className="screen">
      <header>
        <h1 style={{ fontSize: "1rem", margin: 0 }}>{machineName}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            disabled={pushState !== "idle"}
            onClick={async () => {
              setPushState("enabling");
              try {
                await onEnablePush();
                setPushState("enabled");
              } catch {
                setPushState("idle");
              }
            }}
          >
            {pushState === "enabled" ? "Push ✓" : pushState === "enabling" ? "…" : "Enable push"}
          </button>
          <button className="danger" onClick={onDisconnect}>
            Unpair
          </button>
        </div>
      </header>

      <div className="list">
        {loading && <p className="muted">Loading sessions…</p>}
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {!loading && sessions.length === 0 && (
          <p className="muted">No sessions yet.</p>
        )}
        {sessions.map((s) => (
          <div key={s.id} className="card session-card" onClick={() => onOpen(s.id)}>
            <h3>{s.title || s.id.slice(0, 12)}</h3>
            {s.updatedAt && <span className="muted">{String(s.updatedAt)}</span>}
          </div>
        ))}
      </div>

      <button className="primary" onClick={createSession}>
        New session
      </button>

      <details className="card">
        <summary className="muted">Activity ({events.length})</summary>
        <div className="events">
          {events.slice(-30).map((e) => (
            <div key={e.id}>
              {e.type} · {JSON.stringify(e.properties)?.slice(0, 120)}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
