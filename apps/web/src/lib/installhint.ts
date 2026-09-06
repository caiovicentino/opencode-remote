// P2-220: iOS Safari evicts the script-writable storage (IndexedDB +
// localStorage) of a website that was never installed to the Home Screen after
// ~7 days of no use — the device's private key dies with it and the only
// recovery is physically walking up to the Mac to scan another QR. This module
// decides when a calm one-line hint ("add to Home Screen keeps your pairing")
// is worth showing.
//
// PURE on purpose (in the spirit of archive.ts / welcome.ts): no React, no
// window, no localStorage, no fetch. apps/web is not unit-testable in jsdom
// here, so scripts/unit.test.ts pins the full verdict table against this file.
//
// WHY ONLY iOS (module-header reason, kept out of the copy): Android's Chrome
// has its own install prompt AND a different storage-eviction policy
// (WebAPKs/installed TWA storage is not swept the way Safari's ITP purges
// regular-tab websites), so an Android variant needs its own verdict table —
// future task if it ever deserves one.

export const INSTALL_HINT_MESSAGE =
  "Adicione o app à tela de início para manter o pareamento salvo — no navegador, toque no botão Compartilhar e escolha Adicionar à Tela de Início.";

export const INSTALL_HINT_DISMISSED_KEY = "ocr.installhint.dismissed";

/** iOS only — an iPad running iPadOS 13+ may report a Macintosh UA, in which
 * case the caller must pass the touch indicator (navigator.maxTouchPoints) for
 * the pairing-at-risk verdict; without it we stay quiet (fail closed on
 * noise). Android/desktop UAs never qualify. */
function looksLikeIos(userAgent: string, maxTouchPoints?: number): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  // iPadOS 13+ masquerades as macOS desktop Safari: same "Macintosh" UA, but
  // a touch screen. Only trusted when the caller hands the count over.
  return (
    /Macintosh/i.test(userAgent) && typeof maxTouchPoints === "number" && maxTouchPoints > 1
  );
}

export interface InstallHintInput {
  userAgent: string;
  /** (display-mode: standalone) or navigator.standalone — already installed. */
  standalone: boolean;
  /** Running inside the Electron desktop shell, where no browser ever purges
   * the app's own storage. */
  desktopShell: boolean;
  /** At least one saved pairing exists on this device. */
  hasPairing: boolean;
  /** The user already dismissed the hint (their choice wins over the default). */
  dismissed: boolean;
  /** Optional navigator.maxTouchPoints, so an iPad masquerading as macOS can
   * still be recognized. Absent = unknown = stay quiet. */
  maxTouchPoints?: number;
}

export interface InstallHintVerdict {
  show: boolean;
  message: string;
}

/** Ordered rules — each early return is a hide, so the LAST rule is the only
 * one that shows. The order is part of the contract pinned by unit tests. */
export function installHintVerdict(input: InstallHintInput): InstallHintVerdict {
  const message = INSTALL_HINT_MESSAGE;
  // (a) desktop shell: storage is the shell's own, no browser purges it.
  if (input.desktopShell) return { show: false, message };
  // (b) explicit dismissal: the user's choice beats any default.
  if (input.dismissed) return { show: false, message };
  // (c) already installed to the Home Screen: Safari keeps installed
  //     storage, so there is nothing to warn about.
  if (input.standalone) return { show: false, message };
  // (d) not an iPhone/iPad browser (Android, desktop browsers): different
  //     install prompt and storage policy — out of scope for this hint.
  const ua = typeof input.userAgent === "string" ? input.userAgent : "";
  if (!looksLikeIos(ua, input.maxTouchPoints)) return { show: false, message };
  // (e) nothing saved yet: the first screen never earns noise.
  if (!input.hasPairing) return { show: false, message };
  // (f) regular iOS tab with a saved pairing: exactly the storage Safari may
  //     sweep after a week of silence.
  return { show: true, message };
}

/** Tolerant read of the dismissal flag: absent key, wrong type or corrupted
 * JSON all mean "not dismissed", never an exception. */
export function parseInstallHintDismissed(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  try {
    return JSON.parse(raw) === true;
  } catch {
    return false;
  }
}

/** Write side of the flag. Deliberately constant: the entry never carries a
 * room, a key, a token or any other credential — just the word "true". */
export function serializeInstallHintDismissed(): string {
  return "true";
}
