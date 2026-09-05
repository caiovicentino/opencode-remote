import { spawn, spawnSync } from "node:child_process";
import { nowLocalISO } from "./log";
import { tierBModelFor, startHeartbeat, touchHeartbeat, type TierBRole } from "./state";
import { emit } from "./events";
import { notifySupervisor } from "./notify";
import { isMissionModelRole, type MissionModelRole, type MissionModels } from "./mission";
import { fetchAvailableModels, pickMissionModel } from "./modelcatalog";
import { clearModelSubstitution, defaultModelSubstitutionsFile, recordModelSubstitution } from "./modelsubst";

export interface RunResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
  sessionId?: string;
  /** P2-013: resumable subagent task ids seen in stdout (opencode >=1.18.20). */
  taskIds: string[];
  /** P1-094: structured infra flag set only by the producer of an unambiguous
   * infra failure (preflight API unreachable, spawn error) — the classifier
   * reads this, never the output text. */
  infra?: "api-down" | "spawn";
}

// ── P2-013: cheap resumption — id capture from agent stdout ─────────────────

export interface AgentIds {
  sessionId?: string;
  taskIds: string[];
}

/**
 * Real opencode ids are nanoid-length, so requiring a >=8-char suffix keeps
 * prose echoing through stdout out of the capture ("the task_id is resumable",
 * "task_ids"); the lookbehind keeps glued words out ("mytask_abc"). Verified
 * against prose by negative unit tests.
 */
export const MIN_TASK_ID_SUFFIX = 8;
const RESUMABLE_TASK_ID_RE = /(?<![A-Za-z0-9_-])task_[A-Za-z0-9]{8,}/g;

/**
 * P2-028: session ids are now CONSUMED (per-task token costs), so the capture
 * gets the same anchoring the task-id regex already had — the lookbehind keeps
 * glued prose out ("mytask_ses_abc…" must not become a session id and query
 * the wrong row). Suffix stays length-free: the pinned chunk-edge battery
 * completes a 8-char `ses_98z7Yy6` across two chunks.
 */
const SESSION_ID_RE = /(?<![A-Za-z0-9_-])ses_[A-Za-z0-9]+/;
const SESSION_ID_RE_G = /(?<![A-Za-z0-9_-])ses_[A-Za-z0-9]+/g;

/**
 * P2-013: opencode >=1.18.20 surfaces failed subagent tool calls with a
 * resumable `task_id`. Extract those plus the agent's own session id from a
 * block of stdout (pure — pinned against canned output by the unit battery).
 */
export function scanIds(window: string): AgentIds {
  return {
    sessionId: window.match(SESSION_ID_RE)?.[0],
    taskIds: [...window.matchAll(RESUMABLE_TASK_ID_RE)].map((m) => m[0]),
  };
}

/**
 * Merge the per-stream scan results at exit. stdout and stderr each get their
 * own idScanner (round-2 review): a single shared `tail + chunk` across two
 * arbitrarily interleaved streams could fabricate an id that never appeared
 * contiguously (stdout ending "…task_", stderr starting "abc1…"). Session
 * preference is stdout-first — deterministic, and stderr only wins when
 * stdout has none (--print-logs writes the session line to stderr).
 */
export function mergeAgentIds(a: AgentIds, b: AgentIds): AgentIds {
  return {
    sessionId: a.sessionId ?? b.sessionId,
    taskIds: [...a.taskIds, ...b.taskIds.filter((t) => !a.taskIds.includes(t))],
  };
}

/**
 * Streaming scanner behind runAgent: dedupes task ids in arrival order, keeps
 * the first session id and buffers a tail so an id split across two stdout
 * chunks is still captured whole. A match ending exactly at the chunk edge may
 * still grow, so it is held back until more text arrives; flush() commits it
 * once the stream is over.
 */
