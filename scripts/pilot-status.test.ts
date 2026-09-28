/**
 * eval-19 — fleet status digest: the pure verdicts in apps/pilot/src/metrics.ts
 * (pilotLiveness, deployHold, costSummary, attentionFlags) and the daemon's
 * readPilotStatus / readTailLines (apps/daemon/src/pilotstatus.ts) against a
 * temp HOME, a real throwaway git repo and injected pid/statfs probes. The
 * fixtures replay the 2026-09-24 outage: pilot dead since 08:07 GMT-3, 58
 * commits undeployed, a disk-guard hold with backoff, 100 undelivered
 * notifications, every merge of the week unpriced.
 * Run: npx tsx scripts/pilot-status.test.ts
 */
import "./testhome"; // FIRST: throwaway HOME before any app module resolves ~/.opencode-remote
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PilotEvent } from "../apps/pilot/src/events";
import {
  DEPLOY_LAG_CRITICAL_MS,
  PILOT_ALIVE_MAX_MS,
  PILOT_DOWN_AFTER_MS,
  PILOT_PID_GRACE_MS,
  attentionFlags,
  costSummary,
  deployHold,
  pilotLiveness,
  type AttentionInput,
} from "../apps/pilot/src/metrics";
import {
  GIT_CACHE_MS,
  readPilotStatus,
  readQueueBacklog,
  readTailLines,
  resetPilotStatusCache,
  type GitRunner,
} from "../apps/daemon/src/pilotstatus";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const NOW = Date.parse("2026-09-27T14:56:53.000Z");
const temps: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
const MIN = 60_000;
const GB = 1024 ** 3;

// ── 1. pilotLiveness ───────────────────────────────────────────────────────
{
  const at = (ageMs: number, pidAlive: boolean | null = null) => pilotLiveness({ heartbeatAtMs: NOW - ageMs, pidAlive, nowMs: NOW });
  check("liveness: no heartbeat is absent (machine never ran the pilot), not down", pilotLiveness({ heartbeatAtMs: null, pidAlive: null, nowMs: NOW }).state === "absent");
  check("liveness: zero/NaN heartbeat is absent", pilotLiveness({ heartbeatAtMs: 0, pidAlive: null, nowMs: NOW }).state === "absent" && pilotLiveness({ heartbeatAtMs: Number.NaN, pidAlive: null, nowMs: NOW }).state === "absent");
  check("liveness: 20s-old heartbeat is alive", at(20_000).state === "alive" && at(20_000).reason === "fresh");
  check("liveness: exactly the alive ceiling is still alive", at(PILOT_ALIVE_MAX_MS).state === "alive");
  // judgeGate runs the eval battery through execFileSync (judge.ts, up to 30
  // min) and BLOCKS the loop: real gates ran 6.0–6.3 min and pilot.log shows
  // 17 watchdog exits with 3.0–5.7 min of silence — a 5 min threshold flashed
  // stale on a healthy pilot
  check("liveness: 6 min of silence (a real judge gate) is alive, not stale", at(6 * MIN).state === "alive");
  check("liveness: 9 min of silence is alive too (gates ran 5.7 min)", at(9 * MIN).state === "alive");
  check("liveness: past 10 min of silence is stale", at(PILOT_ALIVE_MAX_MS + 1).state === "stale");
  check("liveness: past 30 min is down", at(PILOT_DOWN_AFTER_MS + 1).state === "down" && at(PILOT_DOWN_AFTER_MS + 1).reason === "silent");
  const outage = pilotLiveness({ heartbeatAtMs: Date.parse("2026-09-24T11:07:13.162Z"), pidAlive: false, nowMs: NOW });
  check("liveness: the 24/09 outage (75.8h silent, pid gone) is down", outage.state === "down" && outage.heartbeatAgeMs === NOW - Date.parse("2026-09-24T11:07:13.162Z"));
  check("liveness: `since` is the heartbeat instant", outage.since === "2026-09-24T11:07:13.162Z");
  check("liveness: dead pid inside the KeepAlive grace is a restart, not down", at(30_000, false).state === "alive");
  check("liveness: dead pid past the grace is down even with a recent heartbeat", at(PILOT_PID_GRACE_MS + 1, false).state === "down" && at(PILOT_PID_GRACE_MS + 1, false).reason === "pid-dead");
  check("liveness: live pid does not rescue 31 min of silence", at(31 * MIN, true).state === "down");
  check("liveness: live pid + 10+ min silence is stale (wedged loop)", at(PILOT_ALIVE_MAX_MS + 1, true).state === "stale");
  const future = pilotLiveness({ heartbeatAtMs: NOW + 5_000, pidAlive: true, nowMs: NOW });
  check("liveness: a future heartbeat (clock skew) reads as age 0, alive", future.state === "alive" && future.heartbeatAgeMs === 0);
  // 2026-09-27: test runs with the real HOME kept touching pilot/heartbeat
  // while the recorded pilot pid had been dead since 24/09
  const lastAct = Date.parse("2026-09-24T11:07:09.623Z");
  const foreign = pilotLiveness({ heartbeatAtMs: NOW - 10_000, pidAlive: false, nowMs: NOW, pidDeadForMs: 120_000, lastActivityAtMs: lastAct });
  check("liveness: a fresh heartbeat does not outvote a pid seen dead for 2 min", foreign.state === "down" && foreign.reason === "pid-dead", JSON.stringify(foreign));
  check("liveness: …the outage is dated from the last recorded activity, not the foreign touch", foreign.since === "2026-09-24T11:07:09.623Z" && foreign.silentForMs === NOW - lastAct);
  const respawn = pilotLiveness({ heartbeatAtMs: NOW - 10_000, pidAlive: false, nowMs: NOW, pidDeadForMs: 20_000, lastActivityAtMs: lastAct });
  check("liveness: a pid dead for 20s with a fresh heartbeat is a KeepAlive respawn → alive", respawn.state === "alive" && respawn.silentForMs === 0);
  check("liveness: silent verdicts count silence from the heartbeat", at(PILOT_DOWN_AFTER_MS + 1).silentForMs === PILOT_DOWN_AFTER_MS + 1 && at(PILOT_ALIVE_MAX_MS + 1).silentForMs === PILOT_ALIVE_MAX_MS + 1);
}

