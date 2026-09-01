import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { exec, runAgent } from "./runner";
import { nowLocalISO } from "./log";
import { markDone, type Task } from "./backlog";
import { emit } from "./events";
import { latestUiShot } from "./shot";
import { touchHeartbeat, type PilotConfig, type PilotState } from "./state";

export const CONSTITUTION = `CONSTITUTION (never violate):
1. E2E crypto stays E2E: the relay must remain a blind router; never log plaintext frames.
2. Auth surface only grows more strict: handshake allowlist, replay protection (seq in AAD) and the 0600 state file are untouchable.
3. scripts/invariants.ts and deploy/ are safety-critical: changes there need explicit justification in the commit message.
4. No secrets in the repo. No network listeners beyond the documented ports.
5. Every user-visible change is documented (README/AGENTS/docs) and covered by the eval battery.`;

function builderPrompt(t: Task, round: number, findings: string): string {
  const uiTask = t.area === "ui" || t.area === "desktop";
  return `You are the BUILDER agent of the opencode-remote autonomous pipeline (round ${round}).
Work inside this repository (your cwd is a dedicated clone; production runs elsewhere).

TASK (${t.id}) [${t.priority}]: ${t.title}
spec: ${t.spec || "(no extra spec — use judgement, keep the change small and shippable)"}
${findings ? `\nREVIEWER FINDINGS TO ADDRESS:\n${findings}\n` : ""}

Rules:
- ${CONSTITUTION}
- Create/keep working on branch pilot/${t.id}. Commit your work with a conventional message "pilot(${t.id}): ...".
- Run "npm run typecheck" and "npm run build" and fix any errors before committing.
- Document user-visible changes in the relevant docs (README.md / AGENTS.md / docs/).
- Do NOT push, do NOT touch production services, do NOT modify BACKLOG.md.
- Keep the diff focused: one task, no drive-by refactors.
${round > 1 ? `- Rounds 1..${round - 1} already committed work on this branch. Inspect it first with \`git diff main...pilot/${t.id}\` and fix the findings INCREMENTALLY — do not restart from scratch or re-read files you already understand.` : ""}${
    uiTask
      ? `\n- UI self-driving (P2-011): this task changes the UI. Validate your own output visually before finishing: build the app, then use the host browser CLI — \`node tools/browse.mjs open <url> ~/.opencode-remote/pilot/shots/builder/${t.id}-r${round}.png\` — and inspect the PNG. Mention the screenshot path in your final output. This is YOUR pre-merge self-check; post-deploy evidence is captured separately by the pipeline.`
      : ""
  }

When finished, your LAST line of output must be exactly: PILOT:TASK-DONE`;
}

function reviewerPrompt(role: string, focus: string, t: Task, diff: string, uiShot: string | null): string {
  return `You are the ${role} REVIEWER agent of the opencode-remote autonomous pipeline.
A builder implemented TASK (${t.id}): ${t.title}
spec: ${t.spec || "(none)"}

Review the following diff with this focus: ${focus}

Rules:
- ${CONSTITUTION}
- Judge only this diff against the task and the constitution. Do not rewrite the code.
- Be strict but concrete: every finding must reference a file and a problem.
- Cite or it didn't happen (P2-015): every finding bullet must cite a repo-relative
  \`path/file.ext:LINE\` (line matching the workspace files) or quote a literal snippet
  from the diff. Findings without a verifiable citation are mechanically dropped as
  hallucinated; a reviewer whose findings ALL fail verification counts as APPROVE.
${
  uiShot
    ? `- UI evidence (P2-011): the most recent available screenshot for this task is "${uiShot}". It may predate this diff (captured after an earlier deploy) — treat it as a regression baseline, not proof of this diff. Read it (it is an image), say what it shows, and state explicitly whether the diff could plausibly regress it. You can take a fresh screenshot of your local build: \`node tools/browse.mjs shot <path>.png\`.`
    : ""
}

Your LAST lines must be exactly one of:
VERDICT: APPROVE
or
VERDICT: REQUEST_CHANGES
followed by a bullet list of findings.

DIFF:
\`\`\`diff
${diff.slice(0, 60_000)}
\`\`\``;
}

