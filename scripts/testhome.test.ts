/**
 * Test-HOME sandbox guard (2026-09-27 incident): unit.test.ts's runDoctor()
 * normalized and rewrote the PRODUCTION ~/.opencode-remote/pilot/state.json
 * (lessonImpact zeroed, nightly *Last guards dropped) and the battery
 * refreshed the dead pilot's heartbeat, because suites that import pilot
 * modules ran under the owner's real HOME — as every pilot gate run on the
 * host does.
 *  - scripts/testhome.ts points HOME/USERPROFILE at a throwaway dir;
 *  - canary: a child process with a SEEDED home that imports the pilot state
 *    module and writes (touchHeartbeat + saveState(loadState())) changes the
 *    seeded files without the sandbox (negative control) and leaves them
 *    byte-identical with it;
 *  - static guard: every scripts/*.test.ts that imports apps/pilot/src must
 *    import "./testhome" before any other module.
 * Run: npx tsx scripts/testhome.test.ts
 */
import "./testhome";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const repo = join(import.meta.dirname, "..");

// 1. the sandbox itself
const sandbox = process.env.OCR_TEST_HOME ?? "";
check("testhome: HOME points at the throwaway dir", sandbox !== "" && process.env.HOME === sandbox && homedir() === sandbox);
check("testhome: the throwaway dir lives under the OS temp dir", sandbox.startsWith(tmpdir()));
check("testhome: HOME carries no doubled separator", !/[\\/]{2}/.test(sandbox.slice(1)));

// 2. canary — a child with a seeded home writes through the pilot state module
function seededHome(): { home: string; files: string[] } {
  const home = mkdtempSync(join(tmpdir(), "ocr-testhome-canary-"));
  const pilot = join(home, ".opencode-remote", "pilot");
  mkdirSync(pilot, { recursive: true });
  const state = {
    date: "2026-09-24",
    tasks: 8,
    merges: 6,
    lessonImpact: { with: { merges: 352, roundsTotal: 895, tokensTotal: 6424039987 }, without: { merges: 3, roundsTotal: 4, tokensTotal: 16530200 } },
    forensicLast: "2026-09-24",
  };
  writeFileSync(join(pilot, "state.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(pilot, "heartbeat"), "1790248029000");
  return { home, files: [join(pilot, "state.json"), join(pilot, "heartbeat")] };
}
const fingerprint = (files: string[]) => files.map((f) => `${statSync(f).mtimeMs}:${readFileSync(f, "utf8")}`).join("|");

// The child reports the home its pilot writes resolved to; a write into a
// fresh sandbox may fail (no .opencode-remote/pilot there) — that is the
// point, so failures are caught and reported, never fatal.
function runChild(home: string, guarded: boolean): { status: number | null; stderr: string; resolvedHome: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocr-testhome-child-"));
  const child = join(dir, "child.mts");
  const lines = [
    guarded ? `import ${JSON.stringify(pathToFileURL(join(repo, "scripts", "testhome.ts")).href)};` : "",
    `import { homedir } from "node:os";`,
    `import { loadState, saveState, touchHeartbeat } from ${JSON.stringify(pathToFileURL(join(repo, "apps", "pilot", "src", "state.ts")).href)};`,
    "try { touchHeartbeat(); } catch {}",
    "try { saveState(loadState()); } catch {}",
    "console.log(JSON.stringify({ resolvedHome: homedir() }));",
  ];
  writeFileSync(child, lines.join("\n") + "\n");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.OCR_TEST_HOME; // the child must decide for itself, like a fresh suite
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", child], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  let resolvedHome = "";
  try {
    resolvedHome = (JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}") as { resolvedHome?: string }).resolvedHome ?? "";
  } catch {
    // leave empty: the status check below reports the failure
  }
  return { status: r.status, stderr: r.stderr ?? "", resolvedHome };
}

{
  const control = seededHome();
  const before = fingerprint(control.files);
  const r = runChild(control.home, false);
  check("canary control: the unguarded child ran against the seeded home", r.status === 0 && r.resolvedHome === control.home, r.stderr.slice(0, 400));
  check("canary control: without the sandbox the seeded state/heartbeat ARE rewritten", fingerprint(control.files) !== before);
}
{
  const guarded = seededHome();
  const before = fingerprint(guarded.files);
  const r = runChild(guarded.home, true);
  check("canary: the guarded child ran in a throwaway home", r.status === 0 && r.resolvedHome !== "" && r.resolvedHome !== guarded.home, r.stderr.slice(0, 400));
  check("canary: with testhome the seeded state/heartbeat stay byte-identical", fingerprint(guarded.files) === before);
}

// 3. static guard — pilot-importing suites must load the sandbox first
{
  const scriptsDir = join(repo, "scripts");
  const suites = readdirSync(scriptsDir).filter((f) => f.endsWith(".test.ts"));
  const offenders: string[] = [];
  let guardedCount = 0;
  for (const f of suites) {
    const src = readFileSync(join(scriptsDir, f), "utf8");
    if (!/from ["']\.\.\/apps\/pilot\/src\//.test(src) && !/import\(["']\.\.\/apps\/pilot\/src\//.test(src)) continue;
    const firstImport = src.split("\n").find((l) => /^import\s/.test(l)) ?? "";
    if (/^import\s+["']\.\/testhome(\.ts)?["'];?\s*(\/\/.*)?$/.test(firstImport)) guardedCount++;
    else offenders.push(`${f}: first import is ${JSON.stringify(firstImport.slice(0, 80))}`);
  }
  check("static: every pilot-importing suite imports ./testhome first", offenders.length === 0, offenders.join("; "));
  check("static: the guard actually found pilot-importing suites", guardedCount >= 3, `guarded=${guardedCount}`);
}

if (failures) process.exit(1);
console.log("testhome: all checks passed");
