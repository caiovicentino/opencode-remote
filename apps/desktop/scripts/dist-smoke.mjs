#!/usr/bin/env node
/**
 * P3-010: deterministic smoke check for the electron-builder output.
 *
 * Verifies, purely by inspecting the filesystem (no app launch, no network),
 * that a packaged bundle actually carries the two extraResources the shell
 * needs at runtime plus its own executable:
 *
 *   - <resources>/web-dist/index.html  (web UI, loaded via file://)
 *   - <resources>/daemon/index.js      (daemon sidecar bundle, resolveEntry())
 *   - the app binary                   (Contents/MacOS/*, *.exe, ELF stub)
 *
 * Layouts vary per platform (electron-builder):
 *   mac    dist/mac-arm64/OpenCode Remote.app → resources at Contents/Resources
 *   win    dist/win-unpacked                → resources at resources/, *.exe
 *   linux  dist/linux-unpacked              → resources at resources/, exec
 *
 * Exit 0 when every check passes; exit 1 with one line per missing piece
 * (all problems listed, not just the first). Out of the pilot gate by design
 * (docs/PILOT.md) — this is the floor stage 5 (signed installers) builds on.
 *
 * P2-098: when run against the default dist root (no --dir), the check also
 * requires the DMG installer next to the bundle — it is the mac release
 * artifact third parties install (AC "dist:smoke gera DMG").
 *
 * P2-126: the same default run validates the Windows side when the dist root
 * carries a win-unpacked bundle — NSIS setup exe + latest.yml (pure fs
 * checks; runs on any OS, no Windows required).
 *
 * Usage: npm run dist:smoke --workspace @ocr/desktop [-- --dir <path>]
 * Run:   node scripts/dist-smoke.mjs [--dir <bundle>]
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scripts = fileURLToPath(new URL(".", import.meta.url)); // apps/desktop/scripts
const desktopDir = resolve(scripts, ".."); // apps/desktop

/** True when path points at a regular file (not a dir/symlink-to-dir). */
function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/** True when path is a dir containing at least one entry. */
function hasAnyEntry(path) {
  return existsSync(path) && statSync(path).isDirectory() && readdirSync(path).length > 0;
}

/**
 * All regular files directly under dir that are executable by mode bits.
 * (linux-unpacked ships the ELF binary named after the executableName.)
 */
function executableFiles(dir) {
  return readdirSync(dir).filter((name) => {
    const path = join(dir, name);
    return isFile(path) && statSync(path).mode & 0o111;
  });
}

/**
 * Validate one packaged bundle dir (a .app bundle or a win/linux -unpacked
 * dir). Returns the list of problems; empty means the bundle is complete.
 */
export function listProblems(bundleDir) {
  const isMacBundle = basename(bundleDir).endsWith(".app") && existsSync(join(bundleDir, "Contents"));
  const resources = isMacBundle ? join(bundleDir, "Contents", "Resources") : join(bundleDir, "resources");
  const rel = isMacBundle ? "Contents/Resources" : "resources";

  const problems = [];
  if (!existsSync(bundleDir)) return [`bundle dir does not exist: ${bundleDir}`];
  if (!existsSync(join(resources, "web-dist", "index.html"))) {
    problems.push(`missing file: ${rel}/web-dist/index.html`);
  }
  if (!isFile(join(resources, "daemon", "index.js"))) {
    problems.push(`missing file: ${rel}/daemon/index.js`);
  }
  if (isMacBundle) {
    if (!hasAnyEntry(join(bundleDir, "Contents", "MacOS"))) {
      problems.push("no app binary in Contents/MacOS");
    }
  } else {
    const exes = readdirSync(bundleDir).filter((name) => name.endsWith(".exe") && isFile(join(bundleDir, name)));
    let binaryOk = exes.length > 0;
    if (!binaryOk && existsSync(bundleDir) && statSync(bundleDir).isDirectory()) {
      // linux-unpacked: executable file at the root (no .exe suffix)
      try {
        binaryOk = executableFiles(bundleDir).length > 0;
      } catch {
        binaryOk = false;
      }
    }
    if (!binaryOk) problems.push("no app binary at bundle root (expected *.exe or an executable)");
  }
  return problems;
}

/**
 * Default resolution: pick the first electron-builder output under distRoot
 * (mac .app bundles preferred over win/linux-unpacked; lexicographic order
 * keeps it deterministic across arches). Returns an absolute path or null.
 */
export function resolveBundleDir(distRoot) {
  if (!existsSync(distRoot)) return null;
  const candidates = [];
  for (const entry of readdirSync(distRoot).sort()) {
    const path = join(distRoot, entry);
    if (entry.endsWith(".app")) {
      candidates.push(path);
      continue;
    }
    if (statSync(path).isDirectory()) {
      for (const nested of readdirSync(path).sort()) {
        if (nested.endsWith(".app")) candidates.push(join(path, nested));
      }
      candidates.push(path);
    }
  }
  for (const candidate of candidates) {
    if (basename(candidate).endsWith(".app")) return candidate;
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "resources"))) return candidate;
  }
  return null;
}

