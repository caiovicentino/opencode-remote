// Camera-permission verdict for the desktop shell (P2-319). The scanner's
// NotAllowedError sentence was written for iOS Safari — a dead end inside the
// packaged Mac/Windows shell: someone pairing a phone by reading the QR on
// screen had no way back. This module is the single mapping from the OS
// media-access state (systemPreferences.getMediaAccessStatus) to a CLOSED
// verdict: a static pt-BR sentence for the scanner plus, when the platform
// has one, the system settings panel that unlocks the camera (the privacy
// pane on macOS, the camera page on Windows; no target anywhere else). Pure
// on purpose — no electron, no node builtins, no I/O — so
// scripts/unit.test.ts exercises the real code (same pattern as
// micaccess.ts); main.ts injects the platform and the raw status at request
// time, never at boot: the user can flip the permission while the app is open
// and the next ask must see it.

export type CameraAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export type CameraAccessVerdictKind = "ready" | "will-ask" | "blocked-by-system" | "unknown";

export interface CameraAccessVerdict {
  verdict: CameraAccessVerdictKind;
  /** Static pt-BR sentence — never a path, a user name or an address. */
  phrase: string;
  /** System panel that unlocks the camera, when the platform has one. */
  settingsTarget: string | null;
}

/** macOS System Settings → Privacy & Security → Camera. */
export const CAM_PANEL_MACOS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera";

/** Windows Settings → Privacy & security → Camera. */
export const CAM_PANEL_WINDOWS = "ms-settings:privacy-webcam";

const PHRASES: Record<CameraAccessVerdictKind, string> = {
  ready: "A câmera está liberada neste computador. Tente escanear de novo.",
  "will-ask": "O sistema ainda não decidiu sobre a câmera. Tente escanear de novo e permita o acesso quando o sistema perguntar.",
  "blocked-by-system": "O acesso à câmera está negado no sistema. Libere a câmera no painel de privacidade para escanear o código.",
  unknown: "Não foi possível verificar a permissão da câmera neste sistema. Confira os ajustes do sistema e tente de novo.",
};

function settingsTargetFor(platform: unknown): string | null {
  if (platform === "darwin") return CAM_PANEL_MACOS;
  if (platform === "win32") return CAM_PANEL_WINDOWS;
  return null;
}

/**
 * Maps a raw OS media-access status to the closed camera verdict. Only the
 * four documented status strings map to their verdicts; anything else — an
 * unknown value, an absent status, a non-textual input — fails closed to
 * "unknown". Never throws.
 */
export function camAccessVerdict(platform: unknown, status: unknown): CameraAccessVerdict {
  let verdict: CameraAccessVerdictKind;
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
