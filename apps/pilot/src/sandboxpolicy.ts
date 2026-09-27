/**
 * eval-15 (red team): the opencode permission policy written into every
 * pilot workspace before a headless builder/reviewer/planner/explorer run
 * (writeSandboxConfig in pipeline.ts).
 *
 * The old policy was `external_directory: "allow"` + `bash: "allow"`, on the
 * premise that the real boundary is the gate. The gate guards what MERGES; it
 * never guarded what an agent does on the host while it works, and the
 * builder logs show what that meant in production: builders read the
 * operator journal (~/.opencode-remote/memory.md) in 27 tasks, printed the
 * production daemon.json — E2E identity private key included — into their
 * output (4 runs), tailed the production daemon.log with its pairing URI,
 * reset macOS privacy grants (`tccutil reset … com.github.Electron`), killed a
 * system process (killall UserNotificationCenter) and, on 2026-09-23 (P2-347), killed the
 * production daemon with a probe's pattern kill.
 *
 * This policy keeps the work surface intact — the workspace clone itself is
 * never "external", and the external directories builders actually use
 * (evidence shots, pilot scratch, the temp dirs) stay open — and denies the
 * rest: every other directory outside the clone (the private state under
 * ~/.opencode-remote, the live judge, sibling slot clones, ~/.ssh, …) and the
 * commands that reach production or the owner's OS state. It is opencode's
 * tool-level gate, so it stops what the agents did in those logs (direct
 * reads, `cat` of private files, shell pattern kills); a program the agent
 * writes and runs is outside its reach — that needs OS-level isolation
 * (sandbox-exec / a dedicated user), an owner decision documented in the
 * eval-15 report.
 *
 * Pure: builds plain objects (no fs, no env reads) so the unit battery pins
 * the exact policy. opencode evaluates rules in order and the LAST matching
 * rule wins, so each object opens with its "*" default and lists the
 * specific overrides after it.
 */

export type PermissionAction = "allow" | "ask" | "deny";

/**
 * Commands no headless pilot agent may run. Production service control and
 * network exposure (launchctl, tailscale), pattern kills that cannot tell a
 * test server from the production daemon (pkill/killall — kill a PID you
 * spawned instead), macOS privacy, keychain and automation surfaces
 * (tccutil, security, osascript), privilege escalation, persistence and
 * lateral movement, and every git/gh/npm write the pipeline itself owns (the
 * builder prompt already says "do NOT push"; read-only `gh run view`,
 * `gh pr view`, `gh api` GETs stay available for CI logs).
 */
export const DENIED_COMMANDS: readonly string[] = [
  "launchctl*",
  "tailscale*",
  "pkill*",
  "killall*",
  "tccutil*",
  "security*",
  "osascript*",
  "sudo*",
  "su *",
  "crontab*",
  "ssh *",
  "scp *",
  "sftp *",
  "git push*",
  "gh auth*",
  "gh pr merge*",
  "gh pr create*",
  "gh pr close*",
  "gh pr edit*",
  "gh pr ready*",
  "gh pr review*",
  "gh pr comment*",
  "gh issue*",
  "gh release*",
  "gh repo*",
  "gh secret*",
  "gh variable*",
  "gh workflow*",
  "gh api *-X*",
  "gh api *--method*",
  "gh api *-f *",
  "gh api *-F *",
  "gh api *--field*",
  "gh api *--raw-field*",
  "gh api *--input*",
  "npm publish*",
  "npm unpublish*",
  "npm deprecate*",
  "npm dist-tag*",
  "npm owner*",
  "npm token*",
  "npm login*",
  "npm adduser*",
];

/**
 * External directories a pilot agent may touch, relative to `home`. The
 * shots tree carries the builder's UI evidence and the explorer's journey
 * shots; pilot/tmp is the pipeline's scratch; the rest are the system temp
 * dirs (os.tmpdir() lives under /var/folders on macOS).
 */
export function allowedExternalDirs(home: string): string[] {
  const state = `${home.replace(/\/+$/, "")}/.opencode-remote`;
  return [
    `${state}/pilot/shots/*`,
    `${state}/pilot/tmp/*`,
    "/tmp/*",
    "/private/tmp/*",
    "/var/folders/*",
    "/private/var/folders/*",
  ];
}

/** The `permission` block for full-tool pilot agents (builder, reviewers,
 * planner, explorer, fable fallback). */
export function workspacePermission(home: string): Record<string, unknown> {
  const bash: Record<string, PermissionAction> = { "*": "allow" };
  for (const c of DENIED_COMMANDS) bash[c] = "deny";
  const external: Record<string, PermissionAction> = { "*": "deny" };
  for (const d of allowedExternalDirs(home)) external[d] = "allow";
  return { edit: "allow", bash, external_directory: external, webfetch: "allow" };
}

/** The `permission` block for aux agents that ingest untrusted content
 * (researcher, strategist, red team, scribe, forensic fallback) — P1-057:
 * text-only runs, nothing but webfetch. */
export function auxPermission(): Record<string, unknown> {
  return { edit: "deny", bash: "deny", external_directory: "deny", webfetch: "allow" };
}
