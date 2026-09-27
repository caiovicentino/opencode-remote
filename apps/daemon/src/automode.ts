/**
 * AutoMode (P1-082/P1-093): pure rules for answering opencode permission asks
 * on the owner's behalf. No I/O and no import — index.ts wires fetch,
 * broadcast and push; the unit battery drives these functions directly
 * (lesson P2-149: index.ts runs main() on import).
 *
 * eval-12 closed three silent paths:
 * 1. opencode (1.18) announces an answer as `permission.replied`
 *    {sessionID, requestID, reply}. The old inline predicate — "contains
 *    permission, not response, not revoke" — read it as an ask without an id,
 *    so every answer (manual or automatic) pushed a second "Approve needed".
 *    permissionEventFacts classifies it as a reply.
 * 2. opencode answers the approve POST with 404 when the ask is no longer
 *    pending (answered on another device, session aborted). That used to be
 *    retried and then broadcast as an AutoMode failure. It is now confronted
 *    with the pending list: gone → resolved elsewhere, no alarm; still
 *    pending (the approve route itself is gone) → a real failure.
 * 3. A real failure only reached the sockets live at that instant. A phone
 *    that reconnected later reconciled the still-pending ask as "AutoMode
 *    handles it" and hid it: the agent stalled with no card and no push. The
 *    failure now pushes, and AutoFailLedger keeps it so every client that
 *    (re)connects receives AUTO_APPROVE_FAILED_EVENT again until opencode
 *    reports the reply.
 */

/**
 * Synthetic event broadcast after the daemon answered an ask on the owner's
 * behalf. properties: { sessionID, permissionID, action }. The web client
 * matches this literal (apps/web/src/lib/permissionCards.ts, ChatView.tsx) —
 * the parity is pinned by scripts/daemon-hardening.test.ts.
 */
export const AUTO_APPROVED_EVENT = "ocr.permission.auto";

/**
 * Synthetic event for an ask AutoMode could not answer and that is still
 * pending: broadcast on the failure and replayed to each client after its
 * handshake while the ledger holds it. properties: { sessionID, permissionID,
 * action, error, replayed? }. Clients turn the ask into a manual card.
 */
export const AUTO_APPROVE_FAILED_EVENT = "ocr.permission.autoFailed";

/** How long a failure stays replayable when opencode never reports a reply. */
export const AUTO_FAIL_TTL_MS = 24 * 60 * 60 * 1000;

/** Most failures remembered at once — the oldest go first. */
export const AUTO_FAIL_LEDGER_MAX = 64;

/** Label used when the event names no tool. */
export const PERMISSION_LABEL_FALLBACK = "action";

export type PermissionEventKind = "ask" | "reply" | "other";

export interface PermissionEventFacts {
  kind: PermissionEventKind;
  /** "" when absent */
  sessionID: string;
  /** "" when absent — `requestID` for replies, `permissionID`/`id` for asks */
  permissionID: string;
  /** tool name for push text and logs ("bash", "edit"…), or the fallback */
  label: string;
}

/**
 * Classify one opencode event. Anything that does not name a permission is
 * "other". A name carrying replied/reply/response/revoke is an answer and
 * never an ask. Every other permission-shaped event stays an ask exactly as
 * before (never miss a real ask), with the tool read from `type` (legacy
 * events) or `permission` (opencode 1.18 `permission.asked`).
 */
export function permissionEventFacts(type: unknown, properties: unknown): PermissionEventFacts {
  const t = typeof type === "string" ? type.toLowerCase() : "";
  const p = (properties !== null && typeof properties === "object" ? properties : {}) as Record<string, unknown>;
  const sessionID = str(p.sessionID);
  if (!t.includes("permission")) return { kind: "other", sessionID, permissionID: "", label: PERMISSION_LABEL_FALLBACK };
  if (/repl(y|ied)|response|revoke/.test(t)) {
    return {
      kind: "reply",
      sessionID,
      permissionID: str(p.requestID) || str(p.permissionID) || str(p.id),
      label: PERMISSION_LABEL_FALLBACK,
    };
  }
  return {
    kind: "ask",
    sessionID,
    permissionID: str(p.permissionID) || str(p.id),
    label: toolLabel(p.type) || toolLabel(p.permission) || PERMISSION_LABEL_FALLBACK,
  };
}

export type ApproveAttempt = "approved" | "not-found" | "retry";

/** One approve POST, judged by its HTTP status (null = the request itself failed). */
export function approveAttemptVerdict(status: number | null): ApproveAttempt {
  if (typeof status !== "number") return "retry";
  if (status >= 200 && status < 300) return "approved";
  if (status === 404) return "not-found";
  return "retry";
}

/**
 * After a 404: is the ask still in opencode's pending list (`GET /permission`
 * rows carry `id`)? Fail-closed — an unreadable list is a failure, because a
 * human looking at a card is cheaper than an agent stalled in silence.
 */
export function notFoundOutcome(pending: unknown, permissionID: string): "resolved-elsewhere" | "failed" {
  if (!Array.isArray(pending)) return "failed";
  const stillPending = pending.some((row) => row !== null && typeof row === "object" && (row as { id?: unknown }).id === permissionID);
  return stillPending ? "failed" : "resolved-elsewhere";
}

/** Push copy for a final failure (same register as the other daemon pushes). */
export function autoFailPush(label: string, machine: string): { title: string; body: string } {
  const what = label && label !== PERMISSION_LABEL_FALLBACK ? label : "an action";
  return { title: "AutoMode couldn't approve", body: `${what} on ${machine} is waiting — approve it manually` };
}

export interface AutoFailEntry {
  sessionID: string;
  permissionID: string;
  action: string;
  /** short cause ("HTTP 500", a fetch error message) */
  error: string;
  /** when the failure was recorded (ms) */
  at: number;
}

/**
 * Failures still worth telling a (re)connecting client about. Bounded by
 * count and age; insertion order is age order (a re-record moves to the end).
 */
export class AutoFailLedger {
  private entries = new Map<string, AutoFailEntry>();

  constructor(
    private readonly max = AUTO_FAIL_LEDGER_MAX,
    private readonly ttlMs = AUTO_FAIL_TTL_MS,
  ) {}

  record(entry: AutoFailEntry): void {
    if (!entry.permissionID) return;
    this.entries.delete(entry.permissionID);
    this.entries.set(entry.permissionID, { ...entry });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** True when the id was held (a reply or a later success resolves it). */
  clear(permissionID: string): boolean {
    return this.entries.delete(permissionID);
  }

  /** Drop what opencode no longer lists as pending (rows carry `id`); a non-array keeps everything. */
  retainPending(pending: unknown): void {
    if (!Array.isArray(pending)) return;
    const ids = new Set(
      pending
        .map((row) => (row !== null && typeof row === "object" ? (row as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === "string"),
    );
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.entries.delete(id);
  }

  /** Entries younger than the TTL, oldest first; expired ones are dropped. */
  live(now: number): AutoFailEntry[] {
    for (const [id, e] of this.entries) if (!(now - e.at < this.ttlMs)) this.entries.delete(id);
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  get size(): number {
    return this.entries.size;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** A tool name fit for a push line: a short identifier, never free text. */
function toolLabel(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(v) ? v : "";
}
