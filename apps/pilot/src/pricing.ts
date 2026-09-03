/**
 * P2-113 — dollar telemetry: apply a per-model BYOK list-price table to the
 * four token columns costs.ts already reconciles from opencode.db (input,
 * output, cacheRead, cacheWrite).
 *
 * REFRAME (the operator runs own inference): the dollar figure is a PRODUCT
 * metric — what a BYOK (bring-your-own-key) cloud user would have paid at
 * provider list prices — never the operator's own ops cost. For own ops the
 * primary metrics stay tokens and provider-cache hit (cache hit = GPU/exports
 * saved, not dollars saved); the $ chip is labeled accordingly in the UI.
 *
 * Every entry cites its public source and as-of date; a manual update (edit
 * the row + bump `asOf`) is the update path — nothing here fetches remotely.
 * Unknown models are never silently converted to $0: their tokens land in
 * `unpricedTokens` and the UI says so.
 */

/** The 4 token columns costs.ts reads from the opencode `session` table. */
export interface TokenCols {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One priced model row: the pipeline tier it belongs to + USD per MTok. */
export interface PriceEntry {
  tier: "A" | "B";
  usdPerMTok: TokenCols;
}

/** Public sources behind PRICE_TABLE rows, cited verbatim in the UI tooltip. */
export const PRICE_AS_OF = "2026-09-03";
export const PRICE_SOURCES: Record<string, { url: string; asOf: string }> = {
  zai: { url: "https://docs.z.ai/guides/overview/pricing", asOf: PRICE_AS_OF },
  anthropic: { url: "https://platform.claude.com/docs/en/about-claude/pricing", asOf: PRICE_AS_OF },
};

/**
 * List prices keyed by the model id exactly as opencode reports it in the
 * `session.model` column (`{"id":"glm-5.2","providerID":"glm52",…}`).
 *
 * - GLM-5.2 (Z.ai): input $1.4, cached input $0.26, output $4.4; cache-write
 *   storage is limited-time free → 0.
 * - Claude Sonnet 4.6 (Anthropic): input $3, output $15, 5m cache write
 *   $3.75 (1.25×), cache read $0.30 (0.1×).
 */
export const PRICE_TABLE: Record<string, PriceEntry> = {
  "glm-5.2": { tier: "A", usdPerMTok: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 } },
  "claude-sonnet-4-6": { tier: "B", usdPerMTok: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
};

/** Human-facing source line rendered by the dashboard tooltip. */
export const PRICE_SOURCE_LABEL = `fonte: docs.z.ai + platform.claude.com (preços de lista, ${PRICE_AS_OF})`;

/**
 * The opencode `session.model` column is a JSON blob like
 * `{"id":"glm-5.2","providerID":"glm52"}` (older rows: a plain string, null
 * or absent). Normalize to the model id the price table is keyed by.
 * Tolerant by design — anything unparseable becomes "unknown".
 */
export function normalizeSessionModel(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const trimmed = raw.trim();
  if (!trimmed) return "unknown";
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as { id?: unknown };
      if (j && typeof j.id === "string" && j.id.trim()) return j.id.trim().slice(0, 64);
    } catch {
      // fall through: keep the raw text below
    }
  }
  return trimmed.slice(0, 64);
}

/** Dollar view of one task's per-model token breakdown (P2-113). */
export interface TaskUsd {
  /** BYOK list-price total in USD (tierA + tierB). */
  total: number;
  /** USD attributable to tier A (flash/builder) sessions. */
  tierA: number;
  /** USD attributable to tier B (deep/escalation) sessions. */
  tierB: number;
  /** Tokens from models absent from PRICE_TABLE — counted, never priced. */
  unpricedTokens: number;
  /** Total tokens across all models (the same 4 columns summed). */
  tokens: number;
}

/**
 * Price one task's per-model token breakdown at BYOK list prices. Pure —
 * the unit battery pins every constant in PRICE_TABLE through this function.
 * Values stay raw floats (per-task costs can be far below a cent); the UI
 * rounds for display only.
 */
export function taskCostUSD(perModel: Record<string, TokenCols>): TaskUsd {
  let tierA = 0;
  let tierB = 0;
  let unpricedTokens = 0;
  let tokens = 0;
  for (const [model, cols] of Object.entries(perModel ?? {})) {
    const c = cols ?? ({} as Partial<TokenCols>);
    const input = c.input || 0;
    const output = c.output || 0;
    const cacheRead = c.cacheRead || 0;
    const cacheWrite = c.cacheWrite || 0;
    const colTotal = input + output + cacheRead + cacheWrite;
    tokens += colTotal;
    // hasOwn guard (round 2 review): a model id like "__proto__" or
    // "constructor" must resolve to "no price", never to an inherited
    // Object.prototype member (which would truthy-pass and yield NaN).
    const price = Object.hasOwn(PRICE_TABLE, model) ? PRICE_TABLE[model] : undefined;
    if (!price) {
      unpricedTokens += colTotal;
      continue;
    }
    const usd =
      (input * price.usdPerMTok.input +
        output * price.usdPerMTok.output +
        cacheRead * price.usdPerMTok.cacheRead +
        cacheWrite * price.usdPerMTok.cacheWrite) /
      1e6;
    if (price.tier === "B") tierB += usd;
    else tierA += usd;
  }
  return { total: tierA + tierB, tierA, tierB, unpricedTokens, tokens };
}