export function idScanner(): { scan: (chunk: string) => AgentIds; flush: () => AgentIds } {
  let sessionId: string | undefined;
  let tail = "";
  const seen = new Set<string>();
  const taskIds: string[] = [];
  const commit = (window: string, final: boolean) => {
    // a match ending at the window edge may be split across the next chunk —
    // only settle it once more text has arrived (or on the final flush)
    const settled = (m: RegExpMatchArray) => final || m.index! + m[0].length < window.length;
    if (!sessionId) {
      const s = [...window.matchAll(SESSION_ID_RE_G)].find(settled);
      if (s) sessionId = s[0];
    }
    for (const m of [...window.matchAll(RESUMABLE_TASK_ID_RE)]) {
      if (settled(m) && !seen.has(m[0])) {
        seen.add(m[0]);
        taskIds.push(m[0]);
      }
    }
  };
  return {
    scan(chunk: string): AgentIds {
      const window = tail + chunk;
      commit(window, false);
      tail = window.slice(-128);
      return { sessionId, taskIds: [...taskIds] };
    },
    flush(): AgentIds {
      if (tail) commit(tail, true);
      return { sessionId, taskIds: [...taskIds] };
    },
  };
}

/**
 * P2-016: opencode API endpoint. Reviewer note (round 2): the :4096 fallback is
 * duplicated with apps/daemon/src/index.ts (OPENCODE_URL) — keep them in sync;
 * the daemon copy is not exported, so a shared constant is a follow-up.
 */
export const OPENCODE_URL_DEFAULT = "http://127.0.0.1:4096";
export const OPENCODE_URL = process.env.OPENCODE_URL ?? OPENCODE_URL_DEFAULT;

/** P2-016 preflight tuning: 5s probe timeout, 15s between retries, 3 retries (~45s). */
export const API_PREFLIGHT = { timeoutMs: 5_000, waitMs: 15_000, retries: 3 } as const;

/**
 * P2-016: one cheap health probe of the local opencode server. Same check the
 * CLI doctor does (GET /global/health): a 200 whose body is not explicitly
 * `healthy: false` counts as up.
 */
