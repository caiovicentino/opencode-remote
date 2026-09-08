// P2-211: install-location classifier for the macOS first-boot journey. A
// leigo user downloads the release DMG, opens the app straight from the
// mounted volume and never drags it anywhere — the bundle then runs read-only
// from a random quarantine path, Squirrel.Mac can never swap it (auto-update
// silently stops working), state seems to vanish on every launch and the app
// is gone when the volume is ejected. Nothing said why — the same class of
// late, mute failure the P2-197/P2-199 pairing verdicts closed. This module
// turns the boot-time location snapshot into one calm verdict.
//
// P2-299 (Windows, additive): Windows has the exact same first-boot traps —
// Explorer opens the executable from inside the downloaded zip by unpacking
// it into a temporary folder under the user profile, the person runs the app
// from the Downloads folder without ever installing it, or runs it from a
// network share — and in every one of those cases the installer can never
// swap the binary on update, state seems to vanish on every launch and the
// app disappears when the path does. The Windows table classifies ONLY by the
// shape of the running executable's path — the very string the shell already
// holds at boot (process.execPath) — so it needs no new disk access, no new
// system call and no timer. Windows paths are case-insensitive, so the table
// compares against a lowercased copy of the path; the rules, in THIS order:
//   1. a platform outside the documented pair (darwin, win32) is ok exactly
//      as before;
//   2. a missing or non-textual path entry is unknown (the macOS table keeps
//      its own P2-211 flow byte-for-byte and is not re-ruled here);
//   3. a network share wins over everything else because it is the gravest
//      case: a path starting with two backslashes is unc-share;
//   4. then the user temp directory: a path under the profile's
//      AppData\Local\Temp folder (where Explorer unpacks an executable opened
//      straight from inside a zip) is zip-temp;
//   5. then the Downloads folder: a path under it reuses the existing
//      downloads state;
//   6. anything else — the system Program Files folders and the per-user
//      Programs area explicitly included — is ok.
// The verdict is pure: the same input yields the same result on every call.
//
// Same module hygiene as sidecarexit.ts / webreach.ts / relaylink.ts: NO
// electron, NO node:fs, no fetch, no I/O — main.ts reads the real paths at
// runtime and scripts/unit.test.ts exercises every branch in plain Node.
// Messages are static, actionable pt-BR with no file paths, no URL schemes
// and no secrets (the P2-140 bar).
//
// Scope note (by design): only macOS and Windows are classified — every
// other platform verdicts to ok. Moving the app, calling any "move to
// Applications/Program Files" API or opening dialogs is explicitly out of
// scope; the verdict only ever explains and points at the install action.

export type InstallLocationState =
  | "ok"
  | "dmg-volume"
  | "translocated"
  | "downloads"
  | "unknown"
  | "zip-temp"
  | "unc-share";

export interface InstallLocationVerdict {
  state: InstallLocationState;
  /** Short actionable pt-BR phrase — static, never carries a path or URL. */
  message: string;
}

/** Volume-mount point on macOS: every mounted DMG lands under /Volumes/<name>/ */
const VOLUMES_PREFIX = "/Volumes/";
/** Gatekeeper's quarantine translocation segment: a launched-from-Downloads
 * (or any not-approved) bundle runs from a random read-only copy under
 * /private/var/folders/…/AppTranslocation/<uuid>/d/<App>.app */
const APP_TRANSLOCATION_SEGMENT = "/AppTranslocation/";
/** The classic "I never moved it" location. */
const DOWNLOADS_SEGMENT = "/Downloads/";

/** UNC network share prefix on Windows: a path starting with two backslashes
 * runs straight off someone else's machine — the gravest case, so it wins
 * over every other signal. */
const UNC_SHARE_PREFIX = "\\\\";
/** The user temp directory's standard shape under the user profile
 * (%LOCALAPPDATA%\Temp): where Explorer unpacks an executable opened from
 * inside a downloaded zip. Compared case-insensitively. */
const USER_TEMP_SEGMENT = "\\appdata\\local\\temp\\";
/** Windows mirror of the macOS downloads signal: the classic "I never
 * installed it" location. Compared case-insensitively. */
const WIN_DOWNLOADS_SEGMENT = "\\downloads\\";
/** System-wide program folders (per-machine installs). Compared
 * case-insensitively. */
const PROGRAM_FILES_SEGMENT = "\\program files\\";
const PROGRAM_FILES_X86_SEGMENT = "\\program files (x86)\\";
/** The per-user program area (%LOCALAPPDATA%\Programs): where per-user
 * installers — this project's NSIS setup included — land by default.
 * Compared case-insensitively. */
const USER_PROGRAMS_SEGMENT = "\\appdata\\local\\programs\\";

/** Static copy per state, reused verbatim by the log line, the forced test
 * hatch and the pairing payload so every surface says the same sentence. */
