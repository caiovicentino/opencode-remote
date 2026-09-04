// Pure decision logic for the unread badge (P2-150). Kept free of electron
// imports so scripts/unit.test.ts can exercise it (same pattern as tray.ts
// and notify.ts): main.ts hands it the platform and the raw renderer push and
// gets back everything the OS surfaces need — which badge mechanism to use,
// the sanitized count, a pt-BR description for screen readers and the capped
// display label.

/** Where the badge renders: macOS/Linux dock count, Windows taskbar overlay
 * (setBadgeCount is a no-op there), none = platform without a badge surface. */
export type BadgeKind = "dock" | "overlay" | "none";

export interface BadgePlan {
  /** Badge surface for this platform/count combination. */
  kind: BadgeKind;
  /** Sanitized count — never negative, never fractional, never NaN. */
  count: number;
  /** Screen-reader description ("2 mensagens não lidas"); empty at zero. */
  description: string;
  /** Display label, capped at "9+" above nine; empty at zero. */
  label: string;
}

/** P3-053 rule, extracted: a malformed push never writes garbage. Anything
 * that is not a positive finite number sanitizes to zero (strings, NaN,
 * ±Infinity, negatives and fractions lose their remainder via floor). */
function sanitizeCount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const n = Math.floor(raw);
  return n > 0 ? n : 0;
}

/** pt-BR description for assistive tech; empty when the count is zero so a
 * cleared badge never announces anything. */
function badgeDescription(count: number): string {
  if (count <= 0) return "";
  return count === 1 ? "1 mensagem não lida" : `${count} mensagens não lidas`;
}

/** Display label. The taskbar overlay slot and the dock both have room for a
 * single corner glyph — above nine everything reads "9+". */
function badgeLabel(count: number): string {
  if (count <= 0) return "";
  return count > 9 ? "9+" : String(count);
}

/**
 * Decide how (and whether) an unread push shows up on the OS surface:
 * darwin/linux keep the P3-053 dock badge (app.setBadgeCount), win32 uses the
 * taskbar overlay icon — zero count means "clear it" — and any other platform
 * has no badge surface at all.
 */
export function badgePlan(platform: string, raw: unknown): BadgePlan {
  const count = sanitizeCount(raw);
  const kind: BadgeKind = platform === "win32" ? "overlay" : platform === "darwin" || platform === "linux" ? "dock" : "none";
  return { kind, count, description: badgeDescription(count), label: badgeLabel(count) };
}