// ── 2. deployHold ──────────────────────────────────────────────────────────
const ev = (ts: string, type: PilotEvent["type"], fields: Partial<PilotEvent> = {}): PilotEvent => ({ ts, type, ...fields });
// the real tail of 2026-09-24 07:40 GMT-3 (pilot/events.jsonl), abridged
const outageFeed: PilotEvent[] = [
  ev("2026-09-23T17:40:00.000Z", "deploy", { phase: "start", detail: "sha 1ebbbc1" }),
  ev("2026-09-23T17:40:03.000Z", "deploy", { phase: "install", ok: true, detail: "fast-install (lock unchanged) in 2s" }),
  ev("2026-09-23T17:44:00.000Z", "deploy", { phase: "done", ok: true, detail: "sha 1ebbbc1 live" }),
  ev("2026-09-23T18:56:00.000Z", "deploy", { phase: "start", detail: "sha 7718fe3" }),
  ev("2026-09-23T18:56:00.001Z", "deploy", { phase: "disk-guard", ok: false, detail: "disk low: 4.9gb free (need 5.0gb) — deploy aborted before npm ci/build" }),
  ev("2026-09-24T10:40:19.221Z", "agent", { task: "P2-356", detail: "narration" }),
  ev("2026-09-24T10:40:25.756Z", "deploy", { phase: "start", detail: "sha a491841" }),
  ev("2026-09-24T10:40:25.757Z", "deploy", { phase: "disk-guard", ok: false, detail: "disk low: 2.1gb free (need 5.0gb) — deploy aborted before npm ci/build" }),
  ev("2026-09-24T10:40:38.631Z", "deploy", { phase: "start", detail: "sha a491841" }),
  ev("2026-09-24T10:40:38.632Z", "deploy", { phase: "disk-guard", ok: false, detail: "disk low: 2.1gb free (need 5.0gb) — deploy aborted before npm ci/build" }),
  ev("2026-09-24T10:40:39.215Z", "deploy", { phase: "backoff", ok: false, detail: "5x disk-guard in a row — pending deploy paused 30min" }),
  ev("2026-09-24T11:07:09.623Z", "agent", { task: "P2-356", detail: "reviewing" }),
];
{
  const hold = deployHold(outageFeed);
  check("hold: the disk-guard refusal behind the backoff is the hold", hold?.reason === "disk-guard", JSON.stringify(hold));
  check("hold: carries the newest refusal's detail and instant", hold?.detail.startsWith("disk low: 2.1gb") === true && hold?.at === "2026-09-24T10:40:38.632Z");
  check("hold: counts every refusal since the last deploy that got through (3)", hold?.count === 3, JSON.stringify(hold));
  check("hold: backoff expiry = backoff instant + 30 min", hold?.until === "2026-09-24T11:10:39.215Z", String(hold?.until));
  const cleared = [...outageFeed, ev("2026-09-24T12:00:00.000Z", "deploy", { phase: "start", detail: "sha a491841" }), ev("2026-09-24T12:00:05.000Z", "deploy", { phase: "install", ok: true }), ev("2026-09-24T12:03:00.000Z", "deploy", { phase: "done", ok: true, detail: "sha a491841 live" })];
  check("hold: a deploy that got past the guards clears it", deployHold(cleared) === null);
  const inFlight = [...outageFeed.slice(0, 3), ev("2026-09-24T12:00:00.000Z", "deploy", { phase: "start", detail: "sha a491841" })];
  check("hold: a lone trailing `start` (attempt in flight) is not a hold", deployHold(inFlight) === null);
  const rolled = [...outageFeed.slice(0, 5), ev("2026-09-23T19:00:00.000Z", "deploy", { phase: "install", ok: true }), ev("2026-09-23T19:05:00.000Z", "deploy", { phase: "rollback", ok: false, detail: "health failed" })];
  check("hold: a rollback is a failed deploy, not a hold (the rollback chip owns it)", deployHold(rolled) === null);
  const sha = [...outageFeed.slice(0, 3), ev("2026-09-23T18:00:00.000Z", "deploy", { phase: "sha-guard", ok: false, detail: "sha 9999999 not verified" })];
  check("hold: an unverified-sha refusal is a sha-guard hold without backoff", deployHold(sha)?.reason === "sha-guard" && deployHold(sha)?.until === null);
  check("hold: an empty feed has no hold", deployHold([]) === null);
  check("hold: a feed without deploy events has no hold", deployHold([ev("2026-09-24T10:00:00.000Z", "phase", { task: "P2-1", phase: "builder" })]) === null);
}