/**
 * P2-098: the mac release artifact is the DMG — third parties install from it.
 * Returns the first *.dmg file directly under distRoot (sorted, deterministic),
 * or null when electron-builder produced none.
 */
export function findDmg(distRoot) {
  if (!existsSync(distRoot)) return null;
  for (const entry of readdirSync(distRoot).sort()) {
    if (entry.toLowerCase().endsWith(".dmg") && isFile(join(distRoot, entry))) return join(distRoot, entry);
  }
  return null;
}

/**
 * P2-126: the Windows release artifact is the NSIS setup exe. Mirrors findDmg:
 * returns the first *.exe file directly under distRoot (sorted, deterministic),
 * or null when electron-builder produced none. Pure fs checks — runs on any
 * OS, no Windows required.
 */
export function findWindowsInstaller(distRoot) {
  if (!existsSync(distRoot)) return null;
  for (const entry of readdirSync(distRoot).sort()) {
    if (entry.toLowerCase().endsWith(".exe") && isFile(join(distRoot, entry))) return join(distRoot, entry);
  }
  return null;
}

/**
 * P2-126: validate the Windows side of a dist root — the NSIS setup exe plus
 * the update metadata (latest.yml) the in-app update check falls back to.
 * Reports problems in the listProblems format (one string each, empty means
 * complete) and never requires Windows to run.
 */
export function windowsInstallerProblems(distRoot) {
  const problems = [];
  if (!existsSync(distRoot)) return [`dist root does not exist: ${distRoot}`];
  if (!findWindowsInstaller(distRoot)) problems.push("no Windows setup *.exe under dist root");
  if (!isFile(join(distRoot, "latest.yml"))) problems.push("missing file: latest.yml");
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  let dir = null;
  const dirIndex = argv.indexOf("--dir");
  if (dirIndex !== -1 && argv[dirIndex + 1]) dir = resolve(argv[dirIndex + 1]);
  if (!dir) {
    const explicit = argv.find((a) => a.startsWith("--dir="));
    if (explicit) dir = resolve(explicit.slice("--dir=".length));
  }

  // --dir-less runs target the default dist root: the bundle must ALSO have a
  // DMG sibling (P2-098 — the mac release artifact third parties install).
  const requireDmg = dir === null;
  if (!dir) {
    dir = resolveBundleDir(join(desktopDir, "dist"));
    if (!dir) {
      console.error(
        "dist-smoke: no electron-builder output found under apps/desktop/dist —\n" +
          "run `npm run dist --workspace @ocr/desktop` or pass --dir <path to .app / *-unpacked>",
      );
      process.exitCode = 1;
      return;
    }
  } else if (!existsSync(dir)) {
    console.error(`dist-smoke: --dir does not exist: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const problems = listProblems(dir);
  if (problems.length > 0) {
    console.error(`dist-smoke: FAIL ${dir}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`dist-smoke: ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  console.log(`dist-smoke: OK ${dir}`);
  console.log("  web-dist/index.html present");
  console.log("  daemon/index.js present");
  console.log("  app binary present");
  if (requireDmg) {
    const dmg = findDmg(join(desktopDir, "dist"));
    if (!dmg) {
      console.error(
        "dist-smoke: FAIL no *.dmg under apps/desktop/dist — the mac installer is the release artifact\n" +
          "  (electron-builder mac target `dmg`); rebuild with `npm run dist --workspace @ocr/desktop`",
      );
      process.exitCode = 1;
      return;
    }
    console.log(`  dmg artifact present: ${basename(dmg)}`);
  }
  // P2-126: on a default run whose dist root carries Windows packaging output
  // (win-unpacked), the NSIS setup exe + latest.yml are release artifacts too
  // — same treatment as the DMG above. Skipped when no win-unpacked exists so
  // mac-only dev machines keep passing; pure fs checks, no Windows required.
  if (requireDmg && existsSync(join(desktopDir, "dist", "win-unpacked"))) {
    const distRoot = join(desktopDir, "dist");
    const winProblems = windowsInstallerProblems(distRoot);
    if (winProblems.length > 0) {
      console.error("dist-smoke: FAIL Windows installer incomplete under apps/desktop/dist");
      for (const problem of winProblems) console.error(`  - ${problem}`);
      console.error(`dist-smoke: ${winProblems.length} Windows problem(s) found`);
      process.exitCode = 1;
      return;
    }
    console.log(`  windows installer present: ${basename(findWindowsInstaller(distRoot))}`);
  }
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) main();
