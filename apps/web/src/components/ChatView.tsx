import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { EventEnvelope } from "@ocr/protocol";
import { WavRecorder, encodeWav } from "../lib/recorder";
import { saveFile } from "../lib/files";
import { useT } from "../lib/i18n";
import { humanizeError } from "../lib/errors";
import { getVoiceSettings } from "./SettingsView";
import { renderBubbleText } from "./FileCard";
import ArtifactViewer from "./ArtifactViewer";
import { artifactMentions, listArtifacts, type ArtifactMeta } from "../lib/artifacts";
import {
  artifactKindFor,
  consumeArtifactEvents,
  type ArtifactAutoState,
} from "../lib/artifactAuto";
import { clampSplitPct, isSplitViewport, SPLIT_MIN_PX } from "../lib/split";
import { useExitAnimation } from "../lib/motion";
import { sessionTitleOf } from "../lib/title";
import { permissionPreview } from "../lib/permission";
import {
  collectPermissionAsks,
  isPermissionResolvedElsewhere,
  reconcilePermissionCards,
  type PermissionAsk,
} from "../lib/permissionCards";
import { getCachedSession, putCachedSession } from "../lib/sessionCache";
import { appendDraft, getDraft, setDraft } from "../lib/drafts";
import { firstSentence, pressureLevel } from "../lib/context";
import { clampComposerHeight, composerSelectorLabel } from "../lib/composer";
import { mergeBubbles, rowsToBubbles, type Bubble, type HistoryRow } from "../lib/bubbleMerge";
import {
  reduceThinking,
  thinkingExpanded,
  thinkingSeconds,
  type ThinkingState,
} from "../lib/thinking";
import { initialUnreadState, reduceUnread, sendUnreadToShell } from "../lib/unread";
import { ArtifactIcon, IconArrowUp, IconChat, IconChevronDown, IconDownload, IconLaptop, IconMic, IconPlus, IconWrench } from "./icons";

interface Props {
  sessionId: string;
  events: EventEnvelope[];
  connStatus: string;
  voice?: boolean;
  /** P2-090: true while the right-hand Browser pane is the visible slot —
   * the browser (manual or P1-072 auto-open) keeps priority over the artifact
   * auto-open, which must never cover it. */
  browserActive?: boolean;
  request: (
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
    timeoutMs?: number,
  ) => Promise<{ status: number; body: unknown }>;
  onBack: () => void;
  /** P2-091: artifact picked on another surface (ArtifactsView list) — adopted
   * once into this chat's manual pick so it opens in the P2-062 split-pane
   * (wide) or overlay (!wide) exactly like a card click. */
  paneArtifact?: ArtifactMeta | null;
  /** Called after paneArtifact is adopted so the source can clear its pending state. */
  onPaneArtifactConsumed?: () => void;
}

interface QuestionInfo {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiple?: boolean;
  custom?: boolean;
}
interface QuestionReq {
  requestID: string;
  questions: QuestionInfo[];
}

interface DiffFile {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
}

interface ToolActivity {
  tool: string;
  status: string;
  title: string;
  output: string;
}

function toolsFromRows(rows: HistoryRow[]): Map<string, ToolActivity> {
  const map = new Map<string, ToolActivity>();
  for (const row of rows) {
    for (const part of row.parts ?? []) {
      if (part.type === "tool" && part.callID) {
        map.set(part.callID, {
          tool: part.tool ?? "tool",
          status: part.state?.status ?? "",
          title: part.state?.title ?? "",
          output: part.state?.output ?? "",
        });
      }
    }
  }
  return map;
}

/** P3-083: imperative scrolls honor prefers-reduced-motion — the global CSS
 * media query already neutralizes animations/transitions, but scrollIntoView
 * with an explicit behavior would override it. */
