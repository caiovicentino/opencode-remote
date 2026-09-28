// eval-01: pilot → supervisor relay with honest outcomes, plus the Web Push
// fallback digest that takes over when the supervisor session is unreachable.
//
// Why: /api/pilot-notify used to POST the SYNCHRONOUS `/session/<id>/message`
// (the answer only comes after the supervisor's whole opencode turn — the
// pilot timed out at 120s on 93 attempts) and flattened every failure to a
// bare `{delivered:false}`. From 22/09 the configured supervisor session no
// longer existed (opencode answers 404 NotFoundError), so every notification
// failed permanently, the pilot parked it for a replay that could never
// succeed (100 lines in notify-pending.jsonl) and nothing reached a human.
//
// Now the relay uses opencode's `prompt_async` (204 = accepted, no turn
// wait), classifies the real reason, and on a PERMANENT failure (session
// missing, not configured, 4xx) routes failures to the phone through a
// rate-limited digest grouped by (task, kind) — the daemon owns delivery from
// then on, so the pilot stops parking messages that can never be replayed.
// Transient failures (opencode down/5xx/timeout) keep the old contract: no
// ownership, the pilot parks and replays later.
//
// Pure module: no fs, no timers, no network — index.ts injects the upstream
// POST and the push, pilotwatch.ts persists the digest state.

/** At most one fallback push per window; later items fold into the next one. */
export const DIGEST_MIN_INTERVAL_MS = 10 * 60_000;
/** The same (task, kind) is pushed at most once per cooldown (counts accumulate). */
export const DIGEST_KEY_COOLDOWN_MS = 6 * 60 * 60_000;
/** Items not pushed within this window are dropped (stale news). */
export const DIGEST_ENTRY_TTL_MS = 24 * 60 * 60_000;
/** Bound on distinct pending keys (oldest dropped first). */
export const DIGEST_MAX_ENTRIES = 50;
/** Lines shown per push; the rest is summarized as "+N outros". */
export const DIGEST_MAX_LINES = 4;
/** Upstream POST budget — prompt_async answers immediately when healthy. */
export const RELAY_UPSTREAM_TIMEOUT_MS = 15_000;

const TASK_RE = /^[A-Za-z0-9][\w.-]{0,39}$/;
const SESSION_RE = /^ses[A-Za-z0-9_-]{4,64}$/;
const TEXT_MAX = 8_000;
const LINE_MAX = 120;
const KIND_MAX = 80;

export type RelayTarget = "supervisor" | "operator";

export interface RelayRequest {
  text: string;
  task: string;
  kind: string;
  ok: boolean;
  /** Short one-line summary for the phone (falls back to the text). */
  detail: string;
  to: RelayTarget;
}

export interface RelayResult {
  /** The supervisor session accepted the prompt. */
  delivered: boolean;
  /** Closed-set reason when not delivered (see relayReasonPhrase). */
  reason?: string;
  /** The daemon took ownership: "push" = queued to the phone digest,
   *  "drop" = informational message deliberately not routed anywhere.
   *  Absent = no ownership (transient failure) — the caller may replay. */
  fallback?: "push" | "drop";
  /** The digest push went out in this call (false = held by the rate limit). */
  pushed?: boolean;
  /** Paired phones with a push subscription right now. */
  phones?: number;
}

export interface FallbackItem {
  task: string;
  kind: string;
  line: string;
  to: RelayTarget;
  /** Relay reason that sent the item to the phone (supervisor items). */
  reason?: string;
}

