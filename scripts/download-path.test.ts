/**
 * RT-466 — the download allowlist must consult the filesystem, not just the
 * string form of a path (constitution invariant #6). This battery pins the
 * pure verdicts in apps/daemon/src/downloadpath.ts — realpath resolution,
 * separator-anchored containment, regular-file admission, the O_NOFOLLOW +
 * realpath re-check at open time — and the structural shape of the
 * /__ocr/files and /__ocr/download routes in index.ts (lesson P3-447: assert
 * on source shape so a refactor cannot quietly reintroduce the string-only
 * gate or a statSync that follows links).
 *
 * Symlink cases are skipped (OK) on platforms where symlinkSync needs
 * developer mode / admin rights (Windows) — the checks remain present so the
 * source-shape pins still run everywhere.
 * Run: npx tsx scripts/download-path.test.ts
 */
import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { accessibleDownloadPath, containedIn, openContainedFile, resolveDownloadRoots } from "../apps/daemon/src/downloadpath";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}
function skip(name: string) {
  console.log(`OK  ${name} (skipped: symlinks unavailable on this platform)`);
}

// --- fixtures ---------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "rt466-"));
const root = join(tmp, "root");
mkdirSync(root);
const outside = join(tmp, "outside");
mkdirSync(outside);
const realRoot = realpathSync(root);
const roots = resolveDownloadRoots([root]);
check("roots: realpath'd (tmpdir /var → /private/var on macOS)", roots[0] === realRoot);

writeFileSync(join(root, "a.txt"), "hello");
const aReal = realpathSync(join(root, "a.txt"));

// --- resolveDownloadRoots ------------------------------------------------------

check("missing root: falls back to the resolved form", resolveDownloadRoots([join(tmp, "does-not-exist")])[0] === resolve(join(tmp, "does-not-exist")));
check("roots deduped after realpath", resolveDownloadRoots([root, root]).length === 1);

// --- containedIn --------------------------------------------------------------

check("containedIn: direct root admitted", containedIn(realRoot, [realRoot]));
check("containedIn: file under root admitted", containedIn(join(realRoot, "a.txt"), [realRoot]));
check("containedIn: separator anchored — sibling prefix refused", !containedIn(realRoot + "-evil" + "x", [realRoot]));
check("containedIn: outside path refused", !containedIn(join(outside, "secret.txt"), [realRoot]));

// --- accessibleDownloadPath -----------------------------------------------------

check("regular file in root: admitted as the real path", accessibleDownloadPath(join(root, "a.txt"), roots) === aReal);
check("regular file via parent '..': admitted (resolve normalizes)", accessibleDownloadPath(join(root, "..", "root", "a.txt"), roots) === aReal);
check("path outside any root: refused", accessibleDownloadPath(join(outside, "secret.txt"), roots) === null);
check("nonexistent path: refused (null, no throw)", accessibleDownloadPath(join(root, "ghost.txt"), roots) === null);
check("directory (the root itself): refused", accessibleDownloadPath(root, roots) === null);

const rootEvil = join(tmp, "root-evil");
mkdirSync(rootEvil);
writeFileSync(join(rootEvil, "f.txt"), "evil");
check("sibling prefix (root-evil): refused", accessibleDownloadPath(join(rootEvil, "f.txt"), roots) === null);

// --- symlinks (guarded for platforms without link support) ----------------------

let symlinksWork = true;
try {
  writeFileSync(join(tmp, "probe.txt"), "probe");
  symlinkSync(join(tmp, "probe.txt"), join(tmp, "probe-link"));
} catch {
  symlinksWork = false;
}

