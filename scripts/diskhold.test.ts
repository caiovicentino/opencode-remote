/**
 * eval-02 — disk hold + retention battery (pure node: fs/os/path only).
 *
 * Pins the rules that keep a full disk from taking the fleet down again
 * (the 2026-09-24 ENOSPC crash loop): the hysteresis levels, the worst-volume
 * fold, one alert per transition, the forced window after a runtime ENOSPC,
 * the boot gate (no write while critical; ENOSPC out of the first write waits
 * instead of crashing; any other error still crashes), the never-throwing
 * persistence seam, the in-memory heartbeat the watchdog now judges, the
 * atomic deploy-guard lists, the artifact/session retention planners and the
 * index.ts wiring.
 * Run: npx tsx scripts/diskhold.test.ts
 */
import "./testhome"; // throwaway HOME before any pilot module loads (testhome.ts)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDiskFullError, type VolumeProbe, type VolumeReading } from "../apps/pilot/src/disk";
import {
  DISK_HOLD_THRESHOLDS,
  DISK_HOLD_TICK_MS,
  bootDiskGate,
  diskAlert,
  diskHatch,
  diskHoldDetail,
  diskHoldTickMs,
  diskLevelFor,
  forceDiskHold,
  initialDiskHold,
  noteDiskFailure,
  persistSafely,
  pollDiskHold,
  readFleetVolumes,
  stepDiskHold,
  waitWhileDiskCritical,
  worstReading,
  type DiskHold,
  type DiskHoldIo,
  type DiskTransition,
} from "../apps/pilot/src/diskhold";
import { heartbeatAgeMs, touchHeartbeatFile } from "../apps/pilot/src/state";
import { readQuarantine, readVerifiedMerges, quarantineSha, recordVerifiedMerge } from "../apps/pilot/src/deployguard";
import { ARTIFACT_MIN_AGE_MS, planArtifactRule, planSessionRetention, pilotSessionDirs, sweepPilotArtifacts, type ArtifactEntry, type ArtifactFs } from "../apps/pilot/src/retention";

// P2-120: nothing here may reach the real event feed
const EVENTS_DIR = mkdtempSync(join(tmpdir(), "diskhold-ev-"));
process.env.PILOT_EVENTS_FILE = join(EVENTS_DIR, "events.jsonl");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const GIB = 1024 ** 3;
const DAY = 24 * 60 * 60_000;
const T = DISK_HOLD_THRESHOLDS;
const VOLS: VolumeProbe[] = [
  { label: "pilot state", path: "/v/state" },
  { label: "opencode db", path: "/v/db" },
];
const reading = (label: string, free: number | null, dev: number | null = null): VolumeReading => ({ label, path: `/v/${label}`, freeBytes: free, dev });

/** Scripted io: every probe returns the next free-bytes value for all volumes. */
function scripted(frees: number[], extra: Partial<DiskHoldIo> = {}) {
  const alerts: { t: DiskTransition; detail: string; level: string }[] = [];
  const logs: string[] = [];
  let i = 0;
  let clock = 1_000_000;
  const io: DiskHoldIo = {
    env: {},
    read: async (v) => ({ ...v, freeBytes: frees[Math.min(i, frees.length - 1)]!, dev: null }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      i++;
    },
    touch: () => {},
    alert: (t, detail, hold) => alerts.push({ t, detail, level: hold.level }),
    logFn: (_lvl, msg) => logs.push(msg),
    ...extra,
  };
  return { io, alerts, logs, advance: (ms: number) => (clock += ms), next: () => i++ };
}

// ── ENOSPC classification ────────────────────────────────────────────────────
{
  const fsErr = Object.assign(new Error("ENOSPC: no space left on device, open '/x/pilot/state.json.tmp'"), { code: "ENOSPC" });
  check("isDiskFullError: node fs ENOSPC (the 24/09 state.json.tmp)", isDiskFullError(fsErr));
  check("isDiskFullError: EDQUOT code", isDiskFullError({ code: "EDQUOT" }));
  check(
    "isDiskFullError: git index.lock text (the 24/09 04:20:30 fatal)",
    isDiskFullError(new Error("exec failed (status 128): git reset -q --hard origin/main\nfatal: Unable to create '/x/repo-1/.git/index.lock': No space left on device")),
  );
  check("isDiskFullError: plain string reason", isDiskFullError("Error: ENOSPC: no space left on device, write"));
  check("isDiskFullError: EACCES is not disk-full", !isDiskFullError(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })));
  check("isDiskFullError: null/undefined/number", !isDiskFullError(null) && !isDiskFullError(undefined) && !isDiskFullError(42));
  check("isDiskFullError: word-bounded (ENOSPCX is not a match)", !isDiskFullError(new Error("code ENOSPCX")));
}