export interface RelayDeps {
  /** supervisorSession from pilot.json (read by the caller on every request). */
  session: string | null | undefined;
  /** POST the text to the session; resolves with the upstream status and body
   * text, rejects on transport errors (TimeoutError/AbortError on timeout). */
  post: (session: string, text: string) => Promise<{ status: number; text: string }>;
  /** Queue one item on the phone digest (flushes when due). */
  fallback: (item: FallbackItem) => Promise<{ pushed: boolean; phones: number }>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Stable dedupe kind for a notification: success vs failure plus the detail
 * with every number collapsed ("disk low: 0.1gb free" and "disk low: 2.1gb
 * free" are the same kind), lowercased and bounded. Mirrors the pilot's
 * notify.ts so both ends group identically.
 */
export function notifyKind(ok: boolean, detail: string): string {
  const norm = detail
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return `${ok ? "ok" : "fail"}:${norm}`;
}

/** Validate and bound an untrusted /api/pilot-notify body. Null = no text. */
export function sanitizeRelayBody(raw: unknown): RelayRequest | null {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = str(b.text).slice(0, TEXT_MAX);
  if (!text.trim()) return null;
  const task = TASK_RE.test(str(b.task)) ? str(b.task) : "pilot";
  const ok = b.ok === true;
  const detailRaw = str(b.detail) || text;
  const detail = oneLine(detailRaw, LINE_MAX);
  const kindRaw = str(b.kind).trim();
  const kind = kindRaw ? oneLine(kindRaw, KIND_MAX) : notifyKind(ok, detailRaw);
  const to: RelayTarget = b.to === "operator" ? "operator" : "supervisor";
  return { text, task, kind, ok, detail, to };
}

/** Permanent = retrying the same session cannot succeed until config changes. */
export function isPermanentRelayReason(reason: string): boolean {
  if (reason === "session-not-found" || reason === "no-supervisor-session" || reason === "invalid-supervisor-session") {
    return true;
  }
  const m = /^upstream-http-(\d{3})$/.exec(reason);
  return m !== null && Number(m[1]) >= 400 && Number(m[1]) < 500;
}

/** Short pt-BR phrase for a relay reason (push header, liveness detail). */
export function relayReasonPhrase(reason: string | null | undefined): string {
  switch (reason) {
    case "session-not-found":
      return "a sessão do supervisor não existe mais no opencode";
    case "no-supervisor-session":
      return "nenhuma sessão de supervisor configurada";
    case "invalid-supervisor-session":
      return "supervisorSession inválido em pilot.json";
    case "upstream-unreachable":
      return "o opencode não respondeu";
    case "upstream-timeout":
      return "o opencode demorou demais para aceitar o aviso";
    case "operator":
      return "alerta direto para o operador";
    default: {
      const m = /^upstream-http-(\d{3})$/.exec(reason ?? "");
      return m ? `o opencode recusou o aviso (HTTP ${m[1]})` : "motivo desconhecido";
    }
  }
}

function isTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  return name === "TimeoutError" || name === "AbortError" || /timeout|aborted/i.test(msg);
}

/**
 * Route one pilot notification. Never throws: every outcome is a RelayResult.
 * `to: "operator"` skips the supervisor entirely (the pilot's notifyOperator
 * hook). Supervisor failures: permanent + failure → phone digest; permanent +
 * success/info → dropped (a merge note is not worth a page); transient → no
 * ownership, so the pilot parks and replays.
 */
export async function relayPilotNotify(raw: unknown, deps: RelayDeps): Promise<RelayResult> {
  const req = sanitizeRelayBody(raw);
  if (!req) return { delivered: false, reason: "empty-text" };
  const toPhone = async (reason: string): Promise<RelayResult> => {
    try {
      const f = await deps.fallback({ task: req.task, kind: req.kind, line: `${req.task}: ${req.detail}`, to: req.to, reason });
      return { delivered: false, reason, fallback: "push", pushed: f.pushed, phones: f.phones };
    } catch {
      // the digest could not even be queued — no ownership, let the pilot park
      return { delivered: false, reason };
    }
  };
  if (req.to === "operator") return toPhone("operator");
  const session = typeof deps.session === "string" ? deps.session.trim() : "";
  let reason: string;
  if (!session) reason = "no-supervisor-session";
  else if (!SESSION_RE.test(session)) reason = "invalid-supervisor-session";
  else {
    try {
      const res = await deps.post(session, req.text);
      if (res.status >= 200 && res.status < 300) return { delivered: true };
      reason =
        res.status === 404 && /NotFoundError|session not found/i.test(res.text)
          ? "session-not-found"
          : `upstream-http-${res.status}`;
    } catch (err) {
      reason = isTimeout(err) ? "upstream-timeout" : "upstream-unreachable";
    }
  }
  if (!isPermanentRelayReason(reason)) return { delivered: false, reason };
  if (req.ok) return { delivered: false, reason, fallback: "drop" };
  return toPhone(reason);
}

// ── fallback digest ──────────────────────────────────────────────────────────

export interface DigestEntry {
  key: string;
  task: string;
  kind: string;
  to: RelayTarget;
  line: string;
  reason?: string;
  first: number;
  last: number;
  count: number;
}

export interface DigestState {
  entries: DigestEntry[];
  /** Epoch ms of the last fallback push attempt (0 = never). */
  lastPushAt: number;
  /** key → epoch ms of its last push (pruned after the cooldown). */
  keyPushedAt: Record<string, number>;
}

export function emptyDigest(): DigestState {
  return { entries: [], lastPushAt: 0, keyPushedAt: {} };
}

/** Defensive load of a persisted digest (unknown JSON → empty). */
export function normalizeDigest(raw: unknown): DigestState {
  const d = (raw && typeof raw === "object" ? raw : {}) as Partial<DigestState>;
  const entries = Array.isArray(d.entries)
    ? d.entries.filter(
        (e): e is DigestEntry =>
          !!e &&
          typeof e.key === "string" &&
          typeof e.line === "string" &&
          typeof e.first === "number" &&
          typeof e.last === "number" &&
          typeof e.count === "number",
      )
    : [];
  const keyPushedAt: Record<string, number> = {};
  if (d.keyPushedAt && typeof d.keyPushedAt === "object") {
    for (const [k, v] of Object.entries(d.keyPushedAt)) if (typeof v === "number") keyPushedAt[k] = v;
  }
  return { entries, lastPushAt: typeof d.lastPushAt === "number" ? d.lastPushAt : 0, keyPushedAt };
}

/** Fold one item in: same (task, kind) key bumps count/last and keeps the newest line. */
export function digestAdd(state: DigestState, item: FallbackItem, now: number): DigestState {
  const key = `${item.task}|${item.kind}`;
  const fresh = state.entries.filter((e) => now - e.last < DIGEST_ENTRY_TTL_MS && e.key !== key);
  const prev = state.entries.find((e) => e.key === key && now - e.last < DIGEST_ENTRY_TTL_MS);
  const entry: DigestEntry = prev
    ? { ...prev, line: item.line, reason: item.reason ?? prev.reason, to: item.to, last: now, count: prev.count + 1 }
    : { key, task: item.task, kind: item.kind, to: item.to, line: item.line, reason: item.reason, first: now, last: now, count: 1 };
  return { ...state, entries: [...fresh, entry].slice(-DIGEST_MAX_ENTRIES) };
}

export interface DigestPush {
  title: string;
  body: string;
  keys: string[];
}

function cooling(state: DigestState, key: string, now: number): boolean {
  const at = state.keyPushedAt[key];
  return typeof at === "number" && now - at < DIGEST_KEY_COOLDOWN_MS;
}

/**
 * The push due now, or null (nothing eligible, or inside the rate-limit
 * window). Keys still cooling stay pending and keep counting — they go out,
 * with their count, once the cooldown ends.
 */
export function digestPlan(state: DigestState, now: number): DigestPush | null {
  const eligible = state.entries
    .filter((e) => now - e.last < DIGEST_ENTRY_TTL_MS && !cooling(state, e.key, now))
    .sort((a, b) => a.first - b.first);
  if (eligible.length === 0) return null;
  if (state.lastPushAt > 0 && now - state.lastPushAt < DIGEST_MIN_INTERVAL_MS) return null;
  const lines = eligible
    .slice(0, DIGEST_MAX_LINES)
    .map((e) => `• ${e.line}${e.count > 1 ? ` (×${e.count})` : ""}`);
  if (eligible.length > DIGEST_MAX_LINES) lines.push(`+${eligible.length - DIGEST_MAX_LINES} outros avisos`);
  const supervisor = eligible.find((e) => e.to === "supervisor");
  const header = supervisor ? `Supervisor inacessível: ${relayReasonPhrase(supervisor.reason)}. Cópia no telefone:` : "";
  const only = eligible.length === 1 ? eligible[0]! : null;
  const title = only
    ? only.to === "operator"
      ? `⚠️ Pilot: ${only.task}`
      : `📮 Pilot: ${only.task} falhou`
    : `📮 Pilot: ${eligible.length} avisos`;
  return { title, body: [header, ...lines].filter(Boolean).join("\n"), keys: eligible.map((e) => e.key) };
}

/** Record a push attempt: pushed keys leave the queue and start cooling. */
export function digestMarkSent(state: DigestState, keys: string[], now: number): DigestState {
  const sent = new Set(keys);
  const keyPushedAt: Record<string, number> = {};
  for (const [k, at] of Object.entries(state.keyPushedAt)) {
    if (now - at < DIGEST_KEY_COOLDOWN_MS) keyPushedAt[k] = at;
  }
  for (const k of sent) keyPushedAt[k] = now;
  return {
    entries: state.entries.filter((e) => !sent.has(e.key) && now - e.last < DIGEST_ENTRY_TTL_MS),
    lastPushAt: now,
    keyPushedAt,
  };
}
