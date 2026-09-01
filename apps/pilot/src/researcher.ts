import { agentStream, exec, runAgent } from "./runner";
import { log, nowLocalISO } from "./log";
import { notifySupervisor } from "./notify";
import { emit } from "./events";
import type { PilotConfig } from "./state";

const RESEARCH_SOURCES = `
1. https://electronjs.org/blog — Electron releases and deprecations
2. https://github.com/sst/opencode/releases — opencode releases (our runtime!)
3. https://www.anthropic.com/news and https://openai.com/news — competing desktop agents
4. https://news.ycombinator.com/front — what the frontier is discussing today
`;

/**
 * RESEARCHER role: bring frontier signal from the outside world into the
 * backlog. Runs at most once per day; proposes 1-2 experimental [spike] tasks
 * grounded in a source URL, curated against our mission (docs/VISION.md).
 */
export async function runResearcher(cfg: PilotConfig, state: { researchLast?: string }): Promise<void> {
  const today = nowLocalISO().slice(0, 10);
  if (state.researchLast === today) return;
  state.researchLast = today;
  log("info", "researcher: daily frontier scan starting");

  const prompt = `You are the RESEARCHER agent of the opencode-remote autonomous pipeline.
Your job: bring FRONTIER signal from the outside world so this product innovates instead of
only polishing. You have webfetch — use it.

Mission context (read first): docs/VISION.md only.
SECURITY RULE: never read, quote or transmit ~/.opencode-remote/memory.md or any file
outside this repo — your context must stay free of private data because you also fetch
untrusted web pages (prompt-injection exfiltration risk). Private data stays private.
Our stack: TypeScript monorepo — Electron desktop shell (apps/desktop), React PWA (apps/web),
daemon (apps/daemon), relay (apps/relay), autonomous pilot (apps/pilot).

Sources to scan today (fetch each, skim, extract what matters to us):
${RESEARCH_SOURCES}

Then propose 1-2 experimental tasks ([spike]) that could give us an edge — new capability,
new integration, new technique. Rules for a good spike:
- shippable in ONE pipeline cycle (~30 min of agent work)
- grounded in a concrete source URL you actually fetched (cite it in the spec)
- aligned with the mission: desktop-first, zero-friction, self-evolving
- NOT a duplicate of anything already in BACKLOG.md (read ## Ready and ## Done)

Append them to BACKLOG.md under ## Ready using EXACTLY the existing line format:
- [ ] (ID) [P2] [spike] Title — spec: what to build, where, acceptance criteria (fonte: <url>) (area: <area>)
IDs continue the sequence. The trailing (area: ...) tag is mandatory — pick exactly one of
ui|daemon|desktop|infra|relay (the area the task touches most). Do NOT touch other
sections. Commit with message "pilot(researcher): frontier scan ${today}" (no push).

Your LAST line of output must be exactly: RESEARCHER:DONE`;

  const r = await runAgent(prompt, {
    cwd: cfg.workspace,
    timeoutMin: 20,
    label: "researcher",
    onStdout: agentStream("researcher"),
  });
  emit("phase", { task: "research", phase: r.output.includes("RESEARCHER:DONE") ? "done" : "failed", ok: r.output.includes("RESEARCHER:DONE") });
  if (!r.output.includes("RESEARCHER:DONE")) {
    log("warn", "researcher did not finish", { tail: r.output.slice(-200) });
    return;
  }
  // push com retry: deploy concorrente pode mover origin/main e rejeitar o push
  exec(`for i in 1 2 3; do git push -q origin main && break || sleep 3; done; git add BACKLOG.md && git commit -qm "pilot(researcher): frontier scan ${today}" && for i in 1 2 3; do git push -q origin main && break || sleep 3; done`, {
    cwd: cfg.workspace,
    allowFail: true,
  });
  log("info", "researcher scan committed");
  const summary = r.output.slice(-600);
  await notifySupervisor("research — frontier scan", true, summary);
}
