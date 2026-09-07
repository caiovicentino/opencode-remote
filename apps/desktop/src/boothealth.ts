// P2-270: boot-health verdict for the desktop shell. A bad update could put
// stage 5 of docs/VISION.md (docs/VISION.md) into a loop nobody could see or
// escape: the signed package installs a version that dies before painting a
// useful window, every reopening dies the same way, the feed keeps inviting
// the owner to "update" to the very same version at each recheck — without a
// single log line and without one word to the owner, who has no remote access
// to the machine precisely because the shell never opens. gpuplan.ts counts
// GPU-process drops since P2-244, crash.ts / hangwatch.ts / loadfail.ts guard
// the renderer — but no file in apps/desktop/src remembered WHICH version is
// running, WHICH one last truly opened, nor how many consecutive openings
// died before a window. This module owns that DECISION: it maps (the running
// version, the record read from disk, the current instant and the documented
// floor) to exactly one of three verdicts — normal, suspeito or recuperar —
// plus a short tray label and one static sentence.
//
// Same module hygiene as gpuplan.ts / updatespace.ts / datawipe.ts: NO
// electron, NO node:fs, NO node:path, no fetch, no I/O of any kind, no
// timers — main.ts resolves the session flag, reads and writes the record
// through src/boothealthstore.ts (fs injected), and scripts/unit.test.ts plus
// the portable scripts/boothealth.test.ts exercise every rule in plain Node.
//
// RULE ORDER CONTRACT (the gate depends on it) — the rules below are
// evaluated exactly in this order and the order is part of the API:
//
//  1. an active test-harness session is NORMAL before any other decision,
//     and the wiring writes nothing, opens nothing and changes no screenshot
//     framing (the P2-235 and P2-238 lessons: the harness drives the
//     operator's machine);
//  2. an absent, empty, unreadable or non-object record is NORMAL, zeroes
//     the count and is NEVER "recuperar" — accusing a version on the basis
//     of a corrupted record would take exactly the security updates away
//     from the user, so corruption always resolves toward "do nothing";
//  3. a non-finite current instant is REFUSED instead of guessed — a broken
//     clock never becomes an accusation (the verdict degrades to normal);
//  4. an opening instant in the future is treated as "now" — a host clock
//     running ahead, which P2-214 proved to be a real failure, must never
//     invent history, so the record stays usable and the instant is clamped
//     to now instead of invalidating the record (the sanitize-as-corrupt
//     approach would silently heal a genuinely failing version);
//  5. a running version different from the last seen version zeroes the
//     count BEFORE any comparison, because the count belongs to ONE version;
//  6. a running version equal to the last one already considered healthy is
//     NORMAL even with a high count (the downgrade escape hatch);
//  7. a count below the documented floor is SUSPEITO and only registers;
//  8. a count at or above the floor is RECUPERAR.
//
// The result is identical for the same input in two calls — no clock, no
// randomness, no I/O.
//
// Label hygiene (the P2-140 and P2-182 lessons): every label and sentence is
// static pt-BR — the language of the neighboring journey status line in the
// tray (src/traystatus.ts) — with no file path, no volume name, no address,
// no port and no secret, and every tray label fits inside TRAY_TIP_MAX_CHARS
// (128, traystatus.ts), the max size documented for tray text.
//
// The "recuperar" verdict is a NON-DESTRUCTIVE verdict, by contract: it
// never rolls a version back, never uninstalls, never deletes user data and
// never installs anything. Its only effects, wired in main.ts, are to
// suspend the AUTOMATIC update check for that execution, to swap the tray
// label and to open one native question offering the outputs that already
// exist (the P2-163 diagnostic bundle) or "continue anyway" — a choice that
// is valid for that execution only and is never persisted.

/** Openings of the same version that died before a useful window, at which
 * the shell stops trusting the version. Same family as the P2-244 GPU ceiling
 * and the P3-011 reload budget (3): one death is an accident, two are a
 * pattern, three consecutive dead openings are a version that does not open
 * on this machine. */
export const BOOT_HEALTH_OPENING_FLOOR = 3;

/** The persisted boot record (boothealth.json, next to gpu-state.json). All
 * fields are version strings and counts only — never a path, never a
 * credential. `lastHealthyVersion` is absent until some opening of some
 * version truly finished loading a window. */
