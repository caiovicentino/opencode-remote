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
