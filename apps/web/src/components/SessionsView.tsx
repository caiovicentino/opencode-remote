import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { timeAgo, sessionUpdatedTs } from "../lib/time";
import { groupByRecency } from "../lib/recency";
import { loadArchived, saveArchived, toggleArchived } from "../lib/archive";
import type { EventEnvelope } from "@ocr/protocol";
import type { Pairing } from "../lib/client";
import { applySessionFilters, splitPilotSessions, type BadgeFilter } from "../lib/sessionFilter";
import { dropCachedSession } from "../lib/sessionCache";
import { IconArchive, IconCheck, IconChevronDown, IconFilter, IconPencil, IconUndo, IconX } from "./icons";
import MachinePicker from "./MachinePicker";

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
  /** P3-084: currently open conversation — drives the sharp active row. */
  activeSession?: string | null;
  /** P2-220: one-line iOS install hint (null/absent hides the banner). */
  installHint?: string | null;
  /** P2-220: persists the dismissal under its own localStorage key. */
  onDismissInstallHint?: () => void;
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
      {/* P2-124: SVG chevron instead of the "▾" glyph (no emoji-as-icons) */}
      <IconChevronDown
        size={12}
        aria-hidden
        style={{
          transform: open ? "rotate(180deg)" : undefined,
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      {label}
    </button>
  );
}

/** P3-084: temporal group header (Hoje/Ontem/Anteriores) — locale-proof hook
 * via data-group for the desktop-flow gate. Hidden when the bucket is empty. */
