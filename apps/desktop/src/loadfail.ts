// P2-247: pure load-failure policy for the desktop shell. A window whose
// content never finishes loading — a corrupted asset inside the package, a
// partially written update, a file quarantined by antivirus on Windows, a
// slow volume — used to leave the stage-3 user (docs/VISION.md) staring at a
// definitive white window: no word, no log line, no recovery. main.ts only
// ever observed the SUCCESS side of the main window's load ("did-finish-load",
// for the zoom level), so the failure event died in silence — exactly the
// outcome P2-223 closed for the frozen window and P2-244 for the GPU process.
//
// Same module hygiene as hangwatch.ts / gpuplan.ts: NO electron, no node:fs,
// no fetch, no I/O, no timers of any kind — main.ts resolves the real
// "did-fail-load" event, applies the verdict, waits and reloads through the
// same webContents.reload() path as the P3-011 recovery, and paints the
// final message into the window itself; scripts/unit.test.ts and the portable
// twin scripts/loadfail.test.ts exercise every rule in plain Node.
//
// THE NUMBERS, and why:
// - LOAD_FAIL_MAX_ATTEMPTS is THREE, the same family as the P3-011 renderer
//   reload budget: one failed load may be transient (antivirus scan, disk
//   flush); by the third consecutive automatic reload the asset is broken for
//   good and reloading again is noise, not recovery.
// - LOAD_FAIL_RETRY_DELAY_MS is 1_500: long enough for the common transient
//   causes (a scan or a flush holding the file) to release it, short enough
//   that the person still sees the app trying before the give-up.
//
// PRIVACY CONTRACT (the P2-182 lesson): the shared desktop.log must never
// carry the user's navigation. Of the failed address, ONLY the URL scheme
// survives sanitization (a bare validated word like "file" or "https") —
// file names, paths and query strings never reach the record, so neither the
// log line nor the in-window phrase can leak them.
//
// RULE ORDER CONTRACT (the gate depends on it): loadFailVerdict applies the
// rules in this exact order and returns exactly one plan per call —
//  1. a frame that is not the main one always ignores without accumulating
//     anything (guest frames have their own P2-092/P2-184 guards, untouched);
//  2. Chromium's deliberate navigation abort (ERR_ABORTED — fired, among
//     others, by the shell's own will-navigate guard) always ignores without
//     accumulating anything, otherwise every guarded navigation would burn
//     retry budget;
//  3. a count below the ceiling orders one more retry;
//  4. only a count at or above the ceiling gives up with the in-window
//     warning.
// The returned count is never negative and the same input always yields the
// same output.

/** Max consecutive automatic reloads of the main frame before the shell gives
 * up and shows the in-window warning. Same family as the P3-011 budget (3). */
export const LOAD_FAIL_MAX_ATTEMPTS = 3;

/** Wait between one failed load and the next automatic reload, in ms. */
export const LOAD_FAIL_RETRY_DELAY_MS = 1_500;

/** Chromium's ERR_ABORTED: a navigation cancelled on purpose (user stop,
 * superseded load, or the shell's own will-navigate guard) — never evidence
 * of a broken asset, so it must never consume retry budget. */
export const CHROMIUM_ERR_ABORTED = -3;

/** Scheme words longer than this are not schemes; the address is not trusted. */
const SCHEME_MAX = 32;

/** Shape of one sanitized "did-fail-load" event. `scheme` carries only the
 * validated URL scheme of the failed address ("" when unknown) — never the
 * full URL (the P2-182 lesson). `ok` is false for the zeroed record every
 * unusable input degrades to. */
export interface LoadFailureRecord {
  code: number;
  description: string;
  scheme: string;
  isMainFrame: boolean;
  ok: boolean;
}

/** The zeroed record: code 0 is not a real Chromium error code, the frame is
 * flagged secondary, and loadFailVerdict ignores it without accumulating. */
export const LOAD_FAILURE_ZEROED: LoadFailureRecord = {
  code: 0,
  description: "",
  scheme: "",
  isMainFrame: false,
  ok: false,
};

/** Scheme-only extraction: a bare `scheme://` prefix validated against the
 * URL grammar. Anything else — no separator, a schemeless path, a Windows
 * drive letter — degrades to "" so nothing but a real scheme can travel. */
function urlScheme(address: string): string {
  const sep = address.indexOf("://");
  if (sep <= 0) return "";
  const scheme = address.slice(0, sep);
  if (scheme.length > SCHEME_MAX) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*$/.test(scheme) ? scheme.toLowerCase() : "";
}

const zeroed = (): LoadFailureRecord => ({ ...LOAD_FAILURE_ZEROED });

