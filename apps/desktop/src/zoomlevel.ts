// P2-238: pure zoom-level policy for the desktop shell. The View menu lets the
// user grow (or shrink) the app's text; until now that adjustment lived only in
// the running webContents, so closing the window threw it away — someone who
// needs bigger text had to set it again on every launch. This module owns the
// NUMBERS: the documented range, the step, the tolerance rules for the value
// read back from disk and the verdict for each menu action.
//
// Same module hygiene as window-state.ts / hotkey.ts / quithint.ts: NO
// electron, no node:fs, no fetch, no I/O, no timers of any kind — main.ts
// resolves the session flag and the persisted value, applies the verdict to
// the webContents and persists through the existing window-state path, and
// scripts/unit.test.ts exercises every rule in plain Node.
//
// The zoom level is Chromium's logarithmic scale: factor = 1.2^level, so
// level 0 is the factory 100%, each step multiplies the text size by ~1.2
// (~20% per click) and negative levels shrink it.
//
// RULE ORDER CONTRACT (the gate depends on it): the harness-session rule comes
// FIRST and must stay first — before any saved-state, packaged or platform
// consideration (lesson from P2-221/P2-235). With OCR_DESKTOP_SESSION defined
// the applied level is ALWAYS the default and nothing zoom-related is written
// to disk: a zoom inherited from another execution would change the framing of
// every evidence screenshot and break the npm run test:desktop-flow battery.
// The second rule is that absent, unreadable or out-of-range state becomes the
// default (never an error, never a clamp of garbage to a nonzero level).

/** Factory zoom (factor 1.0). Every session starts from here unless the user's
 * own remembered level says otherwise — and a test session never does. */
export const DEFAULT_ZOOM_LEVEL = 0;

/** Smallest allowed level (factor 1.2^-3 ≈ 58%). Below ~60% the shell chrome
 * (13px UI text, tray hints, panes) stops being readable, so going further
 * down buys nothing the product can still use. */
export const MIN_ZOOM_LEVEL = -3;

/** Largest allowed level (factor 1.2^6 ≈ 3x, Chromium's own ceiling). Three
 * times the factory size keeps the stage-3 product of docs/VISION.md legible
 * for low-vision users while the layout stays usable; beyond that the shell
 * turns into an unusable collage of giant panes. */
export const MAX_ZOOM_LEVEL = 6;

/** One menu click moves exactly one Chromium zoom level (~20% text size), the
 * same feel the native zoomIn/zoomOut roles always had. */
export const ZOOM_STEP = 1;

/**
 * Tolerant reader for the value loaded from disk: whatever comes in, a valid
 * level comes out — non-numeric, non-finite or wrong-typed values become the
 * default, values outside the documented range are clamped to the nearest
 * edge. Never throws, never returns NaN.
 */
export function sanitizeZoom(raw: unknown): number {
  if (typeof raw !== "number") return DEFAULT_ZOOM_LEVEL;
  if (!Number.isFinite(raw)) return DEFAULT_ZOOM_LEVEL;
  if (raw < MIN_ZOOM_LEVEL) return MIN_ZOOM_LEVEL;
  if (raw > MAX_ZOOM_LEVEL) return MAX_ZOOM_LEVEL;
  return raw;
}

/** The zoom actions the View menu offers. */
export type ZoomAction = "increase" | "decrease" | "restore";

export interface ZoomVerdict {
  /** The level to apply after the action, already clamped to the range. */
  level: number;
  /** True when the action could not change anything (the level was already at
   * the ceiling/floor, or already the default for "restore") — the menu item
   * renders disabled instead of pretending it did something. */
  atLimit: boolean;
}

/**
 * Pure decision for one menu action against one level: "increase" moves one
 * step up (clamped at MAX), "decrease" one step down (clamped at MIN) and
 * "restore" always lands on the default. The level is preserved whenever the
 * action changes nothing, and `atLimit` says so. Same input → same output,
 * always inside [MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL].
 */
export function zoomVerdict(current: unknown, action: ZoomAction): ZoomVerdict {
  const base = sanitizeZoom(current);
  if (action === "restore") {
    return { level: DEFAULT_ZOOM_LEVEL, atLimit: base === DEFAULT_ZOOM_LEVEL };
  }
  if (action === "increase") {
    if (base >= MAX_ZOOM_LEVEL) return { level: MAX_ZOOM_LEVEL, atLimit: true };
    return { level: Math.min(base + ZOOM_STEP, MAX_ZOOM_LEVEL), atLimit: false };
  }
  if (base <= MIN_ZOOM_LEVEL) return { level: MIN_ZOOM_LEVEL, atLimit: true };
  return { level: Math.max(base - ZOOM_STEP, MIN_ZOOM_LEVEL), atLimit: false };
}

export interface ZoomStartupPlan {
  /** The level to apply to the window for this session. */
  level: number;
  /** False only for a harness session: nothing zoom-related may reach disk. */
  persist: boolean;
  /** Short static pt-BR phrase for the log — no paths, no schemes, no secrets. */
  reason: string;
}

/**
 * Decide the session's starting zoom level. Rules apply in this exact order:
 *
 *  1. a test-harness session (OCR_DESKTOP_SESSION) always starts at the
 *     default and persists nothing — see the RULE ORDER CONTRACT above;
 *  2. anything the disk yields (absent, garbage, out of range) is sanitized
 *     by sanitizeZoom — a file written before P2-238 has no zoom field and
 *     falls back to the default exactly like a corrupted one.
 */
export function zoomStartupPlan(input: { harnessSession: boolean; saved: unknown }): ZoomStartupPlan {
  if (input.harnessSession) {
    return {
      level: DEFAULT_ZOOM_LEVEL,
      persist: false,
      reason: "sessão de teste do harness — zoom padrão, nada é gravado",
    };
  }
  return {
    level: sanitizeZoom(input.saved),
    persist: true,
    reason: sanitizeZoom(input.saved) === DEFAULT_ZOOM_LEVEL ? "zoom padrão" : "zoom lembrado do último fechamento",
  };
}
