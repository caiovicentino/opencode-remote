/**
 * P2-354: pure boot-budget verdict for the packaged-app smoke. Deliberately NO
 * I/O here (same rule as packaged-boot-verdict.mjs): scripts/unit.test.ts
 * imports this file directly and must never boot Electron, the daemon or the
 * fs — no imports at all, only closed-set decisions.
 *
 * The first boot-time ratchet (spike): packaged-boot.mjs now MEASURES the cold
 * start it was already proving — wall-clock from the process spawn until
 * load-finished with the console canary seen — and always prints one line,
 * `packaged-boot boot in Xms budget Yms`, with the ceiling resolved from the
 * table below. The ratchet technique (measure, lock a ceiling that only goes
 * down) is applied to the Desktop app cold-start journey.
 *
 * Budget table (ms, per platform) — the rationale lives in this comment on
 * purpose, so a reviewer audits the ceiling without running anything:
 *
 *   darwin: 20000  baseline measured on the dev machine this spike (Apple
 *                  Silicon macOS, packaged-boot rounds of P2-354): the packaged
 *                  cold start landed at 5441ms on the first launch of a freshly
 *                  packaged bundle (cold caches) and 921–1122ms on repeat runs
 *                  (warm caches). 20000ms is a generous first ceiling (~4x the
 *                  cold baseline) so runner jitter never produces red noise —
 *                  the tightening slice comes after the baseline is stable
 *                  across CI runs.
 *
 *   win32:  60000  documented generous ceiling, never measured locally: the
 *                  windows-latest runner is slower and this spike does not
 *                  measure there. Set ABOVE the smoke's own 45s load timeout
 *                  so the budget can never be the deciding failure on Windows
 *                  (a boot that slow is already load-failed by the verdict
 *                  gate); the baseline slice will replace this number.
 *
 * OUT OF SCOPE (P2-354, spike): no CI job fails on time yet — the verdict is
 * informational and packaged-boot.mjs never gates on it —, ceilings do not
 * tighten automatically, and no new dependency enters any workspace.
 */

/** Cold-start ceilings in ms per platform. Only darwin/win32 run the smoke. */
export const BOOT_BUDGET_MS = { darwin: 20000, win32: 60000 };

const MESSAGES = {
  ok: (measured, budget) => `boot dentro do teto — ${measured}ms medidos, teto ${budget}ms`,
  "over-budget": (measured, budget) => `boot acima do teto — ${measured}ms medidos, teto ${budget}ms`,
  unknown: "tempo de boot não medido ou plataforma sem teto — falha aberta, nunca vermelho",
};

/**
 * Decide the boot-budget verdict from the platform and one measured number:
 *
 *   platform    process.platform of the runner (darwin, win32, ...)
 *   measuredMs  wall-clock ms from spawn until load-finished with canary seen
 *
 * Returns a closed set — "ok" | "over-budget" | "unknown" — never a boolean
 * that a caller could misread as red:
 *
 *   ok           measured <= budget for a known platform
 *   over-budget  measured > budget; the message cites the measured number
 *   unknown      measured missing, negative, non-finite or non-number, or a
 *                platform without a budget entry — NEVER red on doubt
 *
 * `unknown` always carries what is still knowable: budgetMs is the table
 * entry when the platform is known, measuredMs echoes a valid input, so the
 * printed line stays informative even on a failed boot.
 */
export function bootBudgetVerdict(platform, measuredMs) {
  const budget = Object.hasOwn(BOOT_BUDGET_MS, platform) ? BOOT_BUDGET_MS[platform] : null;
  const measured = typeof measuredMs === "number" && Number.isFinite(measuredMs) && measuredMs >= 0 ? measuredMs : null;
  if (measured === null || budget === null) {
    return { state: "unknown", message: MESSAGES.unknown, budgetMs: budget, measuredMs: measured };
  }
  const shown = Math.round(measured);
  if (measured > budget) {
    return { state: "over-budget", message: MESSAGES["over-budget"](shown, budget), budgetMs: budget, measuredMs: measured };
  }
  return { state: "ok", message: MESSAGES.ok(shown, budget), budgetMs: budget, measuredMs: measured };
}

/**
 * The single ratchet line the smoke prints on EVERY run (fail open): a known
 * measurement renders as `Xms`, a known budget as `Yms`; a missing side
 * renders as the bare token `unknown` (the ms suffix belongs to a number, not
 * to an absence) — the `packaged-boot boot in X budget Y` frame never changes.
 */
export function bootBudgetLine(platform, measuredMs) {
  const verdict = bootBudgetVerdict(platform, measuredMs);
  const shown = verdict.measuredMs === null ? "unknown" : `${Math.round(verdict.measuredMs)}ms`;
  const shownBudget = verdict.budgetMs === null ? "unknown" : `${verdict.budgetMs}ms`;
  return `packaged-boot boot in ${shown} budget ${shownBudget}`;
}