export interface BootHealthRecord {
  lastSeenVersion?: string;
  lastHealthyVersion?: string;
  unmatchedOpenings?: number;
  lastOpeningAt?: number;
}

/** Exactly one of three verdicts, per the rule order in the header. */
export type BootHealthVerdictName = "normal" | "suspeito" | "recuperar";

export interface BootHealthView {
  verdict: BootHealthVerdictName;
  /** Short tray label, static and secret-free (applied by main.ts only for
   * the "recuperar" verdict). */
  label: string;
  /** One static sentence, safe for the shell log — no path, no volume. */
  phrase: string;
  /** Stable reason id: harness | registro | relogio | saudavel | versao |
   * abaixo | recuperar. */
  reason: string;
  /** The effective unmatched-openings count for the RUNNING version after
   * the zeroing rules (absent/corrupt record and version change → 0). The
   * store adds the ongoing opening on top of it. */
  count: number;
  /** The normalized record (future opening instants already treated as
   * "now"), or null when rule 2 zeroed everything. The store uses it as the
   * base for its next write. */
  record: BootHealthRecord | null;
}

export interface BootHealthInput {
  /** True when the hermetic test harness owns this session
   * (OCR_DESKTOP_SESSION) — always normal, before everything else. */
  harnessSession: boolean;
  /** The version actually running (app.getVersion()). */
  runningVersion: string;
  /** The record exactly as read from disk — anything may arrive. */
  record: unknown;
  /** The current instant in epoch ms; non-finite refuses the decision. */
  nowMs: number;
  /** The documented floor (BOOT_HEALTH_OPENING_FLOOR in production; the
   * tests pass it explicitly). */
  floor: number;
}

// --- static copy (pt-BR, path-free, volume-free, address-free, secret-free) ---

const LABEL_NORMAL = "OpenCode Remote — inicialização regular";
const LABEL_SUSPECT = "OpenCode Remote — abertura irregular registrada";
export const BOOT_HEALTH_LABEL_RECOVER =
  "OpenCode Remote — versão sem janela útil: atualização automática suspensa";

const PHRASE_HARNESS = "Sessão de teste do harness — veredito normal e nenhum registro gravado ou aberto.";
const PHRASE_RECORD = "Registro de aberturas ausente ou ilegível — nada é acusado e a contagem recomeça do zero.";
const PHRASE_CLOCK = "Relógio da máquina ilegível — decisão recusada em vez de adivinhada.";
const PHRASE_HEALTHY = "A versão em execução já abriu janela útil antes — inicialização regular.";
const PHRASE_VERSION = "Versão diferente da última vista — a contagem pertence a uma versão só e recomeça do zero.";
const PHRASE_BELOW = "Aberturas sem janela útil abaixo do piso — apenas registrado; a atualização automática segue ligada.";
const PHRASE_RECOVER = "Esta versão fechou sem janela útil vezes demais — atualização automática suspensa nesta execução.";

/** One-question recovery dialog (static copy, pt-BR like quithint.ts /
 * datawipe.ts). The diagnostic button reuses the exact label of the existing
 * P2-163 "Copiar diagnóstico" Help-menu item, and "continue anyway" is valid
 * for that execution only — nothing is ever persisted. */
export const BOOT_HEALTH_DIALOG_TITLE = "O OpenCode Remote não abriu?";
export const BOOT_HEALTH_DIALOG_MESSAGE =
  "Esta versão fechou sem abrir janela útil mais vezes que o normal.";
export const BOOT_HEALTH_DIALOG_DETAIL =
  "A verificação automática de atualização fica suspensa nesta execução.";
export const BOOT_HEALTH_BUTTON_DIAGNOSTIC = "Copiar diagnóstico";
export const BOOT_HEALTH_BUTTON_CONTINUE = "Seguir assim mesmo";

/** Fixed button positions, matching the buttons array order in main.ts. */
export const BOOT_HEALTH_BUTTON_INDEX = { diagnostic: 0, continue: 1 } as const;

/**
 * Tolerant reader for the record value loaded from disk: whatever comes in, a
 * usable record or null comes out — never an exception. A non-object (or
 * array), an absent/empty lastSeenVersion, a lastHealthyVersion that is
 * neither absent nor a non-empty string, a non-finite or negative count or a
 * non-finite opening instant all make the record unusable (rule 2: normal,
 * count zeroed, never "recuperar"). A lastOpeningAt in the future is NOT
 * corruption: it is treated as "now" (clamped) so a clock that ran ahead
 * never invents history nor heals a genuinely failing version.
 */