// ── 3. costSummary ─────────────────────────────────────────────────────────
{
  const merges = [
    { task: "P2-354", at: "2026-09-24T02:01:00-03:00" },
    { task: "P2-355", at: "2026-09-24T03:32:38-03:00" },
    { task: "P2-355", at: "2026-09-24T03:40:00-03:00" }, // same task merged twice counts once
    { task: "P2-001", at: "2026-09-01T00:00:00-03:00" }, // outside the week
    { task: 42 as unknown as string, at: "2026-09-24T00:00:00Z" }, // malformed row skipped
  ];
  const state = {
    taskCosts: { "P2-354": 8_929_377, "P2-355": 23_344_253, "P2-001": 1 },
    taskUSD: {
      "P2-354": { total: 0, tierA: 0, tierB: 0, unpricedTokens: 8_929_377, tokens: 8_929_377 },
      "P2-355": { total: 0, tierA: 0, tierB: 0, unpricedTokens: 23_344_253, tokens: 23_344_253 },
    },
  };
  const week = costSummary(merges, state, NOW, 7 * 86_400_000);
  check("cost: the week counts 2 distinct merged tasks", week.merges === 2, JSON.stringify(week));
  check("cost: tokens summed per task once", week.tokens === 8_929_377 + 23_344_253);
  check("cost: all-unpriced week reports usd null, never a fake $0", week.usd === null && week.unpricedTokens === week.tokens);
  const day = costSummary(merges, state, NOW, 86_400_000);
  check("cost: nothing merged in the last 24h (pilot down) → zeros", day.merges === 0 && day.tokens === 0 && day.usd === null);
  const priced = costSummary(merges, { taskUSD: { "P2-354": { total: 1.25, unpricedTokens: 0, tokens: 100 }, "P2-355": { total: 0.5, unpricedTokens: 10, tokens: 20 } } }, NOW, 7 * 86_400_000);
  check("cost: priced totals add up", priced.usd === 1.75 && priced.tokens === 120 && priced.unpricedTokens === 10);
  const legacy = costSummary(merges, { taskCosts: { "P2-354": 5, "P2-355": 7 } }, NOW, 7 * 86_400_000);
  check("cost: tasks without a taskUSD row fall back to taskCosts tokens", legacy.tokens === 12 && legacy.usd === null);
  check("cost: a merge stamped in the future is ignored", costSummary([{ task: "X", at: "2026-10-01T00:00:00Z" }], {}, NOW, 7 * 86_400_000).merges === 0);
}

// ── 4. attentionFlags ──────────────────────────────────────────────────────
{
  const base: AttentionInput = {
    installed: true,
    pilot: { state: "alive" },
    deploy: { behind: 0, pendingSinceMs: null, hold: null },
    disk: { freeBytes: 80 * GB, minFreeBytes: 5 * GB },
    alerts: { undelivered: 0 },
    nowMs: NOW,
  };
  check("attention: healthy fleet → nothing", attentionFlags(base).length === 0);
  check("attention: machine without the pilot → nothing, whatever the facts", attentionFlags({ ...base, installed: false, pilot: { state: "down" }, alerts: { undelivered: 9 } }).length === 0);
  const outage = attentionFlags({
    ...base,
    pilot: { state: "down" },
    deploy: { behind: 58, pendingSinceMs: Date.parse("2026-09-23T17:37:36Z"), hold: deployHold(outageFeed) },
    alerts: { undelivered: 100 },
  });
  check(
    "attention: the outage reads pilot-down + deploy-lag (critical), then deploy-hold (disk back) + alerts (warn)",
    JSON.stringify(outage) ===
      JSON.stringify([
        { kind: "pilot-down", level: "critical" },
        { kind: "deploy-lag", level: "critical" },
        { kind: "deploy-hold", level: "warn" },
        { kind: "alerts-undelivered", level: "warn" },
      ]),
    JSON.stringify(outage),
  );
  const diskStillLow = attentionFlags({ ...base, deploy: { behind: 1, pendingSinceMs: NOW - 10 * MIN, hold: deployHold(outageFeed) }, disk: { freeBytes: 2 * GB, minFreeBytes: 5 * GB } });
  check("attention: disk-guard hold with the disk still low is critical, next to disk-low", diskStillLow.some((f) => f.kind === "deploy-hold" && f.level === "critical") && diskStillLow.some((f) => f.kind === "disk-low" && f.level === "critical"));
  check("attention: a fresh pending deploy (10 min) is not lag", !diskStillLow.some((f) => f.kind === "deploy-lag"));
  check("attention: 3h pending is a lag warning", attentionFlags({ ...base, deploy: { behind: 3, pendingSinceMs: NOW - 3 * 3_600_000, hold: null } }).some((f) => f.kind === "deploy-lag" && f.level === "warn"));
  check("attention: past 24h pending is a critical lag", attentionFlags({ ...base, deploy: { behind: 3, pendingSinceMs: NOW - DEPLOY_LAG_CRITICAL_MS - 1, hold: null } }).some((f) => f.kind === "deploy-lag" && f.level === "critical"));
  check("attention: disk under 2× the floor warns", attentionFlags({ ...base, disk: { freeBytes: 8 * GB, minFreeBytes: 5 * GB } }).some((f) => f.kind === "disk-low" && f.level === "warn"));
  check("attention: unknown disk reading raises nothing", !attentionFlags({ ...base, disk: { freeBytes: null, minFreeBytes: 5 * GB } }).some((f) => f.kind === "disk-low"));
  check("attention: stale pilot is a warning", JSON.stringify(attentionFlags({ ...base, pilot: { state: "stale" } })) === JSON.stringify([{ kind: "pilot-stale", level: "warn" }]));
  const dirty = attentionFlags({ ...base, deploy: { behind: 1, pendingSinceMs: NOW, hold: { reason: "dirty-guard", detail: "x", at: "", until: null, count: 1 } } });
  check("attention: dirty-guard hold always needs the operator", dirty.some((f) => f.kind === "deploy-hold" && f.level === "critical"));
}