// ── hysteresis levels ────────────────────────────────────────────────────────
{
  check("thresholds: low 10GiB, critical = deploy guard 5GiB, margin 2GiB", T.lowBytes === 10 * GIB && T.criticalBytes === 5 * GIB && T.marginBytes === 2 * GIB);
  const table: [number, "ok" | "low" | "critical", "ok" | "low" | "critical"][] = [
    [11, "ok", "ok"],
    [9.9, "ok", "low"],
    [4.9, "ok", "critical"],
    [11, "low", "low"], // below 12 = low + margin: no flapping at the edge
    [12, "low", "ok"],
    [4, "low", "critical"],
    [6, "critical", "critical"], // below 7 = critical + margin
    [7, "critical", "low"],
    [11.9, "critical", "low"],
    [12, "critical", "ok"],
  ];
  for (const [gib, prev, want] of table) {
    const got = diskLevelFor(gib * GIB, prev);
    check(`diskLevelFor(${gib}GiB, prev ${prev}) = ${want}`, got === want, `got ${got}`);
  }
}

// ── worst-volume fold ────────────────────────────────────────────────────────
{
  const w = worstReading([reading("a", 50 * GIB), reading("b", 3 * GIB), reading("c", null), reading("d", Number.NaN), reading("e", -1)]);
  check("worstReading: least free among readable volumes (null/NaN/negative ignored)", w?.label === "b" && w.freeBytes === 3 * GIB);
  check("worstReading: nothing readable → null", worstReading([reading("a", null)]) === null);
}

// ── stepDiskHold transitions ─────────────────────────────────────────────────
{
  const ok = initialDiskHold();
  const s1 = stepDiskHold(ok, [reading("pilot state", 9 * GIB), reading("db", 200 * GIB)], 100);
  check("step: ok → low is `enter`, since stamped", s1.hold.level === "low" && s1.transition === "enter" && s1.hold.since === 100);
  const s2 = stepDiskHold(s1.hold, [reading("pilot state", 4 * GIB)], 200);
  check("step: low → critical is `escalate`, since kept", s2.hold.level === "critical" && s2.transition === "escalate" && s2.hold.since === 100);
  const s3 = stepDiskHold(s2.hold, [reading("pilot state", 8 * GIB)], 300);
  check("step: critical → low is `deescalate`", s3.hold.level === "low" && s3.transition === "deescalate");
  const s4 = stepDiskHold(s3.hold, [reading("pilot state", 13 * GIB)], 400);
  check("step: → ok is `resume`, since cleared", s4.hold.level === "ok" && s4.transition === "resume" && s4.hold.since === null);
  const s5 = stepDiskHold(s2.hold, [reading("pilot state", null)], 500);
  check("step: no readable volume keeps a critical hold (never resumes on missing evidence)", s5.hold.level === "critical" && s5.transition === null);
  const s6 = stepDiskHold(ok, [], 600);
  check("step: no readable volume never enters a hold (fail-open like P3-006)", s6.hold.level === "ok" && s6.transition === null);
  const steady = stepDiskHold(s1.hold, [reading("pilot state", 9.5 * GIB)], 700);
  check("step: same level → no transition (one alert per episode)", steady.transition === null);
}

// ── forced window after a runtime ENOSPC ─────────────────────────────────────
{
  const f = forceDiskHold(initialDiskHold(), 1_000, "saveState (pipeline crash): ENOSPC", 60_000);
  check("force: ok → critical is `enter` with the reason kept", f.hold.level === "critical" && f.transition === "enter" && f.hold.forcedBy?.startsWith("saveState") === true);
  const inside = stepDiskHold(f.hold, [reading("pilot state", 500 * GIB)], 30_000);
  check("force: statfs says roomy but the window holds critical", inside.hold.level === "critical" && inside.transition === null);
  const after = stepDiskHold(inside.hold, [reading("pilot state", 500 * GIB)], 61_001);
  check("force: after the window a roomy probe resumes", after.hold.level === "ok" && after.transition === "resume" && after.hold.forcedBy === null);
  const again = forceDiskHold(f.hold, 2_000, "again", 60_000);
  check("force: forcing an already-critical hold is not a new transition", again.transition === null && again.hold.forcedUntil === 62_000);
}

