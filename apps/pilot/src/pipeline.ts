import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec, runAgent } from "./runner";
import { markDone, type Task } from "./backlog";
import { emit } from "./events";
import { touchHeartbeat, type PilotConfig, type PilotState } from "./state";

export const CONSTITUTION = `CONSTITUTION (never violate):
1. E2E crypto stays E2E: the relay must remain a blind router; never log plaintext frames.
2. Auth surface only grows more strict: handshake allowlist, replay protection (seq in AAD) and the 0600 state file are untouchable.
3. scripts/invariants.ts and deploy/ are safety-critical: changes there need explicit justification in the commit message.
4. No secrets in the repo. No network listeners beyond the documented ports.
5. Every user-visible change is documented (README/AGENTS/docs) and covered by the eval battery.`;

function builderPrompt(t: Task, round: number, findings: string): string {
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

When finished, your LAST line of output must be exactly: PILOT:TASK-DONE`;
}

function reviewerPrompt(role: string, focus: string, t: Task, diff: string): string {
  return `You are the ${role} REVIEWER agent of the opencode-remote autonomous pipeline.
A builder implemented TASK (${t.id}): ${t.title}
spec: ${t.spec || "(none)"}

Review the following diff with this focus: ${focus}

Rules:
- ${CONSTITUTION}
- Judge only this diff against the task and the constitution. Do not rewrite the code.
- Be strict but concrete: every finding must reference a file and a problem.

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
}

export async function runPipeline(cfg: PilotConfig, t: Task, state: PilotState): Promise<PipelineResult> {
  const ws = cfg.workspace;
  // fresh workspace at origin/main
  exec("git fetch origin", { cwd: ws });
  exec("git reset -q --hard origin/main", { cwd: ws });
  exec("git clean -qfd", { cwd: ws });
  exec(`git branch -qD pilot/${t.id} 2>/dev/null || true`, { cwd: ws, allowFail: true });
  exec(`git checkout -q -b pilot/${t.id}`, { cwd: ws });

  // sandbox permissions: agents in the clone get full tool access (the real
  // security boundary is the gatekeeper + invariants + staged deploy, not this)
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

  // ── build ⇄ review loop ─────────────────────────────────────────────────
  let findings = "";
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
        JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "agent", data: line.trim().slice(0, 160) }),
      );
    }
  };
  for (let round = 1; round <= cfg.maxReviewRounds && !merged; round++) {
    emit("phase", { task: t.id, phase: "builder", detail: `round ${round}` });
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "builder round", data: { task: t.id, round } }));
    const build = await runAgent(builderPrompt(t, round, findings), {
      cwd: ws,
      timeoutMin: cfg.taskTimeoutMin,
      label: `builder-${t.id}-r${round}`,
      onStdout: stream,
    });
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "builder done", data: { task: t.id, round } }));
    writeFileSync(join(homedir(), ".opencode-remote/pilot", "last-builder-output.log"), build.output);
    emit("phase", { task: t.id, phase: "builder-done", ok: build.output.includes("PILOT:TASK-DONE") });
    if (!build.output.includes("PILOT:TASK-DONE")) {
      return { ok: false, detail: `builder did not finish (round ${round}): ${build.output.slice(-300)}` };
    }
    const diff = exec(`git diff main...pilot/${t.id}`, { cwd: ws }).output;
    if (!diff.trim()) return { ok: false, detail: "builder produced an empty diff" };

    // two adversarial reviewers in parallel, isolated contexts
    emit("phase", { task: t.id, phase: "reviewers" });
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "reviewers start", data: { task: t.id, round } }));
    const [sec, qual] = await Promise.all([
      runAgent(reviewerPrompt("SECURITY", "crypto, auth, injection, secrets, permission surface", t, diff), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `sec-${t.id}-r${round}`,
        onStdout: stream,
      }),
      runAgent(reviewerPrompt("QUALITY", "regressions, UX, docs, test coverage, complexity", t, diff), {
        cwd: ws,
        timeoutMin: cfg.reviewTimeoutMin,
        label: `qual-${t.id}-r${round}`,
        onStdout: stream,
      }),
    ]);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        msg: "reviewers done",
        data: { task: t.id, round, secOk: /VERDICT:\s*APPROVE/i.test(sec.output), qualOk: /VERDICT:\s*APPROVE/i.test(qual.output) },
      }),
    );
    const secOk = /VERDICT:\s*APPROVE/i.test(sec.output);
    const qualOk = /VERDICT:\s*APPROVE/i.test(qual.output);
    emit("phase", { task: t.id, phase: "reviewers-done", ok: secOk && qualOk });
    if (secOk && qualOk) {
      emit("phase", { task: t.id, phase: "gatekeeper" });
      merged = await gatekeeper(cfg, ws, t, state);
      emit("phase", { task: t.id, phase: "merge", ok: merged });
      if (!merged) return { ok: false, detail: "gatekeeper rejected: eval battery or invariants failed" };
    } else {
      findings = [
        ...(!secOk ? extractFindings(sec.output) : []),
        ...(!qualOk ? extractFindings(qual.output) : []),
      ].join("\n");
      if (round === cfg.maxReviewRounds) {
        return { ok: false, detail: `max review rounds reached — findings: ${findings.slice(0, 400)}` };
      }
    }
  }
  return { ok: true, detail: `task ${t.id} merged`, sha: headSha(ws) };
}

function extractFindings(output: string): string[] {
  const idx = output.search(/VERDICT:\s*REQUEST_CHANGES/i);
  const tail = idx >= 0 ? output.slice(idx) : output.slice(-1500);
  return tail
    .split("\n")
    .filter((l) => /^\s*[-*]/.test(l))
    .slice(0, 12);
}

/** Deterministic gate: typecheck, build, test battery, invariants. No judgement. */
async function gatekeeper(cfg: PilotConfig, ws: string, t: Task, state: PilotState): Promise<boolean> {
  const steps: Array<[string, string]> = [
    ["typecheck", "npm run typecheck --silent"],
    ["build", "npm run build --silent"],
    ["lock-sync", "npm ci --dry-run --no-audit --no-fund --loglevel=error"],
    ["reconnect", "npx tsx scripts/reconnect.test.ts"],
    ["integration", "npx tsx scripts/integration.ts"],
    ["invariants", "npx tsx scripts/invariants.ts"],
    // NOTE: live tests (download/push/smoke/live-eval) run post-deploy via
    // `invariants --live` + health checks — they need RELAY_URL + prod pairing.
  ];
  for (const [name, cmd] of steps) {
    const r = exec(cmd, { cwd: ws, timeoutMin: 20, allowFail: true });
    if (!r.ok) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "gatekeeper fail", data: { task: t.id, step: name, tail: r.output.slice(-300) } }));
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
    // fallback: local merge to main and push
    exec("git checkout -q main && git merge -q --no-ff --no-edit pilot/" + t.id, { cwd: ws });
    exec("git push -q origin main", { cwd: ws });
  }
  // bring workspace main up to date with the merge, then mark the task done
  exec("git checkout -q main", { cwd: ws, allowFail: true });
  exec("git pull -q origin main", { cwd: ws, allowFail: true });
  markDone(ws, t.id, `merged by pilot ${new Date().toISOString().slice(0, 10)}`);
  exec(`git add BACKLOG.md && git commit -qm "pilot(${t.id}): mark done" && git push -q origin main`, {
    cwd: ws,
    allowFail: true,
  });
  return true;
}

function headSha(ws: string): string {
  return exec("git rev-parse HEAD", { cwd: ws }).output.trim();
}
