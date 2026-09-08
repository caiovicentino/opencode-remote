import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { timeAgo, sessionUpdatedTs } from "../lib/time";
import { groupByRecency } from "../lib/recency";
import { loadArchived, saveArchived, toggleArchived } from "../lib/archive";
import type { EventEnvelope } from "@ocr/protocol";
import { applySessionFilters, splitPilotSessions, type BadgeFilter } from "../lib/sessionFilter";
import { dropCachedSession } from "../lib/sessionCache";
import { buildAskDialog, type AskIntent } from "../lib/askdialog";
import { IconArchive, IconCheck, IconChevronDown, IconFilter, IconMore, IconPencil, IconPlus, IconUndo, IconX } from "./icons";
import AskDialog from "./AskDialog";

interface Session {
  id: string;
  title?: string;
  updatedAt?: string | number;
  time?: { created?: string; updated?: string };
}

interface Props {
  events: EventEnvelope[];
  unread: Record<string, number>;
  request: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ) => Promise<{ status: number; body: unknown }>;
  onOpen: (sessionId: string) => void;
  tick: number;
  /** P1-046: creation lifted to App so Cmd+T/Cmd+K reuse the same path. */
  creating: boolean;
  onCreateSession: () => Promise<string | null>;
  /** "list" (Bug 2: mobile 56px rows + kebab + fixed "+ Nova conversa" pill)
   * | "rows" (desktop flat Claude-style list) */
  variant?: "list" | "rows";
  /** P3-084: currently open conversation — drives the sharp active row. */
  activeSession?: string | null;
  /** P2-220: one-line iOS install hint (null/absent hides the banner). */
  installHint?: string | null;
  /** P2-220: persists the dismissal under its own localStorage key. */
  onDismissInstallHint?: () => void;
}

