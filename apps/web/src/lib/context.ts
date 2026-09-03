// P1-079: per-session context gauge + pinned recap helpers.
// Pure functions so the unit battery pins the bands and the sentence cut.
// The pressure NUMBER is computed daemon-side (apps/daemon/src/contextgauge.ts
// → GET /__ocr/context); this module only color-bands it. The pipeline's
// recycle threshold lives in apps/pilot/src/context.ts.

/** Gauge thresholds — yellow from here (share of the model window). */
export const CONTEXT_WARN_PCT = 70;
/** Red zone; the pilot pipeline recycles the builder session at this point. */
export const CONTEXT_CRITICAL_PCT = 85;

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