// ── a long hold re-alerts every 6h (one missed signal = 10 days down) ─────────
{
  const H = 60 * 60_000;
  const low = [reading("pilot state", 8 * GIB)];
  const entered = stepDiskHold(initialDiskHold(), low, 0);
  check("remind: entering stamps alertedAt", entered.transition === "enter" && entered.hold.alertedAt === 0);
  const early = stepDiskHold(entered.hold, low, 6 * H - 1);
  check("remind: silent before 6h", early.transition === null && early.hold.alertedAt === 0);
  const due = stepDiskHold(early.hold, low, 6 * H);
  check("remind: at 6h the hold re-alerts once and re-arms", due.transition === "remind" && due.hold.alertedAt === 6 * H);
  const after = stepDiskHold(due.hold, low, 6 * H + 60_000);
  check("remind: not again right after", after.transition === null);
  const crit = stepDiskHold(after.hold, [reading("pilot state", 1 * GIB)], 7 * H);
  check("remind: an escalation re-arms the clock", crit.transition === "escalate" && crit.hold.alertedAt === 7 * H);
  const down = stepDiskHold(crit.hold, [reading("pilot state", 8 * GIB)], 8 * H);
  check("remind: a de-escalation (log-only) keeps the clock", down.transition === "deescalate" && down.hold.alertedAt === 7 * H);
  const d = diskHoldDetail(crit.hold, stepDiskHold(down.hold, low, 13 * H).hold, "remind", 13 * H);
  check("remind: the text says how long the fleet has been held", /disk hold still low after 13h/.test(d), d);
  const back = stepDiskHold(down.hold, [reading("pilot state", 30 * GIB)], 9 * H);
  check("remind: resume clears the clock", back.transition === "resume" && back.hold.alertedAt === null);
}

// ── alert text ───────────────────────────────────────────────────────────────
{
  const prev = initialDiskHold();
  const crit = stepDiskHold(prev, [reading("pilot state", 0.1 * GIB)], 0);
  const d = diskHoldDetail(prev, crit.hold, "enter", 0);
  check("detail: critical names the volume, the free space and the resume point", /critical/.test(d) && /0\.1gb free on pilot state/.test(d) && /resumes by itself at 12\.0gb/.test(d), d);
  check("detail: fits the 220-char event cap", d.length <= 220, String(d.length));
  const back = stepDiskHold(crit.hold, [reading("pilot state", 40 * GIB)], 3 * 60 * 60_000);
  const r = diskHoldDetail(crit.hold, back.hold, "resume", 3 * 60 * 60_000);
  check("detail: resume reports how long the fleet was held", /disk ok again: 40\.0gb free on pilot state — fleet resumed after 180min/.test(r), r);
  const forced = forceDiskHold(prev, 0, "boot write: ENOSPC: no space left on device, open '/x/pilot.pid'");
  check("detail: a forced hold says which write failed", /write failed: boot write/.test(diskHoldDetail(prev, forced.hold, "enter", 0)));
}

