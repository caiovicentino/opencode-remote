// PWA shell (Bug 2): pure helpers behind the slide-in drawer. No DOM, no
// React — scripts/drawer.test.ts drives every branch in plain Node. Copy
// resolves through lib/i18n keys (P2-118: never a literal phrase here).

import { isPilotTitle } from "./sessionFilter";
import { sessionUpdatedTs } from "./time";

/** Drawer destinations, in row order. "chats" is the conversations list. */
export type DrawerDest = "chats" | "artifacts" | "mission" | "settings" | "files";

export interface DrawerRow {
  id: DrawerDest;
  /** dict key of the row label (i18n en+pt) */
  labelKey: string;
}

/** The four primary rows of the brief, plus Files as the quiet fifth so the
 * mobile file browser stays reachable (it left the bottom tabs). */
export const DRAWER_ROWS: readonly DrawerRow[] = [
  { id: "chats", labelKey: "navConversations" },
  { id: "artifacts", labelKey: "navArtifacts" },
  { id: "mission", labelKey: "navMission" },
  { id: "settings", labelKey: "navSettings" },
  { id: "files", labelKey: "navFiles" },
];

/** Recents shown inside the drawer — one line each, newest first. */
export const RECENTS_LIMIT = 8;

export interface RecentRow {
  id: string;
  title: string;
  unread: boolean;
  active: boolean;
  /** P3-357b: pinned conversations ride above the recency order. */
  pinned: boolean;
}

interface SessionLike {
  id: string;
  title?: string;
  updatedAt?: string | number;
  time?: { created?: string; updated?: string };
}

/**
 * Newest `limit` user conversations (autonomous-pilot sessions never crowd
 * the drawer), title falling back to a short id. Unread marks every session
 * with a pending badge except the one on screen; truncation is CSS.
 * P3-357b: pinned conversations come first regardless of recency (newest
 * first among themselves) and never count against the limit — a pin must be
 * visible even when it is old.
 */
export function recentRows(
  sessions: readonly SessionLike[],
  unread: Record<string, number>,
  activeSession: string | null,
  limit: number = RECENTS_LIMIT,
  pinnedIds: readonly string[] = [],
): RecentRow[] {
  const pinnedSet = new Set(pinnedIds);
  const newest = [...sessions]
    .filter((s) => !isPilotTitle(s.title))
    .sort((a, b) => sessionUpdatedTs(b) - sessionUpdatedTs(a));
  const picked = [
    ...newest.filter((s) => pinnedSet.has(s.id)),
    ...newest.filter((s) => !pinnedSet.has(s.id)).slice(0, Math.max(0, limit)),
  ];
  return picked.map((s) => ({
    id: s.id,
    title: s.title?.trim() || s.id.slice(0, 12),
    unread: s.id !== activeSession && (unread[s.id] ?? 0) > 0,
    active: s.id === activeSession,
    pinned: pinnedSet.has(s.id),
  }));
}

/** Hamburger dot: something unread exists outside the open conversation. */
export function hasUnreadDot(unread: Record<string, number>, activeSession: string | null): boolean {
  return Object.entries(unread).some(([id, n]) => id !== activeSession && n > 0);
}

/** Which drawer row reads as active for the visible slot (null on home/chat). */
export function activeDrawerRow(topSlot: string, hasSession: boolean): DrawerDest | null {
  if (topSlot === "chats") return "chats";
  if (topSlot === "artifacts" || topSlot === "mission" || topSlot === "settings" || topSlot === "files") return topSlot;
  void hasSession;
  return null;
}