// ── 5. readTailLines ───────────────────────────────────────────────────────
{
  const dir = tempDir("pilot-status-tail-");
  const file = join(dir, "pilot.log");
  const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ ts: `t${i}`, msg: i % 7 === 0 ? "strategist refill" : "agent" }));
  writeFileSync(file, lines.join("\n") + "\n");
  const tail = readTailLines(file, 400);
  check("tail: last 400 lines, in order", tail.length === 400 && tail[0] === lines[600] && tail[399] === lines[999]);
  const small = readTailLines(file, 400, 2_000);
  check("tail: a byte window that cuts a line drops the partial one", small.length > 0 && small.every((l) => lines.includes(l)), small[0]);
  check("tail: missing file → []", readTailLines(join(dir, "nope.log"), 10).length === 0);
  writeFileSync(join(dir, "empty.log"), "");
  check("tail: empty file → []", readTailLines(join(dir, "empty.log"), 10).length === 0);
}

// ── 6. readPilotStatus against a temp HOME + a real git repo ───────────────
function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}
const queueMd = (ready: string[], blocked: string[]) =>
  ["# Backlog", "", "## Ready", ...ready.map((id) => `- [ ] (${id}) [P2] task ${id} — spec: x`), "", "## Blocked", ...blocked.map((id) => `- [ ] (${id}) [P2] task ${id} — spec: x`), "", "## Done", ""].join("\n");
{
  resetPilotStatusCache();
  const repo = tempDir("pilot-status-repo-");
  sh(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "BACKLOG.md"), queueMd(["P2-345"], ["P2-109", "P2-110"]));
  sh(repo, "add", "BACKLOG.md");
  execFileSync("git", ["commit", "-q", "-m", "prod"], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: "2026-09-23T14:37:18-03:00", GIT_AUTHOR_DATE: "2026-09-23T14:37:18-03:00" } });
  const prod = sh(repo, "rev-parse", "HEAD");
  const commitAt = (date: string, msg: string) =>
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  // the shape of a real healthy interval: a verified merge, then bookkeeping
  // that never deploys alone, then another verified merge (carrying the queue)
  commitAt("2026-09-23T14:37:36-03:00", "pilot(P2-900): feature (#2)");
  const verified1 = sh(repo, "rev-parse", "HEAD");
  commitAt("2026-09-23T20:00:00-03:00", "pilot(P2-900): mark done (#3)");
  writeFileSync(join(repo, "BACKLOG.md"), queueMd(["P2-356", "P2-357"], ["P2-109", "P2-110", "P2-099"]));
  sh(repo, "add", "BACKLOG.md");
  commitAt("2026-09-24T04:12:05-03:00", "pilot(P2-901): feature (#4)");
  const main = sh(repo, "rev-parse", "HEAD");
  sh(repo, "update-ref", "refs/remotes/origin/main", main);
  sh(repo, "reset", "-q", "--hard", prod); // production sits behind 2 verified merges + 1 bookkeeping commit
  writeFileSync(join(repo, ".git", "FETCH_HEAD"), "");

  const home = tempDir("pilot-status-home-");
  const pdir = join(home, ".opencode-remote", "pilot");
  mkdirSync(pdir, { recursive: true });
  writeFileSync(join(home, ".opencode-remote", "pilot.json"), JSON.stringify({ slots: 8 }));
  writeFileSync(join(pdir, "heartbeat"), String(Date.parse("2026-09-24T11:07:13.162Z")));
  writeFileSync(join(pdir, "pilot.pid"), "35139");
  writeFileSync(join(pdir, "events.jsonl"), outageFeed.map((e) => JSON.stringify(e)).join("\n") + "\n{torn");
  writeFileSync(
    join(pdir, "state.json"),
    JSON.stringify({ taskUSD: { "P2-355": { total: 0, tierA: 0, tierB: 0, unpricedTokens: 23_344_253, tokens: 23_344_253 } } }),
  );
  writeFileSync(
    join(pdir, "verified-merges.jsonl"),
    [
      JSON.stringify({ sha: verified1, task: "P2-900", at: "2026-09-23T14:37:36-03:00" }),
      JSON.stringify({ sha: main, task: "P2-901", at: "2026-09-24T04:12:05-03:00" }),
      JSON.stringify({ sha: "2d96574", task: "P2-355", at: "2026-09-24T03:32:38-03:00" }), // not on this repo's history: cost only
    ].join("\n") + "\n",
  );
  writeFileSync(join(pdir, "notify-pending.jsonl"), Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: i })).join("\n") + "\n");
  writeFileSync(join(pdir, "notify-last"), String(Date.parse("2026-09-12T03:02:00.000Z")));

  let gitCalls = 0;
  const git: GitRunner = (args, cwd) => {
    gitCalls++;
    // the digest may only READ: any mutating subcommand fails the suite
    if (!["rev-parse", "rev-list", "log", "show"].includes(args[0]!)) throw new Error(`mutating git call: ${args.join(" ")}`);
    try {
      return Promise.resolve(execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
    } catch {
      return Promise.resolve(null);
    }
  };
  const pidProbes: number[] = [];
  const deps = {
    home,
    repo,
    nowMs: NOW,
    git,
    pidAlive: (pid: number) => {
      pidProbes.push(pid);
      return false;
    },
    statfs: () => ({ freeBytes: 81 * GB, totalBytes: 228 * GB }),
  };
  const s = await readPilotStatus(deps);
  check("digest: installed (pilot.json + heartbeat present)", s.installed === true);
  check("digest: pilot down since the last heartbeat, pid probed and gone", s.pilot.state === "down" && s.pilot.since === "2026-09-24T11:07:13.162Z" && s.pilot.pid === 35139 && s.pilot.pidAlive === false && pidProbes[0] === 35139);
  check("digest: last event instant survives a torn trailing line", s.pilot.lastEventAt === "2026-09-24T11:07:09.623Z", String(s.pilot.lastEventAt));
  check("digest: prod vs origin/main from real git", s.deploy.prodSha === prod && s.deploy.mainSha === main, JSON.stringify(s.deploy));
  check("digest: lag counts VERIFIED merges pending, not raw commits", s.deploy.behind === 2 && s.deploy.behindTotal === 3, JSON.stringify(s.deploy));
  check("digest: pendingSince = committer date of the oldest pending VERIFIED merge", s.deploy.pendingSince === "2026-09-23T17:37:36.000Z", String(s.deploy.pendingSince));
  check("digest: fetch freshness from FETCH_HEAD mtime", typeof s.deploy.fetchedAt === "string");
  check("digest: disk-guard hold from the feed", s.deploy.hold?.reason === "disk-guard" && s.deploy.hold.count === 3);
  check("digest: disk reading + the deploy guard floor (5 GB)", s.disk.freeBytes === 81 * GB && s.disk.minFreeBytes === 5 * GB);
  check("digest: queue comes from origin/main, not the stale checkout", s.queue.source === "origin/main" && s.queue.ready === 2 && s.queue.blocked === 3, JSON.stringify(s.queue));
  check("digest: week cost = the recorded merges (one real + the walk-external one), unpriced", s.cost.week.merges === 3 && s.cost.week.usd === null && s.cost.week.unpricedTokens === 23_344_253);
  check("digest: 100 undelivered notifications, last delivery 15+ days ago", s.alerts.undelivered === 100 && (s.alerts.lastDeliveredAgeMs ?? 0) > 15 * 86_400_000);
  check(
    "digest: attention = pilot-down, deploy-lag (critical), deploy-hold (disk back → warn), alerts",
    s.attention.map((f) => `${f.kind}:${f.level}`).join(",") === "pilot-down:critical,deploy-lag:critical,deploy-hold:warn,alerts-undelivered:warn",
    JSON.stringify(s.attention),
  );
  check("digest: never leaks paths — no HOME or repo path in the payload", !JSON.stringify(s).includes(home) && !JSON.stringify(s).includes(repo));

  const callsAfterFirst = gitCalls;
  await readPilotStatus(deps);
  check("digest: git answers are cached inside GIT_CACHE_MS", gitCalls === callsAfterFirst);
  await readPilotStatus({ ...deps, nowMs: NOW + GIT_CACHE_MS + 1 });
  check("digest: the cache expires after GIT_CACHE_MS", gitCalls > callsAfterFirst);

  // a quarantined merge is never the deploy target — the walk skips it
  writeFileSync(join(pdir, "quarantine.jsonl"), JSON.stringify({ sha: main, task: "P2-901", at: "2026-09-24T04:12:05-03:00", why: "live invariants failed" }) + "\n");
  const qd = await readPilotStatus({ ...deps, nowMs: NOW });
  check("digest: a quarantined newest merge is skipped (the older verified one is the target)", qd.deploy.behind === 1 && qd.deploy.behindTotal === 3 && qd.deploy.pendingSince === "2026-09-23T17:37:36.000Z", JSON.stringify(qd.deploy));
  rmSync(join(pdir, "quarantine.jsonl"), { force: true });

  resetPilotStatusCache();
  const md = await readQueueBacklog({ repo, git, nowMs: NOW });
  check("queue backlog: origin/main copy (P2-356/P2-357), not the checkout's P2-345", !!md && md.includes("(P2-356)") && !md.includes("(P2-345)"));
  resetPilotStatusCache();
  const noRemote = await readQueueBacklog({ repo, git: async () => null, nowMs: NOW });
  check("queue backlog: without git answers it falls back to the checkout file", !!noRemote && noRemote.includes("(P2-345)"));

  // ── THE false-alarm repro (verify-19 replay-lag): a HEALTHY, idle fleet —
  // prod runs the newest gate-verified merge and main carries only bookkeeping
  // commits after it ("mark done", scribe lessons) that never deploy alone.
  // The old rule counted them and raised deploy-lag critical (26 h old).
  {
    resetPilotStatusCache();
    const healthyRepo = tempDir("pilot-status-healthy-repo-");
    sh(healthyRepo, "init", "-q", "-b", "main");
    writeFileSync(join(healthyRepo, "BACKLOG.md"), "# Backlog\n\n## Ready\n\n## Blocked\n\n## Done\n");
    sh(healthyRepo, "add", "BACKLOG.md");
    const envAt = (at: number) => ({ ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: new Date(at).toISOString(), GIT_COMMITTER_DATE: new Date(at).toISOString() });
    const commitAtEpoch = (at: number, msg: string) => execFileSync("git", ["commit", "-q", "--allow-empty", "-m", msg], { cwd: healthyRepo, env: envAt(at) });
    commitAtEpoch(NOW - 26 * 3_600_000, "pilot(P2-900): feature (#1)");
    const deployed = sh(healthyRepo, "rev-parse", "HEAD");
    commitAtEpoch(NOW - 26 * 3_600_000 + 16_000, "pilot(P2-900): mark done (#2)");
    commitAtEpoch(NOW - 26 * 3_600_000 + 60_000, "pilot(scribe): 3 lesson(s) from P2-900 (#3)");
    const healthyMain = sh(healthyRepo, "rev-parse", "HEAD");
    sh(healthyRepo, "update-ref", "refs/remotes/origin/main", healthyMain);
    sh(healthyRepo, "reset", "-q", "--hard", deployed); // prod = the verified merge = the deploy target
    const healthyHome = tempDir("pilot-status-healthy-home-");
    const hpdir = join(healthyHome, ".opencode-remote", "pilot");
    mkdirSync(hpdir, { recursive: true });
    writeFileSync(join(healthyHome, ".opencode-remote", "pilot.json"), "{}");
    writeFileSync(join(hpdir, "heartbeat"), String(NOW - 5_000));
    writeFileSync(join(hpdir, "pilot.pid"), String(process.pid)); // alive
    writeFileSync(join(hpdir, "verified-merges.jsonl"), JSON.stringify({ sha: deployed, task: "P2-900", at: new Date(NOW - 26 * 3_600_000).toISOString() }) + "\n");
    writeFileSync(join(hpdir, "events.jsonl"), JSON.stringify({ ts: new Date(NOW - 26 * 3_600_000 + 120_000).toISOString(), type: "deploy", phase: "done", ok: true, detail: `sha ${deployed.slice(0, 7)} live` }) + "\n");
    const hs = await readPilotStatus({ home: healthyHome, repo: healthyRepo, nowMs: NOW, statfs: () => ({ freeBytes: 80 * GB, totalBytes: 245 * GB }) });
    check("healthy idle fleet: NO deploy lag — bookkeeping after a verified merge never deploys alone", hs.deploy.behind === 0 && hs.deploy.pendingSince === null, JSON.stringify(hs.deploy));
    check("healthy idle fleet: the raw commits stay informational (2 on main)", hs.deploy.behindTotal === 2, JSON.stringify(hs.deploy));
    check("healthy idle fleet: no deploy-lag flag and the pilot is alive", hs.pilot.state === "alive" && !hs.attention.some((f) => f.kind === "deploy-lag"), JSON.stringify(hs.attention));
  }

  // prod not on origin/main's first-parent history (cap hit or diverged) →
  // the lag is UNKNOWN, never a wrong number
  {
    resetPilotStatusCache();
    const oddRepo = tempDir("pilot-status-odd-repo-");
    sh(oddRepo, "init", "-q", "-b", "main");
    writeFileSync(join(oddRepo, "BACKLOG.md"), "# Backlog\n\n## Ready\n\n## Blocked\n\n## Done\n");
    sh(oddRepo, "add", "BACKLOG.md");
    sh(oddRepo, "commit", "-q", "-m", "on main");
    sh(oddRepo, "update-ref", "refs/remotes/origin/main", sh(oddRepo, "rev-parse", "HEAD"));
    sh(oddRepo, "checkout", "-q", "--orphan", "prodline");
    writeFileSync(join(oddRepo, "OTHER.md"), "diverged production line\n");
    sh(oddRepo, "add", "OTHER.md");
    sh(oddRepo, "commit", "-q", "-m", "prod elsewhere");
    const odd = await readPilotStatus({ home, repo: oddRepo, nowMs: NOW, statfs: () => null });
    check("digest: prod off origin/main's first-parent history → lag unknown (null), no lag flag", odd.deploy.behind === null && odd.deploy.behindTotal === null && odd.deploy.pendingSince === null && !odd.attention.some((f) => f.kind === "deploy-lag"), JSON.stringify(odd.deploy));
  }

  // a foreign process keeps the heartbeat fresh while the recorded pid is dead
  resetPilotStatusCache();
  const touch = (at: number) => writeFileSync(join(pdir, "heartbeat"), String(at));
  touch(NOW - 5_000);
  const first = await readPilotStatus({ ...deps, nowMs: NOW });
  check("digest: pid just seen dead + fresh heartbeat → still alive (respawn grace)", first.pilot.state === "alive", JSON.stringify(first.pilot));
  touch(NOW + 95_000);
  const second = await readPilotStatus({ ...deps, nowMs: NOW + 100_000 });
  check("digest: the same pid dead 100s later → down despite the fresh heartbeat", second.pilot.state === "down" && second.pilot.reason === "pid-dead", JSON.stringify(second.pilot));
  check("digest: …dated from the last events.jsonl activity (pilot.log absent → events fallback)", second.pilot.since === "2026-09-24T11:07:09.623Z" && second.attention[0]?.kind === "pilot-down");
  touch(Date.parse("2026-09-24T11:07:13.162Z"));

  // the pilot's own log anchors the outage: events.jsonl can be appended by
  // third parties (in-chat agents, test runs) — pilot.log is the pilot's file
  resetPilotStatusCache();
  mkdirSync(join(home, ".opencode-remote", "logs"), { recursive: true });
  const logFile = join(home, ".opencode-remote", "logs", "pilot.log");
  writeFileSync(logFile, "pilot wrote this\n");
  utimesSync(logFile, Date.parse("2026-09-24T10:00:00.000Z") / 1000, Date.parse("2026-09-24T10:00:00.000Z") / 1000);
  touch(NOW - 5_000);
  const anchored = await readPilotStatus({ ...deps, nowMs: NOW + 300_000 });
  check("digest: a pid-dead outage is dated from pilot.log's mtime, not a newer events ts", anchored.pilot.since === "2026-09-24T10:00:00.000Z" && anchored.pilot.reason === "pid-dead", JSON.stringify(anchored.pilot));
  utimesSync(logFile, Date.now() / 1000, Date.now() / 1000);

  // ── pid identity (kill(pid,0) says "some process", never "the pilot") ──────
  // B5: the pid space wraps every ~23 min on this host; a dead pilot's pid is
  // reassigned within hours, and a squatter plus a third-party heartbeat write
  // resurrected the verdict on 2026-09-27 (replay case B). The recorded
  // process must have started BEFORE the pid file it wrote (ensureSingleton
  // writes it at boot); a process born after is a reuse → not the pilot.
  {
    resetPilotStatusCache();
    const home2 = tempDir("pilot-status-pid-");
    const pdir2 = join(home2, ".opencode-remote", "pilot");
    mkdirSync(pdir2, { recursive: true });
    writeFileSync(join(home2, ".opencode-remote", "pilot.json"), "{}");
    const pidFile2 = join(pdir2, "pilot.pid");
    const pidReused = 999123; // any pid a squatter holds
    writeFileSync(pidFile2, String(pidReused));
    // the pid file was written when the REAL pilot booted — long before the
    // squatter took the pid over (mtime 30 min in the fixture's past)
    utimesSync(pidFile2, (NOW - 30 * MIN) / 1000, (NOW - 30 * MIN) / 1000);
    writeFileSync(join(pdir2, "heartbeat"), String(NOW - 5_000)); // third-party fresh touch
    writeFileSync(join(pdir2, "events.jsonl"), JSON.stringify({ ts: new Date(NOW - 3 * 86_400_000).toISOString(), type: "agent", task: "P2-1", detail: "x" }) + "\n");
    const identityDeps = {
      home: home2,
      repo: null,
      nowMs: NOW,
      pidAlive: () => true, // kill(pid,0) succeeded / EPERM: SOME process holds it
      pidIdentity: async () => NOW + 5_000, // …but it started AFTER the pid file → reuse
      statfs: () => null,
    };
    const reuse1 = await readPilotStatus(identityDeps);
    check("identity: a live pid that started after the pid file is a reuse — grace keeps it a respawn", reuse1.pilot.state === "alive", JSON.stringify(reuse1.pilot));
    const reuse2 = await readPilotStatus({ ...identityDeps, nowMs: NOW + 100_000 });
    check("identity: past the grace the reused pid is down despite the fresh heartbeat", reuse2.pilot.state === "down" && reuse2.pilot.reason === "pid-dead", JSON.stringify(reuse2.pilot));
    check("identity: …dated from the last recorded activity (3d ago), not the foreign touch", reuse2.pilot.since === new Date(NOW - 3 * 86_400_000).toISOString(), String(reuse2.pilot.since));
    // a fresh pid file generation (new pid): the process that wrote it owns it
    writeFileSync(pidFile2, "999124");
    utimesSync(pidFile2, (NOW - 30 * MIN) / 1000, (NOW - 30 * MIN) / 1000);
    const owner = await readPilotStatus({ ...identityDeps, nowMs: NOW + 100_000, pidIdentity: async () => NOW - 3_600_000 });
    check("identity: a process that started BEFORE the pid file it wrote is the pilot → alive", owner.pilot.state === "alive", JSON.stringify(owner.pilot));
    writeFileSync(pidFile2, "999125");
    utimesSync(pidFile2, (NOW - 30 * MIN) / 1000, (NOW - 30 * MIN) / 1000);
    const unknown = await readPilotStatus({ ...identityDeps, nowMs: NOW + 100_000, pidIdentity: async () => null });
    check("identity: an unknown identity never flips the verdict by itself (fail-open)", unknown.pilot.state === "alive", JSON.stringify(unknown.pilot));
  }
  // the real ps probe: a process that wrote its own pid file stays alive; the
  // same file predating the process start is a reuse (windows has no `ps`)
  if (process.platform !== "win32") {
    resetPilotStatusCache();
    const proc = spawn("sleep", ["60"], { stdio: "ignore" });
    try {
      const home3 = tempDir("pilot-status-pid-real-");
      const pdir3 = join(home3, ".opencode-remote", "pilot");
      mkdirSync(pdir3, { recursive: true });
      writeFileSync(join(home3, ".opencode-remote", "pilot.json"), "{}");
      const pidFile3 = join(pdir3, "pilot.pid");
      writeFileSync(pidFile3, String(proc.pid!));
      utimesSync(pidFile3, (NOW - 30 * MIN) / 1000, (NOW - 30 * MIN) / 1000); // written "long ago"
      writeFileSync(join(pdir3, "heartbeat"), String(NOW - 5_000));
      writeFileSync(join(pdir3, "events.jsonl"), "");
      const realDeps = { home: home3, repo: null, nowMs: NOW, pidAlive: () => true, statfs: () => null };
      const real1 = await readPilotStatus(realDeps);
      check("identity(real ps): the squatter's start postdates the pid file → reuse, grace holds", real1.pilot.state === "alive", JSON.stringify(real1.pilot));
      const real2 = await readPilotStatus({ ...realDeps, nowMs: NOW + 100_000 });
      check("identity(real ps): past the grace the reused pid is down", real2.pilot.state === "down" && real2.pilot.reason === "pid-dead", JSON.stringify(real2.pilot));
      resetPilotStatusCache();
      writeFileSync(pidFile3, String(proc.pid!)); // the real boot order: file written AFTER the process started
      const real3 = await readPilotStatus({ ...realDeps, nowMs: NOW + 200_000 });
      check("identity(real ps): the process that wrote its own pid file stays alive", real3.pilot.state === "alive", JSON.stringify(real3.pilot));
    } finally {
      proc.kill("SIGKILL");
    }
  }

  // a machine that never ran the pilot
  resetPilotStatusCache();
  const bare = tempDir("pilot-status-bare-");
  const none = await readPilotStatus({ home: bare, repo: null, nowMs: NOW, statfs: () => null });
  check("digest: no pilot → installed false, pilot absent, no attention", none.installed === false && none.pilot.state === "absent" && none.attention.length === 0);
  check("digest: no repo → deploy facts unknown (null), queue source none", none.deploy.behind === null && none.deploy.prodSha === null && none.queue.source === "none");

  // the watchdog seam (eval-01): an injected verdict replaces the heartbeat read
  const seam = await readPilotStatus({ ...deps, liveness: () => ({ state: "alive", heartbeatAgeMs: 1_000, since: null, silentForMs: 0, reason: "fresh" }) });
  check("digest: the liveness seam overrides the heartbeat verdict", seam.pilot.state === "alive" && !seam.attention.some((f) => f.kind === "pilot-down"));
}

