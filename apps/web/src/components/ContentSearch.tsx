import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n";
import { timeAgo } from "../lib/time";
import {
  CONTENT_SEARCH_DEBOUNCE_MS,
  CONTENT_SEARCH_TIMEOUT_MS,
  SNIPPET_LEAD_ROWS,
  contentSearchTerm,
  createScanGate,
  createSearchSequence,
  findHandoffVersion,
  freshHits,
  markFindOnOpen,
  parseContentAnswer,
  snippetSegments,
  subscribeFindHandoff,
  takeFindOnOpen,
  type ContentHit,
} from "../lib/convosearch";

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
   * typing never blanks the list between keystrokes; `prevTerm` is the term
   * those hits were fetched for — a click during the load must open the
   * conversation with the term the HITS carry, never the newer typed one */
  | { phase: "loading"; term: string; prev?: ContentHit[]; prevTerm?: string }
  | { phase: "ok"; term: string; hits: ContentHit[]; truncated: boolean }
  | { phase: "unsupported"; term: string }
  | { phase: "error"; term: string };

/**
 * eval-20: debounced GET /__ocr/search (P3-400) for a live query. Terms under
 * CONTENT_SEARCH_MIN stay idle and never leave the device; every failure —
 * thrown or non-200 — resolves to a terminal state, never an eternal spinner.
 *
 * Single-flight (verifier B2): at most ONE scan is in flight. While one is
 * out, newer settled terms are held; when the scan lands, at most one refire
 * runs — the LATEST settled term, never a queue of the ones typed in between.
 * Without this a word typed at 60ms/char piled 7 overlapping scans on the
 * host (256 MB pulled in 3.6s, pongs up to 157ms) and the final term still
 * lost hits. The hook keeps the latest answer on screen while the refire
 * runs (prev), and a click on a stale hit opens the conversation with the
 * term THAT hit carries (prevTerm).
 */
export function useContentSearch(request: RequestFn, query: string) {
  const term = contentSearchTerm(query);
  const [state, setState] = useState<ContentSearchState>({ phase: "idle" });
  const [retryTick, setRetryTick] = useState(0);
  const seq = useRef(createSearchSequence());
  const gate = useRef(createScanGate());
  // App recreates request on every render; the effect must not refire on it
  const requestRef = useRef(request);
  requestRef.current = request;
  // the term at fire time (may be newer than the effect's closure)
  const termRef = useRef(term);
  termRef.current = term;

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
      prevTerm: cur.phase === "ok" ? cur.term : cur.phase === "loading" ? cur.prevTerm : undefined,
    }));
    const timer = setTimeout(() => {
      void fire(mine);
    }, CONTENT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, retryTick]);

  async function fire(mine: number) {
    if (!gate.current.tryFire()) return; // one scan in flight; the landing refires
    const term = termRef.current;
    if (!term) {
      gate.current.landed();
      return;
    }
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
    // one held fire at most: the LATEST settled term, dropped when it already
    // matches what just landed (or the query was cleared)
    if (gate.current.landed() && termRef.current && termRef.current !== term) {
      void fire(seq.current.next());
    }
  }

  return { state, retry: () => setRetryTick((n) => n + 1) };
}

/**
 * eval-20: ChatView's side of the find handoff — the searched term waiting
 * for THIS conversation (lib/convosearch handoff), captured when the conversation
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
  // the term the shown hits were fetched for: during the load the hits are
  // the PREVIOUS answer — a click must hand off THAT term, never the newer
  // one still loading (verifier nit: stale hits opened the chat with the new term)
  const shownTerm = state.phase === "loading" ? (state.prevTerm ?? term) : term;
  const hits = freshHits(shown, titleMatchIds);
  const noTitles = titleMatchIds.length === 0;
  // an honest degraded state: the scan came back partial with NOTHING — the
  // UI must never turn "couldn't finish the scan" into "nothing exists"
  const degraded = state.phase === "ok" && state.truncated && hits.length === 0;
  const listClass = variant === "list" ? "content-hits list" : "content-hits";
  // the retry action is shared by the degraded and the error line
  const retryBtn = (
    <button type="button" className="content-hits-retry" onClick={retry}>
      {t("retry")}
    </button>
  );

  return (
    <div className={listClass}>
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
              onClick={() => onOpen(hit.id, shownTerm)}
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
      {degraded && (
        <p className={noTitles ? "muted content-hits-empty" : "content-hits-note"} role="status" data-degraded="">
          {t("contentSearchDegraded")} {retryBtn}
        </p>
      )}
      {state.phase === "ok" && state.truncated && !degraded && (
        <p className="content-hits-note" role="status">
          {t("contentSearchPartial")}
        </p>
      )}
      {state.phase === "ok" && !state.truncated && hits.length === 0 && noTitles && (
        <p className="muted content-hits-empty" role="status" data-none="">
          {t("contentSearchNone", { q: term })}
        </p>
      )}
      {state.phase === "unsupported" && (
        <p className="content-hits-note" role="status">
          {t("contentSearchUnsupported")}
        </p>
      )}
      {state.phase === "error" && (
        <p className="content-hits-note" role="status">
          {t("contentSearchError")} {retryBtn}
        </p>
      )}
    </div>
  );
}