if (symlinksWork) {
  writeFileSync(join(outside, "secret.txt"), "secret");

  symlinkSync(join(outside, "secret.txt"), join(root, "link-out"));
  check("symlink to file outside any root: refused", accessibleDownloadPath(join(root, "link-out"), roots) === null);

  symlinkSync(outside, join(root, "dir-out"));
  check("intermediate dir symlink to outside: refused", accessibleDownloadPath(join(root, "dir-out", "secret.txt"), roots) === null);

  symlinkSync(join(root, "a.txt"), join(root, "link-in"));
  check("internal symlink to internal file: admitted (real target contained)", accessibleDownloadPath(join(root, "link-in"), roots) === aReal);

  symlinkSync(join(outside, "nope.txt"), join(root, "link-broken"));
  check("broken symlink: refused (null, no throw)", accessibleDownloadPath(join(root, "link-broken"), roots) === null);

  const rootAlias = join(tmp, "root-alias");
  symlinkSync(root, rootAlias);
  const aliasRoots = resolveDownloadRoots([rootAlias]);
  check("root reached through a symlink: realpath'd to the same root", aliasRoots[0] === realRoot);
  check("file under a symlinked root: admitted", accessibleDownloadPath(join(rootAlias, "a.txt"), aliasRoots) === aReal);

  check("roots deduped across symlink and real form", resolveDownloadRoots([root, rootAlias]).length === 1);

  // --- TOCTOU: openContainedFile re-verifies at open time -----------------------
  writeFileSync(join(root, "swap.txt"), "contents");
  const swapReal = accessibleDownloadPath(join(root, "swap.txt"), roots);
  check("swap fixture: validated before the swap", swapReal === realpathSync(join(root, "swap.txt")));

  if (swapReal) {
    rmSync(join(root, "swap.txt"));
    symlinkSync(join(outside, "secret.txt"), join(root, "swap.txt"));
    check("openContainedFile after swap to outside symlink: refused", openContainedFile(swapReal, roots) === null);

    rmSync(join(root, "swap.txt"));
    symlinkSync(join(root, "a.txt"), join(root, "swap.txt"));
    check("openContainedFile after swap to internal symlink: refused (fail closed)", openContainedFile(swapReal, roots) === null);

    rmSync(join(root, "swap.txt"));
    writeFileSync(join(root, "swap.txt"), "ok");
    const fd = openContainedFile(swapReal, roots);
    check("openContainedFile: the real file reopens after swap-back", typeof fd === "number");
    if (typeof fd === "number") closeSync(fd);
  } else {
    check("openContainedFile TOCTOU block (fixture validated)", false, "swap fixture failed to validate");
  }

  // --- fifo: open must never hang ------------------------------------------------
  let fifoChecked = false;
  try {
    execFileSync("mkfifo", [join(root, "pipe")]);
    fifoChecked = true;
  } catch {
    fifoChecked = false;
  }
  if (fifoChecked) {
    check("fifo: refused as not-a-file", accessibleDownloadPath(join(root, "pipe"), roots) === null);
    if (constants.O_NONBLOCK !== undefined) {
      check("openContainedFile on a fifo: refused without hanging", openContainedFile(realpathSync(join(root, "pipe")), roots) === null);
    }
  }
} else {
  skip("symlink to file outside any root: refused");
  skip("intermediate dir symlink to outside: refused");
  skip("internal symlink to internal file: admitted");
  skip("broken symlink: refused");
  skip("root reached through a symlink: realpath'd");
  skip("file under a symlinked root: admitted");
  skip("roots deduped across symlink and real form");
  skip("openContainedFile TOCTOU block");
}

// --- structural pins over index.ts (lesson P3-447) --------------------------------

const src = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
const filesStart = src.indexOf('"/__ocr/files"');
const filesEnd = src.indexOf('"/__ocr/download/start"', filesStart);
const filesBlock = src.slice(filesStart, filesEnd);
check("pin: /__ocr/files block located", filesStart >= 0 && filesEnd > filesStart);
check("pin: /__ocr/files uses lstatSync (follows nothing)", filesBlock.includes("lstatSync(full)"));
check("pin: /__ocr/files skips symlink entries", filesBlock.includes("isSymbolicLink()"));
check("pin: /__ocr/files does not statSync-follow links", !/\bstatSync\(full\)/.test(filesBlock));

const chunkStart = src.indexOf('"/__ocr/download/chunk"');
const chunkEnd = src.indexOf('"/__ocr/devices"', chunkStart);
const chunkBlock = src.slice(chunkStart, chunkEnd);
check("pin: chunk route located", chunkStart >= 0 && chunkEnd > chunkStart);
check("pin: chunk opens through openContainedFile", chunkBlock.includes("openContainedFile(d.path"));
check("pin: raw openSync on the recorded path is gone", !chunkBlock.includes('openSync(d.path, "r")'));

check("pin: index.ts wires downloadpath.js", src.includes('from "./downloadpath.js"'));
check("pin: string-only prefix gate removed from index.ts", !src.includes('abs.startsWith(r + "/")'));

// --- cleanup --------------------------------------------------------------------

rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall download-path checks passed");