export function installMessage(state: InstallLocationState): string {
  switch (state) {
    case "ok":
      return "o app está instalado no lugar certo — nada a fazer";
    case "dmg-volume":
      return "o app está rodando direto do disco de instalação — arraste-o para a pasta Aplicativos, ejete o disco e reabra pela pasta Aplicativos";
    case "translocated":
      return "o sistema rodou o app em uma cópia temporária — feche-o, arraste-o para a pasta Aplicativos e reabra pela pasta Aplicativos";
    case "downloads":
      return "o app está na pasta de downloads — arraste-o para a pasta Aplicativos e reabra pela pasta Aplicativos";
    case "zip-temp":
      return "o app está rodando de uma cópia temporária extraída de um arquivo compactado — feche-o, instale-o em uma pasta definitiva do computador e reabra pela cópia instalada";
    case "unc-share":
      return "o app está rodando de um compartilhamento de rede — feche-o, instale-o no disco do computador e reabra pela cópia instalada";
    case "unknown":
      return "não deu para confirmar o local de instalação — o app segue funcionando normalmente";
  }
}

/**
 * Map the boot location snapshot to (state, message). Deterministic and
 * secret-free. Precedence: a dev build never warns (development must stay
 * quiet even when launched from a mounted volume); a platform outside the
 * documented pair is out of scope and always ok; on macOS the mounted volume
 * beats everything else on the path (running straight from the DMG), the
 * quarantine translocation segment wins over the applications-folder signal
 * (a translocated copy always reports "not in Applications", but
 * translocation is the precise, actionable diagnosis), a downloads ancestor
 * plus a false signal is the "never dragged it" case, a false signal with no
 * other evidence degrades to a neutral unknown that never accuses and a true
 * signal is ok; on Windows a missing or non-textual path is unknown, the
 * network share beats the temp folder, the temp folder beats Downloads and
 * every other path — installed program folders included — is ok.
 */
export function installVerdict(
  platform: NodeJS.Platform | string,
  bundlePath: string,
  inApplicationsFolder: boolean | null,
  isPackaged: boolean,
): InstallLocationVerdict {
  // Dev builds never warn — a plain `npm start` from anywhere is fine.
  if (!isPackaged) {
    return { state: "ok", message: installMessage("ok") };
  }
  // Only macOS and Windows are classified in this task pair (documented
  // above); every other platform stays ok exactly as before.
  if (platform !== "darwin" && platform !== "win32") {
    return { state: "ok", message: installMessage("ok") };
  }
  if (platform === "win32") {
    return windowsVerdict(bundlePath);
  }
  const path = typeof bundlePath === "string" ? bundlePath : "";
  if (path.startsWith(VOLUMES_PREFIX)) {
    return { state: "dmg-volume", message: installMessage("dmg-volume") };
  }
  if (path.includes(APP_TRANSLOCATION_SEGMENT)) {
    return { state: "translocated", message: installMessage("translocated") };
  }
  if (inApplicationsFolder === false && path.includes(DOWNLOADS_SEGMENT)) {
    return { state: "downloads", message: installMessage("downloads") };
  }
  if (inApplicationsFolder === true) {
    return { state: "ok", message: installMessage("ok") };
  }
  // False (no corroborating signal) or null (platform without the signal):
  // neutral wording on purpose — an unconfirmed location is never a failure.
  return { state: "unknown", message: installMessage("unknown") };
}

/**
 * The Windows table: classify the running executable's path only — no disk
 * access, no system call, no timer (the shell already holds the path at
 * boot). Rules in the documented order above; pure and case-insensitive.
 */
function windowsVerdict(bundlePath: string): InstallLocationVerdict {
  // Missing or non-textual entry: neutral wording, never an accusation.
  if (typeof bundlePath !== "string" || bundlePath === "") {
    return { state: "unknown", message: installMessage("unknown") };
  }
  const path = bundlePath.toLowerCase();
  if (path.startsWith(UNC_SHARE_PREFIX)) {
    return { state: "unc-share", message: installMessage("unc-share") };
  }
  if (path.includes(USER_TEMP_SEGMENT)) {
    return { state: "zip-temp", message: installMessage("zip-temp") };
  }
  if (path.includes(WIN_DOWNLOADS_SEGMENT)) {
    return { state: "downloads", message: installMessage("downloads") };
  }
  // Recognized install destinations — the system Program Files folders and
  // the per-user Programs area — are ok, exactly like any other regular
  // path: the catch-all below is the calm outcome by design.
  if (
    path.includes(PROGRAM_FILES_SEGMENT) ||
    path.includes(PROGRAM_FILES_X86_SEGMENT) ||
    path.includes(USER_PROGRAMS_SEGMENT)
  ) {
    return { state: "ok", message: installMessage("ok") };
  }
  return { state: "ok", message: installMessage("ok") };
}
