// P1-082: pure lifecycle for permission approval cards. ChatView used to
// render one actionable card per permission event with no knowledge of the
// current server state — eternal "ghost" cards for asks that were already
// answered, N duplicate cards for the same request, and a raw 404 when a
// stale card was clicked. The daemon's pending list (GET /permission) is the
// source of truth now; events only seed resolved lines and trigger re-fetches.
// Kept free of DOM/React so scripts/permission-cards.test.ts can pin the
// semantics (same pattern as preview.ts / localws.ts).

import { permissionPreview } from "./permission";

/**
 * eval-10: the daemon's AutoMode contract, one documented place. The daemon
 * (apps/daemon/src/index.ts autoApprove) broadcasts AUTO_APPROVED_EVENT when
 * it answered an ask and AUTO_FAILED_EVENT after its final failed attempt,
 * both with `{ sessionID, permissionID, action }` (+ `error` on failure). Any
 * new daemon path that gives up on an ask (a boot/stream-reattach sweep, a
 * toggle-on sweep, the eval-12 post-handshake replay) must emit
 * AUTO_FAILED_EVENT with the same shape — the PWA renders it as a manual
 * card. The comparisons below and in ChatView keep the string literals on
 * purpose (the daemon-side parity check reads them); scripts/pwa-mobile-ux
 * .test.ts pins these constants against the daemon source.
 */
export const AUTO_APPROVED_EVENT = "ocr.permission.auto";
export const AUTO_FAILED_EVENT = "ocr.permission.autoFailed";

/**
 * eval-10: how long an ask may stay pending under AutoMode before the PWA
 * stops trusting the daemon to answer it. The daemon's own budget is two
 * attempts ~500 ms apart; asks it never saw (asked while it was restarting,
 * before AutoMode was switched on, or a missed AUTO_FAILED_EVENT while the
 * phone slept) never get an event at all — without this grace they stayed
 * suppressed forever: an invisibly stuck agent.
 */
export const AUTO_APPROVE_GRACE_MS = 10_000;

export interface PermissionAsk {
  permissionID: string;
  label: string;
  messageID?: string;
  preview?: string;
  /** P1-093: set on actionable entries whose auto-approval finally failed */
  autoFailed?: boolean;
  /** eval-10: AutoMode left this ask pending past AUTO_APPROVE_GRACE_MS */
  autoStale?: boolean;
}

export type ResolvedOrigin = "auto" | "other";

export interface CollectedAsk extends PermissionAsk {
  /** true when the last event seen for this id was the daemon's auto-approve */
  auto: boolean;
  /** true when the last event seen was the daemon's final auto-approve failure (P1-093) */
  autoFailed: boolean;
}

export interface ResolvedPermission {
  permissionID: string;
  label: string;
  origin: ResolvedOrigin;
}

export interface PermissionCards {
  actionable: PermissionAsk[];
  resolved: ResolvedPermission[];
}

interface PermissionEventProps {
  sessionID?: string;
  id?: string;
  permissionID?: string;
  type?: string;
  action?: string;
  messageID?: string;
}

/**
 * Extract permission asks from the event buffer, deduped by permissionID
 * (opencode emits one event per state change — the same request can appear
 * many times). Last occurrence wins, so a trailing `ocr.permission.auto`
 * flips the entry to auto-approved and clears a recorded auto-fail, while a
 * trailing `ocr.permission.autoFailed` marks it as failed (P1-093). Events
 * from other sessions are ignored; ids may arrive as `permissionID` or the
 * legacy `id` field.
 */
export function collectPermissionAsks(
  events: { type: string; properties?: unknown }[],
  sessionId: string,
): CollectedAsk[] {
  const byId = new Map<string, CollectedAsk>();
  for (const evt of events) {
    const type = evt.type.toLowerCase();
    if (!type.includes("permission")) continue;
    const p = (evt.properties ?? {}) as PermissionEventProps;
    const id = p.permissionID ?? p.id;
    if (!p.sessionID || !id || p.sessionID !== sessionId) continue;
    byId.set(id, {
      permissionID: id,
      // eval-10: reply events (`permission.replied`) carry no type — keep
      // the label an earlier event taught instead of the "action" fallback
      label: p.type ?? p.action ?? byId.get(id)?.label ?? "action",
      messageID: p.messageID,
      preview: permissionPreview(p),
      auto: type === "ocr.permission.auto",
      autoFailed: type === "ocr.permission.autofailed",
    });
  }
  return [...byId.values()];
}

/**
 * Reconcile the asks seen in the event buffer against the daemon's pending
 * list. A card is actionable only while the daemon still lists the permission
 * and the user has not answered it locally — AutoMode suppresses cards except
 * when the daemon's auto-approval finally failed for that ask (P1-093): the
 * operator must get a manual affordance instead of a silent stall. Everything
 * else that was seen becomes a collapsed resolved line ("auto-approved" when
 * the daemon answered it, plain "resolved" otherwise). Asks that are still
 * pending but already answered locally render nothing — never a ghost card.
 * eval-10: `stale` lists asks AutoMode left pending past the grace
 * (staleAutoAsks) — they surface as manual cards flagged `autoStale`.
 */
export function reconcilePermissionCards(
  asks: CollectedAsk[],
  serverPending: PermissionAsk[],
  responded: Set<string>,
  autoMode: boolean,
  stale: ReadonlySet<string> = new Set(),
): PermissionCards {
  const pendingIds = new Set(serverPending.map((x) => x.permissionID));
  const seen = new Map<string, CollectedAsk>();
  for (const ask of asks) seen.set(ask.permissionID, ask);
  // the server list covers asks that predate the view (events already trimmed)
  for (const sp of serverPending) {
    if (!seen.has(sp.permissionID)) seen.set(sp.permissionID, { ...sp, auto: false, autoFailed: false });
  }
  const actionable: PermissionAsk[] = [];
  const resolved: ResolvedPermission[] = [];
  for (const [id, ask] of seen) {
    if (pendingIds.has(id)) {
      const autoStale = autoMode && !ask.autoFailed && stale.has(id);
      if (!responded.has(id) && (!autoMode || ask.autoFailed || autoStale)) {
        const { permissionID, label, messageID, preview, autoFailed } = ask;
        actionable.push({ permissionID, label, messageID, preview, autoFailed, ...(autoStale ? { autoStale } : {}) });
      }
      continue;
    }
    resolved.push({ permissionID: id, label: ask.label, origin: ask.auto ? "auto" : "other" });
  }
  return { actionable, resolved };
}

/**
 * eval-10: asks still pending past `graceMs` since this client first saw
 * them. `firstSeen` is the client's own clock (permission ids → ms), so no
 * phone/computer clock skew enters the verdict. Pure: ChatView owns the map
 * and the timer that re-evaluates when the next grace expires.
 */
export function staleAutoAsks(
  firstSeen: ReadonlyMap<string, number>,
  pendingIds: Iterable<string>,
  now: number,
  graceMs: number = AUTO_APPROVE_GRACE_MS,
): Set<string> {
  const out = new Set<string>();
  for (const id of pendingIds) {
    const seen = firstSeen.get(id);
    if (seen !== undefined && now - seen >= graceMs) out.add(id);
  }
  return out;
}

/** opencode answers 404 when the permission was resolved elsewhere (or by AutoMode). */
export function isPermissionResolvedElsewhere(status: number): boolean {
  return status === 404;
}