export async function apiHealthy(
  url: string = OPENCODE_URL,
  timeoutMs: number = API_PREFLIGHT.timeoutMs,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const r = await fetchImpl(`${url}/global/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const body = (await r.json().catch(() => ({}))) as { healthy?: boolean };
    return body.healthy !== false;
  } catch {
    return false;
  }
}

/**
 * P2-016: wait for the opencode API before spending agent tokens. Deploy churn
 * (npm ci + service restarts) can take down `opencode serve` for tens of
 * seconds; spawning an agent into that window used to fail with
 * "Cannot connect to API" and burned a circuit-breaker attempt (P1-014).
 * Probes once, then retries up to `retries` times with `waitMs` between probes
 * (~45s of waiting with the defaults) — retries happen BEFORE any attempt or
 * failure is counted. Returns false only when the API is still dead after the
 * whole window; the caller then fails the run through the normal path.
 */
export async function waitForApi(
  opts: {
    url?: string;
    timeoutMs?: number;
    waitMs?: number;
    retries?: number;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  } = {},
): Promise<boolean> {
  const url = opts.url ?? OPENCODE_URL;
  const timeoutMs = opts.timeoutMs ?? API_PREFLIGHT.timeoutMs;
  const waitMs = opts.waitMs ?? API_PREFLIGHT.waitMs;
  const retries = opts.retries ?? API_PREFLIGHT.retries;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let probe = 0; ; probe++) {
    if (await apiHealthy(url, timeoutMs, fetchImpl)) return true;
    if (probe >= retries) return false;
    console.log(
      JSON.stringify({
        ts: nowLocalISO(),
        level: "warn",
        msg: "opencode API down — waiting before agent spawn (attempt NOT counted)",
        data: { url, retry: probe + 1, of: retries },
      }),
    );
    await sleepImpl(waitMs);
  }
}

/**
 * Throttled stdout→log bridge for aux agents: one line per 10s lands in
 * pilot.log as `msg: "<role>"`, which the dashboard log drawer filters by role.
 */
export function agentStream(role: string): (chunk: string) => void {
  let last = 0;
  return (chunk: string) => {
    const now = Date.now();
    if (now - last < 10_000) return;
    last = now;
    const lines = chunk.split("\n").filter((l) => l.trim());
    const line = lines[lines.length - 1];
    if (line) {
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: role, data: line.trim().slice(0, 400) }));
    }
  };
}

/**
 * Run one opencode agent headlessly. `prompt` is the full role instruction;
 * the agent works in `cwd` with its own session and no human interaction.
 * Pass `resumeSession` to continue a previous session — the agent keeps its
 * context of files read and decisions made (true context cache across rounds).
 * P2-016: before spawning, the opencode API is preflighted (waitForApi) so a
 * transient outage during deploy churn waits instead of failing the round.
 */
export async function runAgent(
  prompt: string,
  opts: {
    cwd: string;
    timeoutMin: number;
    label: string;
    sessionId?: string;
    printLogs?: boolean;
    onStdout?: (chunk: string) => void;
    preflight?: () => Promise<boolean>;
    spawnImpl?: typeof spawn;
    heartbeatMs?: number;
    heartbeatTouch?: () => void;
    /** Mission v2: `opencode run --model <provider/model>` — set only after
     * the id was verified against the live catalog (runAgentForRole). */
    model?: string;
  },
): Promise<RunResult> {
  if (!(await (opts.preflight ?? waitForApi)())) {
    return {
      ok: false,
      timedOut: false,
      output: `[preflight] opencode API unreachable at ${OPENCODE_URL} after ${API_PREFLIGHT.retries} retries (~${(API_PREFLIGHT.retries * API_PREFLIGHT.waitMs) / 1000}s) — aborting before spawn`,
      taskIds: [],
      infra: "api-down",
    };
  }
  return new Promise((resolve) => {
    const args = ["run"];
    if (opts.printLogs) args.push("--print-logs"); // exposes the session id for context-cache resumes
    if (opts.sessionId) args.push("-s", opts.sessionId);
    if (opts.model) args.push("--model", opts.model); // one argv entry, no shell
    args.push(prompt);
    const spawnFn = opts.spawnImpl ?? spawn;
    const child = spawnFn("opencode", args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"], // stdin MUST be closed: opencode waits for EOF
    });
    let output = "";
    let timedOut = false;
    const outScan = idScanner();
    const errScan = idScanner();
    // P1-035: the self-watchdog must be fed even when the agent stays silent
    // on stdout (a slow strategist/researcher/redteam used to starve the
    // heartbeat and kill the pilot with slots in flight) — hence a timer, not
    // a stdout hook.
    const stopHeartbeat = startHeartbeat(opts.heartbeatMs ?? 60_000, opts.heartbeatTouch ?? touchHeartbeat);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, opts.timeoutMin * 60_000);
    child.stdout.on("data", (c: Buffer) => {
      output += c.toString();
      outScan.scan(c.toString());
      opts.onStdout?.(c.toString());
    });
    child.stderr.on("data", (c: Buffer) => {
      output += c.toString();
      errScan.scan(c.toString());
    });
    child.on("exit", () => {
      stopHeartbeat();
      clearTimeout(timer);
      const ids = mergeAgentIds(outScan.flush(), errScan.flush());
      resolve({ ok: !timedOut, output, timedOut, sessionId: ids.sessionId, taskIds: ids.taskIds });
    });
    child.on("error", (err) => {
      stopHeartbeat();
      clearTimeout(timer);
      const ids = mergeAgentIds(outScan.flush(), errScan.flush());
      resolve({
        ok: false,
        output: output + `\nspawn error: ${String(err)}`,
        timedOut,
        sessionId: ids.sessionId,
        taskIds: ids.taskIds,
        infra: "spawn",
      });
    });
  });
}

// ── P2-040: shared re-run cache (preflight ↔ evidence ↔ gate steps) ────────────

/** Results of command re-executions, keyed by rerunKey(cmd, cwd). */
export type RerunResults = Map<string, { ok: boolean; output: string }>;

/**
 * Cache key for a re-run result: command + workspace. The same command string
 * in a different slot workspace clone (repo-1, repo-2, ...) must never share
 * an entry - one key per (command, workspace) pair.
 */
export function rerunKey(cmd: string, cwd: string): string {
  return `${cmd}\u0000${cwd}`;
}

/**
 * exec() that reuses the result of an identical (command, workspace) run.
 * The round's first execution - the preflight typecheck - populates the map;
 * the gate's evidence re-run and step battery read from it, so a round whose
 * code did not change executes each command exactly once. Injectable `run`
 * keeps the execution count unit-testable.
 */
export function cachedExec(
  cache: RerunResults,
  cmd: string,
  cwd: string,
  opts: { timeoutMin?: number } = {},
  run?: (cmd: string, cwd: string) => { ok: boolean; output: string },
): { ok: boolean; output: string } {
  const key = rerunKey(cmd, cwd);
  const hit = cache.get(key);
  if (hit) return hit;
  const r = run ? run(cmd, cwd) : exec(cmd, { cwd, timeoutMin: opts.timeoutMin ?? 10, allowFail: true });
  cache.set(key, r);
  return r;
}

/**
 * P1-101: one gate step with a single flaky retry. The first execution is the
 * shared-cache `cachedExec`; on a red result the cache entry is evicted and
 * the command runs again (the second result stays cached, so a green step
 * still executes at most once per round — P2-040 preserved). `flaky` classifies
 * the fail→pass pair deterministically, no LLM in the loop. Never more than
 * 2 executions; two reds return the second output.
 */
export function runStepWithRetry(
  cache: RerunResults,
  cmd: string,
  cwd: string,
  opts: { timeoutMin?: number } = {},
  run?: (cmd: string, cwd: string) => { ok: boolean; output: string },
): { ok: boolean; output: string; flaky: boolean } {
  const first = cachedExec(cache, cmd, cwd, opts, run);
  if (first.ok) return { ...first, flaky: false };
  cache.delete(rerunKey(cmd, cwd));
  const second = cachedExec(cache, cmd, cwd, opts, run);
  return { ...second, flaky: second.ok };
}

/**
 * P1-101: exec() via spawnSync so stderr is captured together with stdout —
 * on success AND on failure. Vite/tsc/esbuild write warnings to stderr; when
 * they vanished into the pilot terminal, an honestly pasted `npm run build
 * --silent` output diverged from the gate's re-run ("pasted output diverges"
 * false rejections). stdout comes first (separate buffers — interleave order
 * is lost, which is acceptable for containment parsing).
 */
export function exec(
  cmd: string,
  opts: { cwd: string; timeoutMin?: number; allowFail?: boolean },
): { ok: boolean; output: string } {
  const r = spawnSync(cmd, {
    shell: true,
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: (opts.timeoutMin ?? 10) * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0 && !r.error;
  if (ok) return { ok: true, output };
  if (opts.allowFail) return { ok: false, output };
  throw new Error(`exec failed (status ${r.status}): ${cmd}\n${output.slice(-4000)}`);
}

// ── P1-059: tiered cognition — judgment roles may dispatch to the claude CLI ─

export interface AgentRunOpts {
  cwd: string;
  timeoutMin: number;
  label: string;
  sessionId?: string;
  printLogs?: boolean;
  onStdout?: (chunk: string) => void;
  /** P2-105: extra directories mounted for tier-B dispatch (evidence shots). */
  extraDirs?: string[];
  /** Test seams (runAgent): preflight + spawn injection. */
  preflight?: () => Promise<boolean>;
  spawnImpl?: typeof spawn;
}

/** Mission v2: every role runAgentForRole can dispatch. */
export type DispatchRole = TierBRole | MissionModelRole;

/**
 * Exact argv of the tier-B dispatch, pinned by the unit battery. `-p` print
 * mode + `--add-dir` restricted to the slot workspace clone (anti-exfiltration:
 * nothing under ~/.opencode-remote is ever mounted) + edits auto-accepted.
 * P2-105: `extraDirs` mounts additional read-mostly evidence directories (the
 * fable product review reads the explorer's journey shots); the default stays
 * empty so every pre-existing role dispatch is argv-identical.
 */
export function claudeArgs(model: string, ws: string, extraDirs: string[] = []): string[] {
  const dirs = [ws, ...extraDirs].flatMap((d) => ["--add-dir", d]);
  return ["-p", "--model", model, ...dirs, "--permission-mode", "acceptEdits"];
}

/**
 * P1-059: fallback decision (pure). Tier B output is only trusted when the
 * process exited cleanly AND produced non-empty output containing the role's
 * completion marker — anything else re-runs the role through tier A.
 */
export function shouldFallbackTierB(r: Pick<RunResult, "ok" | "timedOut" | "output">, marker?: string): boolean {
  if (!r.ok) return true;
  if (r.timedOut) return true;
  if (!r.output.trim()) return true;
  return !!marker && !r.output.includes(marker);
}

/**
 * One tier-B run: `claude -p` with the prompt via stdin (stdin closed after
 * EOF — the proven pattern). Same SIGTERM→SIGKILL timeout ladder as runAgent.
 * `claude -p` may stay silent on stdout until the final answer, so the run
 * feeds touchHeartbeat() on a timer — the self-watchdog must not kill the
 * pilot mid-run (P3-052 lesson applied to a non-streaming spawn).
 */
export async function runTierB(
  model: string,
  prompt: string,
  opts: { cwd: string; timeoutMin: number; extraDirs?: string[] },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("claude", claudeArgs(model, opts.cwd, opts.extraDirs), {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let done = false;
    const stopHeartbeat = startHeartbeat();
    const finish = (r: RunResult) => {
      if (done) return;
      done = true;
      stopHeartbeat();
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, opts.timeoutMin * 60_000);
    child.stdout.on("data", (c: Buffer) => {
      output += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      output += c.toString();
    });
    child.stdin.on("error", () => {}); // early exit → EPIPE on the prompt write
    child.stdin.write(prompt);
    child.stdin.end();
    child.on("exit", (code) => {
      finish({ ok: !timedOut && code === 0, output, timedOut, taskIds: [] });
    });
    child.on("error", (err) => {
      finish({ ok: false, output: output + `\nspawn error: ${String(err)}`, timedOut, taskIds: [], infra: "spawn" });
    });
  });
}

/**
 * P2-114: alert cadence for consecutive tier-B spawn failures — every Nth
 * failure (3rd, 6th, …), never per call: a persistently broken binary must
 * surface without spamming ~1 notify per dispatch.
 */
export const TIERB_SPAWN_ALERT_EVERY = 3;

/** Pure alert rule: true on positive multiples of `every`. */
export function shouldAlertTierBSpawn(streak: number, every = TIERB_SPAWN_ALERT_EVERY): boolean {
  return streak > 0 && streak % every === 0;
}

/** In-memory consecutive-spawn-failure counter (boot health is the doctor's
 * `tierb` probe; no persistence in state.json by design). */
let tierBSpawnStreak = 0;

/**
 * P2-114: fold one tier-B result into the streak. Only `infra: "spawn"` (the
 * child could not be started at all — missing/broken binary) increments; any
 * other outcome (success, timeout, missing marker) resets it, so a slow model
 * never trips the alert — only a genuinely broken spawn does. Returns the new
 * streak.
 */
export function noteTierBOutcome(r: Pick<RunResult, "infra">): number {
  tierBSpawnStreak = r.infra === "spawn" ? tierBSpawnStreak + 1 : 0;
  return tierBSpawnStreak;
}

/** Test seam: reset the module-level streak between hermetic checks. */
export function resetTierBSpawnStreak(): void {
  tierBSpawnStreak = 0;
}

function logDispatch(level: string, msg: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));
}

/**
 * Role-aware dispatch (P1-059): judgment roles (strategist, planner, forensic,
 * reviewer escalation) run the stronger tier-B model when one is configured in
 * pilot.json `models.tierB`; on any tier-B failure (spawn error, timeout, empty
 * output, missing completion marker) the same prompt re-runs through tier A
 * (opencode run) so the pipeline never stalls on tier-B availability. Without
 * a configured tier-B model this is exactly runAgent.
 *
 * Tier-B runs are NON-STREAMING and CONTEXT-LESS (round-2 review): `claude -p`
 * prints its final answer once at the end, so `opts.onStdout` is not wired to
 * tier-B output and no session id is produced — `opts.sessionId` and
 * `opts.onStdout` only take effect when the role dispatches to (or falls back
 * to) tier A. The self-watchdog is fed by runTierB's internal heartbeat timer
 * instead of stdout callbacks.
 *
 * Mission v2: `opts.missionModels` (mission.json → models) is consulted
 * FIRST for the mission roles (strategist, researcher, builder, reviewer,
 * scribe). A pinned model runs through `opencode run --model` only when the
 * live catalog lists it (`catalog`, default fetchAvailableModels); an
 * unknown/unavailable id logs `mission-model-fallback` (warn) and the role
 * proceeds exactly as before (tier table → tier A) — the slot never crashes.
 */
export async function runAgentForRole(
  role: DispatchRole,
  prompt: string,
  opts: AgentRunOpts & {
    models?: unknown;
    marker?: string;
    missionModels?: MissionModels;
    catalog?: () => Promise<Set<string> | null>;
    /** Where mission-model substitutions are recorded (tests inject a tmp path). */
    substitutionsFile?: string;
  },
): Promise<RunResult> {
  // execution roles (builder/reviewer/scribe/researcher) never go tier B —
  // only the judgment roles of P1-059 (strategist is both a mission role and
  // a tier-B role) consult the tier table
  const tierBEligible = !isMissionModelRole(role) || role === "strategist";
  const model = tierBEligible ? tierBModelFor(opts.models as Parameters<typeof tierBModelFor>[0], role as TierBRole) : undefined;
  if (isMissionModelRole(role) && opts.missionModels?.[role]) {
    const available = await (opts.catalog ?? fetchAvailableModels)();
    const pick = pickMissionModel(opts.missionModels, role, available);
    const substFile = opts.substitutionsFile ?? defaultModelSubstitutionsFile();
    if (pick.model !== null) {
      logDispatch("info", "agent-dispatch", { role, tier: "mission", model: pick.model, label: opts.label });
      clearModelSubstitution(substFile, role); // the pin dispatches for real again
      return runAgent(prompt, { ...opts, model: pick.model });
    }
    // Fail-closed to a KNOWN model is right; doing it silently is not — both
    // ids go to the warn line AND to the substitutions record the daemon
    // surfaces on the Mission Control card (so the user learns what ran).
    const usedInstead = model ?? "tier-A default";
    logDispatch("warn", "mission-model-fallback", { role, wanted: pick.wanted, usedInstead, reason: pick.reason, label: opts.label });
    recordModelSubstitution(substFile, { role, wanted: pick.wanted ?? "", usedInstead, reason: pick.reason ?? "", at: nowLocalISO() });
  }
  if (!model) return runAgent(prompt, opts);
  logDispatch("info", "agent-dispatch", { role, tier: "B", model, label: opts.label });
  const r = await runTierB(model, prompt, { cwd: opts.cwd, timeoutMin: opts.timeoutMin, extraDirs: opts.extraDirs });
  // P2-114: a broken `claude` binary only ever produced a warn tierB-fallback
  // line — the pilot once ran ~18h with tier-B dead unnoticed. Count
  // consecutive spawn failures and alert on the Nth.
  const streak = noteTierBOutcome(r);
  if (shouldAlertTierBSpawn(streak)) {
    const detail = `tier-B spawn failed ${streak}x in a row (claude binary?) — falling back to tier A`;
    logDispatch("error", "tierB-spawn-broken", { role, model, streak });
    try {
      emit("phase", { task: "doctor", phase: "tierB-spawn", ok: false, detail });
    } catch {}
    void notifySupervisor("tierB", false, detail).catch(() => {});
  }
  if (!shouldFallbackTierB(r, opts.marker)) return r;
  logDispatch("warn", "tierB-fallback", {
    role,
    model,
    label: opts.label,
    ok: r.ok,
    timedOut: r.timedOut,
    outputLen: r.output.length,
    marker: opts.marker ?? null,
    markerSeen: opts.marker ? r.output.includes(opts.marker) : null,
  });
  return runAgent(prompt, opts);
}
