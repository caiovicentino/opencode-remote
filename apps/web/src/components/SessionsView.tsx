import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import type { EventEnvelope } from "@ocr/protocol";
import type { Pairing } from "../lib/client";

interface Session {
  id: string;
  title?: string;
  updatedAt?: string | number;
}

interface Props {
  machineName: string;
  events: EventEnvelope[];
  unread: Record<string, number>;
  connStatus: string;
  machines: Pairing[];
  activeRoom?: string | null;
  onSwitch: (p: Pairing) => void;
  onForget: (p: Pairing) => void;
  onAddMachine: () => void;
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
  onOpenFiles: () => void;
  tick: number;
}

export default function SessionsView({
  machineName,
  events,
  unread,
  connStatus,
  machines,
  activeRoom,
  onSwitch,
  onForget,
  onAddMachine,
  request,
  onOpen,
  onDisconnect,
  onEnablePush,
  onOpenSettings,
  onOpenFiles,
  tick,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled">("idle");
  const [query, setQuery] = useState("");
  const [switching, setSwitching] = useState(false);

  // silent restore: a device that already granted permission never re-authorizes
  useEffect(() => {
    void (async () => {
      try {
        const { restorePush } = await import("../lib/push");
        if (await restorePush(request)) setPushState("enabled");
      } catch {}
    })();
    // run once per mount
  }, []);

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

  const [creating, setCreating] = useState(false);

  async function createSession() {
    if (creating) return;
    setCreating(true);
    setError("");
    try {
      const res = await request("POST", "/session", {});
      const created = res.body as { id?: string };
      if (res.status === 200 && created.id) {
        onOpen(created.id);
        void load();
      } else {
        setError(`create failed (${res.status}): ${JSON.stringify(res.body).slice(0, 140)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function renameSession(id: string, current?: string) {
    const title = window.prompt(t("renamePrompt"), current ?? "");
    if (!title) return;
    await request("PATCH", `/session/${id}`, { title });
    void load();
  }

  async function deleteSession(id: string) {
    if (!window.confirm(t("deleteConfirm"))) return;
    await request("DELETE", `/session/${id}`);
    void load();
  }

  const filtered = sessions.filter(
    (s) =>
      !query.trim() ||
      (s.title ?? "").toLowerCase().includes(query.toLowerCase()) ||
      s.id.toLowerCase().includes(query.toLowerCase()),
  );

  // live status per session, derived from the last relevant event of each one
  const statusOf = (() => {
    const map = new Map<string, { label: string; tone: string; snippet: string }>();
    for (const e of events.slice(-150)) {
      const sid = (e.properties as { sessionID?: string } | undefined)?.sessionID;
      if (!sid) continue;
      if (e.type === "message.part.updated") {
        const text =
          (e.properties as { part?: { text?: string; state?: { title?: string } } }).part?.text ??
          (e.properties as { part?: { state?: { title?: string } } }).part?.state?.title ??
          "";
        map.set(sid, {
          label: t("working"),
          tone: "work",
          snippet: text.replace(/\s+/g, " ").slice(0, 90),
        });
      } else if (e.type.includes("permission")) {
        map.set(sid, { label: t("waitingApproval"), tone: "wait", snippet: "" });
      } else if (e.type === "question.asked") {
        map.set(sid, { label: t("askedQuestion"), tone: "wait", snippet: "" });
      } else if (e.type === "session.error") {
        map.set(sid, { label: t("errored"), tone: "err", snippet: "" });
      } else if (e.type === "session.idle") {
        map.set(sid, { label: t("ready"), tone: "done", snippet: "" });
      }
    }
    return map;
  })();

  const toneColor: Record<string, string> = {
    work: "#3b82f6",
    wait: "#f59e0b",
    err: "var(--danger)",
    done: "#9ca3af",
  };

  return (
    <div className="screen">
      <header>
        <span
          title={`connection: ${connStatus}`}
          style={{
            width: 9,
            height: 9,
            borderRadius: 5,
            flexShrink: 0,
            display: "inline-block",
            background:
              connStatus === "paired"
                ? "#2ecc71"
                : connStatus === "connecting"
                  ? "#f1c40f"
                  : "var(--danger)",
          }}
        />
        <h1
          onClick={() => setSwitching(true)}
          style={{ fontSize: "1rem", margin: 0, cursor: "pointer" }}
          title="Switch machine"
        >
          {machineName} ⌄
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onOpenFiles} aria-label="Files">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-8.6L9.6 5.2A2 2 0 0 0 8.2 4.6H4Z" />
            </svg>
          </button>
          <button onClick={onOpenSettings} aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9 4a7.2 7.2 0 0 1-.1 1.2l2 1.6a.5.5 0 0 1 .1.7l-1.9 3.2a.5.5 0 0 1-.6.2l-2.4-1a7.6 7.6 0 0 1-2 1.2l-.4 2.5a.5.5 0 0 1-.5.4h-3.8a.5.5 0 0 1-.5-.4l-.4-2.5a7.6 7.6 0 0 1-2-1.2l-2.4 1a.5.5 0 0 1-.6-.2L1.7 15.5a.5.5 0 0 1 .1-.7l2-1.6a7.2 7.2 0 0 1 0-2.4l-2-1.6a.5.5 0 0 1-.1-.7L3.6 5.3a.5.5 0 0 1 .6-.2l2.4 1a7.6 7.6 0 0 1 2-1.2l.4-2.5a.5.5 0 0 1 .5-.4h3.8a.5.5 0 0 1 .5.4l.4 2.5a7.6 7.6 0 0 1 2 1.2l2.4-1a.5.5 0 0 1 .6.2l1.9 3.2a.5.5 0 0 1-.1.7l-2 1.6c.1.4.1.8.1 1.2Z" />
            </svg>
          </button>
          <button
            disabled={pushState !== "idle"}
            aria-label={pushState === "enabled" ? t("pushOn") : t("pushEnable")}
            title={pushState === "enabled" ? t("pushOn") : t("pushEnable")}
            style={pushState === "enabled" ? { color: "#2ecc71", borderColor: "#2ecc71" } : undefined}
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
            {pushState === "enabling" ? (
              "…"
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a7 7 0 0 0-7 7v4.2l-1.9 3.6A1 1 0 0 0 4 18.3h16a1 1 0 0 0 .9-1.5L19 13.2V9a7 7 0 0 0-7-7Zm-2 17a2 2 0 1 0 4 0h-4Z" />
              </svg>
            )}
          </button>
          <button className="danger" onClick={onDisconnect} aria-label={t("unpair")} title={t("unpair")}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              <line x1="2" y1="2" x2="22" y2="22" />
            </svg>
          </button>
        </div>
      </header>

      <div className="list">
        <input
          style={{ width: "100%", marginBottom: 8 }}
          placeholder={t("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading && <p className="muted">Loading sessions…</p>}
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        {!loading && filtered.length === 0 && <p className="muted">{t("noSessions")}</p>}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(165px, 1fr))",
            gap: 8,
          }}
        >
          {filtered.map((s) => {
            const st = statusOf.get(s.id);
            return (
              <div
                key={s.id}
                className="card session-card"
                onClick={() => onOpen(s.id)}
                style={{ cursor: "pointer", display: "flex", flexDirection: "column", gap: 4, minHeight: 84 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 4,
                      flexShrink: 0,
                      background: st ? toneColor[st.tone] : "#9ca3af",
                      opacity: st ? 1 : 0.5,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: "0.85rem", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "normal", lineHeight: 1.2 }}>
                    {s.title || s.id.slice(0, 12)}
                  </div>
                  {(unread[s.id] ?? 0) > 0 && <span className="unread-badge">{unread[s.id]}</span>}
                </div>
                <div style={{ flex: 1, fontSize: "0.75rem", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }} className="muted">
                  {st?.snippet || "\u00a0"}
                </div>
                <div style={{ fontSize: "0.72rem", color: st ? toneColor[st.tone] : "#9ca3af" }}>
                  {st?.label ?? t("ready")}
                </div>
                <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  <button aria-label="Rename" style={{ padding: "2px 8px" }} onClick={() => void renameSession(s.id, s.title)}>
                    ✎
                  </button>
                  <button className="danger" aria-label="Delete" style={{ padding: "2px 8px" }} onClick={() => void deleteSession(s.id)}>
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <button className="primary" disabled={creating} onClick={createSession}>
        {creating ? t("creating") : t("newConversation")}
      </button>

      <details className="card">
        <summary className="muted">{t("activity")} ({events.length})</summary>
        <div className="events">
          {events.slice(-30).map((e) => (
            <div key={e.id}>
              {e.type} · {JSON.stringify(e.properties)?.slice(0, 120)}
            </div>
          ))}
        </div>
      </details>

      {switching && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.94)",
            zIndex: 70,
            display: "flex",
            flexDirection: "column",
            padding: 12,
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setSwitching(false)} aria-label="Close machine picker">
              ✕
            </button>
            <div style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>{t("machines")}</div>
          </div>
          <div className="list" style={{ overflow: "auto" }}>
            {machines.map((m) => (
              <div key={m.room} className="card" style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
                <div
                  style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                  onClick={() => {
                    setSwitching(false);
                    if (m.room !== activeRoom) onSwitch(m);
                  }}
                >
                  <div>
                    {m.name ?? m.room.slice(0, 8)}
                    {m.room === activeRoom && <b> · active</b>}
                  </div>
                  <div className="muted" style={{ fontSize: "0.72rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.relay}
                  </div>
                </div>
                <button className="danger" onClick={() => onForget(m)}>
                  {t("forget")}
                </button>
              </div>
            ))}
            <button className="primary" onClick={() => { setSwitching(false); onAddMachine(); }}>
              + Pair new machine
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
