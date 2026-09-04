/** P2-148: first-run welcome decision logic. Pure on purpose —
 * scripts/unit.test.ts asserts the exact truth table, and the caller
 * (App.tsx) owns the localStorage read so this module stays DOM-free. */

/** localStorage key stamped once the onboarding is finished or skipped. */
export const WELCOME_KEY = "ocr_welcome_done";

/** The only flag value that counts as "done" — anything else (absent,
 * corrupted, partial writes) is treated as never seen. */
export const WELCOME_DONE = "1";

/** True only on a genuine first run: the onboarding flag is absent AND no
 * pairing exists yet. An existing pairing (upgraders, re-paired machines)
 * suppresses the welcome unconditionally — quem já usa o app nunca o vê. */
export function shouldShowWelcome(flag: string | null | undefined, hasPairing: boolean): boolean {
  return flag !== WELCOME_DONE && !hasPairing;
}
