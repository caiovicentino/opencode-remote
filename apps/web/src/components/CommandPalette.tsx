import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { applySessionFilters } from "../lib/sessionFilter";
import { previewFromEvents } from "../lib/sessionPreview";
import { humanizeError } from "../lib/errors";
import {
  IconChat,
  IconFolder,
  IconGlobe,
  IconLayers,
  IconRadar,
  IconSettings,
} from "./icons";

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
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
      { key: "a-new", label: t("paletteNewChat"), kind: "action", run: onNewChat },
      { key: "a-artifacts", label: t("paletteOpenArtifacts"), kind: "action", run: () => onOpenPane("artifacts") },
      { key: "a-browser", label: t("paletteOpenBrowser"), kind: "action", run: () => onOpenPane("browser") },
      { key: "a-files", label: t("paletteOpenFiles"), kind: "action", run: () => onOpenPane("files") },
      { key: "a-mission", label: t("paletteOpenMission"), kind: "action", run: () => onOpenPane("mission") },
      { key: "a-settings", label: t("paletteOpenSettings"), kind: "action", run: () => onOpenPane("settings") },
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
    return [...actions, ...sess];
  }, [query, sessions, previews, t, onNewChat, onOpenPane, onOpenSession]);

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
          {!error && items.length === 0 && <div className="palette-empty">{t("paletteEmpty")}</div>}
          {items.map((item, i) => (
            <button
              key={item.key}
              className={`palette-item${i === active ? " active" : ""}${item.preview ? " has-sub" : ""}`}
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(i)}
            >
              <span className="palette-ico">
                {item.kind === "session" ? <IconChat size={15} /> : <PaneIcon item={item.key} />}
              </span>
              <span className="palette-label">
                <span className="palette-label-main">{item.label}</span>
                {item.preview && <span className="palette-sub">{item.preview}</span>}
              </span>
              <span className="palette-kind">{item.kind === "session" ? t("paletteKindSession") : t("paletteKindAction")}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PaneIcon({ item }: { item: string }) {
  if (item === "a-artifacts") return <IconLayers size={15} />;
  if (item === "a-browser") return <IconGlobe size={15} />;
  if (item === "a-files") return <IconFolder size={15} />;
  if (item === "a-mission") return <IconRadar size={15} />;
  return <IconSettings size={15} />;
}
