import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "./runner";
import { emit } from "./events";
import { log, nowLocalISO } from "./log";
import { captureUiShot } from "./shot";
import { touchHeartbeat, type PilotConfig } from "./state";
import { notifySupervisor } from "./notify";
import { DISK_MIN_FREE_BYTES, diskGuardDetail, freeDiskBytes } from "./disk";

export interface DeployResult {
  ok: boolean;
  rolledBack: boolean;
  detail: string;
}

/**
 * P3-006: injectable disk-guard dependencies — tests mock the free-space probe,
 * the threshold, the event stream and the supervisor notify to pin the
 * abort-before-npm-ci path without touching the production event log.
 */
export interface DeployOpts {
  minFreeBytes?: number;
  probeFreeBytes?: (path: string) => Promise<number | null>;
  notify?: typeof notifySupervisor;
  emitEvent?: typeof emit;
}

/**
 * Staged deploy of a merged SHA into the production checkout:
 * reset prod repo to SHA → install → build → restart services → health watch.
 * Any failure rolls back to the previous SHA automatically.
 * `meta.ui` (P2-011): after a clean deploy of a UI-touching task, capture a
 * screenshot of the deployed dashboard into the review log (pilot/shots).
 * P3-006: aborts with a clear detail (and a supervisor notify) before touching
 * anything when free disk space is below the 5GB ceiling.
 */
export async function deploy(
  cfg: PilotConfig,
  sha: string,
  meta?: { task?: string; ui?: boolean },
  opts?: DeployOpts,
): Promise<DeployResult> {
  const emitEvent = opts?.emitEvent ?? emit;
  emitEvent("deploy", { phase: "start", detail: `sha ${sha.slice(0, 7)}` });
  // P3-006 disk guard: must run before ANY mutation (git/npm) — a full disk
  // used to surface later as a cryptic git index.lock failure. Unavailable
  // probe = proceed (fail-open).
  const probe = opts?.probeFreeBytes ?? freeDiskBytes;
  const guard = diskGuardDetail(await probe(cfg.repo), opts?.minFreeBytes ?? DISK_MIN_FREE_BYTES);
  if (guard) {
    log("warn", guard);
    emitEvent("deploy", { phase: "disk-guard", ok: false, detail: guard });
    await (opts?.notify ?? notifySupervisor)(meta?.task ?? "deploy", false, guard);
    return { ok: false, rolledBack: false, detail: guard };
  }
  const prev = exec("git rev-parse HEAD", { cwd: cfg.repo }).output.trim();
  try {
    const prevLock = exec("git show HEAD:package-lock.json | shasum -a 256 | cut -d' ' -f1", { cwd: cfg.repo }).output.trim();
    exec(`git fetch origin`, { cwd: cfg.repo });
    exec("git checkout -q main", { cwd: cfg.repo, allowFail: true });
    exec(`git reset -q --hard ${sha}`, { cwd: cfg.repo });
    // npm ci wipes node_modules — skip when the lock didn't change (services boot from it)
    const newLock = exec("git show HEAD:package-lock.json | shasum -a 256 | cut -d' ' -f1", { cwd: cfg.repo }).output.trim();
    if (newLock !== prevLock) {
      npmInstall(cfg);
    } else {
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "lock unchanged — skipping npm ci" }));
    }
    exec("npm run build --silent", { cwd: cfg.repo, timeoutMin: 15 });
    kickstart(cfg, "com.ocr.relay");
    kickstart(cfg, "com.ocr.daemon");
  } catch (err) {
    await rollback(cfg, prev, `deploy steps failed: ${String(err).slice(0, 200)}`);
    return { ok: false, rolledBack: true, detail: String(err).slice(0, 200) };
  }

  // health watch: services must come up healthy
  const healthy = await pollHealth(cfg, 90);
  if (!healthy) {
    await rollback(cfg, prev, "health check failed after deploy");
    return { ok: false, rolledBack: true, detail: "health check failed" };
  }

  // live invariants against production (replay, tunnel, state perms)
  const inv = exec("npx tsx scripts/invariants.ts --live", { cwd: cfg.repo, timeoutMin: 5, allowFail: true });
  if (!inv.ok) {
    await rollback(cfg, prev, `live invariants failed: ${inv.output.slice(-200)}`);
    return { ok: false, rolledBack: true, detail: "live invariants failed" };
  }

  // soak: keep watching for the monitor window; 3 consecutive failures = rollback
  const soakEverySec = 60;
  const checks = Math.floor((cfg.monitorMin * 60) / soakEverySec);
  let fails = 0;
  for (let i = 0; i < checks; i++) {
    await sleep(soakEverySec * 1000);
    touchHeartbeat();
    const healthyNow = await isHealthy(cfg);
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "soak", data: { check: i + 1, of: checks, healthy: healthyNow } }));
    emit("deploy", { phase: `soak ${i + 1}/${checks}`, ok: healthyNow });
    if (!healthyNow) {
      fails++;
      if (fails >= 3) {
        emit("deploy", { phase: "rollback", ok: false, detail: "soak failed" });
        await rollback(cfg, prev, `soak failed after ${i + 1} checks`);
        return { ok: false, rolledBack: true, detail: "soak failed" };
      }
    } else fails = 0;
  }
  emit("deploy", { phase: "done", ok: true, detail: `sha ${sha.slice(0, 7)} live` });
  // P2-011: UI-changing cycles leave visual evidence in the review log — a
  // post-deploy screenshot the reviewer agents cite in their verdicts.
  if (meta?.ui && meta.task) {
    const shotPath = await captureUiShot(meta.task, sha);
    emit("phase", {
      task: meta.task,
      phase: "ui-shot",
      ok: Boolean(shotPath),
      detail: shotPath ?? "post-deploy screenshot unavailable",
    });
  }
  // self-update: if this deploy changed pilot code, reload ourselves (KeepAlive restarts)
  const pilotChanged = exec(`git diff --name-only ${sha} HEAD -- apps/pilot`, { cwd: cfg.repo, allowFail: true });
  if (String(pilotChanged.output || "").includes("apps/pilot")) {
    log("warn", "deploy included pilot changes — self-reloading");
    process.exit(0); // log is flushed synchronously; the pidfile singleton covers any overlap
  }
  return { ok: true, rolledBack: false, detail: `deployed ${sha.slice(0, 7)} (prev ${prev.slice(0, 7)})` };
}