// ── hatches, tick, volume reads ──────────────────────────────────────────────
{
  check("hatch: OCR_DISK_FULL=1 → full", diskHatch({ OCR_DISK_FULL: "1" }) === "full");
  check("hatch: OCR_DISK_FULL wins over OCR_DISK_OK (daemon semantics)", diskHatch({ OCR_DISK_FULL: "1", OCR_DISK_OK: "1" }) === "full");
  check("hatch: OCR_DISK_OK=1 → ok; unset → none", diskHatch({ OCR_DISK_OK: "1" }) === "ok" && diskHatch({}) === null);
  check("tick: default 30s, env override clamped to [100ms, 10min]", diskHoldTickMs({}) === DISK_HOLD_TICK_MS && diskHoldTickMs({ OCR_DISK_HOLD_TICK_MS: "5" }) === 100 && diskHoldTickMs({ OCR_DISK_HOLD_TICK_MS: "250" }) === 250 && diskHoldTickMs({ OCR_DISK_HOLD_TICK_MS: "99999999" }) === 600_000 && diskHoldTickMs({ OCR_DISK_HOLD_TICK_MS: "x" }) === DISK_HOLD_TICK_MS);
  let reads = 0;
  const counting = async (v: VolumeProbe): Promise<VolumeReading> => {
    reads++;
    return { ...v, freeBytes: 1, dev: 7 };
  };
  const full = await readFleetVolumes(VOLS, { env: { OCR_DISK_FULL: "1" }, read: counting });
  check("readFleetVolumes: OCR_DISK_FULL forces 0 free on every volume without probing", full.every((r) => r.freeBytes === 0) && reads === 0);
  const roomy = await readFleetVolumes(VOLS, { env: { OCR_DISK_OK: "1" }, read: counting });
  check("readFleetVolumes: OCR_DISK_OK forces a roomy reading without probing", roomy.every((r) => (r.freeBytes ?? 0) >= 12 * GIB) && reads === 0);
  const deduped = await readFleetVolumes(VOLS, { env: {}, read: counting });
  check("readFleetVolumes: same device read twice is kept once", deduped.length === 1 && reads === 2);
  const broken = await readFleetVolumes(VOLS, {
    env: {},
    read: async () => {
      throw new Error("statfs exploded");
    },
  });
  check("readFleetVolumes: a throwing probe is a null reading, never a throw", broken.length === 2 && broken.every((r) => r.freeBytes === null));
}

// ── pollDiskHold: one alert per transition ───────────────────────────────────
{
  const { io, alerts, next } = scripted([20 * GIB, 9 * GIB, 9 * GIB, 3 * GIB, 3 * GIB, 8 * GIB, 30 * GIB]);
  let hold: DiskHold = initialDiskHold();
  const seen: (DiskTransition | null)[] = [];
  for (let k = 0; k < 7; k++) {
    const r = await pollDiskHold(hold, VOLS, io);
    hold = r.hold;
    seen.push(r.transition);
    next();
  }
  check("poll: transitions fold as ok→enter→·→escalate→·→deescalate→resume", JSON.stringify(seen) === JSON.stringify([null, "enter", null, "escalate", null, "deescalate", "resume"]), JSON.stringify(seen));
  check("poll: the alert hook sees every transition exactly once (de-escalation included, the default hook drops it)", alerts.map((a) => a.t).join() === "enter,escalate,deescalate,resume");
}

// ── alert seam: (kind, detail) — the notifyOperator contract (eval-01) ─────────
{
  const sent: string[] = [];
  const alert = diskAlert(false, (kind, detail) => {
    sent.push(`${kind}|${detail.slice(0, 10)}`);
  });
  const h = stepDiskHold(initialDiskHold(), [reading("pilot state", 1 * GIB)], 0).hold;
  for (const t of ["enter", "escalate", "remind", "deescalate", "resume"] as DiskTransition[]) alert(t, `${t} detail`, h);
  check(
    "alert seam: enter/escalate/remind notify kind disk-hold, resume disk-resume, de-escalation stays silent",
    sent.map((x) => x.split("|")[0]).join() === "disk-hold,disk-hold,disk-hold,disk-resume",
    sent.join(" "),
  );
  const feed = readFileSync(process.env.PILOT_EVENTS_FILE!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; task: string; phase: string; ok: boolean });
  check(
    "alert seam: each notify also lands in the (test) event feed as task=disk alerts",
    feed.length === 4 && feed.every((e) => e.type === "alert" && e.task === "disk") && feed[3]!.phase === "disk-resume" && feed[3]!.ok === true,
    JSON.stringify(feed),
  );
  let threw = false;
  try {
    diskAlert(false, () => {
      throw new Error("delivery exploded");
    })("enter", "x", h);
  } catch {
    threw = true;
  }
  check("alert seam: a throwing notify never escapes", !threw);
}