export interface PipelineResult {
  ok: boolean;
  detail: string;
  sha?: string;
  /** P2-011: true when the merged diff touched the UI (apps/web | apps/desktop)
   * — triggers a post-deploy screenshot for the review log. */
  touchedUi?: boolean;
}

/** Task IDs come from BACKLOG.md; only this charset ever reaches a shell command. */
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * P2-011: does this diff (from `git diff --name-only`) touch the UI surfaces?
 * Pure function so the eval battery can pin the acceptance criterion: a
 * UI-changing cycle must produce a post-deploy screenshot.
 */
export function touchedUiFromDiff(nameOnly: string): boolean {
  return nameOnly
    .split("\n")
    .some((l) => l.trim().startsWith("apps/web/") || l.trim().startsWith("apps/desktop/"));
}

/**
 * P1-006: per-task gatekeeper failure file (path-safe: id is TASK_ID_RE-checked).
 * Concurrent slots must not overwrite each other's carryover findings.
 */
function gateFailFile(taskId: string): string | null {
  if (!TASK_ID_RE.test(taskId)) return null;
  return join(homedir(), ".opencode-remote/pilot/gate-fail", `${taskId}.json`);
}

/**
 * P1-006: the gate battery (reconnect/integration) binds fixed eval ports and
 * the merge pushes to main — run the whole gatekeeper exclusively across
 * concurrent slots. Builders/reviewers stay parallel; only the gate queues.
 */
let gateLock: Promise<void> = Promise.resolve();
function runGateExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = gateLock;
  let release!: () => void;
  gateLock = new Promise<void>((r) => (release = r));
  return prev.then(fn).finally(release);
}

/** Sandbox permissions: agents in the clone get full tool access. Must exist for
 * EVERY headless run (builder, reviewers, strategist) or opencode aborts on the
 * first permission-requiring action — `git clean` removes it after each sync. */
export function writeSandboxConfig(ws: string) {
  writeFileSync(
    join(ws, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        permission: { edit: "allow", bash: "allow", external_directory: "allow", webfetch: "allow" },
      },
      null,
      2,
    ),
  );
}

