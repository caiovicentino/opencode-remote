import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { applySessionFilters } from "../lib/sessionFilter";
import { previewFromEvents } from "../lib/sessionPreview";
import { humanizeError } from "../lib/errors";
import { SNIPPET_LEAD_PALETTE, freshHits, type ContentHit } from "../lib/convosearch";
import { comboKeys, comboLabel, shortcutFor } from "../lib/shortcuts";
import { openFromSearch, SnippetText, useContentSearch } from "./ContentSearch";
import { KeyCaps, openShortcutsSheet, platformIsMac } from "./ShortcutsShared";
import {
  IconChat,
  IconFolder,
  IconGlobe,
  IconKeyboard,
  IconLayers,
  IconPlus,
  IconRadar,
  IconSearch,
  IconSettings,
} from "./icons";

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown }>;

interface Session {
  id: string;
  title?: string;
}

interface Props {
  request: RequestFn;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
  onOpenPane: (slot: "artifacts" | "browser" | "files" | "settings" | "mission") => void;
  /** P3-084: live event buffer — feeds the last-message preview per session. */
  events: { type: string; properties?: unknown }[];
}

interface Item {
  key: string;
  label: string;
  kind: string;
  /** P3-084: last known message line (sessions only, optional). */
  preview?: string;
  /** eval-20: content-search hit — the snippet line with the occurrence marked. */
  hit?: ContentHit;
  /** eval-20: the shortcut id whose key caps the row shows (lib/shortcuts). */
  shortcut?: string;
  run: () => void;
}

/**
 * P1-046: Cmd+K command palette — flat overlay in the Raycast/Linear style
 * (panel background, hairline border, no gradients). Lists fixed navigation
 * actions plus the machine's conversations, filtered by one query.
 */