// ── noteDiskFailure ──────────────────────────────────────────────────────────
{
  const { io, alerts } = scripted([50 * GIB]);
  const other = noteDiskFailure(initialDiskHold(), new Error("git exploded"), "x", io);
  check("noteDiskFailure: a non-disk error leaves the hold alone", !other.forced && other.hold.level === "ok" && alerts.length === 0);
  const first = noteDiskFailure(initialDiskHold(), Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }), "saveState (pipeline crash)", io);
  check("noteDiskFailure: ENOSPC forces critical and alerts once", first.forced && first.hold.level === "critical" && alerts.length === 1 && alerts[0]!.t === "enter");
  const second = noteDiskFailure(first.hold, "No space left on device", "unhandled rejection", io);
  check("noteDiskFailure: a second ENOSPC while critical does not re-alert", second.forced && alerts.length === 1);
}

// ── waitWhileDiskCritical / bootDiskGate ─────────────────────────────────────
{
  const touches: number[] = [];
  const { io, alerts } = scripted([0, 0, 0, 20 * GIB], { touch: () => touches.push(1) });
  const out = await waitWhileDiskCritical(initialDiskHold(), VOLS, io);
  check("wait: holds while critical, feeding the heartbeat on every tick", out.level === "ok" && touches.length === 3);
  check("wait: exactly one enter and one resume alert", alerts.map((a) => a.t).join() === "enter,resume");
}
{
  const order: string[] = [];
  const { io } = scripted([0, 0, 20 * GIB], { sleep: undefined });
  let frees = [0, 0, 20 * GIB];
  let k = 0;
  const gateIo: DiskHoldIo = {
    ...io,
    read: async (v) => ({ ...v, freeBytes: frees[Math.min(k, frees.length - 1)]!, dev: null }),
    sleep: async () => {
      order.push("sleep");
      k++;
    },
  };
  await bootDiskGate(VOLS, async () => {
    order.push("write");
  }, gateIo);
  check("boot gate: the first write only happens after the disk recovered", order.join() === "sleep,sleep,write", order.join());

  // ENOSPC out of the first write (the 24/09 pidfile) waits instead of crashing
  frees = [20 * GIB];
  k = 0;
  let clock = 0;
  let writes = 0;
  const alerts: string[] = [];
  const forcedIo: DiskHoldIo = {
    env: {},
    read: async (v) => ({ ...v, freeBytes: 20 * GIB, dev: null }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    touch: () => {},
    alert: (t) => alerts.push(t),
    logFn: () => {},
    forcedHoldMs: 90_000,
  };
  await bootDiskGate(VOLS, async () => {
    writes++;
    if (writes === 1) throw Object.assign(new Error("ENOSPC: no space left on device, open '/x/pilot/pilot.pid'"), { code: "ENOSPC" });
  }, forcedIo);
  check("boot gate: ENOSPC from the pidfile write → hold → retried after the forced window", writes === 2 && clock >= 90_000, `writes=${writes} clock=${clock}`);
  check("boot gate: the forced hold is announced and released once each", alerts.join() === "enter,resume", alerts.join());

  let threw = "";
  try {
    await bootDiskGate(VOLS, async () => {
      throw new Error("EACCES: permission denied, open '/x/pilot.pid'");
    }, forcedIo);
  } catch (err) {
    threw = String(err);
  }
  check("boot gate: any other error still propagates (crash-only contract)", threw.includes("EACCES"));
}

// ── persistSafely ────────────────────────────────────────────────────────────
{
  let seen: unknown = null;
  const failed = persistSafely(
    () => {
      throw Object.assign(new Error("ENOSPC: no space left on device, open 'state.json.tmp'"), { code: "ENOSPC" });
    },
    (err) => {
      seen = err;
    },
  );
  check("persistSafely: a throwing write returns false and hands the error over", failed === false && isDiskFullError(seen));
  let threw = false;
  try {
    persistSafely(
      () => {
        throw new Error("a");
      },
      () => {
        throw new Error("b");
      },
    );
  } catch {
    threw = true;
  }
  check("persistSafely: even a throwing onError never escapes", !threw);
  check("persistSafely: success returns true", persistSafely(() => {}, () => {}) === true);
}

// ── in-memory heartbeat (the watchdog's judge) ───────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "diskhold-hb-"));
  const unwritable = join(dir, "missing-dir", "heartbeat"); // the write fails like ENOSPC would
  await new Promise((r) => setTimeout(r, 30));
  touchHeartbeatFile(unwritable);
  check("heartbeat: a failed file write still refreshes the in-memory beat", heartbeatAgeMs() < 25 && !existsSync(unwritable));
  const ok = join(dir, "heartbeat");
  touchHeartbeatFile(ok);
  check("heartbeat: the file stays the external signal when writable", existsSync(ok) && Number(readFileSync(ok, "utf8")) > 0);
  const stateSrc = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "state.ts"), "utf8");
  const wd = stateSrc.slice(stateSrc.indexOf("export function startWatchdog"));
  check("heartbeat: startWatchdog judges heartbeatAgeMs(), not the file", wd.includes("heartbeatAgeMs()") && !wd.includes("readFileSync(HEARTBEAT"));
  rmSync(dir, { recursive: true, force: true });
}

