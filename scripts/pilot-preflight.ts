/**
 * Pilot restart preflight — a READ-ONLY GO/NO-GO for the operator before
 * `launchctl load -w ~/Library/LaunchAgents/com.ocr.pilot.plist`.
 *
 * Both long outages (09-12 → 09-22, 09-24 → …) ended with a restart into an
 * environment nobody had checked: a full disk, a judge pinned before RT-390
 * (every deploy rolled back for 12 days), a tier-B block missing a role, a
 * supervisor session that no longer exists (every alert dropped), and 17
 * verified merges waiting to go live at once. This script measures all of it
 * and prints one verdict with the reasons.
 *
 * Strictly read-only: no writes anywhere (git runs with --no-optional-locks,
 * never fetch/status-refresh), no service touched, only GETs to loopback
 * endpoints and to the tier-A provider's model list. Secrets are never
 * printed (daemon.json is not read at all; the provider key, when sent to its
 * own endpoint, never reaches the output).
 *
 * Run:  npx tsx scripts/pilot-preflight.ts [--json]
 * Exit: 0 = GO (maybe with warnings) · 1 = NO-GO · 2 = the preflight crashed
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { parseBacklog } from "../apps/pilot/src/backlog";
import {
  CATCHUP_STEP_TASKS,
  planDeploy,
  planSummary,
  planTaskIds,
  readQuarantine,
  readVerifiedMerges,
  SHA_RE,
  type DeployPlan,
} from "../apps/pilot/src/deployguard";
import { DISK_MIN_FREE_BYTES, formatGb } from "../apps/pilot/src/disk";
import { doctorTierBRoles } from "../apps/pilot/src/doctor";
import {
  compareProtocolMirror,
  inspectJudge,
  JUDGE_PROTOCOL_REL,
  TARGET_PROTOCOL_PATH,
  type GitRead,
  type JudgeInspection,
  type ProtocolDrift,
} from "../apps/pilot/src/judgedrift";
import { parseMissionModels, parseMissionSpec, validRepoUrl } from "../apps/pilot/src/mission";
import { normalizeModels } from "../apps/pilot/src/state";

// ── model ────────────────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface PreflightCheck {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  /** Exact operator action, when there is one. */
  fix?: string;
}

/** Everything the preflight measured — pure data, JSON-safe, secret-free. */
export interface PreflightFacts {
  at: string;
  prodRepo: string;
  launchd: { label: string; loaded: boolean; pid: number | null; lastExit: number | null }[] | null;
  heartbeat: { ageMs: number | null; pid: number | null; pidAlive: boolean | null };
  frozen: boolean;
  auditMode: string | null;
  disks: { label: string; path: string; freeBytes: number | null; failBelow: number; warnBelow: number }[];
  opencodeDbBytes: number | null;
  judge: JudgeInspection;
  /** Runtime comparison of the judge mirror vs each deploy target it would have to speak to. */
  judgeDrift: { target: string; drift: ProtocolDrift }[];
  gh: { ok: boolean; account: string | null; detail: string };
  opencode: { ok: boolean; version: string | null; detail: string };
  daemon: { ok: boolean; opencodeHealthy: boolean | null; relayConnected: boolean | null; pwaHealthy: boolean | null; uptimeS: number | null; detail: string };
  tierA: { model: string | null; baseURL: string | null; status: number | null; listed: boolean | null; keySent: boolean; detail: string };
  claude: { ok: boolean; version: string | null; detail: string };
  tierB: { configured: boolean; rolesOk: boolean; detail: string };
  notify: {
    session: string | null;
    sessionExists: boolean | null;
    pending: number;
    oldestPendingAgeMs: number | null;
    lastDeliveredAgeMs: number | null;
    pushSubscriptions: number | null;
  };
  mission: { present: boolean; valid: boolean; detail: string };
  pilotCfg: { slots: number | null; maxDeploysPerDay: number | null; monitorMin: number | null; digest: boolean | null };
  deploy: {
    prod: string | null;
    prodDirty: string[] | null;
    originLocal: string | null;
    originRemote: string | null;
    plan: DeployPlan | null;
    /** Does the code the restart will run (prod HEAD) have the stepwise catch-up? */
    stepwiseInProd: boolean | null;
    rangeTouches: { pilot: boolean; protocol: boolean; lockfile: boolean; deployDir: boolean; invariants: boolean } | null;
    queueReady: number | null;
  };
  inflight: {
    prs: { number: number; head: string; mergeable: string; title: string }[] | null;
    localOnly: { slot: string; branch: string; commits: number; tip: string; hasPr: boolean }[];
    attempts: Record<string, number>;
    diedMidPipeline: string[];
  };
}

// ── io (read-only) ───────────────────────────────────────────────────────────

export interface PreflightIo {
  readFile(path: string): string | null;
  exists(path: string): boolean;
  listDir(path: string): string[];
  fileSize(path: string): number | null;
  freeBytes(path: string): Promise<number | null>;
  /** argv-only command runner (no shell) — used for read-only commands only. */
  run(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }): { ok: boolean; output: string };
  http(url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }): Promise<{ status: number; body: string } | { error: string }>;
  now(): number;
}

