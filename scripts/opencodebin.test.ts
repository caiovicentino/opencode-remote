/**
 * P3-395 unit tests: the opencode binary candidate list keeps its documented
 * order after gaining the runtime-manager install locations (bun, pnpm,
 * npm-global, volta, ~/.local/bin — and npm/pnpm folders on win32) plus the
 * caller-enumerated nvm/mise node version directories appended last; the
 * enumeration itself is fault-tolerant (missing dir, permission error,
 * hostile listing, cap) and opencodebin.ts stays free of node builtins.
 * Run: npx tsx scripts/opencodebin.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { opencodeCandidates, pickOpencodeBinary } from "../apps/daemon/src/opencodebin";
import { enumerateNodeVersionDirs, NODE_VERSION_DIR_CAP } from "../apps/daemon/src/nodeversions";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

// ---------------------------------------------------------------------------
// 1. Table: every new manager directory appears, on both platforms, after the
//    PATH entries and the pre-existing known locations, tagged "known".
// ---------------------------------------------------------------------------

const POSIX_HOME = "/home/u";
const POSIX_PATH = "/usr/bin:/bin";
const WIN_HOME = "C:\\Users\\u";
const WIN_PATH = "C:\\Windows\\system32";

const posixTable: { name: string; env: Record<string, string>; dir: string }[] = [
  { name: "bun", env: { PATH: POSIX_PATH }, dir: `${POSIX_HOME}/.bun/bin` },
  { name: "local", env: { PATH: POSIX_PATH }, dir: `${POSIX_HOME}/.local/bin` },
  { name: "npm-global", env: { PATH: POSIX_PATH }, dir: `${POSIX_HOME}/.npm-global/bin` },
  { name: "pnpm", env: { PATH: POSIX_PATH }, dir: `${POSIX_HOME}/.local/share/pnpm` },
  { name: "volta", env: { PATH: POSIX_PATH }, dir: `${POSIX_HOME}/.volta/bin` },
];

for (const row of posixTable) {
  const list = opencodeCandidates(row.env, "linux", POSIX_HOME);
  const hit = list.find((c) => c.path === `${row.dir}/opencode`);
  check(
    `posix manager dir (${row.name}) is a known candidate`,
    !!hit && hit.source === "known",
    JSON.stringify(list),
  );
  const pathCount = list.filter((c) => c.source === "path").length;
  check(
    `posix manager dir (${row.name}) comes after every PATH entry`,
    !!hit && list.indexOf(hit!) >= pathCount,
  );
}

const winTable: { name: string; env: Record<string, string>; dir: string }[] = [
  { name: "npm", env: { PATH: WIN_PATH, APPDATA: `${WIN_HOME}\\AppData\\Roaming` }, dir: `${WIN_HOME}\\AppData\\Roaming\\npm` },
  { name: "pnpm", env: { PATH: WIN_PATH, LOCALAPPDATA: `${WIN_HOME}\\AppData\\Local` }, dir: `${WIN_HOME}\\AppData\\Local\\pnpm` },
];

for (const row of winTable) {
  const list = opencodeCandidates(row.env, "win32", WIN_HOME);
  const hit = list.find((c) => c.path === `${row.dir}\\opencode.exe`);
  check(
    `win32 manager dir (${row.name}) is a known candidate`,
    !!hit && hit.source === "known",
    JSON.stringify(list),
  );
  const pathCount = list.filter((c) => c.source === "path").length;
  check(
    `win32 manager dir (${row.name}) comes after every PATH entry`,
    !!hit && list.indexOf(hit!) >= pathCount,
  );
}

// missing APPDATA/LOCALAPPDATA on win32 simply skips the folder
const winNoAppdata = opencodeCandidates({ PATH: WIN_PATH, LOCALAPPDATA: `${WIN_HOME}\\AppData\\Local` }, "win32", WIN_HOME);
check(
  "win32 without APPDATA skips the npm folder without inventing paths",
  !winNoAppdata.some((c) => c.path.includes("undefined")),
  JSON.stringify(winNoAppdata),
);

// ---------------------------------------------------------------------------
// 2. Documented order: PATH, opencode knowns, manager dirs — stable.
// ---------------------------------------------------------------------------

const posixFull = opencodeCandidates({ PATH: POSIX_PATH }, "linux", POSIX_HOME);
check(
  "posix order is exactly the documented one",
  JSON.stringify(posixFull.map((c) => c.path)) ===
    JSON.stringify([
      "/usr/bin/opencode",
      "/bin/opencode",
      `${POSIX_HOME}/.opencode/bin/opencode`,
      "/opt/homebrew/bin/opencode",
      "/usr/local/bin/opencode",
      `${POSIX_HOME}/.bun/bin/opencode`,
      `${POSIX_HOME}/.local/bin/opencode`,
      `${POSIX_HOME}/.npm-global/bin/opencode`,
      `${POSIX_HOME}/.local/share/pnpm/opencode`,
      `${POSIX_HOME}/.volta/bin/opencode`,
    ]),
  JSON.stringify(posixFull),
);
check(
  "posix sources are path,path,known*8",
  JSON.stringify(posixFull.map((c) => c.source)) ===
    JSON.stringify(["path", "path", ...Array(8).fill("known")]),
);
check(
  "order is stable across calls",
  JSON.stringify(opencodeCandidates({ PATH: POSIX_PATH }, "linux", POSIX_HOME)) ===
    JSON.stringify(posixFull),
);

// ---------------------------------------------------------------------------
// 3. PATH collision resolves in favor of PATH (first occurrence wins).
// ---------------------------------------------------------------------------

const collision = opencodeCandidates({ PATH: `${POSIX_HOME}/.bun/bin:${POSIX_PATH}` }, "linux", POSIX_HOME);
const bunHits = collision.filter((c) => c.path === `${POSIX_HOME}/.bun/bin/opencode`);
check("colliding dir appears exactly once", bunHits.length === 1, JSON.stringify(collision));
check("colliding dir keeps the PATH source", bunHits[0]?.source === "path");
check(
  "colliding dir sits with the PATH entries, before the knowns",
  collision.indexOf(bunHits[0]!) < collision.findIndex((c) => c.source === "known"),
);

// ---------------------------------------------------------------------------
// 4. node version directories: appended last, deterministic, platform layout.
// ---------------------------------------------------------------------------

const nvmDir = `${POSIX_HOME}/.nvm/versions/node/v20.11.0`;
const miseDir = `${POSIX_HOME}/.local/share/mise/installs/node/22.6.0`;
const withVersions = opencodeCandidates({ PATH: POSIX_PATH }, "linux", POSIX_HOME, [nvmDir, miseDir]);
check(
  "version dirs land at the very end, joined with bin on posix",
  JSON.stringify(withVersions.slice(-2).map((c) => c.path)) ===
    JSON.stringify([`${nvmDir}/bin/opencode`, `${miseDir}/bin/opencode`]),
  JSON.stringify(withVersions.slice(-2)),
);
check(
  "version-dir candidates are tagged known",
  withVersions.slice(-2).every((c) => c.source === "known"),
);

const winNvm = "C:\\Users\\u\\AppData\\Roaming\\nvm\\v20.11.0";
const winVersions = opencodeCandidates({ PATH: WIN_PATH, APPDATA: `${WIN_HOME}\\AppData\\Roaming` }, "win32", WIN_HOME, [winNvm]);
check(
  "win32 version dir points straight at the folder (nvm-windows layout)",
  winVersions[winVersions.length - 1]?.path === `${winNvm}\\opencode.exe`,
  JSON.stringify(winVersions.slice(-1)),
);

check(
  "version-dir order is stable across calls",
  JSON.stringify(opencodeCandidates({ PATH: POSIX_PATH }, "linux", POSIX_HOME, [nvmDir, miseDir])) ===
    JSON.stringify(withVersions),
);

// empty or garbage version-dir entries are dropped by the pure module
const garbage = opencodeCandidates({ PATH: POSIX_PATH }, "linux", POSIX_HOME, [
  "",
  "relative/dir",
  nvmDir,
]);
check(
  "empty/relative version-dir entries are dropped, absolute ones kept",
  garbage[garbage.length - 1]?.path === `${nvmDir}/bin/opencode` &&
    !garbage.some((c) => c.path === "/opencode" || c.path.endsWith("relative/dir/opencode")),
  JSON.stringify(garbage),
);

// ---------------------------------------------------------------------------
// 5. Enumeration: valid names, garbage names, determinism, cap, failure.
// ---------------------------------------------------------------------------

const enumDeps = (roots: Record<string, string[] | never>, cap?: number) => ({
  platform: "linux" as const,
  home: POSIX_HOME,
  env: {} as Record<string, string>,
  readdir: (dir: string) => {
    const hit = roots[dir];
    if (!hit) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return hit;
  },
  ...(cap === undefined ? {} : { cap }),
});

const nvmRoot = `${POSIX_HOME}/.nvm/versions/node`;
const miseRoot = `${POSIX_HOME}/.local/share/mise/installs/node`;

const good = enumerateNodeVersionDirs(
  enumDeps({ [nvmRoot]: ["v20.11.0", "v18.0.0"], [miseRoot]: ["22.6.0"] }),
);
check(
  "enumeration lists nvm versions then mise, sorted ascending, bin-ready dirs",
  JSON.stringify(good) ===
    JSON.stringify([`${nvmRoot}/v18.0.0`, `${nvmRoot}/v20.11.0`, `${miseRoot}/22.6.0`]),
  JSON.stringify(good),
);

const hostile = enumerateNodeVersionDirs(
  enumDeps({
    [nvmRoot]: ["", ".", "..", ".DS_Store", "has space", "a/b", "back\\slash", "v20.11.0", "v22.6.0-nightly"] as string[],
  }),
);
check(
  "empty/garbage version names are rejected, sane ones kept",
  JSON.stringify(hostile) === JSON.stringify([`${nvmRoot}/v20.11.0`, `${nvmRoot}/v22.6.0-nightly`]),
  JSON.stringify(hostile),
);

const shuffled = enumerateNodeVersionDirs(
  enumDeps({ [nvmRoot]: ["v20.11.0", "v18.0.0", "v19.9.9"] }),
);
const shuffledAgain = enumerateNodeVersionDirs(
  enumDeps({ [nvmRoot]: ["v19.9.9", "v20.11.0", "v18.0.0"] }),
);
check(
  "listing order in the directory does not leak into the result",
  JSON.stringify(shuffled) === JSON.stringify(shuffledAgain),
);

const many = Array.from({ length: 30 }, (_, i) => `v1.${i}.0`);
check(
  `default cap is ${NODE_VERSION_DIR_CAP} entries`,
  enumerateNodeVersionDirs(enumDeps({ [nvmRoot]: many })).length === NODE_VERSION_DIR_CAP,
);
check(
  "cap overflow truncates deterministically (first sorted names win)",
  JSON.stringify(enumerateNodeVersionDirs(enumDeps({ [nvmRoot]: many }, 3))) ===
    JSON.stringify([`${nvmRoot}/v1.0.0`, `${nvmRoot}/v1.1.0`, `${nvmRoot}/v1.10.0`]),
);

// failed enumeration: unreadable/missing roots contribute nothing, never throw
const failed = enumerateNodeVersionDirs(enumDeps({}));
check("failed enumeration returns an empty list", failed.length === 0, JSON.stringify(failed));
const throwsReaddir = enumerateNodeVersionDirs({
  platform: "linux",
  home: POSIX_HOME,
  env: {},
  readdir: (() => {
    throw new Error("EACCES");
  }) as never,
});
check("throwing readdir returns an empty list", throwsReaddir.length === 0);
const lyingReaddir = enumerateNodeVersionDirs({
  platform: "linux",
  home: POSIX_HOME,
  env: {},
  readdir: (() => undefined) as never,
});
check("non-array readdir returns an empty list", lyingReaddir.length === 0);

// "exactly the list of today": a failed enumeration (empty version dirs) must
// leave the candidate list at its documented baseline — nothing added, nothing
// reordered, no throw.
const baseline = opencodeCandidates({ PATH: POSIX_PATH }, "linux", POSIX_HOME, failed);
check(
  "failed enumeration yields exactly the documented baseline list",
  JSON.stringify(baseline) === JSON.stringify(posixFull),
  JSON.stringify(baseline),
);

// ---------------------------------------------------------------------------
// 6. pickOpencodeBinary still prefers the first executable candidate.
// ---------------------------------------------------------------------------

const pick = pickOpencodeBinary(baseline, (p) => p === "/opt/homebrew/bin/opencode");
check(
  "pick returns the first executable candidate and its source",
  pick.path === "/opt/homebrew/bin/opencode" && pick.source === "known",
  JSON.stringify(pick),
);

// ---------------------------------------------------------------------------
// 7. The pure module still imports no node builtin (reads the real source).
// ---------------------------------------------------------------------------

for (const file of ["apps/daemon/src/opencodebin.ts", "apps/daemon/src/nodeversions.ts"]) {
  const source = src(file);
  check(`${file}: no import statement`, !/^\s*import[\s{"'*]/m.test(source));
  check(`${file}: no require()`, !/require\s*\(/.test(source));
  check(`${file}: no node: builtin specifier`, !/node:/.test(source));
}

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nopencodebin/nodeversions: all green");