export async function runPipeline(cfg: PilotConfig, t: Task, state: PilotState): Promise<PipelineResult> {
  const ws = cfg.workspace;
  // central injection guard: t.id is interpolated into shell commands below
  if (!TASK_ID_RE.test(t.id)) return { ok: false, detail: `invalid task id: ${t.id}` };
  // fresh workspace at origin/main
  exec("git fetch origin", { cwd: ws });
  exec("git reset -q --hard origin/main", { cwd: ws });
  exec("git clean -qfd", { cwd: ws });
  exec(`git branch -qD pilot/${t.id} 2>/dev/null || true`, { cwd: ws, allowFail: true });
  exec(`git checkout -q -b pilot/${t.id}`, { cwd: ws });

  // sandbox permissions: agents in the clone get full tool access (the real
  // security boundary is the gatekeeper + invariants + staged deploy, not this)
  writeSandboxConfig(ws);

  // ── build ⇄ review loop ─────────────────────────────────────────────────
  let findings = "";
  let touchedUi = false;
  let builderSession: string | undefined;
  // carry over the last gatekeeper failure for this task, so the builder can
  // fix the exact failing step instead of rediscovering it (per-task file)
  const failFile = gateFailFile(t.id);
  try {
    if (failFile) {
      const prev = JSON.parse(readFileSync(failFile, "utf8")) as { task?: string; tail?: string };
      if (prev.task === t.id && prev.tail) findings += `[previous gatekeeper failure]\n${prev.tail}\n`;
    }
  } catch {}
  let merged = false;
  let lastStream = 0;
  const stream = (chunk: string) => {
    touchHeartbeat();
    const now = Date.now();
    if (now - lastStream < 10_000) return;
    lastStream = now;
    const lines = chunk.split("\n").filter((l) => l.trim());
    const line = lines[lines.length - 1];
    if (line) {
      emit("agent", { task: t.id, detail: line.trim() });
      console.log(
        JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "agent", data: line.trim().slice(0, 400) }),
      );
    }
  };
  for (let round = 1; round <= cfg.maxReviewRounds && !merged; round++) {
    emit("phase", { task: t.id, phase: "builder", detail: `round ${round}` });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "builder round", data: { task: t.id, round } }));
    const build = await runAgent(builderPrompt(t, round, findings), {
      cwd: ws,
      timeoutMin: cfg.taskTimeoutMin,
      label: `builder-${t.id}-r${round}`,
      sessionId: builderSession, // context cache: resume the same session across rounds
      printLogs: true,
      onStdout: stream,
    });
    if (build.sessionId) builderSession = build.sessionId;
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "builder done", data: { task: t.id, round } }));
    // per-task diagnostic log: concurrent slots would clobber a shared file
    writeFileSync(join(homedir(), ".opencode-remote/pilot", `builder-${t.id}.log`), build.output);
    emit("phase", { task: t.id, phase: "builder-done", ok: build.output.includes("PILOT:TASK-DONE") });
    if (!build.output.includes("PILOT:TASK-DONE")) {
      return { ok: false, detail: `builder did not finish (round ${round}): ${build.output.slice(-300)}` };
    }
    // --name-only: unified diff lines are prefixed (a/, b/, diff --git) and
    // would never match a bare path — round-2 review caught exactly that.
    const diff = exec(`git diff main...pilot/${t.id}`, { cwd: ws }).output;
    touchedUi = touchedUiFromDiff(exec(`git diff --name-only main...pilot/${t.id}`, { cwd: ws }).output);
    // P2-011: UI tasks get visual evidence — per-task, post-deploy shape only
    // (round-3 review: unscoped mtime pick could serve another task's stale
    // shot or a builder's pre-merge self-shot as "deployed UI" evidence).
    const uiShot = touchedUi ? latestUiShot(t.id) : null;
    if (!diff.trim()) {
      // empty-diff self-heal: builder ran after the task was already merged.
      // Refresh origin/main first so the merge check below isn't fooled by a
      // stale local ref (transient network failure → best-effort check).
      exec("git fetch -q origin main", { cwd: ws, allowFail: true });
      if (!taskMergedIn(ws, t.id)) return { ok: false, detail: "builder produced an empty diff" };
      emit("phase", { task: t.id, phase: "already-merged" });
      console.log(
        JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "empty diff but task already merged, self-healing", data: { task: t.id } }),
      );
      // clean worktree BEFORE moving to main: a dirty empty-diff workspace
      // would otherwise dirty the wrong branch or block the checkout
      exec("git reset -q --hard HEAD", { cwd: ws, allowFail: true });
      exec("git clean -qfd", { cwd: ws, allowFail: true });
      const co = exec("git checkout -q -B main origin/main", { cwd: ws, allowFail: true });
      let push = { ok: false, output: "" };
      if (co.ok) {
        markDone(ws, t.id, `already merged — empty-diff self-heal ${nowLocalISO().slice(0, 10)}`);
        exec("git add BACKLOG.md", { cwd: ws, allowFail: true });
        // idempotent: if markDone was a no-op (task already marked), skip the
        // commit instead of failing on an empty commit
        const staged = exec("git diff --cached --quiet", { cwd: ws, allowFail: true });
        if (!staged.ok) {
          exec(`git commit -qm "pilot(${t.id}): mark done (empty-diff self-heal)"`, { cwd: ws, allowFail: true });
          // PERMISSION-SURFACE NOTE (constitution #3 spirit): direct push to
          // origin/main outside the reviewer/gatekeeper path — kept restricted
          // to this bookkeeping path (only BACKLOG.md staged, fixed message).
          push = exec("git push -q origin main", { cwd: ws, allowFail: true });
        } else {
          push = { ok: true, output: "" };
        }
      }
      return {
        ok: co.ok && push.ok,
        detail: !co.ok
          ? `task ${t.id} already merged on main but workspace checkout failed`
          : push.ok
            ? `task ${t.id} already merged on main — marked done (empty-diff self-heal)`
            : `task ${t.id} already merged but BACKLOG update failed`,
      };
    }

    // preflight: a broken build must never reach the reviewers (they cost LLM
    // tokens and would only re-report the same typecheck errors)
    const pre = exec("npm run typecheck --silent", { cwd: ws, timeoutMin: 10, allowFail: true });
    if (!pre.ok) {
      findings = `${findings}\n[typecheck still failing — fix these first]\n${pre.output.slice(-1500)}`;
      emit("phase", { task: t.id, phase: "builder", detail: "preflight typecheck failed → next round", ok: false });
      continue;
    }

    // two adversarial reviewers in parallel, isolated contexts
    emit("phase", { task: t.id, phase: "reviewers" });
    console.log(JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "reviewers start", data: { task: t.id, round } }));
    const [sec, qual] = await Promise.all([
      runAgent(reviewerPrompt("SECURITY", "crypto, auth, injection, secrets, permission surface", t, diff, uiShot), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `sec-${t.id}-r${round}`,
        onStdout: stream,
      }),
      runAgent(reviewerPrompt("QUALITY", "regressions, UX, docs, test coverage, complexity", t, diff, uiShot), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `qual-${t.id}-r${round}`,
        onStdout: stream,
      }),
    ]);
    console.log(
      JSON.stringify({
        ts: nowLocalISO(),
        level: "info",
        msg: "reviewers done",
        data: { task: t.id, round, secOk: /VERDICT:\s*APPROVE/i.test(sec.output), qualOk: /VERDICT:\s*APPROVE/i.test(qual.output) },
      }),
    );
    const secParsed = parseFindings(sec.output);
    const qualParsed = parseFindings(qual.output);
    // P2-015: reviewers are LLMs — findings citing files/lines that don't exist
    // (or snippets absent from the diff) are mechanically dropped. A verdict
    // whose findings all fail verification degenerates to an effective APPROVE.
    const secVerified = verifyFindings(secParsed, ws, diff);
    const qualVerified = verifyFindings(qualParsed, ws, diff);
    for (const d of secVerified.dropped) logHallucination(t.id, "security", d);
    for (const d of qualVerified.dropped) logHallucination(t.id, "quality", d);
    const approve = (o: string) => /VERDICT:\s*APPROVE/i.test(o);
    const allDropped = (o: string, v: { kept: string[]; dropped: string[] }) =>
      /VERDICT:\s*REQUEST_CHANGES/i.test(o) && v.dropped.length > 0 && v.kept.length === 0;
    const secOk = approve(sec.output) || allDropped(sec.output, secVerified);
    const qualOk = approve(qual.output) || allDropped(qual.output, qualVerified);
    if (allDropped(sec.output, secVerified) || allDropped(qual.output, qualVerified)) {
      console.log(
        JSON.stringify({
          ts: nowLocalISO(),
          level: "info",
          msg: "review findings all unverifiable → effective approve",
          data: { task: t.id, round },
        }),
      );
    }
    emit("phase", { task: t.id, phase: "reviewers-done", ok: secOk && qualOk });
    if (secOk && qualOk) {
      emit("phase", { task: t.id, phase: "gatekeeper" });
      // serialized across slots: fixed battery ports + main push (P1-006)
      merged = await runGateExclusive(() => gatekeeper(cfg, ws, t, state));
      emit("phase", { task: t.id, phase: "merge", ok: merged });
      if (merged) {
        // gate passed — the per-task carryover file has no reason to linger
        const f = gateFailFile(t.id);
        if (f) {
          try {
            rmSync(f);
          } catch {}
        }
      }
      if (!merged) return { ok: false, detail: "gatekeeper rejected: eval battery or invariants failed" };
    } else {
      // only verified findings reach the builder prompt (P2-015)
      findings = [...(secOk ? [] : secVerified.kept), ...(qualOk ? [] : qualVerified.kept)].join("\n");
      if (round === cfg.maxReviewRounds) {
        return { ok: false, detail: `max review rounds reached — findings: ${findings.slice(0, 400)}` };
      }
    }
  }
  return { ok: true, detail: `task ${t.id} merged`, sha: headSha(ws), touchedUi };
}

