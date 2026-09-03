// P1-082: pure lifecycle for permission approval cards. ChatView used to
// render one actionable card per permission event with no knowledge of the
// current server state — eternal "ghost" cards for asks that were already
// answered, N duplicate cards for the same request, and a raw 404 when a
// stale card was clicked. The daemon's pending list (GET /permission) is the
// source of truth now; events only seed resolved lines and trigger re-fetches.
// Kept free of DOM/React so scripts/permission-cards.test.ts can pin the
// semantics (same pattern as preview.ts / localws.ts).

import { permissionPreview } from "./permission";

export interface PermissionAsk {
  permissionID: string;
  label: string;
  messageID?: string;
  preview?: string;
  /** P1-093: set on actionable entries whose auto-approval finally failed */
  autoFailed?: boolean;
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
      label: p.type ?? p.action ?? "action",
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
 */
export function reconcilePermissionCards(
  asks: CollectedAsk[],
  serverPending: PermissionAsk[],
  responded: Set<string>,
  autoMode: boolean,
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
      if (!responded.has(id) && (!autoMode || ask.autoFailed)) {
        const { permissionID, label, messageID, preview, autoFailed } = ask;
        actionable.push({ permissionID, label, messageID, preview, autoFailed });
      }
      continue;
    }
    resolved.push({ permissionID: id, label: ask.label, origin: ask.auto ? "auto" : "other" });
  }
  return { actionable, resolved };
}

/** opencode answers 404 when the permission was resolved elsewhere (or by AutoMode). */
export function isPermissionResolvedElsewhere(status: number): boolean {
  return status === 404;
}