// ── deploy-guard lists are written atomically ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "diskhold-dg-"));
  const verified = join(dir, "verified-merges.jsonl");
  check("atomic: first write lands", recordVerifiedMerge(verified, "a".repeat(40), "P1-001", "t0"));
  check("atomic: no .tmp residue after a successful write", !existsSync(`${verified}.tmp`) && readdirSync(dir).join() === "verified-merges.jsonl");
  const before = readFileSync(verified, "utf8");
  mkdirSync(`${verified}.tmp`); // the tmp cannot be written (stands in for ENOSPC mid-write)
  const ok = recordVerifiedMerge(verified, "b".repeat(40), "P1-002", "t1");
  check("atomic: a failed write reports false and leaves the list byte-identical", !ok && readFileSync(verified, "utf8") === before && readVerifiedMerges(verified).length === 1);
  const quarantine = join(dir, "quarantine.jsonl");
  quarantineSha(quarantine, "c".repeat(40), "rollback", "P1-003", "t2");
  mkdirSync(`${quarantine}.tmp`);
  quarantineSha(quarantine, "d".repeat(40), "rollback", "P1-004", "t3");
  check("atomic: a failed quarantine write never drops the entries already there", readQuarantine(quarantine).map((q) => q.task).join() === "P1-003");
  rmSync(dir, { recursive: true, force: true });
}

// ── artifact retention planner + executor ────────────────────────────────────
{
  const now = 100 * DAY;
  const e = (name: string, ageMs: number, isFile = true, size = 10): ArtifactEntry => ({ name, mtimeMs: now - ageMs, size, isFile });
  const rule = { name: "t", dir: "", match: /^builder-.+\.log$/, keepNewest: 2, maxAgeDays: 10, maxFiles: 4 };
  const entries = [
    e("builder-A.log", 1 * DAY),
    e("builder-B.log", 2 * DAY),
    e("builder-C.log", 3 * DAY),
    e("builder-D.log", 11 * DAY), // beyond floor, older than 10d → goes
    e("builder-E.log", 5 * DAY), // index 3 (sorted) → kept (within cap/age)
    e("builder-F.log", 6 * DAY), // index 4 → beyond cap 4 → goes
    e("notes.txt", 50 * DAY), // not matched
    e("builder-dir.log", 50 * DAY, false), // not a file (dir/symlink)
  ];
  const gone = planArtifactRule(entries, rule, now).map((x) => x.name).sort();
  check("artifacts: floor kept, cap and age enforced, non-matching and non-files untouched", gone.join() === "builder-D.log,builder-F.log", gone.join());
  const young = planArtifactRule([e("builder-1.log", 10), e("builder-2.log", 20), e("builder-3.log", ARTIFACT_MIN_AGE_MS / 2)], { ...rule, keepNewest: 0, maxFiles: 0 }, now);
  check("artifacts: a file younger than 1h is never removed, even over the cap", young.length === 0);

  const root = mkdtempSync(join(tmpdir(), "diskhold-art-"));
  const t = Date.now();
  for (let k = 0; k < 60; k++) {
    const f = join(root, `builder-P9-${String(k).padStart(3, "0")}.log`);
    writeFileSync(f, "x".repeat(100));
    const m = new Date(t - (k + 2) * DAY);
    utimesSync(f, m, m);
  }
  writeFileSync(join(root, "state.json"), "{}");
  const dry = sweepPilotArtifacts(root, { apply: false });
  check("artifacts: dry-run reports without deleting", dry.removed > 0 && !dry.applied && readdirSync(root).length === 61);
  const real = sweepPilotArtifacts(root);
  const left = readdirSync(root);
  check("artifacts: apply removes exactly the planned files, never state.json", real.ok && real.removed === dry.removed && left.length === 61 - real.removed && left.includes("state.json"), JSON.stringify(real));
  check("artifacts: the 50-newest floor survives (builder logs rule)", left.filter((n) => n.startsWith("builder-")).length >= 28 && left.includes("builder-P9-000.log"));
  rmSync(root, { recursive: true, force: true });

  const failingFs: ArtifactFs = {
    list: () => [e("builder-OLD.log", 400 * DAY), e("builder-OLD2.log", 401 * DAY)],
    rm: (p) => {
      if (p.endsWith("OLD.log")) throw new Error("EPERM");
    },
  };
  const partial = sweepPilotArtifacts("/nowhere", { fs: failingFs, now, rules: [{ ...rule, keepNewest: 0 }] });
  check("artifacts: a failed rm is ok:false and the sweep continues", !partial.ok && partial.removed === 1 && partial.errors.length === 1);
}