// ── 7. wiring (source checks) ──────────────────────────────────────────────
{
  const daemon = readFileSync(new URL("../apps/daemon/src/index.ts", import.meta.url), "utf8");
  check("wiring: GET /api/pilot-status serves readPilotStatus", /seg\[1\] === "pilot-status"[\s\S]{0,120}readPilotStatus\(\)/.test(daemon));
  check("wiring: sealed /__ocr/pilot-status for the phone", /req\.path === "\/__ocr\/pilot-status" && req\.method === "GET"[\s\S]{0,120}readPilotStatus\(\)/.test(daemon));
  check("wiring: /api/pilot-ready reads origin/main's queue first", /seg\[1\] === "pilot-ready"[\s\S]{0,400}readQueueBacklog\(\)/.test(daemon));
  const eventsRoute = daemon.slice(daemon.indexOf('seg[1] === "pilot-events"'), daemon.indexOf('seg[1] === "pilot-history"'));
  check("wiring: /api/pilot-events no longer reads the whole pilot.log per poll", eventsRoute.includes("readTailLines(") && !/readFileSync\(join\(homedir\(\), "\.opencode-remote", "logs", "pilot\.log"\)/.test(eventsRoute));
  check("wiring: /api/pilot-events honors ?since=&limit=", eventsRoute.includes('url.searchParams.get("since")') && eventsRoute.includes('url.searchParams.get("limit")'));
  const desktop = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  const allow = /\?\s*(\/\^\\\/api\\\/pilot-\([^\n]*?\)\$\/)\.test\(u\.pathname\)/.exec(desktop)?.[1];
  const re = allow ? (new Function(`return ${allow}`)() as RegExp) : null;
  check("wiring: desktop daemonApi allowlist admits GET /api/pilot-status", !!re && re.test("/api/pilot-status"), String(allow));
  check("wiring: …and still refuses the unlisted pilot routes", !!re && !re.test("/api/pilot-events") && !re.test("/api/pilot-budget") && !re.test("/api/pilot-status/x"));
}

// ── 8. the new suites run in the gate (an orphan test file never runs) ─────
{
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  const chain = pkg.scripts["test:unit"] ?? "";
  check("chain: test:unit runs pilot-status, dashboard-status, mission-fleet and pilot-stream", ["pilot-status", "dashboard-status", "mission-fleet", "pilot-stream"].every((f) => chain.includes(`tsx scripts/${f}.test.ts`)));
}

for (const d of temps) rmSync(d, { recursive: true, force: true });
if (failures) process.exit(1);
console.log("pilot-status: all checks passed");