/** npm ci with visible errors and one retry (transient cache/lock races happen). */
function npmInstall(cfg: PilotConfig) {
  const r = exec("npm ci --no-audit --no-fund --loglevel=error", { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  if (r.ok) return;
  console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "npm ci retry", data: r.output.slice(-300) }));
  exec("npm ci --no-audit --no-fund --loglevel=error", { cwd: cfg.repo, timeoutMin: 15 });
}

async function rollback(cfg: PilotConfig, prevSha: string, why: string) {
  exec("git checkout -q main", { cwd: cfg.repo, allowFail: true });
  exec(`git reset -q --hard ${prevSha}`, { cwd: cfg.repo, allowFail: true });
  exec("npm ci --silent", { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  exec("npm run build --silent", { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  kickstart(cfg, "com.ocr.relay");
  kickstart(cfg, "com.ocr.daemon");
  console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "rollback", data: { prevSha, why } }));
  await sleep(15_000);
}

function kickstart(cfg: PilotConfig, service: string) {
  exec(`launchctl kickstart -k gui/${process.getuid?.() ?? 501}/${service}`, { cwd: cfg.repo });
}

async function isHealthy(_cfg: PilotConfig): Promise<boolean> {
  try {
    const token = JSON.parse(
      readFileSync(join(homedir(), ".opencode-remote", "daemon.json"), "utf8"),
    ).apiToken;
    const res = await fetch("http://127.0.0.1:8792/api/health", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { healthy?: boolean; relayConnected?: boolean; opencodeHealthy?: boolean };
    return j.healthy === true && j.relayConnected === true && j.opencodeHealthy === true;
  } catch {
    return false;
  }
}

async function pollHealth(cfg: PilotConfig, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await isHealthy(cfg)) return true;
    await sleep(5000);
  }
  return false;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
