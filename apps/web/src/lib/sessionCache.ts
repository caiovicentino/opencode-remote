// P1-064: tiny LRU of recently opened conversations so switching back is
// instant — ChatView hydrates from this map synchronously (no skeleton) and
// refetches the tail in the background. Memory-only: at most MAX_SESSIONS
// entries, oldest evicted. Pure (no DOM) so scripts/unit.test.ts can test it.

export const SESSION_CACHE_MAX = 3;

export interface SessionCacheEntry<Bubble, Tool> {
  bubbles: Bubble[];
  tools: Map<string, Tool>;
  hasMore: boolean;
  /** id of the oldest fetched message — cursor for "load more" */
  oldest: string | null;
  savedAt: number;
}

const cache = new Map<string, SessionCacheEntry<unknown, unknown>>();

export function getCachedSession<Bubble, Tool>(
  id: string,
): SessionCacheEntry<Bubble, Tool> | null {
  const hit = cache.get(id);
  if (!hit) return null;
  // LRU refresh: re-inserting moves the key to the newest position
  cache.delete(id);
  cache.set(id, hit);
  return hit as SessionCacheEntry<Bubble, Tool>;
}

export function putCachedSession<Bubble, Tool>(
  id: string,
  entry: Omit<SessionCacheEntry<Bubble, Tool>, "savedAt">,
): void {
  cache.delete(id);
  cache.set(id, { ...entry, savedAt: Date.now() } as SessionCacheEntry<unknown, unknown>);
  while (cache.size > SESSION_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function dropCachedSession(id: string): void {
  cache.delete(id);
}