export default function CommandPalette({ request, onClose, onOpenSession, onNewChat, onOpenPane, events }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // P3-084: last known message line per conversation (from the event buffer)
  const previews = useMemo(() => previewFromEvents(events), [events]);
  // eval-20: conversations whose MESSAGES mention the query (P3-400 route)
  const { state: content, retry: retryContent } = useContentSearch(request, query);
  const mac = platformIsMac();
  // the retry action is shared by the degraded and the error line
  const retryBtn = (
    <button type="button" className="content-hits-retry" onClick={retryContent}>
      {t("retry")}
    </button>
  );

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", "/session");
        if (res.status === 200) setSessions((res.body as Session[]) ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [request]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const actions: Item[] = [
      { key: "a-new", label: t("paletteNewChat"), kind: "action", shortcut: "newChat", run: onNewChat },
      { key: "a-artifacts", label: t("paletteOpenArtifacts"), kind: "action", shortcut: "pane:artifacts", run: () => onOpenPane("artifacts") },
      { key: "a-browser", label: t("paletteOpenBrowser"), kind: "action", shortcut: "pane:browser", run: () => onOpenPane("browser") },
      { key: "a-files", label: t("paletteOpenFiles"), kind: "action", shortcut: "pane:files", run: () => onOpenPane("files") },
      { key: "a-mission", label: t("paletteOpenMission"), kind: "action", shortcut: "pane:mission", run: () => onOpenPane("mission") },
      { key: "a-settings", label: t("paletteOpenSettings"), kind: "action", shortcut: "pane:settings", run: () => onOpenPane("settings") },
      { key: "a-shortcuts", label: t("paletteShortcuts"), kind: "action", shortcut: "shortcuts", run: openShortcutsSheet },
    ].filter((a) => !q || a.label.toLowerCase().includes(q));
    const sess: Item[] = applySessionFilters(sessions, {}, query, "all")
      .slice(0, 30)
      .map((s) => ({
        key: `s-${s.id}`,
        label: s.title || s.id.slice(0, 12),
        kind: "session",
        preview: previews[s.id],
        run: () => onOpenSession(s.id),
      }));
    // eval-20: content hits come last and never repeat a title match, so the
    // rows above keep their indexes (and the arrow-key cursor) as they land
    const hits = content.phase === "ok" ? freshHits(content.hits, sess.map((s) => s.key.slice(2))) : [];
    const found: Item[] = hits.map((hit) => ({
      key: `m-${hit.id}`,
      label: hit.title,
      kind: "message",
      hit,
      run: () => openFromSearch(hit.id, content.phase === "ok" ? content.term : query.trim(), onOpenSession),
    }));
    return [...actions, ...sess, ...found];
  }, [query, sessions, previews, content, t, onNewChat, onOpenPane, onOpenSession]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function commit(index: number) {
    const item = items[index];
    if (!item) return;
    onClose();
    item.run();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose} role="dialog" aria-modal>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder={t("palettePlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={t("palettePlaceholder")}
          spellCheck={false}
        />
        <div className="palette-list" ref={listRef}>
          {error && <div className="palette-empty">{humanizeError(error, t)}</div>}
          {/* eval-20 (verifier B1): a partial scan that came back with NOTHING
              is never "No matches" — the honest state says the conversations
              could not all be read, with a retry; the partial note rides along
              at 0 hits too, exactly as it does above the hit rows */}
          {!error && items.length === 0 && content.phase !== "loading" && content.phase !== "error" &&
            !(content.phase === "ok" && content.truncated) && <div className="palette-empty" data-empty>{t("paletteEmpty")}</div>}
          {content.phase === "ok" && content.truncated && (
            <div className="palette-status" role="status" data-degraded="">
              {t("contentSearchDegraded")} {retryBtn}
            </div>
          )}
          {items.map((item, i) => (
            <button
              key={item.key}
              className={`palette-item${i === active ? " active" : ""}${item.preview || item.hit ? " has-sub" : ""}`}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(i)}
            >
              <span className="palette-ico">
                {item.kind === "session" ? (
                  <IconChat size={15} />
                ) : item.kind === "message" ? (
                  <IconSearch size={15} />
                ) : (
                  <PaneIcon item={item.key} />
                )}
              </span>
              <span className="palette-label">
                <span className="palette-label-main">{item.label}</span>
                {item.preview && <span className="palette-sub">{item.preview}</span>}
                {item.hit && (
                  <span className="palette-sub palette-snippet">
                    <SnippetText hit={item.hit} lead={SNIPPET_LEAD_PALETTE} />
                  </span>
                )}
              </span>
              {item.shortcut && shortcutFor(item.shortcut) ? (
                <KeyCaps
                  keys={comboKeys(shortcutFor(item.shortcut)!.combo, mac)}
                  label={comboLabel(shortcutFor(item.shortcut)!.combo, mac)}
                />
              ) : (
                <span className="palette-kind">
                  {item.kind === "session"
                    ? t("paletteKindSession")
                    : item.kind === "message"
                      ? t("paletteKindMessage")
                      : t("paletteKindAction")}
                </span>
              )}
            </button>
          ))}
          {/* eval-20: the content search speaks in one quiet line — never a
              spinner that outlives the request, never a raw error */}
          {content.phase === "loading" && (
            <div className="palette-status" role="status">
              <span className="content-hits-pulse" aria-hidden />
              {t("contentSearchLoading")}
            </div>
          )}
          {content.phase === "ok" && content.truncated && content.hits.length > 0 && (
            <div className="palette-status" role="status">
              {t("contentSearchPartial")}
            </div>
          )}
          {content.phase === "unsupported" && (
            <div className="palette-status" role="status">
              {t("contentSearchUnsupported")}
            </div>
          )}
          {content.phase === "error" && (
            <div className="palette-status" role="status">
              {t("contentSearchError")} {retryBtn}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PaneIcon({ item }: { item: string }) {
  if (item === "a-shortcuts") return <IconKeyboard size={15} />;
  // eval-20: "New conversation" fell through to the settings gear
  if (item === "a-new") return <IconPlus size={15} />;
  if (item === "a-artifacts") return <IconLayers size={15} />;
  if (item === "a-browser") return <IconGlobe size={15} />;
  if (item === "a-files") return <IconFolder size={15} />;
  if (item === "a-mission") return <IconRadar size={15} />;
  return <IconSettings size={15} />;
}