// ── session retention planner (pure) ─────────────────────────────────────────
{
  const now = 30 * DAY;
  const dir = "/h/.opencode-remote/pilot/repo-1";
  const s = (id: string, updatedDaysAgo: number, extra: Record<string, unknown> = {}) => ({
    id,
    directory: dir,
    title: id,
    time: { created: now - updatedDaysAgo * DAY, updated: now - updatedDaysAgo * DAY },
    ...extra,
  });
  const rows = [
    s("ses_old1", 20),
    s("ses_old2", 25),
    s("ses_kid1", 21, { parentID: "ses_old1" }), // goes with its root
    s("ses_live", 20),
    s("ses_livekid", 1, { parentID: "ses_live" }), // a recent child keeps its root
    s("ses_recent", 3),
    s("ses_prot", 40),
    s("ses_foreign", 40, { directory: "/Volumes/SSD Major/Major/opencode-remote" }), // the owner's own session, same project
    s("ses_prefix", 40, { directory: `${dir}-copy` }),
    s("bad id!", 40),
    { nonsense: true },
    s("ses_strayKid", 40, { parentID: "ses_ownerRoot" }), // parent lives outside the pilot clones
  ];
  const plan = planSessionRetention(new Map([[dir, rows]]), { maxAgeDays: 14, now, maxDeletes: 100, protect: new Set(["ses_prot"]) });
  const ids = plan.candidates.map((c) => c.id);
  check("sessions: only old ROOT sessions of the exact pilot dir are candidates, oldest first", ids.join() === "ses_old2,ses_old1", ids.join());
  check("sessions: a child rides its root (children counted, never listed itself)", plan.candidates.find((c) => c.id === "ses_old1")?.children === 1 && !ids.includes("ses_kid1"));
  check("sessions: a recent child keeps its whole tree", !ids.includes("ses_live") && plan.kept.recent === 2);
  check("sessions: foreign or prefix-lookalike directories are never trusted", plan.kept.foreign === 3 && !ids.includes("ses_foreign") && !ids.includes("ses_prefix"));
  check("sessions: a child whose root lives outside the pilot clones is never cut off its tree", !ids.includes("ses_strayKid"));
  check("sessions: malformed rows/ids are skipped (a bad id is a 500 upstream)", plan.kept.invalid === 2);
  check("sessions: the protect set wins over age", plan.kept.protected === 1 && !ids.includes("ses_prot"));
  const capped = planSessionRetention(new Map([[dir, rows]]), { maxAgeDays: 14, now, maxDeletes: 1 });
  check(
    "sessions: the per-run cap keeps the oldest candidate first (no protect set → the 40-day root leads)",
    capped.candidates.map((c) => c.id).join() === "ses_prot" && capped.kept.capped === 2,
    JSON.stringify(capped),
  );
  const clamped = planSessionRetention(new Map([[dir, [s("ses_hour", 0.5)]]]), { maxAgeDays: 0, now, maxDeletes: 10 });
  check("sessions: maxAgeDays is clamped to >= 1 day", clamped.candidates.length === 0);
  const P = join("/h", "p"); // join(): the portable battery also runs on Windows
  const dirs = pilotSessionDirs(P, {
    exists: (p) => p === join(P, "repo-explorer"),
    list: (p) => (p === P ? ["repo-2", "repo-1", "repo", "repo-10", "gate-ws", "shots"] : p === join(P, "mission") ? ["org--x"] : p === join(P, "mission", "org--x") ? ["repo", "repo-1"] : []),
  });
  check(
    "sessions: owned dirs = slot clones (+ mission clones) + explorer; never gate-ws/shots/mission base clones",
    JSON.stringify(dirs) === JSON.stringify([join(P, "repo-1"), join(P, "repo-10"), join(P, "repo-2"), join(P, "repo-explorer"), join(P, "mission", "org--x", "repo-1")]),
    JSON.stringify(dirs),
  );
}

