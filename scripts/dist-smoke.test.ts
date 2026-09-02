/**
 * P3-010: tests for apps/desktop/scripts/dist-smoke.mjs — the deterministic
 * validator of the electron-builder output (resources/web-dist, resources/
 * daemon, app binary; mac/win/linux layouts). Pure filesystem fixtures in a
 * tmp dir: no Electron, no network, fully deterministic.
 * Run: npx tsx scripts/dist-smoke.test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProblems, resolveBundleDir } from "../apps/desktop/scripts/dist-smoke.mjs";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "ocr-dist-smoke-"));
}

/** Builds the good mac layout; tests then delete pieces to prove they reprova. */
function makeMacBundle(root: string): string {
  const bundle = join(root, "OpenCode Remote.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources", "web-dist"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources", "daemon"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "MacOS", "OpenCode Remote"), "elf");
  writeFileSync(join(bundle, "Contents", "Resources", "web-dist", "index.html"), "<html>");
  writeFileSync(join(bundle, "Contents", "Resources", "daemon", "index.js"), "// daemon");
  return bundle;
}

function makeWinBundle(root: string): string {
  const bundle = join(root, "win-unpacked");
  mkdirSync(join(bundle, "resources", "web-dist"), { recursive: true });
  mkdirSync(join(bundle, "resources", "daemon"), { recursive: true });
  writeFileSync(join(bundle, "OpenCode Remote.exe"), "exe");
  writeFileSync(join(bundle, "resources", "web-dist", "index.html"), "<html>");
  writeFileSync(join(bundle, "resources", "daemon", "index.js"), "// daemon");
  return bundle;
}

function makeLinuxBundle(root: string): string {
  const bundle = join(root, "linux-unpacked");
  mkdirSync(join(bundle, "resources", "web-dist"), { recursive: true });
  mkdirSync(join(bundle, "resources", "daemon"), { recursive: true });
  writeFileSync(join(bundle, "opencode-remote"), "elf");
  chmodSync(join(bundle, "opencode-remote"), 0o755);
  writeFileSync(join(bundle, "resources", "web-dist", "index.html"), "<html>");
  writeFileSync(join(bundle, "resources", "daemon", "index.js"), "// daemon");
  return bundle;
}

const root = tempRoot();
try {
  // --- mac layout: complete bundle passes, each missing piece reprova ---------
  const mac = makeMacBundle(root);
  check("mac: complete bundle has no problems", listProblems(mac).length === 0);

  rmSync(join(mac, "Contents", "Resources", "daemon", "index.js"));
  const macNoDaemon = listProblems(mac);
  check(
    "mac: removed daemon/index.js is reported with its bundle path",
    macNoDaemon.length === 1 && macNoDaemon[0].includes("Contents/Resources/daemon/index.js"),
  );
  writeFileSync(join(mac, "Contents", "Resources", "daemon", "index.js"), "// daemon");

  rmSync(join(mac, "Contents", "Resources", "web-dist", "index.html"));
  const macNoWeb = listProblems(mac);
  check(
    "mac: removed web-dist/index.html is reported",
    macNoWeb.some((p) => p.includes("Contents/Resources/web-dist/index.html")),
  );
  rmSync(join(mac, "Contents", "Resources", "daemon", "index.js"));
  check(
    "mac: lists all problems, not just the first",
    listProblems(mac).length === 2,
  );
  writeFileSync(join(mac, "Contents", "Resources", "daemon", "index.js"), "// restored");
  rmSync(join(mac, "Contents", "MacOS", "OpenCode Remote"));
  check(
    "mac: removed binary is reported",
    listProblems(mac).some((p) => p.includes("no app binary in Contents/MacOS")),
  );

  // --- win layout --------------------------------------------------------------
  const win = makeWinBundle(join(root, "w"));
  check("win: complete win-unpacked has no problems", listProblems(win).length === 0);
  rmSync(join(win, "OpenCode Remote.exe"));
  check(
    "win: missing .exe is reported",
    listProblems(win).some((p) => p.includes("no app binary")),
  );

  // --- linux layout ------------------------------------------------------------
  const linux = makeLinuxBundle(join(root, "l"));
  check("linux: complete linux-unpacked has no problems", listProblems(linux).length === 0);
  rmSync(join(linux, "opencode-remote"));
  check(
    "linux: missing executable is reported",
    listProblems(linux).some((p) => p.includes("no app binary")),
  );

  // --- misc --------------------------------------------------------------------
  check("missing dir: reported clearly", listProblems(join(root, "nope")).length === 1 && listProblems(join(root, "nope"))[0].includes("does not exist"));

  // Default resolution: mac .app preferred, then resource-bearing dirs, null on none.
  const distRoot = join(root, "dist");
  mkdirSync(join(distRoot, "mac-arm64"), { recursive: true });
  mkdirSync(join(distRoot, "extra"), { recursive: true });
  writeFileSync(join(distRoot, "extra", "notes.txt"), "x");
  makeMacBundle(join(distRoot, "mac-arm64"));
  check(
    "resolve: finds the .app nested under dist",
    resolveBundleDir(distRoot) === join(distRoot, "mac-arm64", "OpenCode Remote.app"),
  );
  rmSync(join(distRoot, "mac-arm64"), { recursive: true });
  mkdirSync(join(distRoot, "win-unpacked", "resources"), { recursive: true });
  check(
    "resolve: falls back to the -unpacked dir carrying resources/",
    resolveBundleDir(distRoot) === join(distRoot, "win-unpacked"),
  );
  rmSync(join(distRoot, "win-unpacked"), { recursive: true });
  check("resolve: null when nothing matches", resolveBundleDir(distRoot) === null);
  check("resolve: null when dist root absent", resolveBundleDir(join(root, "ghost")) === null);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\ndist-smoke tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
