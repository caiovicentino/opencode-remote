/**
 * P2-204: pure boot verdict for the packaged-app smoke. Deliberately NO I/O
 * here (same rule as the P2-194 helper modules): scripts/unit.test.ts imports
 * this file directly and must never boot Electron, the daemon or the fs.
 *
 * The decision table (first match wins — each reason subsumes the ones after
 * it, ordered from "nothing to even launch" to "cosmetic signal"):
 *
 *   binary-missing          no runnable executable inside the bundle
 *   load-failed             the window never finished loading (or never opened)
 *   blank-window            the renderer mounted nothing into #root
 *   console-capture-broken  the injected console canary was never seen, so the
 *                           empty-error signal is untrustworthy
 *   console-error           renderer console errors were captured
 *
 * Messages are short pt-BR lines for the release-job log: no paths, no URL
 * schemes, no secrets (same hygiene the P2-201 verdicts are held to).
 */

/** Known console error the driver injects after load — proof the collector
 * works on this Electron, mirroring the render smoke (desktop-render-driver). */
export const CANARY = "ocr-packaged-boot-canary";

const MESSAGES = {
  ok: "app empacotado abriu, montou a interface e o console está limpo",
  "binary-missing": "executável do app não encontrado no pacote",
  "load-failed": "a janela do app não terminou de carregar",
  "blank-window": "janela em branco — a interface não montou conteúdo",
  "console-capture-broken": "coleta de console não verificada — canário ausente",
  "console-error": "erros no console do renderer",
};

function verdict(reason) {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/**
 * Decide the boot smoke verdict from plain facts:
 *
 *   executableFound  a runnable binary was resolved inside the bundle
 *   loadFinished     the renderer finished loading (Playwright "load")
 *   rootEmpty        true when #root (or body) has no elements and no text
 *   canarySeen       the injected console.error canary was captured
 *   consoleErrors    captured renderer console error strings
 *
 * Returns { ok: true, reason: null, message } or { ok: false, reason, message }.
 */
export function bootVerdict(facts) {
  const errors = Array.isArray(facts?.consoleErrors) ? facts.consoleErrors : [];
  if (facts?.executableFound !== true) return verdict("binary-missing");
  if (facts?.loadFinished !== true) return verdict("load-failed");
  if (facts?.rootEmpty === true) return verdict("blank-window");
  if (facts?.canarySeen !== true) return verdict("console-capture-broken");
  if (errors.length > 0) return verdict("console-error");
  return { ok: true, reason: null, message: MESSAGES.ok };
}
