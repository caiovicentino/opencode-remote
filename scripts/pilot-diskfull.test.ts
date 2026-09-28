/**
 * eval-02 — the REAL pilot entry point on a full disk, hermetic.
 *
 * 2026-09-24 04:20–07:40 the pilot crash-looped on ENOSPC (`pilot fatal …
 * ENOSPC … pilot.pid` at every KeepAlive relaunch). This spawns
 * `node --import tsx/esm apps/pilot/src/index.ts` exactly like the launchd
 * plist does, with a throwaway HOME, a throwaway prod repo path, a dead
 * OPENCODE_URL and the daemon's documented OCR_DISK_FULL=1 hatch, and proves
 * the process boots into the disk hold instead: alive across many hold ticks,
 * one `disk hold` transition logged, no pidfile written, never `pilot
 * started`, never `pilot fatal`.
 *
 * Opt-in (macOS, OCR_REAL_ENOSPC=1): the same boot on a REAL full volume — a
 * 16MB HFS+ image attached under the temp dir and filled to 0 bytes, HOME on
 * it — plus the pre-fix mechanism for contrast: the unchanged ensureSingleton
 * throws ENOSPC there (the old main() did that first and exited 1).
 * Run: npx tsx scripts/pilot-diskfull.test.ts
 */
import "./testhome"; // throwaway HOME before any pilot module loads (testhome.ts)
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSingleton } from "../apps/pilot/src/state";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const ROOT = join(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A child env with nothing that could reach production: temp HOME/XDG, dead
 * opencode URL, temp event feed, no GitHub token, no inherited disk hatches. */
function hermeticEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["OCR_DISK_FULL", "OCR_DISK_OK", "OCR_DISK_HOLD_TICK_MS", "GH_TOKEN", "GITHUB_TOKEN", "OCR_PILOT_REPO", "OPENCODE_URL", "XDG_DATA_HOME"]) delete env[k];
  return {
    ...env,
    HOME: home,
    XDG_DATA_HOME: join(home, "xdg"),
    OPENCODE_URL: "http://127.0.0.1:9",
    PILOT_EVENTS_FILE: join(home, "events.jsonl"),
    OCR_DISK_HOLD_TICK_MS: "200",
    ...extra,
  };
}

