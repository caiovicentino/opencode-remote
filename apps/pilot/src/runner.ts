import { spawn, execSync } from "node:child_process";

export interface RunResult {
  ok: boolean;
  output: string;
  timedOut: boolean;
}

/**
 * Run one opencode agent headlessly. `prompt` is the full role instruction;
 * the agent works in `cwd` with its own session and no human interaction.
 */
export function runAgent(
  prompt: string,
  opts: { cwd: string; timeoutMin: number; label: string; onStdout?: (chunk: string) => void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("opencode", ["run", prompt], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"], // stdin MUST be closed: opencode waits for EOF
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, opts.timeoutMin * 60_000);
    child.stdout.on("data", (c: Buffer) => {
      output += c.toString();
      opts.onStdout?.(c.toString());
    });
    child.stderr.on("data", (c: Buffer) => {
      output += c.toString();
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve({ ok: !timedOut, output, timedOut });
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
