// Microphone-permission verdict for the desktop shell (P2-312). Until now the
// only NotAllowedError advice the product knew was written for iOS Safari —
// useless inside the packaged Mac/Windows shell. This module is the single
// mapping from the OS media-access state
// (systemPreferences.getMediaAccessStatus) to a CLOSED verdict: a static
// pt-BR sentence for the composer plus, when the platform has one, the
// system settings panel that unlocks the microphone (the privacy pane on
// macOS, the microphone page on Windows; no target anywhere else). Pure on
// purpose — no electron, no node builtins, no I/O — so scripts/unit.test.ts
// exercises the real code (same pattern as permissions.ts); main.ts injects
// the platform and the raw status at request time, never at boot: the user
// can flip the permission while the app is open and the next ask must see it.

export type MicAccessStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export type MicAccessVerdictKind = "ready" | "will-ask" | "blocked-by-system" | "unknown";

export interface MicAccessVerdict {
  verdict: MicAccessVerdictKind;
  /** Static pt-BR sentence — never a path, a user name or an address. */
  phrase: string;
  /** System panel that unlocks the microphone, when the platform has one. */
  settingsTarget: string | null;
}

/** macOS System Settings → Privacy & Security → Microphone. */
export const MIC_PANEL_MACOS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

/** Windows Settings → Privacy & security → Microphone. */
export const MIC_PANEL_WINDOWS = "ms-settings:privacy-microphone";

const PHRASES: Record<MicAccessVerdictKind, string> = {
  ready: "O microfone está liberado neste computador. Tente falar de novo.",
  "will-ask": "O sistema ainda não decidiu sobre o microfone. Tente falar de novo e permita o acesso quando o sistema perguntar.",
  "blocked-by-system": "O acesso ao microfone está negado no sistema. Libere o microfone no painel de privacidade para falar com o agente.",
  unknown: "Não foi possível verificar a permissão do microfone neste sistema. Confira os ajustes do sistema e tente de novo.",
};

function settingsTargetFor(platform: unknown): string | null {
  if (platform === "darwin") return MIC_PANEL_MACOS;
  if (platform === "win32") return MIC_PANEL_WINDOWS;
  return null;
}

/**
 * Maps a raw OS media-access status to the closed mic verdict. Only the four
 * documented status strings map to their verdicts; anything else — an unknown
 * value, an absent status, a non-textual input — fails closed to "unknown".
 * Never throws.
 */
export function micAccessVerdict(platform: unknown, status: unknown): MicAccessVerdict {
  let verdict: MicAccessVerdictKind;
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