function scrollBehavior(): ScrollBehavior {
  return typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

/** P1-064: paged-history envelope served by the daemon (?limit&before). */
interface HistoryPage {
  rows?: HistoryRow[];
  hasMore?: boolean;
  oldest?: string | null;
}

interface Skill {
  id: string;
  label: string;
  prompt: string;
}

interface PendingImage {
  id: string;
  mime: string;
  filename: string;
  thumb: string;
  raw?: Uint8Array;
}

/** P3-085: collapsible reasoning block ("Pensou por Xs", Claude Desktop
 * parity). Expanded while the model is still thinking, collapsed the moment
 * the answer starts; the header stays clickable either way. The open state
 * lives in the DOM — aria-expanded is the locale-proof test hook. */
function ThinkingBlock({
  text,
  label,
  streaming,
}: {
  text: string;
  label: string;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(streaming);
  const wasStreaming = useRef(streaming);
  useEffect(() => {
    if (wasStreaming.current !== streaming) {
      wasStreaming.current = streaming;
      setOpen(streaming);
    }
  }, [streaming]);
  return (
    <div className={`thinking${open ? " open" : ""}`}>
      <button className="thinking-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <svg
          className="thinking-chevron"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span>{label}</span>
      </button>
      <div className="thinking-body">
        <div className="thinking-inner">
          {text}
          {streaming && <span className="caret" aria-hidden />}
        </div>
      </div>
    </div>
  );
}

/** P2-049: accessible modal shell — Esc closes, Tab is trapped inside while
 * open, and focus returns to the trigger on close (role=dialog + aria-modal). */
function Modal({
  label,
  z,
  onClose,
  children,
}: {
  label: string;
  z: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      trigger?.focus();
    };
  }, [onClose]);

  function trapTab(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const nodes = ref.current?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="modal-scrim"
      style={{ zIndex: z }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      ref={ref}
      tabIndex={-1}
      onKeyDown={trapTab}
    >
      {children}
    </div>
  );
}

export default function ChatView({
  sessionId,
  events,
  connStatus,
  voice,
  browserActive,
  request,
  onBack,
  paneArtifact,
  onPaneArtifactConsumed,
}: Props) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  // message windowing: render only the tail of long conversations and page in
  // older bubbles on scroll-top, so huge sessions stay smooth on low-end phones
  const MSG_WINDOW = 200;
  const [winStart, setWinStart] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const prePagingHeight = useRef(0);
  // P1-088 invariant: `input` is a per-session draft (lib/drafts). The ONLY
  // allowed writers are the textarea onChange, send(), micUp(), processVideo()
  // — via the updateInput/appendToInput wrappers below — and the [sessionId]
  // restore effect. No stream/event effect may ever write the user's input
  // (rg 'setInput\(' ChatView.tsx must show only those sites).
  const [input, setInput] = useState(() => getDraft(sessionId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // text of the last failed send, so the error banner can offer one-tap retry
  const [retryText, setRetryText] = useState("");

  // transient errors: red text should not stick around forever
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 10_000);
    return () => clearTimeout(t);
  }, [error]);
  const [recState, setRecState] = useState<"idle" | "rec" | "busy">("idle");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const [models, setModels] = useState<{ providerID: string; modelID: string; name: string }[]>([]);
  const [model, setModel] = useState(localStorage.getItem("ocr_model") ?? "");
  const [agent, setAgent] = useState(localStorage.getItem("ocr_agent") ?? "");
  // P3-086: inline agent/model dropdown in the composer (Claude Desktop parity)
  const [modelMenu, setModelMenu] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [tapToggle, setTapToggle] = useState(false);
  const [responded, setResponded] = useState<Set<string>>(new Set());
  const [persistedAsks, setPersistedAsks] = useState<PermissionAsk[]>([]);
  const [persistedQuestions, setPersistedQuestions] = useState<QuestionReq[]>([]);
  const [qResponded, setQResponded] = useState<Set<string>>(new Set());
  const [qSel, setQSel] = useState<Record<string, Record<number, string[]>>>({});
  const [qCustom, setQCustom] = useState<Record<string, Record<number, string>>>({});
  const [showActivity, setShowActivity] = useState(false);
  const [historyTools, setHistoryTools] = useState<Map<string, ToolActivity>>(new Map());
  // P1-064: server paging state + explicit history error (never an eternal skeleton)
  const [historyError, setHistoryError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [oldest, setOldest] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const pagingRef = useRef(false);
  const [sessionTitle, setSessionTitle] = useState("");
  // P1-079: per-session context gauge + pinned recap under the composer
  const [ctx, setCtx] = useState<{ pct: number; tokens: number; window: number } | null>(null);
  const [sessionSummary, setSessionSummary] = useState("");
  // P2-049: autoscroll only when the reader is at the bottom — scrolling up to
  // read must not be yanked back by the streaming tail
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // agent artifacts (P1-010): cards under messages that reference them
  const [artifacts, setArtifacts] = useState<ArtifactMeta[]>([]);
  const [artifactView, setArtifactView] = useState<ArtifactMeta | null>(null);
  // P2-090: artifact auto-opened by the daemon's session.artifact event —
  // kept separate from the manual pick so a user choice is never overridden.
  const [autoArtifact, setAutoArtifact] = useState<ArtifactMeta | null>(null);
  // P2-062: side-by-side preview — wide viewports render the artifact in a
  // right-hand pane (chat stays visible/navigable); narrow ones keep overlay.
  const [wide, setWide] = useState(() => isSplitViewport(window.innerWidth));
  const [splitPct, setSplitPct] = useState(0.5);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const chatRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${SPLIT_MIN_PX}px)`);
    const onChange = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", onChange);
    setWide(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  function splitDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingSplit(true);
  }
  function splitMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingSplit) return;
    const row = chatRowRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    if (rect.width <= 0) return;
    setSplitPct(clampSplitPct((rect.right - e.clientX) / rect.width));
  }
  function splitUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingSplit) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDraggingSplit(false);
  }
  // P2-062: the manual pick wins over the P2-090 auto-open (a manual choice is
  // never overridden); both render in the same side-by-side pane.
  const shownArtifact = artifactView ?? autoArtifact;
  // P3-087: the pane slides in/out (150–300ms ease-out) instead of popping.
  // Each surface keeps its last artifact so the exit animation has content
  // to render while useExitAnimation holds the tree mounted.
  const lastSplitRef = useRef<ArtifactMeta | null>(null);
  if (shownArtifact && wide) lastSplitRef.current = shownArtifact;
  const lastOverlayRef = useRef<ArtifactMeta | null>(null);
  if (artifactView && !wide) lastOverlayRef.current = artifactView;
  const splitPhase = useExitAnimation(!!shownArtifact && wide);
  const splitArtifact = shownArtifact ?? (splitPhase !== "closed" ? lastSplitRef.current : null);
  const splitOpen = wide && splitPhase !== "closed" && !!splitArtifact;
  const overlayPhase = useExitAnimation(!!artifactView && !wide);
  const overlayArtifact = artifactView ?? (overlayPhase !== "closed" ? lastOverlayRef.current : null);
  const t = useT();

  const [exporting, setExporting] = useState(false);
  async function handoffToDesktop() {
    try {
      const res = await request("POST", "/__ocr/handoff", { sessionId });
      if (res.status === 200) setAutoNote(t("openedOnMac"));
      else setError(`handoff failed: ${JSON.stringify(res.body).slice(0, 140)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }
  async function exportChat() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await request("POST", "/__ocr/export", { sessionId });
      if (res.status !== 200) {
        setError(`export failed: ${JSON.stringify(res.body).slice(0, 140)}`);
        return;
      }
      const { path } = res.body as { path: string };
      await saveFile(request, path);
      setAutoNote(t("exported"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }
  async function loadToolHistory() {
    try {
      const res = await request("GET", `/session/${sessionId}/message`);
      if (res.status === 200) {
        const rows = (Array.isArray(res.body) ? (res.body as HistoryRow[]) : ((res.body as HistoryPage)?.rows ?? []));
        setHistoryTools(toolsFromRows(rows));
      }
    } catch {}
  }
  // P1-064: opening the activity drawer reuses the tools already derived from
  // the paged history fetch; a second full-history request on every toggle was
  // one of the two fetches that made session opening slow.
  function ensureToolHistory() {
    if (historyTools.size === 0) void loadToolHistory();
  }
  const [diff, setDiff] = useState<{
    ask: PermissionAsk | null;
    loading: boolean;
    files: DiffFile[];
    err?: string;
  } | null>(null);
  const rolesRef = useRef<Record<string, string>>({});
  const lastEventId = useRef<string | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [pendingVideo, setPendingVideo] = useState<{ file: File; dur: number } | null>(null);
  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd] = useState("");
  const downAt = useRef(0);
  const recorder = useRef<WavRecorder | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", "/provider");
        const all = (res.body as { all?: { id: string; models?: Record<string, { id: string; name?: string }> }[] })
          .all ?? [];
        const flat = all.flatMap((p) =>
          Object.values(p.models ?? {}).map((m) => ({
            providerID: p.id,
            modelID: m.id,
            name: `${p.id} · ${m.name ?? m.id}`,
          })),
        );
        setModels(flat);
      } catch {
        // model list is optional
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const res = await request("GET", "/__ocr/skills");
        if (res.status === 200) setSkills((res.body as { skills?: Skill[] }).skills ?? []);
      } catch {}
    })();
  }, []);

  // artifacts for this session; refetched whenever the agent turns idle again
  const idleCount = events.filter(
    (e) =>
      e.type === "session.idle" &&
      ((e.properties ?? {}) as { sessionID?: string }).sessionID === sessionId,
  ).length;
  useEffect(() => {
    let alive = true;
    void listArtifacts(request, sessionId)
      .then((list) => {
        if (alive) setArtifacts(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sessionId, idleCount, request]);

  // P1-079: context gauge — daemon-computed pressure for this session
  // (opencode tokens vs the model window), refreshed when the agent goes idle.
  // The sample is wiped ONLY on a session switch: an idle refetch keeps the
  // previous gauge on screen until the fresh sample lands (no unmount flash
  // at the end of every turn).
  const ctxSessionRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (ctxSessionRef.current !== sessionId) {
      ctxSessionRef.current = sessionId;
      setCtx(null);
    }
    void (async () => {
      try {
        const res = await request("GET", "/__ocr/context", undefined, { session: sessionId });
        if (alive && res.status === 200) {
          const b = (res.body ?? {}) as { pct?: number; tokens?: number; window?: number };
          if (typeof b.pct === "number" && (b.window ?? 0) > 0) {
            setCtx({ pct: b.pct, tokens: b.tokens ?? 0, window: b.window ?? 0 });
          }
        }
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, idleCount, request]);

  // P2-090: auto-open refs — the effect itself is declared after the
  // [sessionId] reset effect below so a session switch always re-anchors
  // before any event batch is consumed.
  const autoArtifactState = useRef<ArtifactAutoState & { anchor: string | null }>({
    anchor: null,
    pending: null,
  });
  const artifactDismissedRef = useRef<Set<string>>(new Set());
  const artifactViewRef = useRef<ArtifactMeta | null>(null);
  const wideRef = useRef(wide);
  useEffect(() => {
    artifactViewRef.current = artifactView;
    wideRef.current = wide;
  }, [artifactView, wide]);

  // P2-091: adopt an artifact picked on another surface (ArtifactsView list)
  // as the manual pick — same state path as a card click, so the P2-062
  // split-pane/overlay rules and the P2-090 manual-wins-over-auto rule hold.
  // Consuming clears the source's pending state; a re-click (fresh object
  // from App) re-opens even the same file.
  const consumePaneArtifactRef = useRef(onPaneArtifactConsumed);
  consumePaneArtifactRef.current = onPaneArtifactConsumed;
  useEffect(() => {
    if (!paneArtifact) return;
    setArtifactView(paneArtifact);
    setAutoArtifact(null);
    consumePaneArtifactRef.current?.();
  }, [paneArtifact]);

  useEffect(() => {
    let alive = true;
    sessionIdRef.current = sessionId;
    setSessionTitle("");
    void (async () => {
      try {
        const res = await request("GET", `/session/${sessionId}`);
        // a response from a previous session must not overwrite this header
        if (alive && res.status === 200) {
          setSessionTitle(sessionTitleOf(res.body));
          // P1-079: a string session summary wins over the derived recap
          const s = res.body as { summary?: unknown };
          setSessionSummary(typeof s?.summary === "string" ? s.summary : "");
        }
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  // P1-088: restore this session's draft on navigation. Declared AFTER the
  // sessionIdRef sync effect above so it is the last writer on a switch.
  useEffect(() => {
    setInput(getDraft(sessionId));
  }, [sessionId]);

  // P1-088: every composer write goes through these wrappers so the text is
  // always recorded as the ORIGIN session's draft; the visible input updates
  // only while the origin session is still the one on screen.
  function updateInput(value: string) {
    setDraft(sessionIdRef.current, value);
    setInput(value);
  }
  function appendToInput(text: string, sid: string) {
    const next = appendDraft(sid, text);
    if (sid === sessionIdRef.current) setInput(next);
  }

  // P3-086: auto-grow — the textarea grows with its content up to ~6 lines,
  // then stops and scrolls internally (lib/composer clamps; CSS overflow-y).
  // Re-runs on every draft write including session-switch restores.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    el.style.height = "auto";
    el.style.height = `${clampComposerHeight(el.scrollHeight, lh, padY)}px`;
  }, [input, sessionId]);

  // P3-086: dropdown discipline — pointer-down outside or Escape closes the
  // inline agent/model menu; selection stays a click inside.
  useEffect(() => {
    if (!modelMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!modelMenuRef.current?.contains(e.target as Node)) setModelMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelMenu(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [modelMenu]);

  function pickAgent(value: string) {
    setAgent(value);
    localStorage.setItem("ocr_agent", value);
  }
  function pickModel(value: string) {
    setModel(value);
    localStorage.setItem("ocr_model", value);
  }

  // streaming tail state lives ABOVE the [sessionId] switch effect so that
  // effect can clear it (P1-089): session A's live tail must never finalize
  // into session B's transcript on a mid-stream switch.
  const [liveText, setLiveText] = useState("");
  const liveRef = useRef<{ text: string; messageID?: string }>({ text: "" });
  // P3-085: streaming reasoning ("Pensou por Xs" block) — refs above the
  // [sessionId] switch effect, cleared on every switch (P1-089 rule).
  const [liveThinking, setLiveThinking] = useState<ThinkingState | null>(null);
  const thinkingRef = useRef<ThinkingState | null>(null);

  useEffect(() => {
    rolesRef.current = {};
    setResponded(new Set());
    setPersistedAsks([]); // never leak another session's pending asks on switch
    setPersistedQuestions([]);
    setQResponded(new Set());
    setQSel({});
    setQCustom({});
    // P2-090: auto-open state is per session — a pending write of session A
    // must never fire on B's idle, and the pane closes with the switch.
    autoArtifactState.current = { anchor: null, pending: null };
    artifactDismissedRef.current = new Set();
    setAutoArtifact(null);
    // events that arrived before this view opened are covered by the message
    // fetch below — streaming starts from the next event
    lastEventId.current = events[events.length - 1]?.id ?? null;
    // ask the daemon for pending permissions on this session — covers asks that
    // happened before the app was open (otherwise the agent stays stuck invisibly)
    void fetchPendingPermissions();
    void (async () => {
      try {
        const q = await request("GET", "/question");
        const list = (Array.isArray(q.body) ? q.body : []) as {
          id: string;
          sessionID?: string;
          questions?: QuestionInfo[];
        }[];
        setPersistedQuestions(
          list
            .filter((x) => x.sessionID === sessionId)
            .map((x) => ({ requestID: x.id, questions: x.questions ?? [] })),
        );
      } catch {}
    })();
    // P1-089: drop the previous session's streaming tail — otherwise an idle
    // finalize racing the switch appends it to the new session's bubbles
    liveRef.current = { text: "" };
    setLiveText("");
    thinkingRef.current = null;
    setLiveThinking(null);
  }, [sessionId]);

  // P2-090: auto-open the split-pane when the turn goes idle right after the
  // agent wrote an artifact. The pure pairing (write → next idle) lives in
  // lib/artifactAuto; the guards here encode the spec's priorities:
  // - a manual artifact choice is never overridden;
  // - a pane the user closed is not re-opened for the same file;
  // - the browser pane (manual or ocr.preview auto-open) keeps priority.
  // Declared AFTER the [sessionId] reset effect so a switch re-anchors before
  // any event batch is consumed.
  useEffect(() => {
    const st = autoArtifactState.current;
    if (!st.anchor) {
      // first run after mount / session switch: only future events count
      st.anchor = events[events.length - 1]?.id ?? null;
      return;
    }
    const idx = events.findIndex((e) => e.id === st.anchor);
    if (idx < 0) {
      // the watermark slid out of the 500-cap buffer — re-anchor silently,
      // never replay old artifact/idle pairs from an unknown position
      st.anchor = events[events.length - 1]?.id ?? null;
      return;
    }
    st.anchor = events[events.length - 1]?.id ?? null;
    const { open } = consumeArtifactEvents(events.slice(idx + 1), sessionId, st);
    if (!open) return;
    if (!wideRef.current) return; // P2-062 split-pane is a wide-viewport feature
    if (browserActive) return; // P1-072 browser pane has priority
    if (artifactViewRef.current) return; // user is viewing another artifact
    if (artifactDismissedRef.current.has(open)) return; // user closed it before
    setAutoArtifact({
      sessionId,
      name: open,
      size: 0,
      mtime: Date.now(),
      kind: artifactKindFor(open),
    });
  }, [events, sessionId, browserActive]);

  // P1-082: the daemon's pending list (GET /permission) is the source of truth
  // for actionable approval cards — events only trigger this re-fetch.
  async function fetchPendingPermissions() {
    try {
      const res = await request("GET", "/permission");
      const list = (Array.isArray(res.body) ? res.body : []) as {
        id: string;
        sessionID?: string;
        permission?: string;
      }[];
      setPersistedAsks(
        list
          .filter((x) => x.sessionID === sessionIdRef.current)
          .map((x) => ({
            permissionID: x.id,
            label: x.permission ?? "action",
            preview: permissionPreview(x),
          })),
      );
    } catch {}
  }

  // P1-082: AutoMode — the daemon answers permission asks on the user's behalf.
  // While on, no actionable card is ever rendered (passive badge only); the
  // daemon's audit log is the record.
  const [autoMode, setAutoMode] = useState(false);
  async function refreshAutoMode() {
    try {
      const res = await request("GET", "/__ocr/settings");
      if (res.status === 200) setAutoMode((res.body as { autoMode?: boolean }).autoMode === true);
    } catch {}
  }
  useEffect(() => {
    void refreshAutoMode();
  }, [sessionId]);

  // P1-082: permission events no longer render cards by themselves — they
  // (debounced) re-fetch the daemon's pending list instead.
  const permEventCount = events.filter((e) =>
    e.type.toLowerCase().includes("permission"),
  ).length;
  const permRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (permEventCount === 0) return;
    if (permRefetchTimer.current) clearTimeout(permRefetchTimer.current);
    permRefetchTimer.current = setTimeout(() => {
      permRefetchTimer.current = null;
      void fetchPendingPermissions();
    }, 300);
    return () => {
      if (permRefetchTimer.current) {
        clearTimeout(permRefetchTimer.current);
        permRefetchTimer.current = null;
      }
    };
  }, [permEventCount]);

  useEffect(() => {
    setLoadingHistory(true);
    setWinStart(0);
    setHistoryError("");
    // P1-064: warm cache paints the conversation immediately — the refetch
    // below still runs so streaming-fresh messages replace the snapshot.
    const cached = getCachedSession<Bubble, ToolActivity>(sessionId);
    if (cached) {
      setBubbles(cached.bubbles);
      setHistoryTools(cached.tools);
      setHasMore(cached.hasMore);
      setOldest(cached.oldest);
      setWinStart(Math.max(0, cached.bubbles.length - MSG_WINDOW));
      setLoadingHistory(false);
    }
    void loadHistory();
  }, [sessionId]);

  const HISTORY_TIMEOUT_MS = 10_000;
  const PAGE_QUERY = { limit: "50" };

  async function loadHistory() {
    try {
      const res = await request("GET", `/session/${sessionId}/message`, undefined, PAGE_QUERY, HISTORY_TIMEOUT_MS);
      if (res.status !== 200) throw new Error(`GET messages -> ${res.status}`);
      const body = res.body as HistoryPage;
      // legacy daemons (no paging params) still answer a plain array
      const rows = Array.isArray(res.body) ? (res.body as HistoryRow[]) : (body.rows ?? []);
      const out = rowsToBubbles(rows);
      const page = Array.isArray(res.body) ? null : body;
      const tools = toolsFromRows(rows);
      const more = page?.hasMore ?? false;
      const oldestId = page?.oldest ?? rows[0]?.info?.id ?? null;
      setBubbles(out);
      setWinStart(Math.max(0, out.length - MSG_WINDOW));
      setHistoryTools(tools);
      setHasMore(more);
      setOldest(oldestId);
      setHistoryError("");
      putCachedSession(sessionId, { bubbles: out, tools, hasMore: more, oldest: oldestId });
    } catch (err) {
      // keep whatever is on screen; surface a retryable error instead of a
      // skeleton that never resolves
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingHistory(false);
    }
  }

  // P1-064: prepend the page older than `oldest`. If the server tail overlaps
  // what is already rendered (history changed under us, e.g. a rewind), the
  // page replaces the list instead of duplicating bubbles.
  async function loadMore() {
    if (pagingRef.current || !hasMore || !oldest) return;
    pagingRef.current = true;
    setPaging(true);
    const el = listRef.current;
    if (el) prePagingHeight.current = el.scrollHeight;
    try {
      const res = await request(
        "GET",
        `/session/${sessionId}/message`,
        undefined,
        { limit: "100", before: oldest },
        HISTORY_TIMEOUT_MS,
      );
      if (res.status !== 200) throw new Error(`GET messages -> ${res.status}`);
      const body = res.body as HistoryPage;
      const rows = Array.isArray(res.body) ? (res.body as HistoryRow[]) : (body.rows ?? []);
      const older = rowsToBubbles(rows);
      const more = Array.isArray(res.body) ? false : (body.hasMore ?? false);
      const nextOldest = rows[0]?.info?.id ?? oldest;
      const tools = toolsFromRows(rows);
      // P1-089: id-keyed prepend — an overlap (history changed under us,
      // e.g. a rewind) replaces same-id bubbles in place instead of the old
      // whole-list discard, and streamed id-less bubbles survive the merge.
      setBubbles((b) => mergeBubbles(older, b));
      const next = mergeBubbles(older, bubbles);
      setWinStart(Math.max(0, next.length - MSG_WINDOW));
      const mergedTools = new Map([...historyTools, ...tools]);
      setHistoryTools(mergedTools);
      setHasMore(more);
      setOldest(nextOldest);
      setHistoryError("");
      putCachedSession(sessionId, {
        bubbles: next,
        tools: mergedTools,
        hasMore: more,
        oldest: nextOldest,
      });
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      pagingRef.current = false;
      setPaging(false);
    }
  }

  // stream: rebuild the tail of the conversation from live part events.
  // user messages echo as parts too — track message roles and only stream
  // assistant parts. `session.idle`/`session.status:idle` finalize the turn.
  useEffect(() => {
    let text = "";
    let textId: string | undefined;
    let idle = false;
    let errored = "";
    let start = 0;
    if (lastEventId.current) {
      const idx = events.findIndex((e) => e.id === lastEventId.current);
      if (idx >= 0) start = idx + 1;
    }
    lastEventId.current = events[events.length - 1]?.id ?? null;
    for (const evt of events.slice(start)) {
      const p = evt.properties as {
        sessionID?: string;
        status?: { type?: string };
        info?: { id?: string; role?: string };
        part?: { type?: string; text?: string; messageID?: string };
        error?: unknown;
      };
      if (p?.sessionID !== sessionId) continue;
      if (evt.type === "message.updated" && p.info?.id) {
        rolesRef.current[p.info.id] = p.info.role ?? "assistant";
        const infoId = p.info.id;
        if (p.info.role === "user") {
          // tag the freshly sent user bubble so it becomes rewindable
          setBubbles((b) => {
            let idx = -1;
            for (let i = b.length - 1; i >= 0; i--) {
              const cur = b[i];
              if (cur?.role === "user" && !cur.messageID) {
                idx = i;
                break;
              }
            }
            if (idx < 0) return b;
            const next = [...b];
            const target = next[idx]!;
            next[idx] = { ...target, messageID: infoId };
            return next;
          });
        }
        continue;
      }
      if (evt.type === "session.status") idle = p.status?.type === "idle" || idle;
      if (evt.type === "session.error") {
        const errObj = (p as { error?: { name?: string } }).error;
        if (errObj?.name === "MessageAbortedError") {
          idle = true; // user pressed Stop — expected, not a failure
        } else {
          errored = JSON.stringify(evt.properties).slice(0, 200);
        }
      }
      if (p.part?.type === "text" && p.part.text) {
        if (p.part.messageID && rolesRef.current[p.part.messageID] === "user") continue;
        // the tail text and its messageID always come from the SAME part
        // event, so the finalize below keys the right message
        text = p.part.text;
        textId = p.part.messageID;
        idle = false;
      }
      if (evt.type === "session.idle") idle = true;
      // P3-085: fold reasoning/thinking events into the collapsible block
      // state (pure reducer, pinned by scripts/thinking.test.ts)
      thinkingRef.current = reduceThinking(thinkingRef.current, evt, sessionId, Date.now());
    }
    if (thinkingRef.current) setLiveThinking(thinkingRef.current);
    if (text) {
      liveRef.current = { text, messageID: textId };
      setLiveText(text);
    }
    if (idle) {
      // P3-085: freeze the thinking duration and persist it on the final
      // bubble — the collapsed "Pensou por Xs" block stays in the transcript
      const finalThinking = thinkingRef.current
        ? {
            text: thinkingRef.current.text,
            secs: thinkingRef.current.endedAt ? thinkingSeconds(thinkingRef.current) : undefined,
          }
        : undefined;
      if (liveRef.current.text) {
        const final = liveRef.current;
        setBubbles((b) => {
          // P1-089: the append must be idempotent per messageID — a replayed
          // event buffer (watermark slid out of the 500 cap, reconnect
          // resync) re-fires old session.idle events. Never push a second
          // bubble for a message already on screen; history stays the
          // source of truth and refetches converge the text.
          if (final.messageID && b.some((x) => x.messageID === final.messageID)) return b;
          // legacy events carry no messageID — text-only fallback
          if (!final.messageID && b[b.length - 1]?.text === final.text) return b;
          return [
            ...b,
            {
              role: "assistant" as const,
              text: final.text,
              messageID: final.messageID,
              thinking: finalThinking,
            },
          ];
        });
        liveRef.current = { text: "" };
      }
      thinkingRef.current = null;
      setLiveThinking(null);
      setLiveText("");
      setSending(false);
      if (errored) setError(`agent error: ${errored}`);
    }
  }, [events, sessionId]);

  // P2-049: reconnection attempts the user can see — increments each time a
  // connection that had been paired drops again (banner replaces the 9px dot)
  const [connAttempts, setConnAttempts] = useState(0);
  const wasPairedRef = useRef(connStatus === "paired");
  useEffect(() => {
    if (connStatus === "paired") {
      wasPairedRef.current = true;
      return;
    }
    if (wasPairedRef.current) {
      wasPairedRef.current = false;
      setConnAttempts((n) => n + 1);
    }
  }, [connStatus]);

  // P1-061 stream resync: after any reconnect (local loopback or relay), history
  // is the source of truth. On the connecting→paired transition following a
  // drop, clear the stale streaming tail and refetch the conversation —
  // messages produced during the gap appear without a resend. The watermark is
  // re-anchored to the buffer tail so already-rendered events never replay.
  const hadDropRef = useRef(false);
  useEffect(() => {
    if (connStatus === "connecting" || connStatus === "closed") {
      hadDropRef.current = true;
      return;
    }
    if (connStatus === "paired" && hadDropRef.current) {
      hadDropRef.current = false;
      setLiveText("");
      liveRef.current = { text: "" };
      thinkingRef.current = null;
      setLiveThinking(null);
      lastEventId.current = events[events.length - 1]?.id ?? null;
      void loadHistory();
    }
  }, [connStatus]);

  // AutoMode: the daemon answered a permission ask on the user's behalf —
  // drop the local ask UI, surface a transient note and move the card to a
  // collapsed "auto-approved" line (the synthetic WS event carries the id).
  const autoSeenRef = useRef<Set<string>>(new Set());
  const [autoNote, setAutoNote] = useState("");
  useEffect(() => {
    let sawAuto = false;
    for (const evt of events.slice(-20)) {
      if (evt.type !== "ocr.permission.auto") continue;
      const p = evt.properties as { sessionID?: string; permissionID?: string; action?: string };
      if (p?.sessionID !== sessionId || !p?.permissionID) continue;
      if (autoSeenRef.current.has(p.permissionID)) continue;
      autoSeenRef.current.add(p.permissionID);
      sawAuto = true;
      setResponded((prev) => new Set(prev).add(p.permissionID!));
      setPersistedAsks((prev) => prev.filter((x) => x.permissionID !== p.permissionID));
      setAutoNote(t("autoApproved", { action: p.action ?? "action" }));
    }
    if (sawAuto) {
      // the daemon only auto-approves while AutoMode is on — reflect it
      // immediately, then re-check settings so a mid-session toggle-off
      // also takes effect without a reload
      setAutoMode(true);
      void refreshAutoMode();
    }
  }, [events, sessionId]);
  useEffect(() => {
    if (!autoNote) return;
    const t = setTimeout(() => setAutoNote(""), 8_000);
    return () => clearTimeout(t);
  }, [autoNote]);

  // P1-093: AutoMode's approval finally failed — the ask must surface as a
  // manual card instead of stalling silently. The note is persistent but only
  // rendered while a failed id is still pending (see the composer render).
  const autoFailedRef = useRef<Set<string>>(new Set());
  const [autoFailNote, setAutoFailNote] = useState("");
  useEffect(() => {
    for (const evt of events.slice(-20)) {
      if (evt.type !== "ocr.permission.autoFailed") continue;
      const p = evt.properties as { sessionID?: string; permissionID?: string; action?: string };
      if (p?.sessionID !== sessionId || !p?.permissionID) continue;
      if (autoFailedRef.current.has(p.permissionID)) continue;
      autoFailedRef.current.add(p.permissionID);
      setAutoFailNote(t("autoFailed", { action: p.action ?? "action" }));
    }
  }, [events, sessionId]);

  // P2-049: follow the tail only when the reader is already at the bottom;
  // otherwise surface a "go to end" affordance instead of stealing the scroll.
  // P3-083: JS scrolls honor prefers-reduced-motion like the CSS animations do.
  useEffect(() => {
    if (!atBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: scrollBehavior() });
  }, [bubbles, sending, liveText, liveThinking]);

  const lastScrollTop = useRef(0);
  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const st = el.scrollTop;
    // upward intent = the reader moved the viewport up themselves; programmatic
    // scrolls at open (0 -> tail anchor) always move it down
    const scrollingUp = st < lastScrollTop.current - 1;
    lastScrollTop.current = st;
    const nearBottom = el.scrollHeight - st - el.clientHeight < 48;
    if (nearBottom !== atBottomRef.current) {
      atBottomRef.current = nearBottom;
      setAtBottom(nearBottom);
    }
    pageOlder(scrollingUp);
  }

  function jumpToEnd() {
    atBottomRef.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: scrollBehavior() });
  }

  // switching conversations starts the reader at the tail again
  useEffect(() => {
    atBottomRef.current = true;
    setAtBottom(true);
  }, [sessionId]);

  // P3-053: dock unread badge (Claude Desktop parity). The pure reducer in
  // lib/unread.ts owns the count: focused at the tail ⇒ 0, an arrival while
  // blurred or scrolled away ⇒ +1, focusing or jumping to the tail ⇒ 0. The
  // shell bridge pushes it to app.setBadgeCount on every change.
  const [unread, dispatchUnread] = useReducer(
    reduceUnread,
    initialUnreadState(document.hasFocus(), true),
  );
  useEffect(() => {
    const onFocus = () => dispatchUnread({ kind: "focus" });
    const onBlur = () => dispatchUnread({ kind: "blur" });
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
  useEffect(() => {
    dispatchUnread({ kind: "atEnd", atEnd: atBottom });
  }, [atBottom]);
  // A new conversation starts fully read — the old session's count must not
  // leak into the fresh one.
  useEffect(() => {
    dispatchUnread({ kind: "reset" });
  }, [sessionId]);
  // Bump only on genuine tail appends: a history refetch or an older-page
  // prepend rebuilds the array (different first bubble), and the initial
  // 0→N load fires while the anchor is still empty — none of those are
  // "messages arriving".
  const tailAnchor = useRef<{ len: number; first: Bubble | undefined }>({ len: 0, first: undefined });
  useEffect(() => {
    const prev = tailAnchor.current;
    const tailAppend = prev.len > 0 && bubbles.length > prev.len && bubbles[0] === prev.first;
    tailAnchor.current = { len: bubbles.length, first: bubbles[0] };
    if (tailAppend) dispatchUnread({ kind: "message" });
  }, [bubbles]);
  useEffect(() => {
    sendUnreadToShell(unread.count);
  }, [unread.count]);

  // keep the render window bounded on very long conversations
  useEffect(() => {
    if (bubbles.length - winStart > MSG_WINDOW + 60) {
      setWinStart(Math.max(0, bubbles.length - MSG_WINDOW));
    }
  }, [bubbles.length, winStart]);

  // after paging in older bubbles, restore the scroll position the user was at
  useEffect(() => {
    if (prePagingHeight.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight - prePagingHeight.current;
      prePagingHeight.current = 0;
    }
  }, [winStart, bubbles.length]);

  function pageOlder(scrollingUp: boolean) {
    const el = listRef.current;
    if (!el) return;
    if (winStart === 0) {
      // server paging fires only on genuine upward reading — never on the
      // initial render, where scrollTop starts at 0 before the tail anchor
      // (that burst fetched three pages on every session open)
      if (hasMore && !atBottomRef.current && scrollingUp && el.scrollTop < 40) {
        void loadMore();
      }
      return;
    }
    if (el.scrollTop < 40) {
      prePagingHeight.current = el.scrollHeight;
      setWinStart(Math.max(0, winStart - 100));
    }
  }

  const activity = (() => {
    if (!showActivity) return [];
    const map = new Map<string, ToolActivity>();
    for (const [id, t] of historyTools) map.set(id, t);
    for (const evt of events) {
      const p = evt.properties as {
        sessionID?: string;
        part?: {
          type?: string;
          callID?: string;
          tool?: string;
          state?: { status?: string; title?: string; output?: string };
        };
      };
      if (p?.sessionID !== sessionId) continue;
      const part = p.part;
      if (part?.type !== "tool" || !part.callID) continue;
      map.set(part.callID, {
        tool: part.tool ?? "tool",
        status: part.state?.status ?? "",
        title: part.state?.title ?? "",
        output: part.state?.output ?? "",
      });
    }
    return [...map.entries()].reverse();
  })();

  // P1-082: actionable cards come from the daemon's pending list; every ask
  // seen in the event buffer that is no longer pending becomes a collapsed
  // resolved line. 10 duplicate events for one request → one card.
  const { actionable: pending, resolved: resolvedPerms } = reconcilePermissionCards(
    collectPermissionAsks(events.slice(-50), sessionId),
    persistedAsks,
    responded,
    autoMode,
  );

  // agent questions (question.asked / replied / rejected) — live events win,
  // persisted list (GET /question) covers asks that predate the view
  const questions: QuestionReq[] = (() => {
    const answered = new Set(qResponded);
    const live = new Map<string, QuestionReq>();
    for (const evt of events.slice(-50)) {
      if (evt.type === "question.asked") {
        const p = evt.properties as { sessionID?: string; id?: string; questions?: QuestionInfo[] };
        if (p?.sessionID === sessionId && p?.id)
          live.set(p.id, { requestID: p.id, questions: p.questions ?? [] });
      } else if (evt.type === "question.replied" || evt.type === "question.rejected") {
        const p = evt.properties as { requestID?: string };
        if (p?.requestID) {
          answered.add(p.requestID);
          live.delete(p.requestID);
        }
      }
    }
    const out = [...live.values()];
    for (const pq of persistedQuestions) {
      if (!answered.has(pq.requestID) && !live.has(pq.requestID)) out.push(pq);
    }
    return out.filter((q) => !answered.has(q.requestID));
  })();

  async function showDiff(ask: PermissionAsk) {
    setDiff({ ask, loading: true, files: [] });
    try {
      const res = await request(
        "GET",
        `/session/${sessionId}/diff`,
        undefined,
        ask.messageID ? { messageID: ask.messageID } : undefined,
      );
      const files = res.body as DiffFile[];
      setDiff({
        ask,
        loading: false,
        files: Array.isArray(files) ? files : [],
        err: Array.isArray(files) ? undefined : "diff unavailable",
      });
    } catch (err) {
      setDiff({ ask, loading: false, files: [], err: err instanceof Error ? err.message : String(err) });
    }
  }

  const queueKey = `ocr.queue.${sessionId}`;
  const [queue, setQueue] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(queueKey) ?? "[]") as string[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      setQueue(JSON.parse(localStorage.getItem(queueKey) ?? "[]") as string[]);
    } catch {
      setQueue([]);
    }
  }, [sessionId, queueKey]);

  const enqueue = (text: string) => {
    setQueue((prev) => {
      const q = [...prev, text];
      localStorage.setItem(queueKey, JSON.stringify(q));
      return q;
    });
  };

  const flushingRef = useRef(false);
  useEffect(() => {
    if (connStatus !== "paired" || queue.length === 0 || flushingRef.current) return;
    flushingRef.current = true;
    const next = [...queue];
    localStorage.setItem(queueKey, JSON.stringify([]));
    setQueue([]);
    void (async () => {
      for (const text of next) {
        await new Promise((r) => setTimeout(r, 300));
        await send(text);
      }
      flushingRef.current = false;
    })();
  }, [connStatus, queue.length, sessionId]);

  async function respond(permissionID: string, response: "approve" | "reject") {    setResponded((prev) => new Set(prev).add(permissionID));
    try {
      const res = await request("POST", `/session/${sessionId}/permissions/${permissionID}`, {
        response: response === "approve" ? "once" : "reject",
      });
      if (res.status !== 200) {
        if (isPermissionResolvedElsewhere(res.status)) {
          // P1-082: the ask was already answered (another device or AutoMode) —
          // friendly inline note instead of the raw `approve failed (404)`
          setPersistedAsks((prev) => prev.filter((p) => p.permissionID !== permissionID));
          setAutoNote(t("alreadyResolved"));
          return;
        }
        setResponded((prev) => {
          const next = new Set(prev);
          next.delete(permissionID);
          return next;
        });
        setError(`approve failed (${res.status}): ${JSON.stringify(res.body).slice(0, 140)}`);
      } else {
        setPersistedAsks((prev) => prev.filter((p) => p.permissionID !== permissionID));
      }
    } catch (err) {
      setResponded((prev) => {
        const next = new Set(prev);
        next.delete(permissionID);
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const [canUnrevert, setCanUnrevert] = useState(false);
  async function revertTo(messageID: string) {
    if (!window.confirm(t("rewindConfirm"))) return;
    try {
      const res = await request("POST", `/session/${sessionId}/revert`, { messageID });
      if (res.status !== 200) {
        setError(`revert failed (${res.status}): ${JSON.stringify(res.body).slice(0, 140)}`);
        return;
      }
      setCanUnrevert(true);
      setAutoNote(t("rewound"));
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function unrevert() {
    try {
      const res = await request("POST", `/session/${sessionId}/unrevert`, {});
      if (res.status !== 200) {
        setError(`unrevert failed (${res.status})`);
        return;
      }
      setCanUnrevert(false);
      setAutoNote(t("unreverted"));
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function toggleOption(requestID: string, qi: number, label: string, multiple?: boolean) {    setQSel((prev) => {
      const req = prev[requestID] ?? {};
      const cur = req[qi] ?? [];
      const next = multiple
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? []
          : [label];
      return { ...prev, [requestID]: { ...req, [qi]: next } };
    });
  }

  async function answerQuestion(requestID: string, qs: QuestionInfo[]) {
    const perQ = qSel[requestID] ?? {};
    const perC = qCustom[requestID] ?? {};
    const answers = qs.map((q, i) => {
      const sel = perQ[i] ?? [];
      if (sel.length === 0 && q.custom && (perC[i] ?? "").trim()) return [(perC[i] ?? "").trim()];
      return sel;
    });
    setQResponded((prev) => new Set(prev).add(requestID));
    try {
      const res = await request("POST", `/question/${requestID}/reply`, { answers });
      if (res.status !== 200) {
        setQResponded((prev) => {
          const next = new Set(prev);
          next.delete(requestID);
          return next;
        });
        setError(`answer failed (${res.status}): ${JSON.stringify(res.body).slice(0, 140)}`);
      } else {
        setPersistedQuestions((prev) => prev.filter((q) => q.requestID !== requestID));
      }
    } catch (err) {
      setQResponded((prev) => {
        const next = new Set(prev);
        next.delete(requestID);
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function rejectQuestion(requestID: string) {    setQResponded((prev) => new Set(prev).add(requestID));
    try {
      const res = await request("POST", `/question/${requestID}/reject`, {});
      if (res.status !== 200) {
        setQResponded((prev) => {
          const next = new Set(prev);
          next.delete(requestID);
          return next;
        });
      } else {
        setPersistedQuestions((prev) => prev.filter((q) => q.requestID !== requestID));
      }
    } catch {
      setQResponded((prev) => {
        const next = new Set(prev);
        next.delete(requestID);
        return next;
      });
    }
  }

  // flip the newest in-flight user bubble to delivered / queued
  function markPending(v: boolean | "queued") {
    setBubbles((bs) => {
      let idx = -1;
      for (let i = bs.length - 1; i >= 0; i--) {
        if (bs[i]?.pending) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return bs;
      return bs.map((b, i) => (i === idx ? { ...b, pending: v } : b));
    });
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if ((!text && images.length === 0) || sending || liveText || liveThinking) return;
    // the reader's own message always lands on the newest tail
    atBottomRef.current = true;
    setAtBottom(true);
    setSending(true);
    setError("");
    // P1-088: clears ONLY the sending session's draft (it is the current one
    // at click time) — a half-typed draft in another session is never wiped.
    updateInput("");
    setBubbles((b) => [
      ...b,
      {
        role: "user",
        text:
          text ||
          (images.length ? `[image${images.length > 1 ? `s x${images.length}` : ""}]` : ""),
        pending: true,
      },
    ]);
    try {
      const attached = [...images];
      const buildBody = (): Record<string, unknown> => {
        const fileParts = attached.map((img) => ({
          type: "file",
          mime: img.mime,
          filename: img.filename,
          url: `ocr-upload://${img.id}`,
        }));
        const parts: unknown[] = [...fileParts];
        if (text) parts.push({ type: "text", text });
        const sel = model ? models.find((m) => `${m.providerID}/${m.modelID}` === model) : null;
        const body: Record<string, unknown> = { parts };
        if (sel) body.model = { providerID: sel.providerID, modelID: sel.modelID };
        if (agent) body.agent = agent;
        return body;
      };
      setImages([]);
      let body = buildBody();
      let res = await request("POST", `/session/${sessionId}/message`, body);
      // attachments age out of the daemon (30min TTL, or a daemon restart):
      // re-upload whatever we still hold in memory and retry once
      if (res.status === 410 && attached.some((img) => img.raw)) {
        for (const img of attached) {
          if (!img.raw) continue;
          img.id = await uploadBytes(img.raw, img.mime, img.filename);
        }
        body = buildBody();
        res = await request("POST", `/session/${sessionId}/message`, body);
      }
      if (res.status !== 200) {
        setError(`opencode responded ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
        markPending(false);
        if (text && res.status >= 500) setRetryText(text);
      } else {
        markPending(false);
        setRetryText("");
        if (text) {
          // first prompt names the conversation (once per session)
          const flag = `ocr.titled.${sessionId}`;
          if (!localStorage.getItem(flag)) {
            localStorage.setItem(flag, "1");
            void (async () => {
              try {
                const s = await request("GET", `/session/${sessionId}`);
                const cur = sessionTitleOf(s.body);
                if (cur && cur !== "New session" && cur !== "Remote session") return;
                const t = text.replace(/\s+/g, " ").trim().slice(0, 60);
                if (t) {
                  await request("PATCH", `/session/${sessionId}`, { title: t });
                  // refresh the header, unless the user already switched sessions
                  if (sessionIdRef.current === sessionId) setSessionTitle(t);
                }
              } catch {}
            })();
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (text) {
        enqueue(text);
        markPending("queued");
        setError(`offline — message queued (${msg})`);
      } else {
        markPending(false);
        setError(msg);
      }
    } finally {
      setSending(false);
    }
  }

  const CHUNK = 500_000;

  async function downscaleImage(file: File): Promise<{ bytes: Uint8Array; mime: string }> {
    const img = await createImageBitmap(file);
    const max = 1568;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.75));
    if (!blob) throw new Error("image processing failed");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
  }

  async function attachFile(file: File) {
    if (file.type.startsWith("video/")) return void stageVideo(file);
    return void attachImage(file);
  }

  async function stageVideo(file: File) {
    const dur = await videoDuration(file);
    if (!dur) throw new Error("empty video");
    setTrimStart("0");
    setTrimEnd(String(Math.round(dur * 10) / 10));
    setPendingVideo({ file, dur });
  }

  async function videoDuration(file: File): Promise<number> {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.preload = "metadata";
    await new Promise<void>((res) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => res();
    });
    URL.revokeObjectURL(url);
    return v.duration || 0;
  }

  function confirmTrim(useTrim: boolean) {
    if (!pendingVideo) return;
    const { file, dur } = pendingVideo;
    setPendingVideo(null);
    const start = useTrim ? Math.max(0, Number(trimStart) || 0) : 0;
    const end = useTrim ? Math.min(dur, Number(trimEnd) || dur) : dur;
    void processVideo(file, start, end);
  }

  async function uploadBytes(
    bytes: Uint8Array,
    mime: string,
    filename: string,
    kind?: "inline" | "file",
  ): Promise<string> {
    const id = crypto.randomUUID();
    for (let i = 0; i * CHUNK < bytes.length || i === 0; i++) {
      const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      const res = await request("POST", "/__ocr/upload/chunk", { id, idx: i, data: b64Of(slice) });
      if (res.status !== 200) throw new Error("upload failed");
    }
    const res = await request("POST", "/__ocr/upload/complete", { id, mime, filename, kind });
    if (res.status !== 200) {
      throw new Error(String((res.body as { error?: string }).error ?? "upload failed"));
    }
    const body = res.body as { url?: string; path?: string };
    return kind === "file" ? body.path! : body.url!.replace(/^ocr-upload:\/\/+/, "");
  }

  async function extractFrames(file: File, start: number, end: number): Promise<PendingImage[]> {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    await new Promise<void>((res, rej) => {
      video.onloadedmetadata = () => res();
      video.onerror = () => rej(new Error("cannot read video"));
    });
    const span = Math.min(end - start, 60);
    if (span <= 0) throw new Error("empty video");
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = canvas.getContext("2d")!;
    await video.play().catch(() => {});
    const out: PendingImage[] = [];
    const stamp = Date.now();
    for (let i = 0; i < 4; i++) {
      video.currentTime = Math.min(end - 0.05, start + (span * i) / 4 + 0.1);
      await new Promise<void>((res) => {
        video.onseeked = () => res();
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.7));
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length) continue;
      out.push({
        id: "",
        mime: "image/jpeg",
        filename: `frame-${stamp}-${i + 1}.jpg`,
        thumb: canvas.toDataURL("image/jpeg", 0.4),
        raw: bytes,
      });
    }
    video.pause();
    URL.revokeObjectURL(url);
    return out;
  }

  async function extractAudio(file: File, start: number, end: number): Promise<Blob | null> {
    try {
      const ac = new AudioContext();
      const decoded = await ac.decodeAudioData(await file.arrayBuffer());
      await ac.close();
      const secs = Math.min(end - start, 120);
      if (secs < 0.1) return null;
      const off = new OfflineAudioContext(1, Math.ceil(secs * 16000), 16000);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start(0, start, secs);
      const rendered = await off.startRendering();
      return new Blob([encodeWav(rendered.getChannelData(0), 16000)], { type: "audio/wav" });
    } catch {
      return null;
    }
  }

  async function processVideo(file: File, start: number, end: number) {
    // P1-088: pin the origin session — the async result must land in the
    // session's draft where the action started, never in another conversation
    const sid = sessionId;
    setUploading(true);
    setError("");
    try {
      const audio = await extractAudio(file, start, end);
      if (audio) {
        const text = await transcribe(audio);
        if (text) appendToInput(text, sid);
      }
      const frames = await extractFrames(file, start, end);
      for (const f of frames) {
        const id = await uploadBytes(f.raw!, f.mime, f.filename);
        setImages((prev) => [...prev.slice(-3), { ...f, id }]);
      }
      const path = await uploadBytes(
        new Uint8Array(await file.arrayBuffer()),
        file.type || "video/mp4",
        file.name || "video.mp4",
        "file",
      );
      const trimmed = end - start < (await videoDuration(file)) - 0.5;
      const note = trimmed
        ? `[trim ${start.toFixed(1)}-${end.toFixed(1)}s — full video saved at ${path}; use ffmpeg to cut or inspect]`
        : `[full video saved at ${path} — use ffmpeg to inspect frame by frame]`;
      appendToInput(note, sid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function attachImage(file: File) {
    setUploading(true);
    setError("");
    try {
      const { bytes, mime } = await downscaleImage(file);
      const filename = `image-${Date.now()}.jpg`;
      const id = await uploadBytes(bytes, mime, filename);
      setImages((prev) => [
        ...prev.slice(-3),
        { id, mime, filename, thumb: URL.createObjectURL(file), raw: bytes },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  function b64Of(bytes: Uint8Array): string {
    let s = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      s += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    return btoa(s);
  }

  async function transcribe(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = crypto.randomUUID();
    for (let i = 0; i * CHUNK < bytes.length || i === 0; i++) {
      const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
      const res = await request("POST", "/__ocr/transcribe/chunk", {
        id,
        idx: i,
        data: b64Of(slice),
      });
      if (res.status !== 200) throw new Error("audio upload failed");
    }
    const res = await request(
      "POST",
      "/__ocr/transcribe",
      { id, lang: getVoiceSettings().lang },
      undefined,
      180_000,
    );
    if (res.status !== 200) {
      throw new Error(String((res.body as { error?: string }).error ?? "transcription failed"));
    }
    return String((res.body as { text?: string }).text ?? "");
  }

  async function micDown() {
    setError("");
    try {
      recorder.current = new WavRecorder();
      await recorder.current.start();
      downAt.current = Date.now();
      setRecState("rec");
    } catch (err) {
      micError(err);
    }
  }

  async function micUp() {
    // P1-088: pin the origin session for the async transcription append
    const sid = sessionId;
    try {
      setRecState("busy");
      const blob = await recorder.current!.stop();
      const text = await transcribe(blob);
      if (getVoiceSettings().autoSend && text.trim()) {
        await send(text);
      } else if (text) {
        appendToInput(text, sid);
      }
      setRecState("idle");
    } catch (err) {
      micError(err);
      setRecState("idle");
    }
  }

  function micError(err: unknown) {
    const e = err as Error & { name?: string };
    if (e.name === "NotAllowedError") {
      setError("microphone denied — allow it once in iOS Settings → Apps → Safari → Microphone, then reload");
    } else if (e.name === "NotFoundError") {
      setError("no microphone found on this device");
    } else {
      setError(e.message ?? String(e));
    }
    setRecState("idle");
  }

  // P1-079: pinned recap — the session summary when the backend provides one,
  // else the first sentence of the last assistant message.
  let lastAssistant = "";
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    if (b && b.role === "assistant" && b.text?.trim()) {
      lastAssistant = b.text;
      break;
    }
  }
  const recap = sessionSummary ? firstSentence(sessionSummary) : firstSentence(lastAssistant);

  return (
    <div className={`screen${splitOpen ? " artifact-split" : ""}`}>
      <header>
        <button className="chat-back" onClick={onBack}>←</button>
        <h1
          title={sessionTitle}
          style={{
            fontSize: "0.9rem",
            margin: 0,
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {sessionTitle || t("sessionFallback")}
        </h1>
        {ctx && (
          <div
            className="ctx-gauge"
            data-level={pressureLevel(ctx.pct)}
            aria-label={t("ctxGauge")}
            title={t("ctxGaugeDetail", {
              pct: Math.round(ctx.pct),
              tokens: ctx.tokens.toLocaleString(),
              window: ctx.window.toLocaleString(),
            })}
          >
            <span className="ctx-gauge-bar" aria-hidden>
              <span
                className="ctx-gauge-fill"
                style={{ width: `${Math.max(2, Math.min(100, ctx.pct))}%` }}
              />
            </span>
            <span className="ctx-gauge-label">{Math.round(ctx.pct)}%</span>
          </div>
        )}
        <button
          className="chat-handoff"
          onClick={() => void handoffToDesktop()}
          aria-label={t("handoffBtn")}
          title={t("handoffBtn")}
        >
          <IconLaptop />
        </button>
        <button
          onClick={() => void exportChat()}
          disabled={exporting}
          aria-label={t("exportBtn")}
          title={t("exportBtn")}
        >
          {exporting ? "…" : <IconDownload />}
        </button>
        <button
          onClick={() => {
            setShowActivity((v) => !v);
            ensureToolHistory();
          }}
          aria-label={t("toolActivity")}
          style={showActivity ? { borderColor: "var(--accent)" } : undefined}
        >
          <IconWrench />
        </button>
      </header>

      {connStatus !== "paired" && (
        <div className="conn-banner" role="status" title={t("connTitle", { status: connStatus })}>
          <span className="conn-banner-spin" aria-hidden>⟳</span>{" "}
          {t("reconnecting", { n: Math.max(connAttempts, 1) })}
        </div>
      )}

      <div
        className="chat-row"
        ref={chatRowRef}
        style={draggingSplit ? { userSelect: "none", cursor: "col-resize" } : undefined}
      >
        <div className="chat">
        <div className="msg-wrap">
        <div className="messages" ref={listRef} onScroll={handleScroll}>
          {loadingHistory && bubbles.length === 0 && (
            <>
              <div className="skel" style={{ width: "55%", height: 40, alignSelf: "flex-end" }} />
              <div className="skel" style={{ width: "80%", height: 64 }} />
              <div className="skel" style={{ width: "45%", height: 40 }} />
              <div className="skel" style={{ width: "70%", height: 64 }} />
            </>
          )}
          {!loadingHistory && bubbles.length === 0 && !liveText && !liveThinking && !historyError && (
            <div className="chat-empty">
              <span className="chat-empty-icon" aria-hidden>
                <IconChat />
              </span>
              <p className="chat-empty-title">{t("emptyTitle")}</p>
              <p className="chat-empty-hint">{t("emptyHint")}</p>
            </div>
          )}
          {historyError && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px auto" }}>
              <p style={{ color: "var(--danger)", margin: 0, flex: 1, minWidth: 0 }}>
                {t("historyRetry")}
                <span
                  style={{ display: "block", fontSize: "0.75rem", color: "var(--muted)" }}
                >
                  {humanizeError(historyError, t)}
                </span>
              </p>
              <button
                style={{ padding: "6px 10px", flexShrink: 0 }}
                onClick={() => {
                  setHistoryError("");
                  setLoadingHistory(true);
                  void loadHistory();
                }}
              >
                {t("retry")}
              </button>
            </div>
          )}
          {winStart > 0 && (
            <div className="muted" style={{ textAlign: "center", fontSize: "0.75rem" }}>
              ↑ {t("olderMessages", { n: winStart })}
            </div>
          )}
          {winStart === 0 && hasMore && !loadingHistory && (
            <button
              className="chip"
              style={{ margin: "4px auto 8px", display: "block" }}
              disabled={paging}
              onClick={() => void loadMore()}
            >
              {paging ? "…" : t("loadMore")}
            </button>
          )}
          {bubbles.slice(winStart).map((b, i) => (
            <div
              key={i}
              className={`msg ${b.role}${b.pending ? " pending" : ""}`}
              title={b.pending === "queued" ? t("queuedTitle") : undefined}
            >
              {b.images && b.images.length > 0 && (
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: b.text ? 4 : 0 }}>
                  {b.images.map((u, j) => (
                    <img
                      key={j}
                      src={u}
                      alt=""
                      loading="lazy"
                      style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }}
                    />
                  ))}
                </div>
              )}
              {b.role === "assistant" && b.thinking && (
                <ThinkingBlock
                  text={b.thinking.text}
                  label={
                    b.thinking.secs
                      ? t("thoughtFor", { n: b.thinking.secs })
                      : t("thoughtLabel")
                  }
                  streaming={false}
                />
              )}
              {renderBubbleText(b.text, request, setError)}
              {b.role === "assistant" &&
                artifactMentions(b.text, artifacts).map((a) => (
                  <button
                    key={a.name}
                    className="card artifact-card"
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      padding: "6px 10px",
                      marginTop: 4,
                      width: "100%",
                    }}
                    onClick={() => {
                      setArtifactView(a);
                      // manual pick replaces the auto pane (without dismissal —
                      // the user is still engaging with artifacts)
                      setAutoArtifact(null);
                    }}
                    title={t("openArtifact")}
                  >
                    <span aria-hidden className="artifact-icon">
                      <ArtifactIcon kind={a.kind} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        textAlign: "left",
                      }}
                    >
                      {a.name}
                    </span>
                    <span className="muted" style={{ fontSize: "0.72rem" }}>
                      {a.kind}
                    </span>
                  </button>
                ))}
              {b.role === "user" && b.messageID && (
                <button
                  className="muted"
                  style={{ fontSize: "0.7rem", padding: "1px 6px", marginTop: 2, opacity: 0.7 }}
                  onClick={() => void revertTo(b.messageID!)}
                >
                  {t("rewindBtn")}
                </button>
              )}
            </div>
          ))}
          {(liveText || liveThinking) && (
            <div className="msg assistant" aria-live="polite">
              {liveThinking && (
                <ThinkingBlock
                  text={liveThinking.text}
                  label={
                    liveThinking.endedAt
                      ? t("thoughtFor", { n: thinkingSeconds(liveThinking) })
                      : t("thinkingLive")
                  }
                  streaming={!liveThinking.endedAt}
                />
              )}
              {liveText && (
                <>
                  {renderBubbleText(liveText, request, setError)}
                  <span className="caret" aria-hidden />
                </>
              )}
            </div>
          )}
          {sending && !liveText && !liveThinking && (
            <div className="msg assistant">
              <div className="typing">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
          {(sending || liveText || !!liveThinking) && (
            <button
              className="danger"
              style={{ margin: "4px auto", display: "block" }}
              onClick={() => void request("POST", `/session/${sessionId}/abort`)}
            >
              {t("stop")}
            </button>
          )}
          <div ref={bottomRef} />
        </div>

        {!atBottom && (
          <button
            className="jump-end"
            onClick={jumpToEnd}
            aria-label={t("jumpToEnd")}
            title={t("jumpToEnd")}
          >
            ↓
          </button>
        )}
        </div>

        {questions.length > 0 && (
          <div className="card">
            {questions.map((qr) => {
              const perQ = qSel[qr.requestID] ?? {};
              const perC = qCustom[qr.requestID] ?? {};
              const allAnswered = qr.questions.every(
                (q, i) =>
                  (perQ[i]?.length ?? 0) > 0 || (q.custom && (perC[i] ?? "").trim() !== ""),
              );
              return (
                <div key={qr.requestID} style={{ marginBottom: 12 }}>
                  {qr.questions.map((q, qi) => {
                    const sel = perQ[qi] ?? [];
                    return (
                      <div key={qi} style={{ marginBottom: 10 }}>
                        <p style={{ margin: "0 0 2px" }}>
                          <b>{q.header}</b>
                        </p>
                        <p style={{ margin: "0 0 6px" }}>{q.question}</p>
                        {q.options.map((o) => (
                          <label key={o.label} style={{ display: "block" }}>
                            <input
                              type={q.multiple ? "checkbox" : "radio"}
                              name={`${qr.requestID}-${qi}`}
                              checked={sel.includes(o.label)}
                              onChange={() => toggleOption(qr.requestID, qi, o.label, q.multiple)}
                            />{" "}
                            {o.label}
                            {o.description && (
                              <span className="muted"> — {o.description}</span>
                            )}
                          </label>
                        ))}
                        {q.custom && (
                          <input
                            style={{ marginTop: 4 }}
                            placeholder={t("customAnswer")}
                            value={perC[qi] ?? ""}
                            onChange={(e) =>
                              setQCustom((prev) => ({
                                ...prev,
                                [qr.requestID]: { ...(prev[qr.requestID] ?? {}), [qi]: e.target.value },
                              }))
                            }
                          />
                        )}
                      </div>
                    );
                  })}
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="primary"
                      disabled={!allAnswered}
                      onClick={() => void answerQuestion(qr.requestID, qr.questions)}
                    >
                      {t("answer")}
                    </button>
                    <button className="danger" onClick={() => void rejectQuestion(qr.requestID)}>
                      {t("skip")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {pending.length > 0 && (
          <div className="card">
        {pending.map((p) => (
          <div
            key={p.permissionID}
            style={
              p.autoFailed
                ? {
                    marginBottom: 8,
                    border: "1px solid var(--danger)",
                    borderRadius: 8,
                    padding: "6px 8px",
                  }
                : { marginBottom: 8 }
            }
          >
            {p.preview && (
              <pre
                style={{
                  margin: "0 0 6px",
                  padding: "6px 8px",
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  fontSize: "0.72rem",
                  lineHeight: 1.45,
                  overflowX: "auto",
                  maxWidth: "100%",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--muted)",
                }}
              >
                {p.preview}
              </pre>
            )}
            <div className="approval">
              <span style={{ flex: 1 }}>
                {t("approve")} <b>{p.label}</b>?
              </span>
              <button onClick={() => void showDiff(p)}>diff</button>
              <button className="primary" onClick={() => void respond(p.permissionID, "approve")}>
                {t("approve")}
              </button>
              <button className="danger" onClick={() => void respond(p.permissionID, "reject")}>
                {t("deny")}
              </button>
            </div>
          </div>
        ))}
          </div>
        )}

        {autoMode && (
          <p className="muted" role="status" style={{ fontSize: "0.72rem", margin: "4px 0" }}>
            {t("autoBadge")}
          </p>
        )}
        {autoFailNote && pending.some((p) => p.autoFailed) && (
          <p
            className="auto-fail-note"
            role="alert"
            style={{ color: "var(--danger)", fontSize: "0.72rem", margin: "4px 0" }}
          >
            {autoFailNote}
          </p>
        )}
        {resolvedPerms.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2, margin: "4px 0" }}>
            {resolvedPerms.map((r) => (
              <div
                key={r.permissionID}
                className="muted"
                style={{
                  display: "flex",
                  gap: 6,
                  fontSize: "0.72rem",
                  minWidth: 0,
                  alignItems: "baseline",
                }}
              >
                <span aria-hidden>·</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.label} — {r.origin === "auto" ? t("permAutoLine") : t("permResolvedLine")}
                </span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <p style={{ color: "var(--danger)", margin: 0, flex: 1, minWidth: 0 }}>{humanizeError(error, t)}</p>
            {retryText && (
              <button
                className="danger"
                style={{ padding: "6px 10px", flexShrink: 0 }}
                onClick={() => {
                  const text = retryText;
                  setRetryText("");
                  setError("");
                  void send(text);
                }}
              >
                {t("retry")}
              </button>
            )}
          </div>
        )}
        {autoNote && (
          <p style={{ color: "var(--muted)", margin: 0 }}>✔ {autoNote}</p>
        )}
        {canUnrevert && (
          <button style={{ margin: "2px 0" }} onClick={() => void unrevert()}>
            {t("unrevert")}
          </button>
        )}
        {queue.length > 0 && (
          <p className="muted" style={{ margin: 0 }}>
            {t("queued", { n: queue.length })}
          </p>
        )}

        <input
          ref={fileRef}
          className="composer-file"
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void (async () => {
              for (const f of files) {
                await attachFile(f).catch((err) =>
                  setError(err instanceof Error ? err.message : String(err)),
                );
              }
            })();
          }}
        />

        {pendingVideo && (
          <div
            className="card"
            style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: 8 }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 100,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: "0.8rem",
              }}
            >
              {pendingVideo.file.name}
            </span>
            <input
              type="number"
              step="0.1"
              min={0}
              max={pendingVideo.dur}
              style={{ width: 64, padding: "6px 8px" }}
              value={trimStart}
              onChange={(e) => setTrimStart(e.target.value)}
              aria-label={t("trimStart")}
            />
            <span className="muted">→</span>
            <input
              type="number"
              step="0.1"
              min={0}
              max={pendingVideo.dur}
              style={{ width: 64, padding: "6px 8px" }}
              value={trimEnd}
              onChange={(e) => setTrimEnd(e.target.value)}
              aria-label={t("trimEnd")}
            />
            <button className="primary" onClick={() => confirmTrim(true)}>
              {t("attach")}
            </button>
            <button onClick={() => confirmTrim(false)}>{t("full")}</button>
          </div>
        )}

        {skills.length > 0 && (
          <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 2 }}>
            {skills.map((s) => (
              <button
                key={s.id}
                style={{
                  whiteSpace: "nowrap",
                  fontSize: "0.78rem",
                  padding: "6px 12px",
                  borderRadius: 16,
                  flexShrink: 0,
                }}
                disabled={sending || !!liveText || !!liveThinking}
                onClick={() => void send(s.prompt)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}


        <div className="composer">
          {images.length > 0 && (
            <div className="composer-atts">
              {images.map((img) => (
                <span key={img.id} className="composer-att">
                  <img src={img.thumb} alt="" className="composer-att-thumb" />
                  <span className="composer-att-name">{img.filename}</span>
                  <button
                    className="composer-att-x"
                    onClick={() => setImages((prev) => prev.filter((i) => i.id !== img.id))}
                    aria-label={t("removeImage")}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="composer-text"
            rows={1}
            placeholder={recState === "rec" ? t("recording") : t("messagePlaceholder")}
            value={input}
            onChange={(e) => updateInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-bar">
            <button
              className="composer-btn composer-attach"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || recState === "busy"}
              aria-label={t("attachFile")}
              title={t("attachFile")}
            >
              {uploading ? "…" : <IconPlus />}
            </button>
            <button
              className="composer-btn composer-mic"
              onPointerDown={(e) => {
                e.preventDefault();
                if (recState === "idle") void micDown();
              }}
              onPointerUp={() => {
                if (recState !== "rec") return;
                if (tapToggle || Date.now() - downAt.current > 400) {
                  setTapToggle(false);
                  void micUp();
                } else {
                  setTapToggle(true);
                }
              }}
              disabled={!voice || recState === "busy"}
              aria-label={recState === "rec" ? t("stopRecording") : t("recordVoice")}
              title={!voice ? t("micNeedsPermission") : recState === "rec" ? t("stopRecording") : t("recordVoice")}
            >
              {recState === "busy" ? (
                "…"
              ) : recState === "rec" ? (
                <span className="composer-mic-rec" aria-hidden />
              ) : (
                <IconMic />
              )}
            </button>
            <div className="composer-spacer" />
            <div className="composer-model" ref={modelMenuRef}>
              <button
                className="composer-model-btn"
                onClick={() => setModelMenu((v) => !v)}
                aria-expanded={modelMenu}
                aria-haspopup="listbox"
                title={t("modelSelector")}
              >
                <span className="composer-model-label">
                  {composerSelectorLabel(
                    agent || t("agentOption"),
                    model ? (model.split("/")[1] ?? model) : t("defaultModel"),
                  )}
                </span>
                <IconChevronDown size={13} />
              </button>
              {modelMenu && (
                <div className="composer-menu" role="listbox" aria-label={t("modelSelector")}>
                  <div className="composer-menu-head">{t("agentMode")}</div>
                  {["build", "plan"].map((a) => (
                    <button
                      key={a}
                      role="option"
                      aria-selected={agent === a}
                      data-agent={a}
                      className={`composer-menu-item${agent === a ? " selected" : ""}`}
                      onClick={() => {
                        pickAgent(a);
                        setModelMenu(false);
                      }}
                    >
                      {a}
                    </button>
                  ))}
                  <div className="composer-menu-head">{t("model")}</div>
                  <button
                    role="option"
                    aria-selected={!model}
                    data-model=""
                    className={`composer-menu-item${!model ? " selected" : ""}`}
                    onClick={() => {
                      pickModel("");
                      setModelMenu(false);
                    }}
                  >
                    {t("defaultModel")}
                  </button>
                  {models.map((m) => (
                    <button
                      key={`${m.providerID}/${m.modelID}`}
                      role="option"
                      aria-selected={model === `${m.providerID}/${m.modelID}`}
                      data-model={`${m.providerID}/${m.modelID}`}
                      className={`composer-menu-item${model === `${m.providerID}/${m.modelID}` ? " selected" : ""}`}
                      onClick={() => {
                        pickModel(`${m.providerID}/${m.modelID}`);
                        setModelMenu(false);
                      }}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="primary composer-send"
              onClick={() => void send()}
              disabled={sending || !!liveText || !!liveThinking}
              aria-label={t("send")}
              title={liveText || liveThinking ? t("streamingWait") : t("send")}
            >
              {(liveText || liveThinking) ? "…" : <IconArrowUp size={16} />}
            </button>
          </div>
        </div>

        {recap && (
          <div className="chat-recap" title={t("recapDetail")}>
            <span className="chat-recap-label">{t("recapLabel")}</span>
            <span className="chat-recap-text">{recap}</span>
          </div>
        )}
      </div>

      {splitOpen && (
        <>
          <div
            className={`split-divider${draggingSplit ? " dragging" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("resizeSplit")}
            onPointerDown={splitDown}
            onPointerMove={splitMove}
            onPointerUp={splitUp}
            onPointerCancel={splitUp}
          >
            <span />
          </div>
          <div
            className={`artifact-pane${splitPhase === "closing" ? " out" : ""}`}
            style={{ flexBasis: `${splitPct * 100}%` }}
          >
            <ArtifactViewer
              meta={splitArtifact!}
              request={request}
              onClose={() => {
                if (artifactView) {
                  setArtifactView(null);
                } else if (autoArtifact) {
                  // P2-090: closing the auto-opened pane is a choice — the same
                  // file is not re-opened by the next idle
                  artifactDismissedRef.current.add(autoArtifact.name);
                  setAutoArtifact(null);
                }
              }}
              variant="panel"
            />
          </div>
        </>
      )}
      </div>

      {showActivity && (
        <Modal label={t("toolActivity")} z={55} onClose={() => setShowActivity(false)}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setShowActivity(false)} aria-label={t("close")}>
              ✕
            </button>
            <div style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>{t("toolActivity")}</div>
            <button onClick={() => void loadToolHistory()} aria-label={t("refreshTools")}>
              ↻
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {activity.length === 0 && <p className="muted">{t("noToolCalls")}</p>}
            {activity.map(([callID, a]) => (
              <div key={callID} className="card" style={{ padding: "8px 10px", marginBottom: 8 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span
                    style={{
                      fontSize: "0.72rem",
                      color:
                        a.status === "error"
                          ? "var(--danger)"
                          : a.status === "completed"
                            ? "var(--accent)"
                            : "inherit",
                    }}
                  >
                    {a.status === "completed" ? "✓" : a.status === "error" ? "✗" : "⏳"} {a.tool}
                  </span>
                  <span
                    className="muted"
                    style={{
                      flex: 1,
                      fontSize: "0.72rem",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.title}
                  </span>
                </div>
                {a.output && (
                  <pre
                    style={{
                      marginTop: 6,
                      marginBottom: 0,
                      fontSize: "0.68rem",
                      lineHeight: 1.4,
                      overflow: "auto",
                      maxHeight: 120,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      color: "var(--muted)",
                    }}
                  >
                    {a.output.length > 400 ? `…${a.output.slice(-400)}` : a.output}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {diff && (
        <Modal
          label={diff.loading ? t("loadingDiff") : t("changesFor", { action: diff.ask?.label ?? "…" })}
          z={60}
          onClose={() => setDiff(null)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => setDiff(null)} aria-label={t("close")}>
              ✕
            </button>
            <div style={{ flex: 1, fontWeight: 600, fontSize: "0.9rem" }}>
              {diff.loading ? t("loadingDiff") : t("changesFor", { action: diff.ask?.label ?? "…" })}
            </div>
            {diff.ask && !diff.loading && (
              <>
                <button
                  className="primary"
                  onClick={() => {
                    const id = diff.ask!.permissionID;
                    setDiff(null);
                    void respond(id, "approve");
                  }}
                >
                  {t("approve")}
                </button>
                <button
                  className="danger"
                  onClick={() => {
                    const id = diff.ask!.permissionID;
                    setDiff(null);
                    void respond(id, "reject");
                  }}
                >
                  {t("deny")}
                </button>
              </>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {diff.err && <p style={{ color: "var(--danger)" }}>{diff.err}</p>}
            {!diff.loading && !diff.err && diff.files.length === 0 && (
              <p className="muted">{t("noChanges")}</p>
            )}
            {diff.files.map((f) => (
              <div key={f.file} style={{ marginBottom: 10 }}>
                <div
                  style={{
                    fontSize: "0.75rem",
                    marginBottom: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <b>{f.status}</b> · {f.file}{" "}
                  <span className="muted">
                    (+{f.additions} −{f.deletions})
                  </span>
                </div>
                <pre
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    overflowX: "auto",
                    maxWidth: "100%", // P1-080: scroll inside the block, never the page
                    fontSize: "0.72rem",
                    lineHeight: 1.45,
                    margin: 0,
                  }}
                >
                  {f.patch.split("\n").map((l, i) => {
                    const bg = l.startsWith("+")
                      ? "color-mix(in srgb, var(--status-ok) 18%, transparent)"
                      : l.startsWith("-")
                        ? "color-mix(in srgb, var(--status-err) 18%, transparent)"
                        : undefined;
                    return (
                      <div
                        key={i}
                        style={{
                          background: bg,
                          whiteSpace: "pre",
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        }}
                      >
                        {l}
                      </div>
                    );
                  })}
                </pre>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {overlayArtifact && !wide && overlayPhase !== "closed" && (
        <ArtifactViewer
          meta={overlayArtifact}
          request={request}
          closing={overlayPhase === "closing"}
          onClose={() => setArtifactView(null)}
        />
      )}
    </div>
  );
}
