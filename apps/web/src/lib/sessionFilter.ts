// Pure session-list filtering: badge chips (P2-005) + search query.
// Kept dependency-free so scripts/unit.test.ts can exercise it directly.

export type BadgeFilter = "all" | "with" | "without";

/** P1-064: autonomous-pilot conversations are titled with their task id. */
export const PILOT_TITLE_RE = /\bP\d-\d{3}\b/;

export function isPilotTitle(title?: string): boolean {
  return !!title && PILOT_TITLE_RE.test(title);
}

export function splitPilotSessions<S extends { id: string; title?: string }>(
  sessions: S[],
): { user: S[]; pilot: S[] } {
  const user: S[] = [];
  const pilot: S[] = [];
  for (const s of sessions) (isPilotTitle(s.title) ? pilot : user).push(s);
  return { user, pilot };
}

export function hasUnreadBadge(unread: Record<string, number>, id: string): boolean {
  return (unread[id] ?? 0) > 0;
}

export function applySessionFilters<S extends { id: string; title?: string }>(
  sessions: S[],
  unread: Record<string, number>,
  query: string,
  badgeFilter: BadgeFilter,
): S[] {
  const q = query.trim().toLowerCase();
  return sessions.filter((s) => {
    if (badgeFilter === "with" && !hasUnreadBadge(unread, s.id)) return false;
    if (badgeFilter === "without" && hasUnreadBadge(unread, s.id)) return false;
    if (!q) return true;
    return (s.title ?? "").toLowerCase().includes(q) || s.id.toLowerCase().includes(q);
  });
}
