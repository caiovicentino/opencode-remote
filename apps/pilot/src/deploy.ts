import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "./runner";
import { emit } from "./events";
import type { PilotConfig } from "./state";

export interface DeployResult {
  ok: boolean;
  rolledBack: boolean;
  detail: string;
}

/**
 * Staged deploy of a merged SHA into the production checkout:
 * reset prod repo to SHA → install → build → restart services → health watch.
 * Any failure rolls back to the previous SHA automatically.
 */
export async function deploy(cfg: PilotConfig, sha: string): Promise<DeployResult> {
  emit("deploy", { phase: "start", detail: `sha ${sha.slice(0, 7)}` });
  const prev = exec("git rev-parse HEAD", { cwd: cfg.repo }).output.trim();
  try {
    exec(`git fetch origin`, { cwd: cfg.repo });
    exec("git checkout -q main", { cwd: cfg.repo, allowFail: true });
    exec(`git reset -q --hard ${sha}`, { cwd: cfg.repo });
    npmInstall(cfg);
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
    if (!(await isHealthy(cfg))) {
      fails++;
      if (fails >= 3) {
        emit("deploy", { phase: "rollback", ok: false, detail: "soak failed" });
        await rollback(cfg, prev, `soak failed after ${i + 1} checks`);
        return { ok: false, rolledBack: true, detail: "soak failed" };
      }
    } else fails = 0;
  }
  emit("deploy", { phase: "done", ok: true, detail: `sha ${sha.slice(0, 7)} live` });
  return { ok: true, rolledBack: false, detail: `deployed ${sha.slice(0, 7)} (prev ${prev.slice(0, 7)})` };
}

/** npm ci with visible errors and one retry (transient cache/lock races happen). */
function npmInstall(cfg: PilotConfig) {
  const r = exec("npm ci --no-audit --no-fund --loglevel=error", { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  if (r.ok) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "npm ci retry", data: r.output.slice(-300) }));
  exec("npm ci --no-audit --no-fund --loglevel=error", { cwd: cfg.repo, timeoutMin: 15 });
}

async function rollback(cfg: PilotConfig, prevSha: string, why: string) {
  exec("git checkout -q main", { cwd: cfg.repo, allowFail: true });
  exec(`git reset -q --hard ${prevSha}`, { cwd: cfg.repo, allowFail: true });
  exec("npm ci --silent", { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  exec("npm run build --silent", { cwd: cfg.repo, timeoutMin: 15, allowFail: true });
  kickstart(cfg, "com.ocr.relay");
  kickstart(cfg, "com.ocr.daemon");
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "rollback", data: { prevSha, why } }));
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
