// eval-16: which signature the running macOS bundle carries — the pure half of
// the Squirrel.Mac capability check in update.ts.
//
// Squirrel.Mac (Electron's built-in autoUpdater) only applies an update whose
// code signature satisfies the RUNNING app's designated requirement. For a
// certificate-signed build that requirement names the signing identity, so the
// next release signed by the same identity passes. For an ad-hoc build the
// designated requirement is the bundle's own cdhash — no other build can ever
// satisfy it — so every background download ends in a validation error: the
// tray kept saying "Update download failed — will retry" and re-downloaded the
// ~130 MB zip at every scheduled recheck, while the README promised ad-hoc
// builds "keep the manual flow via the release page". A release without the
// Apple secrets ships ad-hoc (apps/desktop/scripts/signing-profile.mjs), so
// the very first public build would have hit this on the second release.
//
// Same module hygiene as updaterollout.ts / updateguard.ts: NO electron, NO
// node:fs, no child_process, no timers, no imports — update.ts runs
// `codesign -dv --verbose=2 <bundle>` and hands the text in; the unit battery
// feeds real outputs captured from ad-hoc, Developer ID and unsigned bundles.

/** The signature the running bundle carries. */
export type MacSigning = "developer-id" | "certificate" | "adhoc" | "unsigned" | "unknown";

/**
 * Classify the combined stdout+stderr of `codesign -dv --verbose=2 <bundle>`.
 * Rule order (first match wins):
 *   1. empty / non-text output → unknown (the probe failed — fail-open);
 *   2. "code object is not signed at all" → unsigned;
 *   3. a `Signature=adhoc` line → adhoc (Electron's linker signature or
 *      electron-builder's `identity: "-"`);
 *   4. an `Authority=Developer ID Application:` line → developer-id;
 *   5. any other `Authority=` line → certificate (e.g. Apple Development —
 *      still a stable identity Squirrel can match);
 *   6. anything else → unknown.
 */
export function macSigningFromCodesign(output: unknown): MacSigning {
  if (typeof output !== "string" || output.trim() === "") return "unknown";
  if (/code object is not signed at all/i.test(output)) return "unsigned";
  if (/^Signature=adhoc\s*$/m.test(output)) return "adhoc";
  if (/^Authority=Developer ID Application:/m.test(output)) return "developer-id";
  if (/^Authority=\S/m.test(output)) return "certificate";
  return "unknown";
}

/** True unless the bundle provably cannot accept a Squirrel.Mac update
 * (ad-hoc or unsigned). Unknown stays true — a failed probe never takes the
 * background update away from a properly signed install. */
export function squirrelCanApply(signing: MacSigning): boolean {
  return signing !== "adhoc" && signing !== "unsigned";
}

/** The .app bundle that contains a macOS executable path
 * (`/Applications/X.app/Contents/MacOS/X` → `/Applications/X.app`); any other
 * path is returned unchanged (codesign resolves a bundle from its main
 * executable too). */
export function bundlePathFromExec(execPath: string): string {
  const match = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
  return match?.[1] ?? execPath;
}