function startPilot(env: NodeJS.ProcessEnv): { child: ChildProcess; out: () => string } {
  let buf = "";
  const child = spawn(process.execPath, ["--import", "tsx/esm", "apps/pilot/src/index.ts"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => (buf += String(d)));
  child.stderr!.on("data", (d) => (buf += String(d)));
  return { child, out: () => buf };
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill("SIGTERM"); // our own child only
  await Promise.race([gone, sleep(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

// ── 1. OCR_DISK_FULL=1: boot into the hold, stay alive, write nothing ───────
{
  const home = mkdtempSync(join(tmpdir(), "pilot-diskfull-"));
  const repo = join(home, "prod");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(home, ".opencode-remote"), { recursive: true });
  // no digest push, no supervisor session: the hold alert stays local
  writeFileSync(join(home, ".opencode-remote", "pilot.json"), JSON.stringify({ digest: false }));
  const { child, out } = startPilot(hermeticEnv(home, { OCR_DISK_FULL: "1", OCR_PILOT_REPO: repo }));
  try {
    const held = await waitFor(() => out().includes('"msg":"disk hold"'), 60_000);
    check("full disk: the real entry point boots into the disk hold", held, out().slice(-800));
    await sleep(2_500); // >= 10 hold ticks at 200ms
    const log = out();
    check("full disk: still alive across the hold ticks (no crash, no exit)", child.exitCode === null && child.signalCode === null, `exit=${child.exitCode} signal=${child.signalCode}`);
    check("full disk: exactly one hold transition logged (no alert per tick)", count(log, '"msg":"disk hold"') === 1, log.slice(-600));
    check("full disk: the hold is critical and names the volume", /"level":"critical"/.test(log) && /0\.0gb free on/.test(log));
    check("full disk: no pidfile written while critical", !existsSync(join(home, ".opencode-remote", "pilot", "pilot.pid")));
    check("full disk: never reached `pilot started` nor `pilot fatal`", !log.includes('"msg":"pilot started"') && !log.includes('"msg":"pilot fatal"') && !log.includes("ENOSPC"));
  } finally {
    await stop(child);
    rmSync(home, { recursive: true, force: true });
  }
}

// ── 2. opt-in: a REAL full volume (macOS hdiutil) ────────────────────────────
if (process.env.OCR_REAL_ENOSPC !== "1" || process.platform !== "darwin") {
  console.log("SKIP real ENOSPC volume (set OCR_REAL_ENOSPC=1 on macOS to run it)");
} else {
  const base = mkdtempSync(join(tmpdir(), "pilot-enospc-"));
  const img = join(base, "vol.dmg");
  const mnt = join(base, "mnt");
  mkdirSync(mnt);
  let attached = false;
  try {
    const mk = spawnSync("hdiutil", ["create", "-size", "16m", "-fs", "HFS+", "-volname", "ocrENOSPC", "-layout", "NONE", img], { encoding: "utf8" });
    const at = mk.status === 0 ? spawnSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt, img], { encoding: "utf8" }) : mk;
    attached = at.status === 0;
    check("real volume: 16MB image attached under the temp dir", attached, `${mk.stderr ?? ""} ${at.stderr ?? ""}`);
    if (attached) {
      const home = join(mnt, "home");
      const pilotDir = join(home, ".opencode-remote", "pilot");
      mkdirSync(pilotDir, { recursive: true });
      writeFileSync(join(home, ".opencode-remote", "pilot.json"), JSON.stringify({ digest: false }));
      // fill the volume to the last byte
      spawnSync("dd", ["if=/dev/zero", `of=${join(mnt, "filler")}`, "bs=64k"], { encoding: "utf8" });
      spawnSync("dd", ["if=/dev/zero", `of=${join(mnt, "filler2")}`, "bs=512"], { encoding: "utf8" });
      let pidErr = "";
      try {
        await ensureSingleton(join(mnt, "demo", "pilot.pid"));
      } catch (err) {
        pidErr = String(err);
      }
      check("real volume: pre-fix mechanism reproduced — ensureSingleton throws ENOSPC on the pidfile", /ENOSPC/.test(pidErr), pidErr);
      const repo = join(base, "prod");
      mkdirSync(repo);
      const { child, out } = startPilot(hermeticEnv(home, { OCR_PILOT_REPO: repo }));
      try {
        const held = await waitFor(() => out().includes('"msg":"disk hold"'), 60_000);
        check("real volume: the pilot holds on the real statfs verdict", held && /"level":"critical"/.test(out()), out().slice(-800));
        await sleep(2_000);
        check("real volume: alive, no `pilot fatal`, no pidfile", child.exitCode === null && !out().includes('"msg":"pilot fatal"') && !existsSync(join(pilotDir, "pilot.pid")), out().slice(-600));
      } finally {
        await stop(child);
      }
    }
  } finally {
    if (attached) spawnSync("hdiutil", ["detach", mnt, "-force"], { encoding: "utf8" });
    rmSync(base, { recursive: true, force: true });
  }

  // ── 3. opt-in: automatic resume on the real entry point ─────────────────────
  // An 8GiB sparse HFS+ image with a 3.5GB filler reads 4.5GiB free (< the
  // 5GiB critical floor); deleting the filler brings it to ~8GiB (>= 7GiB, the
  // critical exit) and the boot must continue by itself: pidfile written,
  // `pilot started`, then the frozen loop (pilot.lock keeps it inert).
  // Costs ~3.6GB of transient backing store on the temp volume.
  const b3 = mkdtempSync(join(tmpdir(), "pilot-resume-"));
  const mnt3 = join(b3, "mnt");
  mkdirSync(mnt3);
  let attached3 = false;
  try {
    const mk = spawnSync("hdiutil", ["create", "-size", "8g", "-type", "SPARSE", "-fs", "HFS+", "-volname", "ocrResume", "-layout", "NONE", join(b3, "v")], { encoding: "utf8" });
    const at = mk.status === 0 ? spawnSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt3, join(b3, "v.sparseimage")], { encoding: "utf8" }) : mk;
    attached3 = at.status === 0;
    check("resume: 8GiB sparse image attached", attached3, `${mk.stderr ?? ""} ${at.stderr ?? ""}`);
    if (attached3) {
      const home = join(mnt3, "home");
      const pilotDir = join(home, ".opencode-remote", "pilot");
      mkdirSync(join(pilotDir, "repo-1", ".git"), { recursive: true }); // slot exists: no clone/npm ci
      writeFileSync(join(home, ".opencode-remote", "pilot.json"), JSON.stringify({ digest: false, slots: 1 }));
      writeFileSync(join(home, ".opencode-remote", "pilot.lock"), ""); // frozen loop after boot
      const filler = join(mnt3, "filler");
      const fill = spawnSync("mkfile", ["-n", "3500m", filler], { encoding: "utf8" });
      check("resume: filler leaves the volume under the critical floor", fill.status === 0, fill.stderr);
      const repo = join(b3, "prod");
      mkdirSync(repo);
      const { child, out } = startPilot(hermeticEnv(home, { OCR_PILOT_REPO: repo }));
      try {
        const held = await waitFor(() => out().includes('"msg":"disk hold"'), 60_000);
        check("resume: holds while the real volume is critical", held && !existsSync(join(pilotDir, "pilot.pid")), out().slice(-600));
        rmSync(filler, { force: true });
        const started = await waitFor(() => out().includes('"msg":"pilot started"'), 60_000);
        check("resume: space back → the boot continues by itself (no restart)", started && child.exitCode === null, out().slice(-1200));
        const pid = existsSync(join(pilotDir, "pilot.pid")) ? Number(String(spawnSync("cat", [join(pilotDir, "pilot.pid")], { encoding: "utf8" }).stdout).trim()) : -1;
        check("resume: the pidfile is written by the same process, after the hold", pid === child.pid);
        check("resume: reaches the loop (frozen) without any fatal", (await waitFor(() => out().includes("frozen — pilot.lock present"), 15_000)) && !out().includes('"msg":"pilot fatal"'));
      } finally {
        await stop(child);
      }
    }
  } finally {
    if (attached3) spawnSync("hdiutil", ["detach", mnt3, "-force"], { encoding: "utf8" });
    rmSync(b3, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall pilot disk-full checks passed");
