import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { timeAgo, sessionUpdatedTs } from "../lib/time";
import type { EventEnvelope } from "@ocr/protocol";
import type { Pairing } from "../lib/client";
import { applySessionFilters, splitPilotSessions, type BadgeFilter } from "../lib/sessionFilter";
import { dropCachedSession } from "../lib/sessionCache";

interface Session {
  id: string;
  title?: string;
  updatedAt?: string | number;
  time?: { created?: string; updated?: string };
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
  /** P1-046: creation lifted to App so Cmd+T/Cmd+K reuse the same path. */
  creating: boolean;
  onCreateSession: () => Promise<string | null>;
  /** "grid" (mobile cards) | "rows" (desktop flat Claude-style list) */
  variant?: "grid" | "rows";
}

/** P1-064: collapsed header for autonomous-pilot sessions, pinned to the end
 * of the list. Same chip vocabulary as the filter row — no extra chrome. */
function PilotGroup({
  open,
  onToggle,
  label,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      className="chip"
      aria-expanded={open}
      onClick={onToggle}
      style={{
        gridColumn: "1 / -1",
        margin: "4px 0 2px",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        width: "fit-content",
      }}
    >
      <span aria-hidden style={{ fontSize: "0.7rem", transform: open ? "rotate(180deg)" : undefined, display: "inline-block" }}>
        ▾
      </span>
      {label}
    </button>
  );
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
  creating,
  onCreateSession,
  variant = "grid",
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled">("idle");
  const [query, setQuery] = useState("");
  const [badgeFilter, setBadgeFilter] = useState<BadgeFilter>("all");
  const [switching, setSwitching] = useState(false);
  const [pilotOpen, setPilotOpen] = useState(false);

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

  async function createSession() {
    const err = await onCreateSession();
    if (err) setError(err);
  }

  async function renameSession(id: string, current?: string) {
    const title = window.prompt(t("renamePrompt"), current ?? "");
    if (!title) return;
    await request("PATCH", `/session/${id}`, { title });
    void load();
  }

  async function deleteSession(id: string) {
    if (!window.confirm(t("deleteConfirm"))) return;
    const res = await request("DELETE", `/session/${id}`);
    // P1-064: a deleted conversation must not linger in the warm cache
    if (res.status === 200) dropCachedSession(id);
    void load();
  }

  const filtered = applySessionFilters(sessions, unread, query, badgeFilter);

  // most recently touched first when the API gives us timestamps
  const sorted = filtered.sort((a, b) => sessionUpdatedTs(b) - sessionUpdatedTs(a));

  // P1-064: autonomous-pilot sessions collapse into their own group at the
  // end of the list so the user's conversations stay on top
  const { user: userSessions, pilot: pilotSessions } = splitPilotSessions(sorted);

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
    work: "var(--status-work)",
    wait: "var(--status-wait)",
    err: "var(--status-err)",
    done: "var(--status-done)",
  };

  function renderRow(s: Session) {
    const st = statusOf.get(s.id);
    const when = timeAgo(s.updatedAt ?? s.time?.updated, t("justNow"));
    const n = unread[s.id] ?? 0;
    return (
      <div
        key={s.id}
        className="sess-row"
        role="button"
        tabIndex={0}
        aria-label={s.title || s.id.slice(0, 12)}
        onClick={() => onOpen(s.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(s.id);
          }
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            flexShrink: 0,
            background: st ? toneColor[st.tone] : "var(--status-done)",
            opacity: st ? 1 : 0.5,
          }}
        />
        <span className="sess-title">{s.title || s.id.slice(0, 12)}</span>
        {n > 0 && <span className="unread-badge">{n}</span>}
        {when && <span className="sess-when">{when}</span>}
      </div>
    );
  }

  function renderCard(s: Session) {
    const st = statusOf.get(s.id);
    const when = timeAgo(s.updatedAt ?? s.time?.updated, t("justNow"));
    return (
      <div
        key={s.id}
        className="card session-card"
        role="button"
        tabIndex={0}
        aria-label={s.title || s.id.slice(0, 12)}
        onClick={() => onOpen(s.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(s.id);
          }
        }}
        style={{ cursor: "pointer" }}
      >
        <div className="session-head">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              flexShrink: 0,
              background: st ? toneColor[st.tone] : "var(--status-done)",
              opacity: st ? 1 : 0.5,
            }}
          />
          <div className="session-title">{s.title || s.id.slice(0, 12)}</div>
          {(unread[s.id] ?? 0) > 0 && <span className="unread-badge">{unread[s.id]}</span>}
          {when && <span className="session-when">{when}</span>}
        </div>
        <div className="session-snippet">{st?.snippet || "\u00a0"}</div>
        <div className="session-meta" style={{ color: st ? toneColor[st.tone] : "var(--status-done)" }}>
          {st?.label ?? t("ready")}
        </div>
        <div className="session-actions" onClick={(e) => e.stopPropagation()}>
          <button aria-label={t("rename")} title={t("rename")} style={{ padding: "2px 8px" }} onClick={() => void renameSession(s.id, s.title)}>
            ✎
          </button>
          <button className="danger" aria-label={t("delete")} title={t("delete")} style={{ padding: "2px 8px" }} onClick={() => void deleteSession(s.id)}>
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <header>
        <span
          title={`connection: ${connStatus}`}
          className={`status-dot${
            connStatus === "paired" ? " ok" : connStatus === "connecting" ? " wait" : " err"
          }`}
        />
        <h1
          onClick={() => setSwitching(true)}
          style={{ fontSize: "1rem", margin: 0, cursor: "pointer" }}
          title="Switch machine"
        >
          {machineName} ⌄
        </h1>
        <div style={{ display: variant === "rows" ? "none" : "flex", gap: 8 }}>
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
            style={pushState === "enabled" ? { color: "var(--status-ok)", borderColor: "var(--status-ok)" } : undefined}
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
        {variant === "rows" && (
          <button className="primary sess-new" disabled={creating} onClick={createSession}>
            {creating ? t("creating") : t("newConversation")}
          </button>
        )}
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          {(["all", "with", "without"] as BadgeFilter[]).map((f) => (
            <button
              key={f}
              className="chip"
              aria-pressed={badgeFilter === f}
              onClick={() => setBadgeFilter(f)}
            >
              {f === "all" ? t("filterAll") : f === "with" ? t("filterWithBadge") : t("filterNoBadge")}
            </button>
          ))}
        </div>
        <input
          style={{ width: "100%", marginBottom: 8 }}
          placeholder={t("search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading && (
          <div className="session-grid">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skel" style={{ height: 72 }} />
            ))}
          </div>
        )}
        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <p style={{ color: "var(--danger)", margin: 0, flex: 1 }}>{humanizeError(error, t)}</p>
            <button style={{ padding: "6px 10px", flexShrink: 0 }} onClick={() => void load()}>
              {t("retry")}
            </button>
          </div>
        )}
        {!loading && filtered.length === 0 && <p className="muted">{t("noSessions")}</p>}
        {variant === "rows" && (
          <div className="sess-rows">
            {userSessions.map(renderRow)}
            {pilotSessions.length > 0 && (
              <PilotGroup
                open={pilotOpen}
                onToggle={() => setPilotOpen((v) => !v)}
                label={t("pilotGroup", { n: pilotSessions.length })}
              />
            )}
            {pilotOpen && pilotSessions.map(renderRow)}
          </div>
        )}
        {variant !== "rows" && (
        <div className="session-grid">
            {userSessions.map(renderCard)}
            {pilotSessions.length > 0 && (
              <PilotGroup
                open={pilotOpen}
                onToggle={() => setPilotOpen((v) => !v)}
                label={t("pilotGroup", { n: pilotSessions.length })}
              />
            )}
            {pilotOpen && pilotSessions.map(renderCard)}
        </div>
        )}
      </div>

      <button className="primary" style={variant === "rows" ? { display: "none" } : undefined} disabled={creating} onClick={createSession}>
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
            background: "var(--scrim)",
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
