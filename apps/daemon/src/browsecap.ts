// P2-284: browse-capability readiness verdict. Pure module — no node:fs,
// node:child_process, node:http, playwright-core or fetch imports and no I/O
// of any kind on purpose, because index.ts runs main() on import and unit
// tests must never boot a daemon (same pattern as doccap.ts / modelready.ts /
// opencodever.ts, lessons P2-149 and P2-228). All real I/O (reading
// OCR_BROWSE_DISABLED, resolving the playwright library, checking the chromium
// executable on disk, capturing a launch-error tail) stays in the caller —
// browse.ts probes, index.ts consumes; this module only judges.
//
// Why this exists: opening a site was the LAST machine capability discovered
// exactly at the worst moment — a lay user asks the agent to open a site,
// waits, and gets a raw English error with an install command
// ("playwright chromium not available — install it with: npx playwright
// install chromium") mid-conversation. Every other capability (voice, doc
// conversion, model, disk) is already announced by /api/health BEFORE the
// user commits to the task; browsing now is too.
//
// The four documented states, decided by the rules in THIS order — the order
// is part of the contract and each rule short-circuits the next:
//   1. absent input, non-object input or non-boolean marks are "unknown" and
//      NEVER "ready" — fail-closed, because announcing a readiness that was
//      never measured is worse than admitting we do not know;
//   2. browsing disabled by environment wins over everything else and is
//      "disabled" — the phrase never suggests installing anything, because
//      it was the machine's owner who turned it off;
//   3. library not resolved is "no-browser" before any look at the
//      executable — without the library there is nothing to launch;
//   4. executable not found is "no-browser";
//   5. a launch error present (the short tail captured by the last failed
//      launch) is "no-browser";
//   6. only the remainder is "ready".
// The result is identical for the same input on every call: no clock, no
// randomness, no module state.
//
// Phrase boundary (part of the contract): no phrase returned by this module
// ever contains an absolute path, a volume name, a library version, a port,
// an address, a raw environment variable name or the raw error tail — the
// tail is input for the verdict only and stays server-side.

export type BrowseState = "ready" | "no-browser" | "disabled" | "unknown";

export interface BrowseVerdict {
  state: BrowseState;
  /** Short actionable pt-BR sentence — never a path, port, address or raw error. */
  message: string;
}

/** The already-normalized result of the probe (see probeBrowse in browse.ts). */
export interface BrowseProbe {
  /** OCR_BROWSE_DISABLED=1 — the machine's owner turned browsing off. */
  disabled: boolean;
  /** The playwright-core library was importable. */
  libraryResolved: boolean;
  /** A chromium executable exists on disk (custom path or registry default). */
  executableFound: boolean;
  /** Short tail of the last failed launch, or null when the last launch worked. */
  launchError: string | null;
}

const READY_MESSAGE = "Navegação de sites pronta neste computador.";
const NO_BROWSER_MESSAGE =
  "Este computador ainda não tem navegador para abrir sites — instalar o navegador do Playwright é opcional e fica a cargo de quem gerencia a máquina.";
const DISABLED_MESSAGE =
  "A navegação de sites está desligada neste computador — quem gerencia a máquina é quem decide quando ligá-la.";
const UNKNOWN_MESSAGE =
  "Não deu para verificar a navegação de sites agora — o resto do app segue disponível do mesmo jeito.";

const READY: BrowseVerdict = { state: "ready", message: READY_MESSAGE };
const NO_BROWSER: BrowseVerdict = { state: "no-browser", message: NO_BROWSER_MESSAGE };
const DISABLED: BrowseVerdict = { state: "disabled", message: DISABLED_MESSAGE };
const UNKNOWN: BrowseVerdict = { state: "unknown", message: UNKNOWN_MESSAGE };

/**
 * A launch error is "present" when it is a non-empty string tail. A value of
 * any other type (garbage from a broken caller) counts as present — fail
 * closed, never announce ready on input we cannot read.
 */
function launchErrorPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "string") return true;
  return value.trim() !== "";
}

/**
 * Judge the browse capability from the already-normalized probe result.
 * See the module header for the rule order and the phrase boundary.
 */
export function browseReadiness(input: unknown): BrowseVerdict {
  // rule 1 — fail-closed validation: no object, no verdict
  if (typeof input !== "object" || input === null || Array.isArray(input)) return UNKNOWN;
  const probe = input as Record<string, unknown>;
  if (
    typeof probe.disabled !== "boolean" ||
    typeof probe.libraryResolved !== "boolean" ||
    typeof probe.executableFound !== "boolean"
  ) {
    return UNKNOWN;
  }
  // rule 2 — the owner's kill switch wins over everything else
  if (probe.disabled) return DISABLED;
  // rule 3 — without the library there is nothing to launch
  if (!probe.libraryResolved) return NO_BROWSER;
  // rule 4 — library present, but no executable on disk
  if (!probe.executableFound) return NO_BROWSER;
  // rule 5 — the last real launch attempt failed
  if (launchErrorPresent(probe.launchError)) return NO_BROWSER;
  // rule 6 — everything present
  return READY;
}
