// P2-218: pure login-item planner for the desktop shell. A stage-3 user
// (docs/VISION.md) installs, pairs by QR and then controls this machine from
// anywhere — until the first reboot, power cut or logout, when the app simply
// is not running anymore. From the phone that looks exactly like the machine
// vanished, with no cause, and neither the P2-209 wake reaction (asleep →
// awake) nor the sidecar respawn (daemon dead, shell alive) can reach the
// case of the app not running at all. This module decides whether the boot
// should turn ON "start at login" — the one OS setting that keeps the shell
// alive across reboots — following the owner's prior choice above everything.
//
// Same module hygiene as wakeplan.ts / installloc.ts / closehint.ts: NO
// electron, no node:fs, no fetch, no I/O of any kind — main.ts reads the real
// app.isPackaged / process.platform / app.getLoginItemSettings() at boot and
// applies the verdict, and scripts/unit.test.ts exercises every rule in plain
// Node. Reasons are short static pt-BR strings with no file paths, no URL
// schemes and no secrets (the P2-140 bar).
//
// Platform note (by design): app.setLoginItemSettings/getLoginItemSettings are
// no-ops outside macOS and Windows (Electron docs; mirrored by
// loginItemSupported in tray.ts, which hides the tray item elsewhere) — any
// other platform always leaves the setting untouched.

export type LoginItemAction = "enable" | "leave";

export interface LoginItemVerdict {
  action: LoginItemAction;
  /** Short pt-BR motive — static, path-free, scheme-free, secret-free. */
  reason: string;
}

/** Everything the decision needs, resolved by the caller (main.ts) at boot. */
export interface LoginItemInput {
  /** True only in a packaged (installed) build — a dev machine's login item
   * is never touched. */
  packaged: boolean;
  /** process.platform as the caller resolved it. */
  platform: string;
  /** app.getLoginItemSettings().openAtLogin, read once at boot. */
  alreadyEnabled: boolean;
  /** True when the owner already decided this setting at least once
   * (the startup.json flag). The owner's choice always wins the default and
   * is never reverted on any boot — including OFF. */
  ownerDecided: boolean;
}

/** Static copy per action, reused verbatim by the pairing payload so the
 * overlay, the log and the diagnostics line all tell the same story. */
export function loginItemMessage(action: LoginItemAction): string {
  return action === "enable"
    ? "a partir de agora este computador abre o app sozinho ao ligar — para desligar, desmarque Start at login no menu da bandeja"
    : "abertura no login segue como está — o ajuste fica no menu da bandeja, em Start at login";
}

/**
 * Decide whether this boot turns the login item on. Rules apply in this
 * exact order:
 *
 *  1. a dev build always leaves the setting alone — the development machine
 *     never has its login item touched;
 *  2. a platform outside macOS/Windows leaves it alone — the API is a no-op
 *     there and the tray item is already hidden (documented above);
 *  3. a recorded owner decision always leaves it alone, even when the toggle
 *     is OFF — the user's choice beats the default and is never reverted on
 *     any boot;
 *  4. an already-enabled login item needs nothing;
 *  5. only the first packaged boot with no recorded decision enables it —
 *     so the phone keeps finding this machine after the first reboot.
 */
export function loginItemPlan(input: LoginItemInput): LoginItemVerdict {
  if (!input.packaged) {
    return { action: "leave", reason: "build de desenvolvimento — o ajuste de login da máquina nunca é mexido" };
  }
  if (input.platform !== "darwin" && input.platform !== "win32") {
    return { action: "leave", reason: "plataforma sem item de login suportado — nada a fazer" };
  }
  if (input.ownerDecided) {
    return { action: "leave", reason: "decisão do dono já registrada — nenhum boot religa o ajuste" };
  }
  if (input.alreadyEnabled) {
    return { action: "leave", reason: "abertura no login já está ligada — nada a fazer" };
  }
  return {
    action: "enable",
    reason: "primeiro boot do app instalado — ligar a abertura no login para o celular achar a máquina",
  };
}
