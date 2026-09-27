import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n";
import { timeAgo } from "../lib/time";
import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  CONTENT_SEARCH_TIMEOUT_MS,
  SNIPPET_LEAD_ROWS,
  contentSearchTerm,
  createSearchSequence,
  freshHits,
  parseContentAnswer,
  snippetSegments,
  type ContentHit,
} from "../lib/convosearch";
import { findHandoffVersion, markFindOnOpen, subscribeFindHandoff, takeFindOnOpen } from "../lib/findhandoff";

type RequestFn = (
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
  timeoutMs?: number,
) => Promise<{ status: number; body: unknown }>;

export type ContentSearchState =
  | { phase: "idle" }
  /** `prev` keeps the last answer on screen while the next term loads, so
   * typing never blanks the list between keystrokes */
  | { phase: "loading"; term: string; prev?: ContentHit[] }
  | { phase: "ok"; term: string; hits: ContentHit[]; truncated: boolean }
  | { phase: "unsupported"; term: string }
  | { phase: "error"; term: string };

/**
 * eval-20: debounced GET /__ocr/search (P3-400) for a live query. Terms under
 * CONTENT_SEARCH_MIN stay idle and never leave the device; only the answer to
 * the latest request may land (lib/convosearch sequence guard), and every
 * failure — thrown or non-200 — resolves to a terminal state, never an
 * eternal spinner.
 */
export function useContentSearch(request: RequestFn, query: string) {
  const term = contentSearchTerm(query);
  const [state, setState] = useState<ContentSearchState>({ phase: "idle" });
  const [retryTick, setRetryTick] = useState(0);
  const seq = useRef(createSearchSequence());
  // App recreates request on every render; the effect must not refire on it
  const requestRef = useRef(request);
  requestRef.current = request;

  useEffect(() => {
    const mine = seq.current.next();
    if (!term) {
      setState({ phase: "idle" });
      return;
    }
    setState((cur) => ({
      phase: "loading",
      term,
      prev: cur.phase === "ok" ? cur.hits : cur.phase === "loading" ? cur.prev : undefined,
    }));
    const timer = setTimeout(() => {
      void (async () => {
        let next: ContentSearchState;
        try {
          const res = await requestRef.current("GET", "/__ocr/search", undefined, { q: term }, CONTENT_SEARCH_TIMEOUT_MS);
          const answer = parseContentAnswer(res.status, res.body);
          next =
            answer.kind === "ok"
              ? { phase: "ok", term, hits: answer.hits, truncated: answer.truncated }
              : { phase: answer.kind, term };
        } catch {
          next = { phase: "error", term };
        }
        if (seq.current.isCurrent(mine)) setState(next);
      })();
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term, retryTick]);

  return { state, retry: () => setRetryTick((n) => n + 1) };
}

/**
 * eval-20: ChatView's side of the find handoff — the searched term waiting
 * for THIS conversation (lib/findhandoff), captured when the conversation
 * opens or when the same one is picked again. The caller applies it once the
 * transcript is on screen and clears it.
 */
export function usePendingFind(sessionId: string): [string | null, () => void] {
  const version = useSyncExternalStore(subscribeFindHandoff, findHandoffVersion);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    setPending(takeFindOnOpen(sessionId));
  }, [sessionId, version]);
  return [pending, () => setPending(null)];
}

/** Open a conversation from a search hit: the find handoff first, so the
 * chat that mounts (or is already up) finds the term waiting. */
export function openFromSearch(sessionId: string, term: string, open: (id: string) => void): void {
  markFindOnOpen(sessionId, term);
  open(sessionId);
}

/** The snippet line: context, the marked occurrence, context. */
export function SnippetText({ hit, lead = SNIPPET_LEAD_ROWS }: { hit: ContentHit; lead?: number }) {
  const segments = useMemo(() => snippetSegments(hit, lead), [hit, lead]);
  return (
    <>
      {segments.map((s, i) =>
        s.mark ? (
          <mark key={i} className="content-hit-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

interface SectionProps {
  request: RequestFn;
  query: string;
  /** conversations already listed as title matches — never repeated here */
  titleMatchIds: string[];
  onOpen: (sessionId: string, term: string) => void;
  /** "rows" = desktop sidebar, "list" = phone conversation list */
  variant: "rows" | "list";
}

/**
 * eval-20: the "In messages" block under the conversation list while a query
 * is typed. Title matches keep rendering above it exactly as before; this
 * block adds the conversations whose MESSAGES mention the term, each with the
 * occurrence highlighted in a one-line snippet. Calm states only: a quiet
 * searching line, one honest "nothing found" line (replacing the list's old
 * "No conversations yet." under a filter), a partial-scan note when the host
 * capped the scan, and a retryable error line.
 */
export default function ContentSearchSection({ request, query, titleMatchIds, onOpen, variant }: SectionProps) {
  const t = useT();
  const { state, retry } = useContentSearch(request, query);
  const term = contentSearchTerm(query);
  if (!term || state.phase === "idle") return null;

  const shown = state.phase === "ok" ? state.hits : state.phase === "loading" ? (state.prev ?? []) : [];
  const hits = freshHits(shown, titleMatchIds);
  const noTitles = titleMatchIds.length === 0;
  const listClass = variant === "list" ? "content-hits list" : "content-hits";

  return (
    <div className={listClass} data-content-search={state.phase}>
      {state.phase === "loading" && hits.length === 0 && (
        <div className="content-hits-status" role="status">
          <span className="content-hits-pulse" aria-hidden />
          {t("contentSearchLoading")}
        </div>
      )}
      {hits.length > 0 && (
        <>
          <div className="sess-group-head" data-group="content">
            {t("contentSearchHeading")}
          </div>
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              className="content-hit"
              data-session={hit.id}
              title={hit.title}
              onClick={() => onOpen(hit.id, term)}
            >
              <span className="content-hit-top">
                <span className="content-hit-title">{hit.title}</span>
                {hit.instant > 0 && <span className="sess-when">{timeAgo(hit.instant, t("justNow"))}</span>}
              </span>
              <span className="content-hit-snippet">
                <SnippetText hit={hit} />
              </span>
            </button>
          ))}
        </>
      )}
      {state.phase === "ok" && hits.length === 0 && noTitles && (
        <p className="muted content-hits-empty">{t("contentSearchNone", { q: term })}</p>
      )}
      {state.phase === "ok" && state.truncated && (hits.length > 0 || noTitles) && (
        <p className="content-hits-note">{t("contentSearchPartial")}</p>
      )}
      {state.phase === "unsupported" && <p className="content-hits-note">{t("contentSearchUnsupported")}</p>}
      {state.phase === "error" && (
        <p className="content-hits-note">
          {t("contentSearchError")}{" "}
          <button type="button" className="content-hits-retry" onClick={retry}>
            {t("retry")}
          </button>
        </p>
      )}
    </div>
  );
}
