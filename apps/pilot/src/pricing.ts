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
 * eval-18 adds the OPS view next to it: when pilot.json configures the
 * self-hosted node (`pricing.selfHosted`, $/MTok or GPU-hour amortization),
 * `opsUSD` carries what the operator actually pays for those tokens.
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

/**
 * eval-18: model ids that are the SAME served model as a PRICE_TABLE row.
 * The fleet's tier-A model ran under the opencode id `glm-5.2` (provider
 * glm52) until 2026-09-11 and under `glm-5.3-flash` (provider b200x4) since —
 * both provider entries point at the same served endpoint; only the id
 * changed. The rename left every task from 09-11 on "unpriced" (68 of the 200
 * tasks in the rolling window, 1.37B tokens) while the row kept pricing the
 * old id. An alias resolves to its target's row; it never invents a price.
 */
export const MODEL_ALIASES: Record<string, string> = {
  "glm-5.3-flash": "glm-5.2",
};

/** Price row for a model id: exact row first, then an alias (own keys only). */
export function listPriceFor(model: string): PriceEntry | undefined {
  // hasOwn guard (round 2 review): "__proto__"/"constructor" must never
  // resolve to an inherited Object.prototype member
  if (Object.hasOwn(PRICE_TABLE, model)) return PRICE_TABLE[model];
  const target = Object.hasOwn(MODEL_ALIASES, model) ? MODEL_ALIASES[model] : undefined;
  return target && Object.hasOwn(PRICE_TABLE, target) ? PRICE_TABLE[target] : undefined;
}

/** Human-facing source line rendered by the dashboard tooltip. */
export const PRICE_SOURCE_LABEL = `fonte: docs.z.ai + platform.claude.com (preços de lista, ${PRICE_AS_OF}; glm-5.3-flash = linha glm-5.2)`;

// ── eval-18: self-hosted ops cost (the operator's own GPU bill) ────────────

/**
 * Relative compute weight of each token column for GPU-hour amortization,
 * derived from the GLM-5.2 list-price ratios (input 1 : cached input 0.26/1.4
 * : output 4.4/1.4). cacheWrite is priced like fresh prefill (weight 1) — a
 * self-hosted prefix cache write IS a prefill. Override per deployment with
 * `pricing.selfHosted.weights` in pilot.json.
 */
export const DEFAULT_COMPUTE_WEIGHTS: TokenCols = {
  input: 1,
  output: 4.4 / 1.4,
  cacheRead: 0.26 / 1.4,
  cacheWrite: 1,
};

/**
 * pilot.json `pricing.selfHosted` after normalization. Two ways to state the
 * cost, resolved to one per-column USD/MTok rate table:
 * - `usdPerMTok` — direct rates (the operator already knows its $/MTok), or
 * - `usdPerHour` + `mtokPerHour` — GPU-hour amortization: the node's all-in
 *   hourly cost divided by the WEIGHTED MTok it processes per hour
 *   (Σ column × weight; measure it over a trailing window, docs/PILOT.md).
 * `models` lists the opencode model ids served by that node.
 */
export interface SelfHostedPricing {
  models: string[];
  usdPerMTok: TokenCols;
  /** How the rates were obtained — surfaced in the dashboard tooltip. */
  basis: "usdPerMTok" | "gpuHour";
  usdPerHour?: number;
  mtokPerHour?: number;
}

/** Normalized pilot.json `pricing` block (only `selfHosted` today). */
export interface PricingConfig {
  selfHosted?: SelfHostedPricing;
}

const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const finitePos = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

function tokenColsOr(raw: unknown, fallback: TokenCols | null): TokenCols | null {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const cols = { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite };
  // all four columns or nothing: a half-filled rate table would silently
  // price the missing columns at $0
  if (!Object.values(cols).every(finiteNonNeg)) return fallback;
  return cols as TokenCols;
}

/**
 * Tolerant parse of pilot.json `pricing` (same contract as normalizeModels):
 * garbage, missing model ids or a rate that is not a finite number make the
 * block behave exactly like an absent one — no ops cost, never NaN.
 */
