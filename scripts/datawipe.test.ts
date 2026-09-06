/**
 * P2-267: data-wipe tests (apps/desktop/src/datawipe.ts) — the portable twin
 * of the unit.test.ts block. Pure node: no Electron, no sockets, no chmod,
 * no spawn; the only fs use is reading the real datawipe.ts source for the
 * hygiene assertion, via a URL relative to this file (Windows-safe).
 * Run: npx tsx scripts/datawipe.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dataWipeVerdict,
  isAbsoluteDataRoot,
  isFilesystemRoot,
  WIPE_BUTTON_CANCEL,
  WIPE_BUTTON_INDEX,
  WIPE_BUTTON_NEXT,
  WIPE_BUTTON_WIPE,
  WIPE_DIALOG_TITLE,
  WIPE_REASON_HARNESS,
  WIPE_REASON_NOTHING,
  WIPE_REASON_ROOT,
  WIPE_REASON_UNCONFIRMED,
  WIPE_REASON_WIPE,
  WIPE_STEP1_DETAIL,
  WIPE_STEP1_MESSAGE,
  WIPE_STEP2_DETAIL,
  WIPE_STEP2_MESSAGE,
  wipePlannedChildren,
  type WipeReport,
} from "../apps/desktop/src/datawipe";
import { uninstallCleanupPlan, type UninstallCleanupPlan } from "../apps/desktop/src/uninstallplan";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const GOOD_ROOT = "/Users/ze/Library/Application Support/OpenCode Remote";
const FULL = ["daemon.json", "logs", "startup.json"];
const verdict = (harnessSession: boolean, dataRoot: string | null | undefined, confirmed: boolean, removable: readonly string[]) =>
  dataWipeVerdict({ harnessSession, dataRoot, confirmed, removableNames: removable });

// --- the complete verdict table, rules in the documented order ---------------
check("P2-267: harness session refuses even with confirmation present and a full list", verdict(true, GOOD_ROOT, true, FULL).action === "refuse");
check(
  "P2-267: the harness refusal is the harness reason (rule order: first)",
  verdict(true, GOOD_ROOT, true, FULL).reason === WIPE_REASON_HARNESS && verdict(true, null, false, []).reason === WIPE_REASON_HARNESS,
);
check(
  "P2-267: an invalid root with confirmation present still refuses (rule order)",
  verdict(false, "./dados relativos", true, FULL).action === "refuse" && verdict(false, "./dados relativos", true, FULL).reason === WIPE_REASON_ROOT,
);
for (const bad of [null, undefined, ""] as (string | null | undefined)[]) {
  check(
    `P2-267: an absent or empty root refuses fail-closed (${String(bad)})`,
    verdict(false, bad, true, FULL).action === "refuse" && verdict(false, bad, true, FULL).reason === WIPE_REASON_ROOT,
  );
}
for (const relative of ["dados do app", "./dados", "../sub", "OpenCode Remote"]) {
  check(`P2-267: a relative root refuses (${JSON.stringify(relative)})`, verdict(false, relative, true, FULL).action === "refuse");
}
for (const volume of ["/", "C:\\", "C:/", "C:", "\\\\srv", "\\\\srv\\"]) {
  check(`P2-267: a bare filesystem root refuses (${JSON.stringify(volume)})`, verdict(false, volume, true, FULL).action === "refuse");
}
check(
  "P2-267: isAbsoluteDataRoot accepts the documented absolute shapes only",
  isAbsoluteDataRoot("/Users/ze/dados") && isAbsoluteDataRoot("C:\\Users\\ze") && isAbsoluteDataRoot("C:/x") &&
    !isAbsoluteDataRoot("dados") && !isAbsoluteDataRoot("./dados") && !isAbsoluteDataRoot("C:"),
);
check(
  "P2-267: isFilesystemRoot flags the volume/drive/UNC-host shapes only",
  isFilesystemRoot("/") && isFilesystemRoot("C:\\") && isFilesystemRoot("C:/") && isFilesystemRoot("C:") &&
    isFilesystemRoot("\\\\srv") && isFilesystemRoot("\\\\srv\\") && !isFilesystemRoot(GOOD_ROOT) && !isFilesystemRoot("/dados"),
);
check(
  "P2-267: a missing confirmation refuses",
  verdict(false, GOOD_ROOT, false, FULL).action === "refuse" && verdict(false, GOOD_ROOT, false, FULL).reason === WIPE_REASON_UNCONFIRMED,
);
check(
  "P2-267: an empty removable list becomes nothing-to-do",
  verdict(false, GOOD_ROOT, true, []).action === "noop" && verdict(false, GOOD_ROOT, true, []).reason === WIPE_REASON_NOTHING,
);
const happy = verdict(false, GOOD_ROOT, true, FULL);
check(
  "P2-267: the happy case wipes with a non-empty confirmation text",
  happy.action === "wipe" && happy.reason === WIPE_REASON_WIPE && happy.confirmText === WIPE_STEP1_MESSAGE,
);
check(
  "P2-267: refuse and noop verdicts carry no confirmation text",
  [verdict(true, GOOD_ROOT, true, FULL), verdict(false, GOOD_ROOT, false, FULL), verdict(false, GOOD_ROOT, true, [])].every(
    (v) => v.action !== "wipe" && v.confirmText === "",
  ),
);
check(
  "P2-267: the same input in two calls yields an identical verdict",
  JSON.stringify(verdict(false, GOOD_ROOT, true, FULL)) === JSON.stringify(verdict(false, GOOD_ROOT, true, FULL)),
);

// --- text hygiene: static, path-free, volume-free, secret-free ----------------
const texts = [
  verdict(true, GOOD_ROOT, true, FULL).reason,
  verdict(false, "./x", true, FULL).reason,
  verdict(false, GOOD_ROOT, false, FULL).reason,
  verdict(false, GOOD_ROOT, true, []).reason,
  happy.reason,
  happy.confirmText,
  WIPE_DIALOG_TITLE,
  WIPE_STEP1_MESSAGE,
  WIPE_STEP1_DETAIL,
  WIPE_STEP2_MESSAGE,
  WIPE_STEP2_DETAIL,
  WIPE_BUTTON_NEXT,
  WIPE_BUTTON_WIPE,
  WIPE_BUTTON_CANCEL,
];
const clean = (s: string): boolean =>
  s.length > 0 &&
  !s.includes("/") &&
  !s.includes("\\") &&
  !s.includes("://") &&
  !/[A-Za-z]:[\\/]/.test(s) &&
  !s.includes("Users") &&
  !s.includes("~") &&
  !/[A-Za-z0-9+/_-]{40,}/.test(s);
check("P2-267: every reason and dialog copy is static, path-free, volume-free and secret-free", texts.every(clean));
check(
  "P2-267: the step-1 copy lists what goes and what stays; step 2 warns the paired phones",
  WIPE_STEP1_MESSAGE.includes("identidade") &&
    WIPE_STEP1_MESSAGE.includes("celulares pareados") &&
    WIPE_STEP1_DETAIL.includes("O que fica") &&
    WIPE_STEP2_MESSAGE.includes("todos os celulares pareados perdem o acesso"),
);
check(
  "P2-267: both dialog steps put Cancel last (Escape) at the fixed index",
  WIPE_BUTTON_INDEX.primary === 0 && WIPE_BUTTON_INDEX.cancel === 1 && WIPE_BUTTON_CANCEL.length > 0 && WIPE_BUTTON_NEXT.length > 0 && WIPE_BUTTON_WIPE.length > 0,
);

// --- executor against a fake fs (the real disk is never touched) --------------
const planOf = (observed: string[]) => uninstallCleanupPlan("OpenCode Remote", observed);
const fakeFs = (failFor: readonly string[] = []): { calls: string[]; fs: { rmSync(path: string, opts: { recursive: boolean; force: boolean }): void } } => {
  const calls: string[] = [];
  return {
    calls,
    fs: {
      rmSync: (p) => {
        if (failFor.some((n) => p.endsWith(n))) {
          const err = new Error("permission denied") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        calls.push(p);
      },
    },
  };
};

{
  const { calls, fs } = fakeFs();
  const report = wipePlannedChildren("/dados", planOf(["daemon.json", "logs", "Notes.txt", "", "../escape"]), fs, "/");
  check(
    "P2-267: the executor deletes exactly the removable immediate children under the root",
    JSON.stringify(calls) === JSON.stringify(["/dados/daemon.json", "/dados/logs"]) &&
      JSON.stringify(report.removed) === JSON.stringify(["daemon.json", "logs"]) &&
      report.failed.length === 0,
  );
  check(
    "P2-267: a preserved or plan-refused name is never touched",
    calls.every((p) => !p.includes("Notes.txt") && !p.includes("escape")),
  );
}
{
  const smuggled: UninstallCleanupPlan = {
    dataRootName: "OpenCode Remote",
    remove: ["daemon.json", "..", "a\\b", "/etc", "C:\\Users"],
    preserve: [],
    refused: [],
  };
  const { calls, fs } = fakeFs();
  const report = wipePlannedChildren("/dados", smuggled, fs, "/");
  check(
    "P2-267: a structurally unsafe name is skipped even when smuggled into the plan",
    JSON.stringify(report.removed) === JSON.stringify(["daemon.json"]) && JSON.stringify(calls) === JSON.stringify(["/dados/daemon.json"]),
  );
}
{
  const { calls, fs } = fakeFs(["logs"]);
  const report: WipeReport = wipePlannedChildren("/dados", planOf(["daemon.json", "logs", "startup.json"]), fs, "/");
  check(
    "P2-267: a removal failure becomes a report entry and the other removals continue",
    JSON.stringify(report.removed) === JSON.stringify(["daemon.json", "startup.json"]) &&
      report.failed.length === 1 &&
      report.failed[0].name === "logs" &&
      report.failed[0].code === "EPERM" &&
      calls.length === 2,
  );
  check(
    "P2-267: the report carries no path — bare names and stable codes only",
    !JSON.stringify(report).includes("/") && !JSON.stringify(report).includes("permission"),
  );
}
check(
  "P2-267: the executor is deterministic for the same plan in two calls",
  JSON.stringify(wipePlannedChildren("/dados", planOf(["daemon.json", "logs"]), fakeFs().fs, "/")) ===
    JSON.stringify({ removed: ["daemon.json", "logs"], failed: [] }),
);

// --- module hygiene: the real source stays pure --------------------------------
const wipeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "desktop", "src", "datawipe.ts"), "utf8");
check(
  "P2-267: datawipe.ts imports only the pure uninstallplan vocabulary — no electron, node:fs, node:path, fetch",
  wipeSrc.split("\n").filter((l) => l.trim().startsWith("import ") || l.includes("require(")).length === 1 &&
    wipeSrc.includes('from "./uninstallplan"') &&
    !/from\s+"electron"/.test(wipeSrc) &&
    !/from\s+"node:fs"/.test(wipeSrc) &&
    !/from\s+"node:path"/.test(wipeSrc) &&
    !wipeSrc.includes("fetch("),
);

if (failures > 0) {
  console.error(`DATAWIPE TESTS FAILED: ${failures}`);
  process.exit(1);
}
console.log("DATAWIPE TESTS PASSED");
process.exit(0);