function GroupHead({ group, label }: { group: string; label: string }) {
  return (
    <div className="sess-group-head" data-group={group}>
      {label}
    </div>
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
  activeSession = null,
  installHint = null,
  onDismissInstallHint,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pushState, setPushState] = useState<"idle" | "enabling" | "enabled">("idle");
  const [query, setQuery] = useState("");
  const [badgeFilter, setBadgeFilter] = useState<BadgeFilter>("all");
  // P2-108: badge filters live in a menu attached to the search instead of a
  // chip row — less chrome above the list, one affordance to filter.
  const [filterOpen, setFilterOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [pilotOpen, setPilotOpen] = useState(false);
  // P3-084: client-side archive (this device's localStorage, reversible)
  const [archivedIds, setArchivedIds] = useState<string[]>(() => loadArchived());
  const [archivedOpen, setArchivedOpen] = useState(false);

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

  // P3-084: archive/restore — local-only, no server flag to call
  function archiveConversation(id: string) {
    const next = toggleArchived(archivedIds, id, true);
    setArchivedIds(next);
    saveArchived(next);
  }

  function restoreConversation(id: string) {
    const next = toggleArchived(archivedIds, id, false);
    setArchivedIds(next);
    saveArchived(next);
  }

  const filtered = applySessionFilters(sessions, unread, query, badgeFilter);

  // most recently touched first when the API gives us timestamps
  const sorted = filtered.sort((a, b) => sessionUpdatedTs(b) - sessionUpdatedTs(a));

  // P3-084: archived conversations leave the main list (both variants) and
  // live in their own collapsed group at the end
  const archivedSet = new Set(archivedIds);
  const archivedSessions = sorted.filter((s) => archivedSet.has(s.id));
  const live = sorted.filter((s) => !archivedSet.has(s.id));

  // P1-064: autonomous-pilot sessions collapse into their own group at the
  // end of the list so the user's conversations stay on top
  const { user: userSessions, pilot: pilotSessions } = splitPilotSessions(live);

  // P3-084: temporal buckets (Hoje/Ontem/Anteriores), local-midnight bounded
  const groups = groupByRecency((s) => sessionUpdatedTs(s), userSessions);

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

  function renderRow(s: Session, archived = false) {
    const st = statusOf.get(s.id);
    const when = timeAgo(s.updatedAt ?? s.time?.updated, t("justNow"));
    const n = archived ? 0 : (unread[s.id] ?? 0);
    const label = s.title || s.id.slice(0, 12);
    return (
      <div
        key={s.id}
        className={`sess-row${!archived && s.id === activeSession ? " active" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-current={!archived && s.id === activeSession ? "true" : undefined}
        title={label}
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
        <span className="sess-title">{label}</span>
        {n > 0 && <span className="unread-badge">{n}</span>}
        {when && <span className="sess-when">{when}</span>}
        {/* P3-084: hover-revealed actions (rename / archive|restore) */}
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          {archived ? (
            <button
              className="row-restore"
              aria-label={t("restore")}
              title={t("restore")}
              onClick={() => restoreConversation(s.id)}
            >
              <IconUndo size={14} />
            </button>
          ) : (
            <>
              <button
                className="row-rename"
                aria-label={t("rename")}
                title={t("rename")}
                onClick={() => void renameSession(s.id, s.title)}
              >
                <IconPencil size={14} />
              </button>
              <button
                className="row-archive"
                aria-label={t("archive")}
                title={t("archive")}
                onClick={() => archiveConversation(s.id)}
              >
                <IconArchive size={14} />
              </button>
            </>
          )}
        </span>
      </div>
    );
  }

  function renderCard(s: Session, archived = false) {
    const st = archived ? undefined : statusOf.get(s.id);
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
        {!archived && (
          <div className="session-meta" style={{ color: st ? toneColor[st.tone] : "var(--status-done)" }}>
            {st?.label ?? t("ready")}
          </div>
        )}
        <div className="session-actions" onClick={(e) => e.stopPropagation()}>
          <button aria-label={t("rename")} title={t("rename")} style={{ padding: "2px 8px" }} onClick={() => void renameSession(s.id, s.title)}>
            <IconPencil size={14} />
          </button>
          {archived ? (
            <button aria-label={t("restore")} title={t("restore")} style={{ padding: "2px 8px" }} onClick={() => restoreConversation(s.id)}>
              <IconUndo size={14} />
            </button>
          ) : (
            <button className="danger" aria-label={t("delete")} title={t("delete")} style={{ padding: "2px 8px" }} onClick={() => void deleteSession(s.id)}>
              <IconX size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      {/* P2-124: the desktop sidebar carries its own chrome (App-level "+ New"
          + section nav above, account footer below) — no mobile header here. */}
      {/* P2-108: the mobile chrome is demoted to a quiet overline — machine
          name reads as a 0.72rem label, actions stay reachable as ghost
          icons. */}
      {variant !== "rows" && (
      <header className="sess-mobile-head">
        <button
          className="sess-machine-overline"
          onClick={() => setSwitching(true)}
          title={t("accountSwitch")}
          aria-label={t("accountSwitch")}
        >
          <span
            title={`connection: ${connStatus}`}
            className={`status-dot${
              connStatus === "paired" ? " ok" : connStatus === "connecting" ? " wait" : " err"
            }`}
          />
          <span className="sess-overline">{machineName}</span>
          <IconChevronDown size={10} aria-hidden style={{ display: "inline-block" }} />
        </button>
        <div className="sess-head-actions">
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
      )}

      <div className="list">
        {/* P2-220: calm iOS install hint, in the P2-112 card vocabulary. It
            fails OPEN on purpose: normal document flow at the top of the list
            — never position:fixed/sticky, never covering the message field,
            never blocking send, never disabling or hiding any control. If the
            detection is wrong somewhere, the cost is one quiet line, not a
            lost pairing. */}
        {installHint && (
          <div className="install-hint" role="note" data-install-hint>
            <span className="install-hint-body">{installHint}</span>
            <button
              className="install-hint-dismiss"
              onClick={onDismissInstallHint}
              aria-label={t("installHintDismiss")}
            >
              {t("installHintDismiss")}
            </button>
          </div>
        )}
        {/* P2-108: badge filters folded into a search-attached menu (was a
            chip row); locale-independent hooks for the gate: data-filter. */}
        <div className="sess-search-row">
          <input
            placeholder={t("search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className="sess-filter-btn"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            aria-label={t("filterTitle")}
            title={t("filterTitle")}
            onClick={() => setFilterOpen((v) => !v)}
          >
            <IconFilter size={14} />
            {badgeFilter !== "all" && <span className="sess-filter-dot" aria-hidden />}
          </button>
          {filterOpen && (
            <>
              <div className="sess-menu-scrim" onClick={() => setFilterOpen(false)} aria-hidden />
              <div className="sess-filter-menu" role="menu">
                {(["all", "with", "without"] as BadgeFilter[]).map((f) => (
                  <button
                    key={f}
                    role="menuitemradio"
                    aria-checked={badgeFilter === f}
                    data-filter={f}
                    className="sess-filter-item"
                    onClick={() => {
                      setBadgeFilter(f);
                      setFilterOpen(false);
                    }}
                  >
                    <span className="sess-filter-check" aria-hidden>
                      {badgeFilter === f && <IconCheck size={12} />}
                    </span>
                    {f === "all" ? t("filterAll") : f === "with" ? t("filterWithBadge") : t("filterNoBadge")}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
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
            {groups.today.length > 0 && <GroupHead group="today" label={t("groupToday")} />}
            {groups.today.map((s) => renderRow(s))}
            {groups.yesterday.length > 0 && <GroupHead group="yesterday" label={t("groupYesterday")} />}
            {groups.yesterday.map((s) => renderRow(s))}
            {groups.earlier.length > 0 && <GroupHead group="earlier" label={t("groupEarlier")} />}
            {groups.earlier.map((s) => renderRow(s))}
            {pilotSessions.length > 0 && (
              <PilotGroup
                open={pilotOpen}
                onToggle={() => setPilotOpen((v) => !v)}
                label={t("pilotGroup", { n: pilotSessions.length })}
              />
            )}
            {pilotOpen && pilotSessions.map((s) => renderRow(s))}
            {archivedSessions.length > 0 && (
              <button
                className="chip"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((v) => !v)}
                style={{
                  gridColumn: "1 / -1",
                  margin: "4px 0 2px",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  width: "fit-content",
                }}
              >
                <IconChevronDown
                  size={12}
                  aria-hidden
                  style={{
                    transform: archivedOpen ? "rotate(180deg)" : undefined,
                    display: "inline-block",
                    flexShrink: 0,
                  }}
                />
                {t("groupArchived", { n: archivedSessions.length })}
              </button>
            )}
            {archivedOpen && archivedSessions.map((s) => renderRow(s, true))}
          </div>
        )}
        {variant !== "rows" && (
        <div className="session-grid">
            {userSessions.map((s) => renderCard(s))}
            {pilotSessions.length > 0 && (
              <PilotGroup
                open={pilotOpen}
                onToggle={() => setPilotOpen((v) => !v)}
                label={t("pilotGroup", { n: pilotSessions.length })}
              />
            )}
            {pilotOpen && pilotSessions.map((s) => renderCard(s))}
            {archivedSessions.length > 0 && (
              <button
                className="chip"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((v) => !v)}
                style={{ gridColumn: "1 / -1", width: "fit-content" }}
              >
                <span aria-hidden style={{ fontSize: "0.7rem", display: "inline-flex" }}>
                  <IconChevronDown
                    size={12}
                    style={{ transform: archivedOpen ? "rotate(180deg)" : undefined }}
                  />
                </span>
                {t("groupArchived", { n: archivedSessions.length })}
              </button>
            )}
            {archivedOpen && archivedSessions.map((s) => renderCard(s, true))}
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
        <MachinePicker
          machines={machines}
          activeRoom={activeRoom}
          onSwitch={onSwitch}
          onForget={onForget}
          onAddMachine={onAddMachine}
          onClose={() => setSwitching(false)}
        />
      )}
    </div>
  );
}
