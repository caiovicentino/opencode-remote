// P2-348: pure login-launch planner for the desktop shell. Since P2-218 the
// installed app opens at login — and that boot used to throw the full window
// in the owner's face on every machine restart, because nothing distinguished
// an automatic login launch from a user launch. Owners reacted by turning
// Start at login OFF in the tray, which is exactly the failure P2-218 exists
// to prevent (an app that is not running is the one failure no wake reaction
// can fix: the phone finds no machine after the reboot). This module decides
// whether a boot shows the main window or keeps it ready and hidden in the
// tray, following the launch evidence the caller reads:
//
//   - a cold deep link (an opencode-remote://pair invite that arrived before
//     ready) always wins and shows the window — the user asked for something;
//   - a dev build always shows — the developer launched it;
//   - on macOS the OS itself reports the login launch (wasOpenedAtLogin);
//   - on Windows the launch is a login launch when the dedicated
//     LOGIN_LAUNCH_ARG is in argv — the same argument setLoginItemEnabled
//     registers next to openAtLogin (single call point in main.ts);
//   - any other platform has no login-item auto-launch, so every launch there
//     is a user launch and shows the window.
//
// Same module hygiene as loginitem.ts / wakeplan.ts / storageprobe.ts: NO
// Electron API, no Node builtins, no network calls, no timers, no imports at
// all — main.ts reads the real platform / app.isPackaged /
// app.getLoginItemSettings().wasOpenedAtLogin / process.argv / the
// cold-deep-link state at boot and applies the verdict, and
// scripts/unit.test.ts exercises every rule in plain Node. Reasons are short
// static pt-BR strings with no file paths, no URL schemes and no secrets (the
// P2-140 bar).

/** The closed set of boot outcomes: open the window, or stay in the tray. */
export type LoginLaunchAction = "show" | "tray";

export interface LoginLaunchVerdict {
  action: LoginLaunchAction;
  /** Short pt-BR motive — static, path-free, scheme-free, secret-free. */
  reason: string;
}

/** Everything the decision needs, resolved by the caller (main.ts) at boot. */
export interface LoginLaunchInput {
  /** process.platform as the caller resolved it. */
  platform: string;
  /** True only in a packaged (installed) build — a dev machine's launch is
   * always the developer's own. */
  packaged: boolean;
  /** app.getLoginItemSettings().wasOpenedAtLogin, read once at boot. The OS
   * property exists on macOS; on Windows it is undefined and the caller's
   * argv carries the decision instead. */
  wasOpenedAtLogin: boolean;
  /** process.argv of THIS launch — the Windows login registration carries
   * LOGIN_LAUNCH_ARG (setLoginItemEnabled registers it with openAtLogin). */
  argv: readonly string[];
  /** True when a cold deep link (opencode-remote://pair) arrived before
   * ready — macOS open-url or the Windows cold-start argv (P2-329). */
  coldDeepLink: boolean;
}

/**
 * The dedicated login argument registered with openAtLogin on Windows
 * (main.ts's single setLoginItemSettings call point) and detected here by
 * exact entry match. Kept unique and unsimilar to any existing flag so a
 * user-launched Windows argv can never collide with it.
 */
export const LOGIN_LAUNCH_ARG = "--ocr-login-launch";

/**
 * Decide how this boot surfaces the shell window. Rules apply in this exact
 * order, first match wins:
 *
 *  1. a cold deep link always wins and shows the window — an invite the
 *     owner clicked is an explicit request, even on a login boot;
 *  2. a dev build always shows — the developer launched it themselves;
 *  3. a packaged macOS launch reported by the OS as opened at login stays
 *     in the tray (window ready and hidden), any other macOS launch shows;
 *  4. a packaged Windows launch carrying LOGIN_LAUNCH_ARG stays in the
 *     tray, any other Windows launch shows;
 *  5. any other platform shows — there is no login-item auto-launch there.
 */
export function loginLaunchPlan(input: LoginLaunchInput): LoginLaunchVerdict {
  if (input.coldDeepLink) {
    return { action: "show", reason: "convite de pareamento aberto — mostrando a janela" };
  }
  if (!input.packaged) {
    return { action: "show", reason: "build de desenvolvimento — mostrando a janela" };
  }
  const tray = {
    action: "tray" as const,
    reason: "aberto sozinho ao ligar o computador — janela pronta e escondida até você pedir",
  };
  const show = { action: "show" as const, reason: "aberto por você — mostrando a janela" };
  if (input.platform === "darwin") {
    return input.wasOpenedAtLogin ? tray : show;
  }
  if (input.platform === "win32") {
    return input.argv.includes(LOGIN_LAUNCH_ARG) ? tray : show;
  }
  return { action: "show", reason: "plataforma sem item de login suportado — mostrando a janela" };
}
