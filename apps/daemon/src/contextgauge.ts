// P1-079: context-pressure helpers for the /__ocr/context endpoint.
// Pure functions kept in their own module (same pattern as sessionctx.ts) so
// tests pin them without booting a daemon. The token numbers come from the
// opencode server (GET /session/:id), which materializes the same per-session
// totals it persists in opencode.db.

/** Gauge thresholds — yellow ~70%, red ~85% of the model window. */
export const CONTEXT_WARN_PCT = 70;
export const CONTEXT_CRITICAL_PCT = 85;

/** Pure pressure calculation: 0..100, tolerant of garbage input. */
export function contextPct(tokens: number, window: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens <= 0) return 0;
  return Math.min(100, (tokens / window) * 100);
}

/** Token totals of one opencode session (subset of GET /session/:id). */
export interface OpencodeSessionTokens {
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  model?: { providerID?: string; modelID?: string };
}

/** input+output+reasoning+cacheRead+cacheWrite — the full billed context. */
export function sessionTokenTotal(s: OpencodeSessionTokens): number {
  const t = s.tokens ?? {};
  return (
    (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
  );
}

export interface OpencodeProviders {
  all?: {
    id: string;
    models?: Record<string, { id?: string; limit?: { context?: number } }>;
  }[];
}

/**
 * Resolve a model's context window from the /provider catalog. Model keys are
 * not normalized upstream — some providers key bare model ids ("glm-5.2"),
 * others provider-qualified ones ("deepseek/deepseek-v4-flash") — so match
 * bare key, value id and provider-qualified key. 0 when not found.
 */
export function contextWindowFor(providers: OpencodeProviders, providerID: string, modelID: string): number {
  for (const p of providers.all ?? []) {
    if (p?.id !== providerID) continue;
    for (const [key, m] of Object.entries(p.models ?? {})) {
      if (key === modelID || m?.id === modelID || key === `${providerID}/${modelID}`) {
        const ctx = m.limit?.context;
        return typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0 ? ctx : 0;
      }
    }
    break;
  }
  return 0;
}

/**
 * P1-079 (round 2): flatten the catalog into a `providerID/modelKey → context
 * window` map. Covers both key shapes the session's model field produces
 * (bare "glm-5.2" and qualified "deepseek/deepseek-v4-flash") because the
 * lookup key is always the provider-qualified `${providerID}/${modelID}`.
 */
export function buildWindowMap(providers: OpencodeProviders): Map<string, number> {
  const windows = new Map<string, number>();
  for (const p of providers.all ?? []) {
    if (!p) continue;
    for (const [key, m] of Object.entries(p.models ?? {})) {
      const ctx = m?.limit?.context;
      if (typeof ctx !== "number" || !Number.isFinite(ctx) || ctx <= 0) continue;
      windows.set(`${p.id}/${key}`, ctx);
    }
  }
  return windows;
}

/** Default freshness window for the provider window cache. */
export const WINDOW_CACHE_TTL_MS = 60_000;

/**
 * Short-TTL cache of the flattened window map: the gauge endpoint fires on
 * every idle transition of every open chat, and the raw /provider catalog is
 * ~6MB — refetching + reparsing it per request is waste. A stale/missing
 * lookup returns 0 and the caller refetches the catalog once, refreshing the
 * cache (an unknown model therefore refetches per request — correct, and no
 * worse than the pre-cache behavior).
 */
export class WindowCache {
  private entry: { windows: Map<string, number>; at: number } | null = null;
  constructor(private ttlMs = WINDOW_CACHE_TTL_MS) {}

  /** Consume a freshly fetched catalog (rebuilds the map). */
  refresh(providers: OpencodeProviders, now = Date.now()): void {
    this.entry = { windows: buildWindowMap(providers), at: now };
  }

  /** Cached window for `providerID/modelID`; 0 on miss or stale entry. */
  lookup(providerID: string, modelID: string, now = Date.now()): number {
    if (!this.entry || now - this.entry.at > this.ttlMs) return 0;
    return this.entry.windows.get(`${providerID}/${modelID}`) ?? 0;
  }

  /** Drop the cached map (tests / forced refresh). */
  clear(): void {
    this.entry = null;
  }
}
