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
  onOpenSettings: () => void;
  tick: number;
}

export default function SessionsView({
  machineName,
  events,
  request,
  onOpen,
  onDisconnect,
  onEnablePush,
  onOpenSettings,
  tick,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled">("idle");
  const [query, setQuery] = useState("");

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

  async function renameSession(id: string, current?: string) {
    const title = window.prompt("New name:", current ?? "");
    if (!title) return;
    await request("PATCH", `/session/${id}`, { title });
    void load();
  }

  async function deleteSession(id: string) {
    if (!window.confirm("Delete this session?")) return;
    await request("DELETE", `/session/${id}`);
    void load();
  }

  const filtered = sessions.filter(
    (s) =>
      !query.trim() ||
      (s.title ?? "").toLowerCase().includes(query.toLowerCase()) ||
      s.id.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="screen">
      <header>
        <h1 style={{ fontSize: "1rem", margin: 0 }}>{machineName}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onOpenSettings} aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4a7.2 7.2 0 0 1-.1 1.2l2 1.6a.5.5 0 0 1 .1.7l-1.9 3.2a.5.5 0 0 1-.6.2l-2.4-1a7.6 7.6 0 0 1-2 1.2l-.4 2.5a.5.5 0 0 1-.5.4h-3.8a.5.5 0 0 1-.5-.4l-.4-2.5a7.6 7.6 0 0 1-2-1.2l-2.4 1a.5.5 0 0 1-.6-.2L1.7 15.5a.5.5 0 0 1 .1-.7l2-1.6a7.2 7.2 0 0 1 0-2.4l-2-1.6a.5.5 0 0 1-.1-.7L3.6 5.3a.5.5 0 0 1 .6-.2l2.4 1a7.6 7.6 0 0 1 2-1.2l.4-2.5a.5.5 0 0 1 .5-.4h3.8a.5.5 0 0 1 .5.4l.4 2.5a7.6 7.6 0 0 1 2 1.2l2.4-1a.5.5 0 0 1 .6.2l1.9 3.2a.5.5 0 0 1-.1.7l-2 1.6c.1.4.1.8.1 1.2Z" />
            </svg>
          </button>
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
        <input
          style={{ width: "100%", marginBottom: 8 }}
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading && <p className="muted">Loading sessions…</p>}
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {!loading && filtered.length === 0 && <p className="muted">No sessions yet.</p>}
        {filtered.map((s) => (
          <div key={s.id} className="card session-card">
            <div onClick={() => onOpen(s.id)} style={{ flex: 1 }}>
              <h3>{s.title || s.id.slice(0, 12)}</h3>
              {s.updatedAt && <span className="muted">{String(s.updatedAt)}</span>}
            </div>
            <button aria-label="Rename" onClick={() => void renameSession(s.id, s.title)}>
              ✎
            </button>
            <button className="danger" aria-label="Delete" onClick={() => void deleteSession(s.id)}>
              ✕
            </button>
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