/** P2-015: findings are the bullet lines after (or near) the verdict marker. */
export function parseFindings(output: string): string[] {
  const idx = output.search(/VERDICT:\s*REQUEST_CHANGES/i);
  const tail = idx >= 0 ? output.slice(idx) : output.slice(-1500);
  return tail
    .split("\n")
    .filter((l) => /^\s*[-*]/.test(l))
    .slice(0, 12);
}

export interface VerifiedFindings {
  kept: string[];
  dropped: string[];
}

/**
 * P2-015 anti-hallucination filter. A finding is resolvable when:
 *  - it cites only repo-relative files that exist in `ws` (every file citation
 *    must resolve; a cited line, when present, must be non-empty); or
 *  - it cites no file but quotes a literal snippet (≥6 chars) that appears
 *    verbatim in the reviewed diff.
 * Pure in spirit — fs reads only touch the workspace, so the eval battery can
 * pin this against fake findings (one real path, one nonexistent).
 */
export function verifyFindings(findings: string[], ws: string, diff: string): VerifiedFindings {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const f of findings) {
    if (findingResolves(f, ws, diff)) kept.push(f);
    else dropped.push(f);
  }
  return { kept, dropped };
}

interface FileCite {
  path: string;
  line?: number;
}

/** Known source extensions keep prose words ("e.g", "v1.2") out of citations. */
const KNOWN_EXT = "ts|tsx|js|jsx|mjs|cjs|json|md|css|html?|sh|py|rb|go|rs|java|ya?ml|toml|sql|txt|xml|svg";
const FILE_CITE_RE = new RegExp(`(\\b[\\w@][\\w@./+-]*\\.(?:${KNOWN_EXT}))(?::(\\d+))?`, "g");
const SNIPPET_RES = [/"([^"\n]{6,})"/g, /`([^`\n]{6,})`/g];