export function normalizePricingConfig(raw: unknown): PricingConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const sh = (raw as { selfHosted?: unknown }).selfHosted;
  if (!sh || typeof sh !== "object") return undefined;
  const s = sh as Record<string, unknown>;
  const models = Array.isArray(s.models)
    ? [...new Set(s.models.filter((m): m is string => typeof m === "string" && m.trim().length > 0).map((m) => m.trim().slice(0, 64)))]
    : [];
  if (!models.length) return undefined;
  const direct = tokenColsOr(s.usdPerMTok, null);
  if (direct) return { selfHosted: { models, usdPerMTok: direct, basis: "usdPerMTok" } };
  if (!finitePos(s.usdPerHour) || !finitePos(s.mtokPerHour)) return undefined;
  const w = tokenColsOr(s.weights, DEFAULT_COMPUTE_WEIGHTS)!;
  const perWeighted = s.usdPerHour / s.mtokPerHour; // USD per weighted MTok
  return {
    selfHosted: {
      models,
      basis: "gpuHour",
      usdPerHour: s.usdPerHour,
      mtokPerHour: s.mtokPerHour,
      usdPerMTok: {
        input: w.input * perWeighted,
        output: w.output * perWeighted,
        cacheRead: w.cacheRead * perWeighted,
        cacheWrite: w.cacheWrite * perWeighted,
      },
    },
  };
}

/**
 * Short fingerprint of everything that changes a task's dollar view (list
 * table + aliases + the self-hosted config). Stored next to taskUSD so the
 * boot re-price runs only when prices actually moved.
 */
export function pricingFingerprint(pricing?: PricingConfig): string {
  const payload = JSON.stringify({ PRICE_AS_OF, PRICE_TABLE, MODEL_ALIASES, selfHosted: pricing?.selfHosted ?? null });
  let h = 2166136261; // FNV-1a, 32-bit — change detection, not security
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `v1-${(h >>> 0).toString(16)}`;
}

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
  /** eval-18: the operator's OWN cost of the tokens served by the
   * self-hosted node (pilot.json `pricing.selfHosted`), in USD. Absent when
   * no self-hosted pricing is configured — never a fake $0. */
  opsUSD?: number;
  /** eval-18: tokens covered by `opsUSD` (the self-hosted models' share). */
  opsTokens?: number;
}

/** USD of one 4-column breakdown at a per-MTok rate table. */
function priceCols(c: TokenCols, rate: TokenCols): number {
  return (c.input * rate.input + c.output * rate.output + c.cacheRead * rate.cacheRead + c.cacheWrite * rate.cacheWrite) / 1e6;
}

/**
 * Price one task's per-model token breakdown at BYOK list prices. Pure —
 * the unit battery pins every constant in PRICE_TABLE through this function.
 * Values stay raw floats (per-task costs can be far below a cent); the UI
 * rounds for display only.
 *
 * eval-18: aliases (MODEL_ALIASES) resolve to their target row, and a
 * configured self-hosted node adds the separate ops view (`opsUSD`,
 * `opsTokens`) — the BYOK fields keep their exact P2-113 meaning.
 */
export function taskCostUSD(perModel: Record<string, TokenCols>, pricing?: PricingConfig): TaskUsd {
  let tierA = 0;
  let tierB = 0;
  let unpricedTokens = 0;
  let tokens = 0;
  let opsUSD = 0;
  let opsTokens = 0;
  const selfHosted = pricing?.selfHosted;
  for (const [model, cols] of Object.entries(perModel ?? {})) {
    const c = cols ?? ({} as Partial<TokenCols>);
    const counted: TokenCols = {
      input: c.input || 0,
      output: c.output || 0,
      cacheRead: c.cacheRead || 0,
      cacheWrite: c.cacheWrite || 0,
    };
    const colTotal = counted.input + counted.output + counted.cacheRead + counted.cacheWrite;
    tokens += colTotal;
    if (selfHosted?.models.includes(model)) {
      opsUSD += priceCols(counted, selfHosted.usdPerMTok);
      opsTokens += colTotal;
    }
    // hasOwn guard lives in listPriceFor: a model id like "__proto__" or
    // "constructor" resolves to "no price", never to an inherited member
    const price = listPriceFor(model);
    if (!price) {
      unpricedTokens += colTotal;
      continue;
    }
    const usd = priceCols(counted, price.usdPerMTok);
    if (price.tier === "B") tierB += usd;
    else tierA += usd;
  }
  const out: TaskUsd = { total: tierA + tierB, tierA, tierB, unpricedTokens, tokens };
  if (selfHosted) {
    out.opsUSD = opsUSD;
    out.opsTokens = opsTokens;
  }
  return out;
}
