// Screen-capture permission verdict for the desktop shell (P3-404). The
// screen-peek flow ("Ver a tela") captures a frame of this machine's display
// via desktopCapturer in the shell — the TCC-responsible context — so on
// macOS a denied Screen Recording permission would silently produce black or
// empty frames with no way back. This module is the single mapping from the
// OS media-access state (systemPreferences.getMediaAccessStatus("screen")) to
// a CLOSED verdict: a static pt-BR sentence for the requester plus, when the
// platform has one, the system settings panel that unlocks screen capture
// (the privacy pane on macOS, the settings surface on Windows; no target
// anywhere else). Pure on purpose — no electron, no node builtins, no I/O —
// so scripts/unit.test.ts exercises the real code (same pattern as
// camaccess.ts / micaccess.ts); main.ts injects the platform and the raw
// status at request time, never at boot: the user can flip the permission
// while the app is open and the next ask must see it.

export type ScreenAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export type ScreenAccessVerdictKind = "ready" | "will-ask" | "blocked-by-system" | "unknown";

export interface ScreenAccessVerdict {
  verdict: ScreenAccessVerdictKind;
  /** Static pt-BR sentence — never a path, a user name or an address. */
  phrase: string;
  /** System panel that unlocks screen capture, when the platform has one. */
  settingsTarget: string | null;
}

/** macOS System Settings → Privacy & Security → Screen Recording. */
export const SCREEN_PANEL_MACOS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";

/** Windows Settings — the privacy surface that owns app permissions. */
export const SCREEN_PANEL_WINDOWS = "ms-settings:privacy-screen-capture";

const PHRASES: Record<ScreenAccessVerdictKind, string> = {
  ready: "A captura de tela está liberada neste computador. Tente de novo.",
  "will-ask": "O sistema ainda não decidiu sobre a captura de tela. Tente de novo e permita o acesso quando o sistema perguntar.",
  "blocked-by-system": "O acesso à tela está negado no sistema. Libere a captura de tela no painel de privacidade do computador.",
  unknown: "Não foi possível verificar a permissão de captura de tela neste sistema. Confira os ajustes do sistema e tente de novo.",
};

function settingsTargetFor(platform: unknown): string | null {
  if (platform === "darwin") return SCREEN_PANEL_MACOS;
  if (platform === "win32") return SCREEN_PANEL_WINDOWS;
  return null;
}

/**
 * Maps a raw OS media-access status to the closed screen-capture verdict.
 * Only the four documented status strings map to their verdicts; anything
 * else — an unknown value, an absent status, a non-textual input — fails
 * closed to "unknown". Never throws.
 */
export function screenAccessVerdict(platform: unknown, status: unknown): ScreenAccessVerdict {
  let verdict: ScreenAccessVerdictKind;
  switch (status) {
    case "granted":
      verdict = "ready";
      break;
    case "not-determined":
      verdict = "will-ask";
      break;
    case "denied":
    case "restricted":
      verdict = "blocked-by-system";
      break;
    default:
      verdict = "unknown";
  }
  return { verdict, phrase: PHRASES[verdict], settingsTarget: settingsTargetFor(platform) };
}
