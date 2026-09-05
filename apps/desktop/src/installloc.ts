// P2-211: install-location classifier for the macOS first-boot journey. A
// leigo user downloads the release DMG, opens the app straight from the
// mounted volume and never drags it anywhere — the bundle then runs read-only
// from a random quarantine path, Squirrel.Mac can never swap it (auto-update
// silently stops working), state seems to vanish on every launch and the app
// is gone when the volume is ejected. Nothing said why — the same class of
// late, mute failure the P2-197/P2-199 pairing verdicts closed. This module
// turns the boot-time location snapshot into one calm verdict.
//
// Same module hygiene as sidecarexit.ts / webreach.ts / relaylink.ts: NO
// electron, NO node:fs, no fetch, no I/O — main.ts reads the real paths at
// runtime and scripts/unit.test.ts exercises every branch in plain Node.
// Messages are static, actionable pt-BR with no file paths, no URL schemes
// and no secrets (the P2-140 bar).
//
// Scope note (by design): only macOS is classified — every other platform
// verdicts to ok because this task covers macOS only. Moving the app, calling
// any "move to Applications" API or opening dialogs is explicitly out of
// scope; the verdict only ever explains and points at the drag action.

export type InstallLocationState = "ok" | "dmg-volume" | "translocated" | "downloads" | "unknown";

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
    case "unknown":
      return "não deu para confirmar o local de instalação — o app segue funcionando normalmente";
  }
}

/**
 * Map the boot location snapshot to (state, message). Deterministic and
 * secret-free. Precedence: a dev build never warns (development must stay
 * quiet even when launched from a mounted volume); a non-macOS platform is
 * out of scope and always ok; the mounted volume beats everything else on the
 * path (running straight from the DMG); the quarantine translocation segment
 * wins over the applications-folder signal (a translocated copy always
 * reports "not in Applications", but translocation is the precise,
 * actionable diagnosis); a downloads ancestor plus a false signal is the
 * "never dragged it" case; a false signal with no other evidence degrades to
 * a neutral unknown that never accuses; a true signal is ok.
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
  // Only macOS is classified in this task (documented above).
  if (platform !== "darwin") {
    return { state: "ok", message: installMessage("ok") };
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