// ── index.ts wiring pins ─────────────────────────────────────────────────────
{
  const src = readFileSync(join(import.meta.dirname, "..", "apps", "pilot", "src", "index.ts"), "utf8");
  const main = src.slice(src.indexOf("async function main()"));
  check("wiring: the boot gate wraps ensureSingleton before the config/slots are touched", main.indexOf("bootDiskGate(diskVolumes, () => ensureSingleton(), diskIo)") > 0 && main.indexOf("bootDiskGate(") < main.indexOf("const cfg = loadConfig();") && !src.includes("await ensureSingleton();"));
  const loopAt = src.indexOf("for (;;) {\n    touchHeartbeat();");
  const pollAt = src.indexOf("await pollDiskHold(diskHold, diskVolumes, diskIo)");
  check("wiring: the loop probes the disk before any work of the tick", loopAt > 0 && pollAt > loopAt && pollAt < src.indexOf("if (running.size === 0) state = loadState();"));
  check("wiring: space back → the pending-deploy backoff is cleared", src.includes('if (disk.transition === "resume") deployBackoff = null;'));
  check("wiring: critical → space sweeps (on entry, then hourly) + sleep + continue (no deploy, no picks)", /if \(diskHold\.level === "critical"\) \{\s+if \(disk\.transition \|\| distSweepDue\(lastDistSweep, Date\.now\(\)\)\) \{\s+lastDistSweep = Date\.now\(\);\s+sweepForSpace\(/.test(src) && /await sleep\(diskHoldTickMs\(\)\);\s+continue;/.test(src));
  check("wiring: fillFreeSlots refuses new picks on a non-ok disk", src.includes('if (diskHold.level !== "ok") return; // eval-02 disk hold'));
  check(
    "wiring: nightly and aux agents are gated on an ok disk",
    /async function maybeNightly\([^)]*\) \{[\s\S]{0,260}if \(diskHold\.level !== "ok"\) return;/.test(src) && src.includes('if (running.size === 0 && diskHold.level === "ok") {'),
  );
  check("wiring: no misleading nightly-skip record while the disk holds", src.includes('} else if (!foreignMission && diskHold.level === "ok") {'));
  const crash = src.slice(src.indexOf("const wake = recordPipelineCrash(state);"), src.indexOf('log("error", "pipeline crashed"'));
  check("wiring: the crash path cannot throw (no bare saveState; ENOSPC folds into the hold)", crash.includes('saveStateSafe(state, "pipeline crash")') && crash.includes("noteDiskError(err,") && !/\bsaveState\(state\)/.test(crash));
  check("wiring: deploy settle and the budget hook use the safe save", src.includes('saveStateSafe(state, "deploy settled")') && src.includes('saveStateSafe(state, "deploy attempt")'));
  check("wiring: unhandled ENOSPC rejections fold into the hold, others stay fatal", /process\.on\("unhandledRejection", \(reason\) => \{\s+if \(noteDiskError\(reason, "unhandled rejection"\)\) return;[\s\S]{0,300}process\.exit\(1\);/.test(src));
  check("wiring: a disk-full main() waits for space before one clean exit", /if \(noteDiskError\(err, "main loop"\)\) \{[\s\S]{0,120}waitWhileDiskCritical\(diskHold, diskVolumes, diskIo\)/.test(src));
  check("wiring: artifact retention rides the hourly dist sweep", src.includes("sweepArtifacts(); // eval-02"));
}

rmSync(EVENTS_DIR, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall disk-hold checks passed");