/**
 * Tolerant reader for one raw "did-fail-load" event: whatever comes in, a
 * valid record comes out — absent input, a non-numeric or non-finite code, a
 * wrong-typed description, a missing/empty/non-string address — all become the
 * zeroed record. A missing frame field is NOT zeroed: it is treated as a
 * secondary frame (Electron only started passing the flag in newer versions;
 * unknown means "not provably main"). Never throws.
 */
export function sanitizeLoadFailure(input: unknown): LoadFailureRecord {
  if (typeof input !== "object" || input === null) return zeroed();
  const { code, description, address, isMainFrame } = input as {
    code?: unknown;
    description?: unknown;
    address?: unknown;
    isMainFrame?: unknown;
  };
  if (typeof code !== "number" || !Number.isFinite(code)) return zeroed();
  if (typeof description !== "string") return zeroed();
  if (typeof address !== "string" || address.length === 0) return zeroed();
  return {
    code,
    description,
    scheme: urlScheme(address),
    isMainFrame: isMainFrame === true,
    ok: true,
  };
}

/** The three possible answers to one failed load. */
export type LoadFailPlan = "ignore" | "retry" | "giveup";

export interface LoadFailVerdict {
  plan: LoadFailPlan;
  /** The attempt counter AFTER this failure: unchanged when the failure is
   * ignored or the episode ends in give-up, +1 on a retry. Never negative. */
  count: number;
  /** Static pt-BR line for the one log line per decision — path-free,
   * scheme-free. */
  reason: string;
  /** Retry only: how long to wait before the reload. */
  waitMs?: number;
  /** Retry only: the epoch ms the reload is scheduled for (nowMs + waitMs). */
  retryAtMs?: number;
}

const REASON_IGNORE_FRAME = "falha em quadro que não é o principal — ignorada sem acumular";
const REASON_IGNORE_ABORT = "navegação cancelada de propósito — ignorada sem acumular";
const REASON_RETRY = "falha ao carregar a janela principal — tentando de novo";
const REASON_GIVEUP = "falha ao carregar persistente — recarregamentos automáticos esgotados";

/**
 * Pure decision for one failed load of the main window. See the RULE ORDER
 * CONTRACT in the header: non-main frame first, deliberate abort second, then
 * the retry budget — one plan per call, count never negative, stable.
 */
export function loadFailVerdict(record: LoadFailureRecord, attemptsDone: number, nowMs: number): LoadFailVerdict {
  const base = Math.max(0, attemptsDone);
  if (!record.isMainFrame) {
    return { plan: "ignore", count: base, reason: REASON_IGNORE_FRAME };
  }
  if (record.code === CHROMIUM_ERR_ABORTED) {
    return { plan: "ignore", count: base, reason: REASON_IGNORE_ABORT };
  }
  if (base < LOAD_FAIL_MAX_ATTEMPTS) {
    return {
      plan: "retry",
      count: base + 1,
      reason: REASON_RETRY,
      waitMs: LOAD_FAIL_RETRY_DELAY_MS,
      retryAtMs: nowMs + LOAD_FAIL_RETRY_DELAY_MS,
    };
  }
  return { plan: "giveup", count: base, reason: REASON_GIVEUP };
}

export interface LoadFailMessages {
  /** The single pt-BR phrase painted into the window itself on give-up. */
  user: string;
  /** The one desktop.log line for the give-up decision — only the URL scheme
   * may appear from the failed address, never the full URL, a path or a
   * secret (the P2-182 lesson). */
  log: string;
}

/** Body of the in-window give-up message. Static pt-BR, path-free. */
export const LOAD_FAIL_USER_MESSAGE =
  "A tela do app não conseguiu carregar. Tentamos recarregar sozinhos e não deu certo: " +
  "feche e reabra o OpenCode Remote. Se voltar a acontecer, pode haver uma instalação " +
  "danificada — reinstale o app.";

/**
 * The user phrase and the log line for the give-up decision, from the same
 * sanitized record. Both are stable (same input → same output), static pt-BR
 * with no absolute path, no full address and no secret — of the address only
 * the scheme may appear ("esquema file"), with an unknown scheme degrading to
 * a fixed word instead of leaking the raw address.
 */
export function loadFailMessage(record: LoadFailureRecord): LoadFailMessages {
  const scheme = record.scheme || "desconhecido";
  return {
    user: LOAD_FAIL_USER_MESSAGE,
    log: `falha ao carregar a janela principal (código ${record.code}, esquema ${scheme}) — recarregamentos automáticos esgotados`,
  };
}