/** Long-press on a mobile row opens the same action sheet as the kebab. */
const LONG_PRESS_MS = 500;

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
  events,
  unread,
  request,
  onOpen,
  tick,
  creating,
  onCreateSession,
  variant = "list",
  activeSession = null,
  installHint = null,
  onDismissInstallHint,
}: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [badgeFilter, setBadgeFilter] = useState<BadgeFilter>("all");
  // P2-108: badge filters live in a menu attached to the search instead of a
  // chip row — less chrome above the list, one affordance to filter.
  const [filterOpen, setFilterOpen] = useState(false);
  const [pilotOpen, setPilotOpen] = useState(false);
  // P3-084: client-side archive (this device's localStorage, reversible)
  const [archivedIds, setArchivedIds] = useState<string[]>(() => loadArchived());
  const [archivedOpen, setArchivedOpen] = useState(false);
  // P2-323: the in-app confirmation dialog (rename/delete) replaces the
  // native window.prompt/window.confirm the desktop shell never implemented
  const [ask, setAsk] = useState<{ intent: AskIntent; id: string; current: string } | null>(null);
  // Bug 2: per-row action sheet (kebab tap or long-press) — edit/delete left
  // the card face; the row is one tap = open, nothing else.
  const [sheet, setSheet] = useState<{ id: string; title?: string; archived: boolean } | null>(null);
  const pressTimer = useRef<number | null>(null);
  const pressFired = useRef(false);

  // silent restore: a device that already granted permission never re-authorizes
  useEffect(() => {
    void (async () => {
      try {
        const { restorePush } = await import("../lib/push");
        await restorePush(request);
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

  function renameSession(id: string, current?: string) {
    setAsk({ intent: "rename", id, current: typeof current === "string" ? current : "" });
  }

  function deleteSession(id: string) {
    setAsk({ intent: "delete", id, current: "" });
  }

  // P2-323: the dialog only resolves when the user confirms — rename keeps
  // the non-empty guarantee (identical/blank values stay disabled) and delete
  // still clears the warm cache only on a 200.
  async function handleAskConfirm(value: string) {
    if (!ask) return;
    const { intent, id } = ask;
    setAsk(null);
    if (intent === "rename") {
      await request("PATCH", `/session/${id}`, { title: value });
      void load();
      return;
    }
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

  function clearPress() {
    if (pressTimer.current !== null) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
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
                onClick={() => renameSession(s.id, s.title)}
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

  /** Bug 2: mobile list row — 56px, dot + one-line title, kebab. Tap opens;
   * long-press or the kebab opens the action sheet (rename/archive/delete). */
  function renderListRow(s: Session, archived = false) {
    const st = archived ? undefined : statusOf.get(s.id);
    const n = archived ? 0 : (unread[s.id] ?? 0);
    const label = s.title || s.id.slice(0, 12);
    const openSheet = () => setSheet({ id: s.id, title: s.title, archived });
    return (
      <div
        key={s.id}
        className={`convo-row${!archived && s.id === activeSession ? " active" : ""}`}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-current={!archived && s.id === activeSession ? "true" : undefined}
        data-session={s.id}
        onClick={() => {
          if (pressFired.current) {
            pressFired.current = false;
            return;
          }
          onOpen(s.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(s.id);
          }
        }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse") return;
          pressFired.current = false;
          clearPress();
          pressTimer.current = window.setTimeout(() => {
            pressTimer.current = null;
            pressFired.current = true;
            openSheet();
          }, LONG_PRESS_MS);
        }}
        onPointerUp={clearPress}
        onPointerCancel={clearPress}
        onPointerMove={clearPress}
        onContextMenu={(e) => {
          e.preventDefault();
          openSheet();
        }}
      >
        <span
          className="convo-row-dot"
          style={{
            background: st ? toneColor[st.tone] : "var(--status-done)",
            opacity: st ? 1 : 0.5,
          }}
          aria-hidden
        />
        <span className="convo-row-title">{label}</span>
        {n > 0 && <span className="unread-badge">{n}</span>}
        <button
          className="convo-row-menu"
          aria-label={t("rowMenu")}
          title={t("rowMenu")}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            openSheet();
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconMore size={18} />
        </button>
      </div>
    );
  }

  const archivedToggle = (
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
  );

  return (
    <div className={variant === "list" ? "screen chats" : "screen"}>
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
          <div className={variant === "list" ? "convo-rows" : "sess-rows"}>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="skel" style={{ height: variant === "list" ? 56 : 36 }} />
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
            {archivedSessions.length > 0 && archivedToggle}
            {archivedOpen && archivedSessions.map((s) => renderRow(s, true))}
          </div>
        )}
        {variant === "list" && !loading && (
          <div className="convo-rows">
            {groups.today.length > 0 && <GroupHead group="today" label={t("groupToday")} />}
            {groups.today.map((s) => renderListRow(s))}
            {groups.yesterday.length > 0 && <GroupHead group="yesterday" label={t("groupYesterday")} />}
            {groups.yesterday.map((s) => renderListRow(s))}
            {groups.earlier.length > 0 && <GroupHead group="earlier" label={t("groupEarlier")} />}
            {groups.earlier.map((s) => renderListRow(s))}
            {pilotSessions.length > 0 && (
              <PilotGroup
                open={pilotOpen}
                onToggle={() => setPilotOpen((v) => !v)}
                label={t("pilotGroup", { n: pilotSessions.length })}
              />
            )}
            {pilotOpen && pilotSessions.map((s) => renderListRow(s))}
            {archivedSessions.length > 0 && archivedToggle}
            {archivedOpen && archivedSessions.map((s) => renderListRow(s, true))}
          </div>
        )}
      </div>

      {variant === "list" && (
        // Bug 2: ONE large full-width pill, fixed above the bottom edge of
        // the chats list — the only primary action on this screen.
        <div className="chats-new-wrap">
          <button className="primary chats-new-pill" disabled={creating} onClick={createSession}>
            <IconPlus size={18} aria-hidden />
            <span>{creating ? t("creating") : t("newConversation").replace(/^\+\s*/, "")}</span>
          </button>
        </div>
      )}

      {variant === "rows" && (
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
      )}

      {sheet && (
        <>
          <div className="sheet-scrim" onClick={() => setSheet(null)} aria-hidden />
          <div className="sheet" role="menu" aria-label={sheet.title || sheet.id.slice(0, 12)}>
            <div className="sheet-title">{sheet.title || sheet.id.slice(0, 12)}</div>
            {sheet.archived ? (
              <button
                role="menuitem"
                className="sheet-item"
                onClick={() => {
                  restoreConversation(sheet.id);
                  setSheet(null);
                }}
              >
                <IconUndo size={18} aria-hidden />
                {t("restore")}
              </button>
            ) : (
              <>
                <button
                  role="menuitem"
                  className="sheet-item"
                  data-action="rename"
                  onClick={() => {
                    const { id, title } = sheet;
                    setSheet(null);
                    renameSession(id, title);
                  }}
                >
                  <IconPencil size={18} aria-hidden />
                  {t("rename")}
                </button>
                <button
                  role="menuitem"
                  className="sheet-item"
                  data-action="archive"
                  onClick={() => {
                    archiveConversation(sheet.id);
                    setSheet(null);
                  }}
                >
                  <IconArchive size={18} aria-hidden />
                  {t("archive")}
                </button>
                <button
                  role="menuitem"
                  className="sheet-item danger"
                  data-action="delete"
                  onClick={() => {
                    const { id } = sheet;
                    setSheet(null);
                    deleteSession(id);
                  }}
                >
                  <IconX size={18} aria-hidden />
                  {t("delete")}
                </button>
              </>
            )}
          </div>
        </>
      )}

      {ask && (
        <AskDialog
          descriptor={buildAskDialog(ask.intent, t, ask.current)}
          currentTitle={ask.intent === "rename" ? ask.current : undefined}
          onConfirm={(value) => void handleAskConfirm(value)}
          onClose={() => setAsk(null)}
        />
      )}
    </div>
  );
}
