// P1-079: per-session context gauge + pinned recap helpers.
// Pure functions so the unit battery pins the math and the sentence cut.

/** Gauge thresholds — yellow from here (share of the model window). */
export const CONTEXT_WARN_PCT = 70;
/** Red zone; the pilot pipeline recycles the builder session at this point. */
export const CONTEXT_CRITICAL_PCT = 85;

/** Pure pressure calculation: 0..100, tolerant of garbage input. */
export function contextPct(tokens: number, window: number): number {
  if (!Number.isFinite(tokens) || !Number.isFinite(window) || window <= 0 || tokens <= 0) return 0;
  return Math.min(100, (tokens / window) * 100);
}

export type PressureLevel = "ok" | "warn" | "danger";

/** Color band for the gauge: yellow ~70%, red ~85%. */
export function pressureLevel(pct: number): PressureLevel {
  if (pct >= CONTEXT_CRITICAL_PCT) return "danger";
  if (pct >= CONTEXT_WARN_PCT) return "warn";
  return "ok";
}

/**
 * First sentence of a text, for the pinned recap strip: whitespace-collapsed,
 * cut at the first sentence terminator, hard-capped with an ellipsis.
 */
export function firstSentence(text: string, maxLen = 200): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const m = clean.match(/^[\s\S]*?[.!?…](?=\s|$)/);
  const s = (m?.[0] ?? clean).trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen - 1).trimEnd()}…`;
}