export function normalizeBootHealthRecord(raw: unknown, nowMs: number): BootHealthRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { lastSeenVersion, lastHealthyVersion, unmatchedOpenings, lastOpeningAt } = raw as {
    lastSeenVersion?: unknown;
    lastHealthyVersion?: unknown;
    unmatchedOpenings?: unknown;
    lastOpeningAt?: unknown;
  };
  if (typeof lastSeenVersion !== "string" || lastSeenVersion.length === 0) return null;
  if (lastHealthyVersion !== undefined && (typeof lastHealthyVersion !== "string" || lastHealthyVersion.length === 0)) {
    return null;
  }
  if (typeof unmatchedOpenings !== "number" || !Number.isFinite(unmatchedOpenings) || unmatchedOpenings < 0) {
    return null;
  }
  if (typeof lastOpeningAt !== "number" || !Number.isFinite(lastOpeningAt)) return null;
  const clamped =
    Number.isFinite(nowMs) && lastOpeningAt > nowMs ? nowMs : lastOpeningAt;
  // Field order is a contract (P2-218): the JSON key order here matches the
  // order the store writes, so a record round-trips byte-stable.
  const record: BootHealthRecord =
    lastHealthyVersion !== undefined
      ? { lastSeenVersion, lastHealthyVersion, unmatchedOpenings, lastOpeningAt: clamped }
      : { lastSeenVersion, unmatchedOpenings, lastOpeningAt: clamped };
  return record;
}

/**
 * Pure boot decision. Rules apply in this exact order (see the header):
 * 1. harness session → normal before everything;
 * 2. absent/empty/unreadable/non-object record → normal, count zeroed,
 *    never "recuperar";
 * 3. non-finite current instant → refused (normal), never guessed;
 * 4. a future opening instant was already treated as "now" by the
 *    normalizer — the record stays usable;
 * 5. a running version different from the last seen one zeroes the count
 *    before any comparison;
 * 6. a running version equal to the last healthy one → normal, even with a
 *    high count;
 * 7. a count below the floor → suspeito, only registers;
 * 8. a count at or above the floor → recuperar.
 */
export function bootHealthVerdict(input: BootHealthInput): BootHealthView {
  const floor =
    typeof input.floor === "number" && Number.isFinite(input.floor) && input.floor >= 1
      ? input.floor
      : BOOT_HEALTH_OPENING_FLOOR;
  if (input.harnessSession) {
    return { verdict: "normal", label: LABEL_NORMAL, phrase: PHRASE_HARNESS, reason: "harness", count: 0, record: null };
  }
  const normalized = normalizeBootHealthRecord(input.record, input.nowMs);
  if (!normalized) {
    return { verdict: "normal", label: LABEL_NORMAL, phrase: PHRASE_RECORD, reason: "registro", count: 0, record: null };
  }
  if (!Number.isFinite(input.nowMs)) {
    return { verdict: "normal", label: LABEL_NORMAL, phrase: PHRASE_CLOCK, reason: "relogio", count: 0, record: normalized };
  }
  const versionChanged = input.runningVersion !== normalized.lastSeenVersion;
  const count = versionChanged ? 0 : normalized.unmatchedOpenings ?? 0;
  if (normalized.lastHealthyVersion !== undefined && input.runningVersion === normalized.lastHealthyVersion) {
    return { verdict: "normal", label: LABEL_NORMAL, phrase: PHRASE_HEALTHY, reason: "saudavel", count, record: normalized };
  }
  if (versionChanged) {
    return { verdict: "suspeito", label: LABEL_SUSPECT, phrase: PHRASE_VERSION, reason: "versao", count, record: normalized };
  }
  if (count < floor) {
    return { verdict: "suspeito", label: LABEL_SUSPECT, phrase: PHRASE_BELOW, reason: "abaixo", count, record: normalized };
  }
  return { verdict: "recuperar", label: BOOT_HEALTH_LABEL_RECOVER, phrase: PHRASE_RECOVER, reason: "recuperar", count, record: normalized };
}