export function realIo(): PreflightIo {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    exists: (p) => existsSync(p),
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    fileSize: (p) => {
      try {
        return statSync(realpathSync(p)).size;
      } catch {
        return null;
      }
    },
    freeBytes: async (p) => {
      try {
        const s = await statfs(p);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    },
    run: (cmd, args, opts) => {
      try {
        const output = execFileSync(cmd, args, {
          cwd: opts?.cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: opts?.timeoutMs ?? 20_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return { ok: true, output };
      } catch (err) {
        const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` || String(e.message ?? err) };
      }
    },
    http: async (url, init) => {
      try {
        const res = await fetch(url, { headers: init?.headers, signal: AbortSignal.timeout(init?.timeoutMs ?? 6_000) });
        const body = (await res.text()).slice(0, 64 * 1024);
        return { status: res.status, body };
      } catch (err) {
        return { error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 160) : String(err).slice(0, 160) };
      }
    },
    now: () => Date.now(),
  };
}

export interface PreflightEnv {
  home: string;
  /** ~/.opencode-remote */
  state: string;
  prodRepo: string;
  judgeDir: string;
  judgePinFile: string;
  pilotLog: string;
  opencodeConfig: string;
  opencodeDb: string;
  opencodeUrl: string;
  daemonMetricsUrl: string;
  /** Volumes to measure, deduped by the caller. */
  volumes: { label: string; path: string; failBelow: number; warnBelow: number }[];
  io: PreflightIo;
}

const GB = 1024 ** 3;
const PILOT_PLIST = (home: string) => join(home, "Library", "LaunchAgents", "com.ocr.pilot.plist");
const SERVICES = ["com.ocr.opencode", "com.ocr.daemon", "com.ocr.relay", "com.ocr.pwa", "com.ocr.logrotate", "com.ocr.pilot"];

/** The production checkout the pilot runs from: OCR_PILOT_REPO, else the
 * plist's EnvironmentVariables.OCR_PILOT_REPO, else ~/.opencode-remote/prod. */
export function resolveProdRepo(home: string, io: PreflightIo, envRepo = process.env.OCR_PILOT_REPO): string {
  if (envRepo) return envRepo;
  const r = io.run("plutil", ["-extract", "EnvironmentVariables.OCR_PILOT_REPO", "raw", "-o", "-", PILOT_PLIST(home)]);
  const fromPlist = r.ok ? r.output.trim() : "";
  return fromPlist || join(home, ".opencode-remote", "prod");
}

export function defaultEnv(io: PreflightIo = realIo()): PreflightEnv {
  const home = homedir();
  const state = join(home, ".opencode-remote");
  const opencodeDb = join(home, ".local", "share", "opencode", "opencode.db");
  const volumes = [{ label: "interno (~/.opencode-remote: prod, slots, logs)", path: state, failBelow: DISK_MIN_FREE_BYTES, warnBelow: 20 * GB }];
  try {
    const dbDir = dirname(realpathSync(opencodeDb));
    if (statSync(dbDir).dev !== statSync(state).dev) {
      volumes.push({ label: `opencode.db (${dbDir})`, path: dbDir, failBelow: 10 * GB, warnBelow: 30 * GB });
    }
  } catch {}
  return {
    home,
    state,
    prodRepo: resolveProdRepo(home, io),
    judgeDir: join(state, "judge"),
    judgePinFile: join(state, "judge.json"),
    pilotLog: join(state, "logs", "pilot.log"),
    opencodeConfig: join(home, ".config", "opencode", "opencode.jsonc"),
    opencodeDb,
    opencodeUrl: process.env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    daemonMetricsUrl: "http://127.0.0.1:8792/metrics",
    volumes,
    io,
  };
}

// ── collectors ───────────────────────────────────────────────────────────────

function jsonOr<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** `launchctl list` rows for com.ocr.* ("PID\tStatus\tLabel"). */
export function parseLaunchctlList(out: string): Map<string, { pid: number | null; lastExit: number | null }> {
  const rows = new Map<string, { pid: number | null; lastExit: number | null }>();
  for (const line of out.split("\n")) {
    const [pid, status, label] = line.trim().split(/\s+/);
    if (!label || !label.startsWith("com.ocr.")) continue;
    rows.set(label, { pid: pid && /^\d+$/.test(pid) ? Number(pid) : null, lastExit: status && /^-?\d+$/.test(status) ? Number(status) : null });
  }
  return rows;
}

/** Tasks whose last `pipeline start` after the last boot has no `pipeline result`. */
export function tasksDiedMidPipeline(logTail: string): string[] {
  const lines = logTail.split("\n");
  let boot = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes('"msg":"pilot started"')) {
      boot = i;
      break;
    }
  }
  const open = new Set<string>();
  for (const line of lines.slice(boot + 1)) {
    const m = /"msg":"pipeline (start|result)","data":\{"task":"([A-Z0-9-]+)"/.exec(line);
    if (!m) continue;
    if (m[1] === "start") open.add(m[2]!);
    else open.delete(m[2]!);
  }
  return [...open];
}

function gitReader(io: PreflightIo): GitRead {
  return (args) => io.run("git", ["--no-optional-locks", ...args], { timeoutMs: 30_000 });
}

async function probeDaemon(env: PreflightEnv): Promise<PreflightFacts["daemon"]> {
  const r = await env.io.http(env.daemonMetricsUrl);
  if ("error" in r) return { ok: false, opencodeHealthy: null, relayConnected: null, pwaHealthy: null, uptimeS: null, detail: `daemon metrics unreachable (${r.error})` };
  const j = jsonOr<Record<string, unknown>>(r.body, {});
  const flag = (k: string) => (typeof j[k] === "number" ? j[k] === 1 : null);
  const opencodeHealthy = flag("ocr_opencode_healthy");
  const relayConnected = flag("ocr_relay_connected");
  return {
    ok: r.status === 200,
    opencodeHealthy,
    relayConnected,
    pwaHealthy: flag("ocr_pwa_origin_healthy"),
    uptimeS: typeof j.uptime_s === "number" ? j.uptime_s : null,
    detail: `HTTP ${r.status}`,
  };
}

/** Resolve a provider key the way opencode does for the two common shapes. */
function literalKey(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw) return null;
  const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  if (env) return process.env[env[1]!] ?? null;
  if (raw.startsWith("{")) return null; // {file:...} and friends: not resolved here
  return raw;
}

async function probeTierA(env: PreflightEnv): Promise<PreflightFacts["tierA"]> {
  const raw = env.io.readFile(env.opencodeConfig);
  let cfg: { model?: string; provider?: Record<string, { options?: { baseURL?: string; apiKey?: unknown } }> } = {};
  try {
    cfg = raw === null ? {} : (JSON5.parse(raw) as typeof cfg); // opencode.jsonc (same parser as the daemon MCP manager)
  } catch {}
  const model = typeof cfg.model === "string" ? cfg.model : null;
  if (!model || !model.includes("/")) return { model, baseURL: null, status: null, listed: null, keySent: false, detail: "no provider/model default in the opencode config" };
  const [providerId, ...rest] = model.split("/");
  const modelId = rest.join("/");
  const provider = cfg.provider?.[providerId!];
  const baseURL = provider?.options?.baseURL ?? null;
  if (!baseURL) return { model, baseURL: null, status: null, listed: null, keySent: false, detail: `provider "${providerId}" is built-in (no baseURL) — reachability not probed` };
  const key = literalKey(provider?.options?.apiKey);
  const r = await env.io.http(`${baseURL.replace(/\/+$/, "")}/models`, { headers: key ? { authorization: `Bearer ${key}` } : undefined, timeoutMs: 8_000 });
  if ("error" in r) return { model, baseURL, status: null, listed: null, keySent: Boolean(key), detail: `unreachable: ${r.error}` };
  let listed: boolean | null = null;
  if (r.status === 200) {
    const ids = (jsonOr<{ data?: { id?: string }[] }>(r.body, {}).data ?? []).map((d) => d.id);
    listed = ids.includes(modelId);
  }
  return { model, baseURL, status: r.status, listed, keySent: Boolean(key), detail: `GET /models → HTTP ${r.status}` };
}

export async function collectFacts(env: PreflightEnv): Promise<PreflightFacts> {
  const { io } = env;
  const git = gitReader(io);
  const now = io.now();
  const pilotJson = jsonOr<Record<string, unknown>>(io.readFile(join(env.state, "pilot.json")), {});
  const stateJson = jsonOr<{ taskAttempts?: Record<string, number>; auditMode?: { reason?: string } | null }>(io.readFile(join(env.state, "pilot", "state.json")), {});

  // launchd
  const lc = io.run("launchctl", ["list"]);
  const rows = lc.ok ? parseLaunchctlList(lc.output) : null;
  const launchd = rows ? SERVICES.map((label) => ({ label, loaded: rows.has(label), pid: rows.get(label)?.pid ?? null, lastExit: rows.get(label)?.lastExit ?? null })) : null;

  // heartbeat + pidfile
  const hbRaw = Number(io.readFile(join(env.state, "pilot", "heartbeat")) ?? NaN);
  const pidRaw = Number(io.readFile(join(env.state, "pilot", "pilot.pid")) ?? NaN);
  const pid = Number.isInteger(pidRaw) && pidRaw > 0 ? pidRaw : null;
  let pidAlive: boolean | null = null;
  if (pid) {
    const ps = io.run("ps", ["-o", "command=", "-p", String(pid)]);
    pidAlive = ps.ok && /apps\/pilot\/src\/index\.ts/.test(ps.output);
  }

  // disks
  const disks = [];
  for (const v of env.volumes) disks.push({ ...v, freeBytes: await io.freeBytes(v.path) });

  // judge + drift against what the next deploys would ship
  const judge = inspectJudge(env.judgeDir, env.judgePinFile, git, io.exists, (p) => io.readFile(p) ?? "");
  const mirror = io.readFile(join(env.judgeDir, JUDGE_PROTOCOL_REL));

  // deploy plan (local refs only — the pilot fetches on boot, we never do)
  const head = git(["-C", env.prodRepo, "rev-parse", "HEAD"]);
  const prod = head.ok && SHA_RE.test(head.output.trim()) ? head.output.trim() : null;
  const st = git(["-C", env.prodRepo, "status", "--porcelain", "--untracked-files=no"]);
  const prodDirty = st.ok ? st.output.split("\n").map((l) => l.trimEnd()).filter(Boolean) : null;
  const originLocalR = git(["-C", env.prodRepo, "rev-parse", "origin/main"]);
  const originLocal = originLocalR.ok ? originLocalR.output.trim() : null;
  const lsr = io.run("git", ["-C", env.prodRepo, "ls-remote", "origin", "refs/heads/main"], { timeoutMs: 20_000 });
  const originRemote = lsr.ok ? (lsr.output.trim().split(/\s+/)[0] ?? null) : null;
  const histR = git(["-C", env.prodRepo, "log", "--first-parent", "--format=%H", "-n", "500", "origin/main"]);
  const history = histR.ok ? histR.output.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const verified = readVerifiedMerges(join(env.state, "pilot", "verified-merges.jsonl"));
  const quarantine = readQuarantine(join(env.state, "pilot", "quarantine.jsonl"));
  const plan = prod && history.length ? planDeploy(history, prod, verified, quarantine) : null;
  const stepwiseInProd = prod ? /export function planDeploy\(/.test(git(["-C", env.prodRepo, "show", `${prod}:apps/pilot/src/deployguard.ts`]).output) : null;
  let rangeTouches: PreflightFacts["deploy"]["rangeTouches"] = null;
  if (prod && plan?.newest) {
    const names = git(["-C", env.prodRepo, "diff", "--name-only", prod, plan.newest]);
    if (names.ok) {
      const files = names.output.split("\n").filter(Boolean);
      rangeTouches = {
        pilot: files.some((f) => f.startsWith("apps/pilot/")),
        protocol: files.some((f) => f.startsWith("packages/protocol/")),
        lockfile: files.includes("package-lock.json"),
        deployDir: files.some((f) => f.startsWith("deploy/")),
        invariants: files.includes("scripts/invariants.ts"),
      };
    }
  }
  const backlog = git(["-C", env.prodRepo, "show", "origin/main:BACKLOG.md"]);
  const queueReady = backlog.ok ? parseBacklog(backlog.output).length : null;
  // every distinct target the catch-up will stop at speaks through the judge
  const targets = [...new Set([plan?.target, plan?.newest].filter((s): s is string => Boolean(s)))];
  if (targets.length === 0 && prod) targets.push(prod);
  const judgeDrift = targets.map((t) => {
    const src = git(["-C", env.prodRepo, "show", `${t}:${TARGET_PROTOCOL_PATH}`]);
    return { target: t.slice(0, 7), drift: compareProtocolMirror(mirror, src.ok ? src.output : null) };
  });

  // gh
  const ghR = io.run("gh", ["auth", "status", "--hostname", "github.com"], { timeoutMs: 20_000 });
  const account = /Logged in to github\.com account (\S+)/.exec(ghR.output)?.[1] ?? /Logged in to github\.com as (\S+)/.exec(ghR.output)?.[1] ?? null;
  const gh = { ok: ghR.ok && account !== null, account, detail: ghR.ok ? "authenticated" : ghR.output.replace(/gh[opusr]_[A-Za-z0-9_]+/g, "gh*_***").trim().split("\n")[0]?.slice(0, 160) ?? "gh auth status failed" };

  // opencode API
  const oc = await io.http(`${env.opencodeUrl}/global/health`);
  const ocBody = "error" in oc ? {} : jsonOr<{ healthy?: boolean; version?: string }>(oc.body, {});
  const opencode = "error" in oc
    ? { ok: false, version: null, detail: `unreachable (${oc.error})` }
    : { ok: oc.status === 200 && ocBody.healthy !== false, version: ocBody.version ?? null, detail: `HTTP ${oc.status}` };

  const daemon = await probeDaemon(env);
  const tierA = await probeTierA(env);

  // tier B
  const models = normalizeModels(pilotJson.models);
  const configured = Boolean(models?.tierB && Object.keys(models.tierB).length);
  const cl = io.run("claude", ["--version"], { timeoutMs: 20_000 });
  const claude = { ok: cl.ok, version: cl.ok ? (cl.output.trim().split("\n")[0] ?? null) : null, detail: cl.ok ? "ok" : cl.output.trim().slice(-160) || "claude --version failed" };
  const roles = doctorTierBRoles(models);
  const tierB = { configured, rolesOk: roles.ok, detail: roles.detail };

  // notify path
  const session = typeof pilotJson.supervisorSession === "string" && pilotJson.supervisorSession ? pilotJson.supervisorSession : null;
  let sessionExists: boolean | null = null;
  if (session && /^ses_[A-Za-z0-9]+$/.test(session)) {
    const s = await io.http(`${env.opencodeUrl}/session/${session}`);
    sessionExists = "error" in s ? null : s.status === 200 ? true : s.status === 404 ? false : null;
  }
  const pendingLines = (io.readFile(join(env.state, "pilot", "notify-pending.jsonl")) ?? "").split("\n").filter(Boolean);
  const pendingTs = pendingLines.map((l) => jsonOr<{ ts?: number }>(l, {}).ts).filter((t): t is number => typeof t === "number");
  const lastDelivered = Number(io.readFile(join(env.state, "pilot", "notify-last")) ?? NaN);
  const subs = jsonOr<unknown>(io.readFile(join(env.state, "subscriptions.json")), null);
  const notify = {
    session,
    sessionExists,
    pending: pendingLines.length,
    oldestPendingAgeMs: pendingTs.length ? now - Math.min(...pendingTs) : null,
    lastDeliveredAgeMs: Number.isFinite(lastDelivered) && lastDelivered > 0 ? now - lastDelivered : null,
    pushSubscriptions: Array.isArray(subs) ? subs.length : null,
  };

  // mission
  const missionRaw = io.readFile(join(env.state, "mission.json"));
  const mission = { present: missionRaw !== null, valid: missionRaw !== null && parseMissionSpec(missionRaw) !== null, detail: missionReason(missionRaw) };

  // in flight
  const slug = repoSlugOf(env, git);
  const prsR = slug
    ? io.run("gh", ["pr", "list", "--repo", slug, "--state", "open", "--json", "number,headRefName,mergeable,title", "--limit", "50"], { timeoutMs: 30_000 })
    : { ok: false, output: "" };
  const prsAll = prsR.ok ? jsonOr<{ number: number; headRefName: string; mergeable: string; title: string }[]>(prsR.output, []) : null;
  const prs = prsAll?.map((p) => ({ number: p.number, head: p.headRefName, mergeable: p.mergeable, title: p.title.slice(0, 90) })) ?? null;
  const prHeads = new Set((prs ?? []).map((p) => p.head));
  const localOnly: PreflightFacts["inflight"]["localOnly"] = [];
  const slotRoot = join(env.state, "pilot");
  for (const d of io.listDir(slotRoot).filter((n) => /^repo-\d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
    const ws = join(slotRoot, d);
    const refs = git(["-C", ws, "for-each-ref", "--format=%(refname:short)", "refs/heads/pilot/"]);
    if (!refs.ok) continue;
    for (const branch of refs.output.split("\n").map((l) => l.trim()).filter((b) => /^pilot\/(?:P\d|RT)-\d{3}$/.test(b))) {
      const n = Number(git(["-C", ws, "rev-list", "--count", branch, "--not", "--remotes"]).output.trim());
      if (!Number.isFinite(n) || n <= 0) continue;
      const tip = git(["-C", ws, "rev-parse", "--short", branch]).output.trim();
      localOnly.push({ slot: d, branch, commits: n, tip, hasPr: prHeads.has(branch) });
    }
  }
  const logRaw = io.readFile(env.pilotLog) ?? "";
  const tail = logRaw.length > 4 * 1024 * 1024 ? logRaw.slice(-4 * 1024 * 1024) : logRaw;
  const inflight = {
    prs,
    localOnly,
    attempts: Object.fromEntries(Object.entries(stateJson.taskAttempts ?? {}).filter(([, n]) => typeof n === "number" && n > 0)),
    diedMidPipeline: tasksDiedMidPipeline(tail),
  };

  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    at: new Date(now).toISOString(),
    prodRepo: env.prodRepo,
    launchd,
    heartbeat: { ageMs: Number.isFinite(hbRaw) && hbRaw > 0 ? now - hbRaw : null, pid, pidAlive },
    frozen: io.exists(join(env.state, "pilot.lock")),
    auditMode: stateJson.auditMode?.reason ?? null,
    disks,
    opencodeDbBytes: io.fileSize(env.opencodeDb),
    judge,
    judgeDrift,
    gh,
    opencode,
    daemon,
    tierA,
    claude,
    tierB,
    notify,
    mission,
    pilotCfg: {
      slots: num(pilotJson.slots),
      maxDeploysPerDay: num(pilotJson.maxDeploysPerDay),
      monitorMin: num(pilotJson.monitorMin),
      digest: typeof pilotJson.digest === "boolean" ? pilotJson.digest : null,
    },
    deploy: { prod, prodDirty, originLocal, originRemote, plan, stepwiseInProd, rangeTouches, queueReady },
    inflight,
  };
}

function repoSlugOf(env: PreflightEnv, git: GitRead): string | null {
  const url = git(["-C", env.prodRepo, "remote", "get-url", "origin"]);
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\s*$/.exec(url.output.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Why mission.json is (in)valid, in the operator's words. */
export function missionReason(raw: string | null): string {
  if (raw === null) return "ausente — missão padrão (este repo)";
  if (parseMissionSpec(raw) !== null) return "válida";
  const j = jsonOr<Record<string, unknown> | null>(raw, null);
  if (!j || typeof j !== "object" || Array.isArray(j)) return "inválida: não é um objeto JSON";
  const why: string[] = [];
  if (j.v !== 1) why.push("falta v:1");
  const prompt = typeof j.prompt === "string" ? j.prompt.trim() : "";
  if (!prompt && !validRepoUrl(j.repoUrl)) why.push("sem prompt nem repoUrl válido");
  const m = parseMissionModels(j.models);
  if (!m.ok) why.push(m.reason);
  return `inválida (${why.join("; ") || "formato"}) — o pilot ignora o arquivo e usa a missão padrão`;
}

// ── evaluation (pure) ────────────────────────────────────────────────────────

function ago(ms: number | null): string {
  if (ms === null) return "?";
  const min = Math.round(ms / 60_000);
  if (min < 90) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} dias`;
}

export function evaluate(f: PreflightFacts): PreflightCheck[] {
  const out: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => out.push(c);

  // services
  if (!f.launchd) {
    add({ id: "launchd", status: "warn", title: "launchd", detail: "`launchctl list` falhou — estado dos serviços desconhecido" });
  } else {
    const need = ["com.ocr.opencode", "com.ocr.daemon", "com.ocr.relay"];
    const down = f.launchd.filter((s) => need.includes(s.label) && (!s.loaded || s.pid === null)).map((s) => s.label);
    const pwa = f.launchd.find((s) => s.label === "com.ocr.pwa");
    const pilot = f.launchd.find((s) => s.label === "com.ocr.pilot");
    const list = f.launchd.map((s) => `${s.label.replace("com.ocr.", "")}=${!s.loaded ? "não carregado" : s.pid ? `pid ${s.pid}` : `parado (exit ${s.lastExit ?? "?"})`}`).join(", ");
    if (down.length) add({ id: "launchd", status: "fail", title: "serviços de produção", detail: `${down.join(", ")} fora do ar — todo deploy falharia no health check (${list})`, fix: `launchctl kickstart -k gui/$(id -u)/${down[0]}` });
    else if (pwa && (!pwa.loaded || pwa.pid === null)) add({ id: "launchd", status: "warn", title: "serviços de produção", detail: `PWA fora do ar (${list})` });
    else add({ id: "launchd", status: "ok", title: "serviços de produção", detail: list });
    if (pilot?.loaded) add({ id: "pilot-loaded", status: "warn", title: "pilot já carregado", detail: `com.ocr.pilot já está no launchd${pilot.pid ? ` (pid ${pilot.pid})` : ""} — este preflight é para ANTES do restart` });
  }
  const hb = f.heartbeat;
  // the unit battery touches the real heartbeat file (not HOME-hermetic): a
  // fresh heartbeat with no pilot process is noise, not liveness
  const fresh = hb.ageMs !== null && hb.ageMs < 5 * 60_000;
  add({
    id: "heartbeat",
    status: hb.pidAlive ? "warn" : "info",
    title: "heartbeat",
    detail: `último heartbeat há ${ago(hb.ageMs)}${hb.pid ? `; pilot.pid=${hb.pid} ${hb.pidAlive ? "VIVO (um pilot ainda roda?)" : "morto (pidfile velho, o singleton limpa)"}` : ""}${fresh && !hb.pidAlive ? " — heartbeat recente SEM processo do pilot: escrito por outra coisa (a bateria test:unit toca o arquivo real), não é sinal de vida" : ""}`,
  });
  if (f.frozen) add({ id: "frozen", status: "warn", title: "pilot.lock", detail: "~/.opencode-remote/pilot.lock existe — o pilot sobe congelado (não faz nada até remover)", fix: "rm ~/.opencode-remote/pilot.lock" });
  if (f.auditMode) add({ id: "audit", status: "warn", title: "modo audit", detail: `state.json em audit mode (${f.auditMode}) — a fila fica pausada até 2h sem falha`, fix: "touch ~/.opencode-remote/pilot/audit-clear" });

  // disks
  for (const d of f.disks) {
    if (d.freeBytes === null) {
      add({ id: `disk:${d.path}`, status: "warn", title: `disco ${d.label}`, detail: "statfs indisponível" });
      continue;
    }
    const free = `${formatGb(d.freeBytes)} GB livres`;
    if (d.freeBytes < d.failBelow) add({ id: `disk:${d.path}`, status: "fail", title: `disco ${d.label}`, detail: `${free} (< ${formatGb(d.failBelow)} GB) — ENOSPC/recusa de deploy garantidos`, fix: "liberar espaço antes do restart (ver relatório de disco, agente 02)" });
    else if (d.freeBytes < d.warnBelow) add({ id: `disk:${d.path}`, status: "warn", title: `disco ${d.label}`, detail: `${free} (< ${formatGb(d.warnBelow)} GB de folga)` });
    else add({ id: `disk:${d.path}`, status: "ok", title: `disco ${d.label}`, detail: free });
  }
  if (f.opencodeDbBytes !== null) {
    const dbVol = f.disks.find((d) => d.label.startsWith("opencode.db"));
    const runway = dbVol?.freeBytes ? ` — ~${Math.floor(dbVol.freeBytes / (5 * GB))} dias de folga a +5 GB/dia com o pilot ligado` : "";
    add({ id: "opencode-db", status: "info", title: "opencode.db", detail: `${formatGb(f.opencodeDbBytes)} GB${runway}` });
  }

  // judge
  if (!f.judge.usable) {
    add({ id: "judge", status: "fail", title: "judge pinado", detail: `${f.judge.detail} — o gate não roda e todo deploy é recusado`, fix: "revisar ~/.opencode-remote/judge e re-pinar ~/.opencode-remote/judge.json (docs/PILOT.md)" });
  } else {
    add({ id: "judge", status: "ok", title: "judge pinado", detail: f.judge.detail });
  }
  const drifted = f.judgeDrift.filter((d) => d.drift.state === "drift" || d.drift.state === "no-mirror");
  const unknown = f.judgeDrift.filter((d) => d.drift.state === "unknown");
  if (drifted.length) {
    const d = drifted[0]!;
    const win = d.drift.diff ? ` — judge: «${d.drift.diff.judge}» vs alvo: «${d.drift.diff.target}»` : "";
    add({
      id: "judge-drift",
      status: "fail",
      title: "judge × protocolo do alvo",
      detail: `a cópia vendorizada do judge (${JUDGE_PROTOCOL_REL}) diverge em runtime de ${TARGET_PROTOCOL_PATH} em ${drifted.map((x) => x.target).join(", ")} (${d.drift.detail})${win} — as live invariants falhariam e quarentenariam SHAs bons (incidente 10/09→22/09)`,
      fix: `sincronizar ~/.opencode-remote/judge/${JUDGE_PROTOCOL_REL} com ${TARGET_PROTOCOL_PATH}, commitar no repo do judge e re-pinar judge.json`,
    });
  } else if (unknown.length) {
    add({ id: "judge-drift", status: "warn", title: "judge × protocolo do alvo", detail: unknown[0]!.drift.detail });
  } else {
    add({ id: "judge-drift", status: "ok", title: "judge × protocolo do alvo", detail: f.judgeDrift.map((d) => `${d.target}: ${d.drift.state}`).join(", ") || "nenhum alvo" });
  }

  // gh / opencode / daemon / providers
  add(f.gh.ok
    ? { id: "gh", status: "ok", title: "gh auth", detail: `logado como ${f.gh.account}` }
    : { id: "gh", status: "fail", title: "gh auth", detail: `${f.gh.detail} — sem gh não há PR nem merge`, fix: "gh auth login" });
  add(f.opencode.ok
    ? { id: "opencode", status: "ok", title: "opencode API :4096", detail: `saudável (v${f.opencode.version ?? "?"})` }
    : { id: "opencode", status: "fail", title: "opencode API :4096", detail: `${f.opencode.detail} — builders/reviewers não sobem`, fix: "launchctl kickstart -k gui/$(id -u)/com.ocr.opencode" });
  if (!f.daemon.ok || f.daemon.opencodeHealthy === false || f.daemon.relayConnected === false) {
    add({ id: "daemon", status: "fail", title: "daemon (health de deploy)", detail: `${f.daemon.detail}; opencode=${f.daemon.opencodeHealthy} relay=${f.daemon.relayConnected} — o health check pós-deploy falharia e quarentenaria o SHA` });
  } else {
    add({ id: "daemon", status: f.daemon.pwaHealthy === false ? "warn" : "ok", title: "daemon (health de deploy)", detail: `opencode=${f.daemon.opencodeHealthy} relay=${f.daemon.relayConnected} pwa=${f.daemon.pwaHealthy} uptime=${ago((f.daemon.uptimeS ?? 0) * 1000)}` });
  }
  const ta = f.tierA;
  if (ta.status === null && ta.baseURL) add({ id: "tier-a", status: "fail", title: `provider tier A (${ta.model})`, detail: `${ta.baseURL}: ${ta.detail} — todo builder falharia` });
  else if (ta.status !== null && ta.status >= 500) add({ id: "tier-a", status: "fail", title: `provider tier A (${ta.model})`, detail: `${ta.detail} — provider degradado` });
  else if (ta.status === 401 || ta.status === 403) add({ id: "tier-a", status: ta.keySent ? "fail" : "warn", title: `provider tier A (${ta.model})`, detail: ta.keySent ? `${ta.detail}: a chave configurada foi RECUSADA` : `${ta.detail}: alcançável (chave não verificada)` });
  else if (ta.status === 200) add({ id: "tier-a", status: ta.listed === false ? "warn" : "ok", title: `provider tier A (${ta.model})`, detail: ta.listed === false ? `${ta.detail}, mas o modelo não aparece na lista` : `${ta.detail}, modelo servido` });
  else add({ id: "tier-a", status: "info", title: `provider tier A (${ta.model ?? "?"})`, detail: ta.detail });
  if (f.tierB.configured) {
    add(f.claude.ok
      ? { id: "claude", status: "ok", title: "claude CLI (tier B)", detail: f.claude.version ?? "ok" }
      : { id: "claude", status: "warn", title: "claude CLI (tier B)", detail: `${f.claude.detail} — tier B cai para tier A (tierB-fallback)` });
    add({ id: "tierb-roles", status: f.tierB.rolesOk ? "ok" : "warn", title: "tier B completo", detail: f.tierB.detail, fix: f.tierB.rolesOk ? undefined : "completar models.tierB no ~/.opencode-remote/pilot.json (hot-reload)" });
  } else {
    add({ id: "tierb-roles", status: "info", title: "tier B", detail: f.tierB.detail });
  }

  // alert path
  const n = f.notify;
  const pushNone = n.pushSubscriptions === 0;
  const pending = n.pending ? `; ${n.pending} notificação(ões) parada(s) em notify-pending.jsonl (mais antiga há ${ago(n.oldestPendingAgeMs)})` : "";
  const delivered = `; última entrega ${n.lastDeliveredAgeMs === null ? "nunca registrada" : `há ${ago(n.lastDeliveredAgeMs)}`}`;
  if (!n.session || n.sessionExists === false) {
    add({
      id: "notify",
      status: pushNone ? "fail" : "warn",
      title: "caminho de alerta",
      detail: `${!n.session ? "pilot.json sem supervisorSession" : `a sessão supervisora ${n.session} NÃO existe no opencode (404)`}${pushNone ? " e 0 inscrições de push" : ""} — alertas do pilot não chegam a ninguém${pending}${delivered}`,
      fix: "apontar supervisorSession no ~/.opencode-remote/pilot.json para uma sessão viva do opencode (e/ou reinscrever o push no celular)",
    });
  } else if (n.sessionExists === null) {
    add({ id: "notify", status: "warn", title: "caminho de alerta", detail: `sessão supervisora ${n.session} não verificável${pending}${delivered}` });
  } else {
    add({ id: "notify", status: n.pending ? "warn" : "ok", title: "caminho de alerta", detail: `sessão supervisora existe${pending}${delivered}` });
  }

  // mission + config
  add({ id: "mission", status: f.mission.present && !f.mission.valid ? "warn" : "ok", title: "mission.json", detail: f.mission.detail });
  const c = f.pilotCfg;
  add({ id: "pilot-config", status: "info", title: "pilot.json", detail: `slots=${c.slots ?? "?"} maxDeploysPerDay=${c.maxDeploysPerDay ?? "?"} monitorMin=${c.monitorMin ?? "?"} (soak de deploy de 1 merge) digest=${c.digest ?? "default"}` });

  // deploy plan
  out.push(...evaluateDeploy(f));

  // in flight
  const inf = f.inflight;
  const pilotPrs = (inf.prs ?? []).filter((p) => p.head.startsWith("pilot/"));
  const parts: string[] = [];
  if (inf.diedMidPipeline.length) parts.push(`morreram no meio do pipeline: ${inf.diedMidPipeline.join(", ")}`);
  if (pilotPrs.length) parts.push(`PRs pilot/* abertos: ${pilotPrs.map((p) => `#${p.number} ${p.head} (${p.mergeable})`).join(", ")}`);
  // at risk = what the boot doctor deletes: pilot/<ID> with no open PR and no
  // recorded attempt (doctorBranches protects taskAttempts > 0); a first
  // attempt then restarts clean at origin/main (setupTaskBranch)
  const lost = inf.localOnly.filter((l) => !l.hasPr && !((inf.attempts[l.branch.slice("pilot/".length)] ?? 0) > 0));
  const tag = (l: PreflightFacts["inflight"]["localOnly"][number]) =>
    l.hasPr ? " (tem PR)" : (inf.attempts[l.branch.slice("pilot/".length)] ?? 0) > 0 ? " (preservado: tentativa registrada)" : " (SEM PR — o boot apaga)";
  if (inf.localOnly.length) parts.push(`commits só locais: ${inf.localOnly.map((l) => `${l.branch}@${l.slot} ${l.commits}× ${l.tip}${tag(l)}`).join(", ")}`);
  if (Object.keys(inf.attempts).length) parts.push(`tentativas em curso: ${Object.entries(inf.attempts).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  add({
    id: "inflight",
    status: lost.length ? "warn" : "info",
    title: "trabalho em voo",
    detail: `${parts.join(" · ") || "nada em voo"}${lost.length ? ` — no boot o doctor apaga ${lost.map((l) => l.branch).join(", ")} (sem PR aberto, sem tentativa registrada) e a 1ª tentativa recomeça limpa em origin/main: esse trabalho local se perde (só reflog)` : ""}`,
    fix: lost.length ? `preservar antes do restart: ${lost.map((l) => `git -C ~/.opencode-remote/pilot/${l.slot} branch backup/${l.branch.slice("pilot/".length)} ${l.branch}`).join(" && ")}` : undefined,
  });
  return out;
}

function evaluateDeploy(f: PreflightFacts): PreflightCheck[] {
  const out: PreflightCheck[] = [];
  const d = f.deploy;
  if (!d.prod) {
    out.push({ id: "deploy", status: "fail", title: "deploy pendente", detail: `prod (${f.prodRepo}) sem HEAD legível` });
    return out;
  }
  if (d.prodDirty === null) out.push({ id: "prod-dirty", status: "warn", title: "checkout de produção", detail: "git status falhou — o dirty guard recusaria todo deploy (fail-closed)" });
  else if (d.prodDirty.length) out.push({ id: "prod-dirty", status: "fail", title: "checkout de produção", detail: `${d.prodDirty.length} arquivo(s) rastreado(s) modificado(s) (${d.prodDirty.slice(0, 3).join(", ")}) — o dirty guard recusa todo deploy`, fix: `revisar e limpar: git -C ${f.prodRepo} status` });
  if (d.originLocal && d.originRemote && d.originLocal !== d.originRemote) {
    out.push({ id: "origin-fresh", status: "info", title: "origin/main local", detail: `ref local ${d.originLocal.slice(0, 7)} ≠ remoto ${d.originRemote.slice(0, 7)} — o plano abaixo usa a ref local; o pilot faz fetch no boot e pode ir além` });
  }
  const plan = d.plan;
  if (!plan) {
    out.push({ id: "deploy", status: "warn", title: "deploy pendente", detail: "histórico de origin/main ilegível no checkout de produção" });
    return out;
  }
  if (!plan.anchored) {
    out.push({ id: "deploy", status: "warn", title: "deploy pendente", detail: `prod ${d.prod.slice(0, 7)} não está no histórico first-parent de origin/main — ${planSummary(plan)}; o guard de direção decide` });
    return out;
  }
  if (!plan.target) {
    out.push({ id: "deploy", status: "ok", title: "deploy pendente", detail: `prod ${d.prod.slice(0, 7)} já está no merge verificado mais novo — nada a deployar` });
    return out;
  }
  const total = plan.pending.length;
  const steps = plan.skipped.length === 0 ? Math.ceil(total / CATCHUP_STEP_TASKS) : 1;
  const soakOld = f.pilotCfg.monitorMin ?? 10;
  const touches = d.rangeTouches
    ? Object.entries(d.rangeTouches).filter(([, v]) => v).map(([k]) => ({ pilot: "apps/pilot (self-reload)", protocol: "packages/protocol (judge!)", lockfile: "package-lock (npm ci completo)", deployDir: "deploy/ (constituição)", invariants: "scripts/invariants.ts (judge desatualizado p/ checks estáticos)" })[k as "pilot"]).join(", ")
    : "?";
  const skipped = plan.skipped.length ? `; ${plan.skipped.length} quarentenado(s) no intervalo viaja(m) junto: ${plan.skipped.map((q) => q.task || q.sha.slice(0, 7)).join(", ")}` : "";
  const how = d.stepwiseInProd
    ? `o código de prod já faz catch-up em ${steps} passo(s) de até ${CATCHUP_STEP_TASKS} merges, soak ≥10 min cada`
    : `ATENÇÃO: o código que o restart roda (prod ${d.prod.slice(0, 7)}) ainda não tem o catch-up em passos — fará UM salto de ${total} merges com soak de ${soakOld} min (monitorMin); com o catch-up desta PR em prod seriam ${steps} passo(s) de até ${CATCHUP_STEP_TASKS}`;
  out.push({
    id: "deploy",
    status: total >= 2 ? "warn" : "info",
    title: "deploy pendente",
    detail: `prod ${d.prod.slice(0, 7)} → ${plan.newest?.slice(0, 7)}: ${total} merge(s) verificado(s): ${planTaskIds(plan.pending, 40)}${skipped}; toca: ${touches || "nada sensível"}; ${how}; fila Ready: ${d.queueReady ?? "?"} tarefa(s)`,
    fix: !d.stepwiseInProd && total >= 2 && soakOld < 10 ? "antes do restart, subir monitorMin para 10 no ~/.opencode-remote/pilot.json (o salto ganha 10 min de soak; o pilot só lê monitorMin no boot — voltar ao valor antigo vale a partir do restart seguinte)" : undefined,
  });
  return out;
}

export function verdict(checks: PreflightCheck[]): { go: boolean; fails: PreflightCheck[]; warns: PreflightCheck[] } {
  const fails = checks.filter((c) => c.status === "fail");
  const warns = checks.filter((c) => c.status === "warn");
  return { go: fails.length === 0, fails, warns };
}

const TAG: Record<CheckStatus, string> = { ok: "[ OK  ]", warn: "[AVISO]", fail: "[FALHA]", info: "[INFO ]" };

export function render(f: PreflightFacts, checks: PreflightCheck[]): string {
  const v = verdict(checks);
  const lines = [`Pilot preflight — ${new Date(f.at).toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" })} (GMT-3) — somente leitura`, `prod: ${f.prodRepo}`, ""];
  for (const c of checks) {
    lines.push(`${TAG[c.status]} ${c.title}: ${c.detail}`);
    if (c.fix) lines.push(`         → ${c.fix}`);
  }
  lines.push("");
  lines.push(v.go ? `VEREDITO: GO${v.warns.length ? ` (com ${v.warns.length} aviso(s))` : ""}` : `VEREDITO: NO-GO — ${v.fails.length} falha(s), ${v.warns.length} aviso(s)`);
  for (const c of v.fails) lines.push(`  ✗ ${c.title}: ${c.fix ?? c.detail.slice(0, 160)}`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const facts = await collectFacts(defaultEnv());
  const checks = evaluate(facts);
  if (process.argv.includes("--json")) console.log(JSON.stringify({ facts, checks, verdict: verdict(checks).go ? "GO" : "NO-GO" }, null, 2));
  else console.log(render(facts, checks));
  process.exitCode = verdict(checks).go ? 0 : 1;
}

if (process.argv[1]?.endsWith("pilot-preflight.ts")) {
  main().catch((err) => {
    console.error(`preflight crashed: ${String(err).slice(0, 400)}`);
    process.exitCode = 2;
  });
}
