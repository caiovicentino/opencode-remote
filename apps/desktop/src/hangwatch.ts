// P2-223: pure hang-watch verdict planner for the desktop shell. A frozen
// window used to leave the owner staring at a dead app without a word, and a
// third renderer crash in a row became a permanent white screen in silence.
// This module decides how loud each moment must be — log only, a tray tip,
// or the native Reload/Wait box — and carries the copy so the log line, the
// notification and the dialog all tell the same story.
//
// Same module hygiene as quithint.ts / closehint.ts / loginitem.ts: NO
// electron, no node:fs, no fetch, no I/O of any kind — crash.ts and main.ts
// resolve the inputs and apply the verdict, and scripts/unit.test.ts
// exercises every rule in plain Node. All phrases are short static pt-BR
// strings with no file paths, no URL schemes and no secrets (the P2-140 bar).
//
// RULE ORDER CONTRACT (the gate depends on it): the harness-session rule
// comes FIRST and must stay first — before any time, budget or packaging
// consideration, the P2-221 lesson — because tools/desktop.mjs, the
// npm run test:desktop-flow battery and the P2-204/P2-208 packaged-boot
// smokes would hang on a modal box. The second gate is temporal: below the
// exported warn threshold the action is only "log", so a normal garbage
// collector spike never becomes an alarm.

export type HangAction = "log" | "warn" | "dialog";

/** A window frozen for less than this is routine (GC pause, sync drain):
 * log only. Roughly the moment a human starts noticing the beachball. */
export const HANG_WARN_THRESHOLD_MS = 5_000;

/** A window STILL frozen past this gets the native Reload/Wait box — the
 * same beat as a browser's "page unresponsive" sheet. */
export const HANG_DIALOG_THRESHOLD_MS = 30_000;

export interface HangVerdictInput {
  /** True when the hermetic test harness owns this session — it must never
   * see a modal (first rule, before everything else). */
  harnessSession: boolean;
  /** How long the window has been unresponsive (0 on the white-screen path,
   * where the renderer is gone and the hang duration is moot). */
  unresponsiveMs: number;
  /** True when the renderer reload budget is gone (definitive white page). */
  reloadBudgetExhausted: boolean;
  /** True when a user-facing warning already fired for this same episode. */
  alreadyWarned: boolean;
}

export interface HangVerdict {
  action: HangAction;
  /** Short pt-BR line for the log — static, path-free, scheme-free. */
  log: string;
  /** Short pt-BR line for the tray tip (notification body). */
  tray: string;
  /** Short pt-BR line for the native dialog body. */
  dialog: string;
}

/** Native dialog + notification copy, exported so tests, crash.ts and main.ts
 * share one source. */
export const HANG_NOTIFY_TITLE = "OpenCode Remote não está respondendo";
export const HANG_DIALOG_TITLE = "A janela parou de responder";
export const HANG_DIALOG_MESSAGE =
  "A janela está travada há bastante tempo. Recarregar não perde a conversa.";
export const HANG_BUTTON_RELOAD = "Recarregar";
export const HANG_BUTTON_WAIT = "Aguardar";
/** Dialog button indices, fixed by the buttons array order in main.ts. */
export const HANG_BUTTON_INDEX = { reload: 0, wait: 1 } as const;

const LOG_HARNESS = "sessão de teste do harness — travamento apenas registrado";
const LOG_SHORT = "janela lenta por pouco tempo — apenas registrado";
const LOG_EXHAUSTED = "tela branca definitiva: orçamento de recargas esgotado";
const LOG_SEVERE = "janela travada por tempo longo — oferecendo recarregar ou aguardar";
const LOG_WARNED = "janela segue travada — aviso já mostrado neste episódio";
const LOG_WARN = "janela parou de responder — avisando sem caixa de diálogo";
const TRAY_TIP = "A janela parou de responder. Pode voltar sozinha — recarregar não perde conversa.";

/**
 * Decide how loud a frozen window must be. Rules apply in this exact order:
 *
 *  1. a test-harness session only logs — the gate and the packaged smoke end
 *     the app themselves and a modal box would hang them;
 *  2. a freeze below the warn threshold only logs — a normal GC spike must
 *     never become an alarm;
 *  3. an exhausted reload budget (definitive white screen) offers the box —
 *     the automatic recovery gave up, so the owner gets the escape hatch;
 *  4. a freeze still going past the dialog threshold offers the box, even
 *     after the tray tip;
 *  5. a warning already shown in this same episode stays quiet — one
 *     user-facing warning per episode;
 *  6. a fresh freeze past the warn threshold gets the tray tip without a
 *     modal — the renderer may well recover on its own.
 */
export function hangVerdict(input: HangVerdictInput): HangVerdict {
  if (input.harnessSession) {
    return { action: "log", log: LOG_HARNESS, tray: TRAY_TIP, dialog: HANG_DIALOG_MESSAGE };
  }
  if (!input.reloadBudgetExhausted && input.unresponsiveMs < HANG_WARN_THRESHOLD_MS) {
    return { action: "log", log: LOG_SHORT, tray: TRAY_TIP, dialog: HANG_DIALOG_MESSAGE };
  }
  if (input.reloadBudgetExhausted) {
    return { action: "dialog", log: LOG_EXHAUSTED, tray: TRAY_TIP, dialog: HANG_DIALOG_MESSAGE };
  }
  if (input.unresponsiveMs >= HANG_DIALOG_THRESHOLD_MS) {
    return { action: "dialog", log: LOG_SEVERE, tray: TRAY_TIP, dialog: HANG_DIALOG_MESSAGE };
  }
  if (input.alreadyWarned) {
    return { action: "log", log: LOG_WARNED, tray: TRAY_TIP, dialog: HANG_DIALOG_MESSAGE };
  }
  return { action: "warn", log: LOG_WARN, tray: TRAY_TIP, dialog: HANG_DIALOG_MESSAGE };
}
