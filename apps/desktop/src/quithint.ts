// P2-221: pure quit-confirmation planner for the desktop shell. Since P2-218
// the app opens at login precisely so the phone always finds this machine —
// but the tray/menu Quit items still ended the process with zero words, and
// the owner only notices the lost remote access when already far away. This
// module decides whether an explicit quit should ask first, and carries the
// native dialog's copy so the box, the log line and the diagnostics line all
// tell the same story.
//
// Same module hygiene as closehint.ts / wakeplan.ts / loginitem.ts: NO
// electron, no node:fs, no fetch, no I/O of any kind — main.ts resolves the
// indicators at quit time and applies the verdict, and scripts/unit.test.ts
// exercises every rule in plain Node. Reasons are short static pt-BR strings
// with no file paths, no URL schemes and no secrets (the P2-140 bar).
//
// RULE ORDER CONTRACT (the gate depends on it): the harness-session rule
// comes FIRST and must stay first. tools/desktop.mjs (P1-051), the
// npm run test:desktop-flow battery and the P2-204/P2-208 packaged-boot smoke
// all end the app by themselves; a modal dialog on that path would hang the
// gate and the release. A test session always quits silently, before any
// other consideration and before any dialog can open.

export type QuitAction = "quit" | "confirm";

export interface QuitVerdict {
  action: QuitAction;
  /** Short pt-BR motive — static, path-free, scheme-free, secret-free. */
  reason: string;
}

/** Everything the decision needs, resolved by the caller (main.ts) at quit
 * time. No probe, no request and no timer is created for this: every input
 * already exists when the user asks to quit. */
export interface QuitHintInput {
  /** True only in a packaged (installed) build. */
  packaged: boolean;
  /** True when the hermetic test harness owns this session (the
   * OCR_DESKTOP_SESSION hatch) — it must always quit silently. */
  harnessSession: boolean;
  /** The daemon's health at the last pairing tick (true = answered 200). */
  daemonHealthy: boolean;
  /** True when at least one phone is in the allowlist. */
  phonePaired: boolean;
  /** True when the owner already checked "don't ask again" (quit-ask.json). */
  dontAskAgain: boolean;
}

/** Native dialog copy, exported so tests and main.ts share one source. */
export const QUIT_DIALOG_TITLE = "Sair do OpenCode Remote?";
export const QUIT_DIALOG_MESSAGE = "Sair encerra o acesso do celular a esta máquina";
export const QUIT_DIALOG_DETAIL =
  "Enquanto o app estiver aberto, o celular continua enxergando este computador — mesmo com a janela fechada. Sair de verdade derruba esse acesso até que o app seja aberto de novo.";
export const QUIT_BUTTON_QUIT = "Sair";
export const QUIT_BUTTON_STAY = "Continuar na bandeja";
export const QUIT_BUTTON_NEVER = "Não perguntar de novo";

/** Dialog button indices, fixed by the buttons array order in main.ts. */
export const QUIT_BUTTON_INDEX = { quit: 0, stay: 1, never: 2 } as const;

/**
 * Decide whether an explicit quit (tray Quit item, menu quit item) quits
 * silently or asks first. Rules apply in this exact order:
 *
 *  1. a test-harness session always quits silently — the gate and the packaged
 *     smoke end the app themselves and a modal box would hang them;
 *  2. an unpackaged (dev) build always quits silently — nothing on a dev
 *     machine is hosting the phone's remote access;
 *  3. a recorded "don't ask again" decision always quits silently — the
 *     owner's choice is definitive, like the P2-218 startup decision;
 *  4. an unhealthy local daemon quits silently — there is no remote access
 *     left to lose;
 *  5. no paired phone quits silently — for the same reason;
 *  6. only a packaged build with a healthy daemon, a paired phone and no
 *     recorded decision asks first.
 */
export function quitVerdict(input: QuitHintInput): QuitVerdict {
  if (input.harnessSession) {
    return { action: "quit", reason: "sessão de teste do harness — sair sem caixa de diálogo" };
  }
  if (!input.packaged) {
    return { action: "quit", reason: "build de desenvolvimento — sair sem confirmação" };
  }
  if (input.dontAskAgain) {
    return { action: "quit", reason: "dono pediu para não perguntar de novo — sair direto" };
  }
  if (!input.daemonHealthy) {
    return { action: "quit", reason: "daemon local não está saudável — não há acesso remoto a perder" };
  }
  if (!input.phonePaired) {
    return { action: "quit", reason: "nenhum celular pareado — não há acesso remoto a perder" };
  }
  return {
    action: "confirm",
    reason: "build empacotado com daemon saudável e celular pareado — confirmar antes de sair",
  };
}