function findingResolves(finding: string, ws: string, diff: string): boolean {
  // URLs are not file citations; they would only produce phantom paths
  const cleaned = finding.replace(/https?:\/\/\S+/g, " ");
  const fileCites: FileCite[] = [...cleaned.matchAll(FILE_CITE_RE)].map((m) => ({
    path: m[1] ?? "", // group 1 always matches when the regex matched
    line: m[2] !== undefined ? Number(m[2]) : undefined,
  }));
  if (fileCites.length > 0) return fileCites.every((c) => pathResolves(ws, c.path, c.line));
  return SNIPPET_RES.some((re) => [...cleaned.matchAll(re)].some((m) => m[1] !== undefined && diff.includes(m[1])));
}

function pathResolves(ws: string, rawPath: string, line: number | undefined): boolean {
  // unified-diff prefixes + traversal attempts are never valid citations
  const rel = rawPath.replace(/^(?:\.\/)+/, "").replace(/^(?:a|b)\//, "");
  if (rel.includes("..")) return false;
  let lines: string[];
  try {
    if (!existsSync(join(ws, rel))) return false;
    lines = readFileSync(join(ws, rel), "utf8").split("\n");
  } catch {
    return false;
  }
  if (line === undefined) return true;
  const l = lines[line - 1];
  return l !== undefined && l.trim().length > 0;
}

function logHallucination(task: string, reviewer: string, finding: string) {
  console.log(
    JSON.stringify({
      ts: nowLocalISO(),
      level: "warn",
      msg: "finding hallucinated, dropped",
      data: { task, reviewer, finding: finding.trim().slice(0, 200) },
    }),
  );
}

/** Deterministic gate: typecheck, build, test battery, invariants. No judgement. */
async function gatekeeper(cfg: PilotConfig, ws: string, t: Task, state: PilotState): Promise<boolean> {
  const steps: Array<[string, string]> = [
    ["typecheck", "npm run typecheck --silent"],
    ["build", "npm run build --silent"],
    ["unit", "npm run test:unit --silent"],
    ["lock-sync", "npm ci --dry-run --no-audit --no-fund --loglevel=error"],
    ["reconnect", "npx tsx scripts/reconnect.test.ts"],
    ["integration", "npx tsx scripts/integration.ts"],
    ["desktop-sidecar", "npx tsx scripts/desktop-sidecar.test.ts"],
    ["invariants", "npx tsx scripts/invariants.ts"],
    // NOTE: live tests (download/push/smoke/live-eval) run post-deploy via
    // `invariants --live` + health checks — they need RELAY_URL + prod pairing.
  ];
  // Desktop render smoke (P0-002): when the diff touches the desktop shell or
  // the web UI it renders, go beyond process boot — did-finish-load + renderer
  // console capture + #root mounted content — so a white window (e.g. asset
  // 404 on file://) is rejected. Most white-window regressions come from
  // apps/web/-only changes, hence the second trigger. Fail closed: when the
  // diff cannot be computed, run the smoke anyway instead of skipping it.
  const diff = exec(`git diff --name-only main...pilot/${t.id}`, { cwd: ws, allowFail: true });
  const renderTouched =
    !diff.ok ||
    diff.output.split("\n").some((l) => {
      const p = l.trim();
      return p.startsWith("apps/desktop/") || p.startsWith("apps/web/");
    });
  if (renderTouched) {
    steps.push(["desktop-render", "npx tsx scripts/desktop-render.test.ts"]);
  }
  for (const [name, cmd] of steps) {
    const r = exec(cmd, { cwd: ws, timeoutMin: 20, allowFail: true });
    if (!r.ok) {
      console.log(JSON.stringify({ ts: nowLocalISO(), level: "warn", msg: "gatekeeper fail", data: { task: t.id, step: name, tail: r.output.slice(-300) } }));
      const failFile = gateFailFile(t.id);
      if (failFile) {
        try {
          mkdirSync(dirname(failFile), { recursive: true });
          writeFileSync(
            failFile,
            JSON.stringify({ task: t.id, step: name, tail: r.output.slice(-1200), at: nowLocalISO() }, null, 2),
          );
        } catch {}
      }
      state.failures++;
      return false;
    }
  }
  // merge via GitHub PR for audit trail
  const title = `pilot(${t.id}): ${t.title}`;
  exec(`git push -q origin pilot/${t.id}`, { cwd: ws, allowFail: true });
  const pr = exec(
    `gh pr create --head pilot/${t.id} --title ${JSON.stringify(title)} --body ${JSON.stringify("Autonomous pipeline merge — gatekeeper green (typecheck, build, reconnect, integration, invariants, download).")}`,
    { cwd: ws, timeoutMin: 5, allowFail: true },
  );
  if (pr.ok) {
    const merge = exec("gh pr merge --squash --delete-branch --auto || gh pr merge --squash --delete-branch", {
      cwd: ws,
      timeoutMin: 5,
      allowFail: true,
    });
    if (!merge.ok) return false;
  } else {
    // fallback: local merge to main and push. origin/main may have moved
    // (concurrent slot/aux pushes): fetch + retry so a non-fast-forward never
    // crashes a post-green pipeline with an unhandled exec error.
    let pushed = false;
    for (let i = 0; i < 3 && !pushed; i++) {
      exec("git fetch -q origin", { cwd: ws, allowFail: true });
      exec("git checkout -q main", { cwd: ws, allowFail: true });
      // reset --hard also clears a conflicted-merge state from a prior attempt
      const base = exec("git reset -q --hard origin/main", { cwd: ws, allowFail: true });
      const merge = exec(`git merge -q --no-ff --no-edit pilot/${t.id}`, { cwd: ws, allowFail: true });
      if (!base.ok || !merge.ok) break; // conflict — only a full pipeline round fixes it
      pushed = exec("git push -q origin main", { cwd: ws, allowFail: true }).ok;
    }
    if (!pushed) return false; // branch is on origin; the next cycle re-runs the task
  }
  // bring workspace main up to date with the merge, then mark the task done
  exec("git checkout -q main", { cwd: ws, allowFail: true });
  exec("git pull -q origin main", { cwd: ws, allowFail: true });
  markDone(ws, t.id, `merged by pilot ${nowLocalISO().slice(0, 10)}`);
  exec(`git add BACKLOG.md && git commit -qm "pilot(${t.id}): mark done" && git push -q origin main`, {
    cwd: ws,
    allowFail: true,
  });
  return true;
}

function headSha(ws: string): string {
  return exec("git rev-parse HEAD", { cwd: ws }).output.trim();
}

/**
 * True when a commit on origin/main has the canonical subject `pilot(<id>): ...`.
 * The id is validated against TASK_ID_RE (never reaches a shell unchecked) and
 * regex-escaped, then matched as a line-anchored ERE — so body/revert references
 * to the id don't count as "merged".
 */
export function taskMergedIn(ws: string, id: string): boolean {
  if (!TASK_ID_RE.test(id)) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = exec(`git log origin/main --extended-regexp --grep='^pilot\\(${escaped}\\):' --oneline`, {
    cwd: ws,
    allowFail: true,
  });
  return r.ok && r.output.trim().length > 0;
}
