import { spawn, execSync } from "node:child_process";

export interface RunResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
  sessionId?: string;
}

/**
 * Run one opencode agent headlessly. `prompt` is the full role instruction;
 * the agent works in `cwd` with its own session and no human interaction.
 * Pass `resumeSession` to continue a previous session — the agent keeps its
 * context of files read and decisions made (true context cache across rounds).
 */
export function runAgent(
  prompt: string,
  opts: { cwd: string; timeoutMin: number; label: string; sessionId?: string; printLogs?: boolean; onStdout?: (chunk: string) => void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const args = ["run"];
    if (opts.printLogs) args.push("--print-logs"); // exposes the session id for context-cache resumes
    if (opts.sessionId) args.push("-s", opts.sessionId);
    args.push(prompt);
    const child = spawn("opencode", args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"], // stdin MUST be closed: opencode waits for EOF
    });
    let output = "";
    let timedOut = false;
    let sessionId: string | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, opts.timeoutMin * 60_000);
    const scanSession = (c: string) => {
      if (!sessionId) {
        const m = c.match(/ses_[A-Za-z0-9]+/);
        if (m) sessionId = m[0];
      }
    };
    child.stdout.on("data", (c: Buffer) => {
      output += c.toString();
      scanSession(c.toString());
      opts.onStdout?.(c.toString());
    });
    child.stderr.on("data", (c: Buffer) => {
      output += c.toString();
      scanSession(c.toString());
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve({ ok: !timedOut, output, timedOut, sessionId });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: output + `\nspawn error: ${String(err)}`, timedOut });
    });
  });
}

export function exec(
  cmd: string,
  opts: { cwd: string; timeoutMin?: number; allowFail?: boolean },
): { ok: boolean; output: string } {
  try {
    const out = Bun_shim_execSync(cmd, opts);
    return { ok: true, output: out };
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
    const output = `${e.stdout?.toString() ?? ""}${e.stderr?.toString() ?? ""}`;
    if (opts.allowFail) return { ok: false, output };
    throw new Error(`exec failed (status ${e.status}): ${cmd}\n${output.slice(-4000)}`);
  }
}

function Bun_shim_execSync(cmd: string, opts: { cwd: string; timeoutMin?: number }): string {
  return execSync(cmd, {
    cwd: opts.cwd,
    encoding: "utf8",
    timeout: (opts.timeoutMin ?? 10) * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  }) as unknown as string;
}
