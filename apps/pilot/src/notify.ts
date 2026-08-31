import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Wake the supervisor agent (the user's chat session) after a pipeline result,
 * so every merged task gets a complementary human-side review and steering. */
export async function notifySupervisor(task: string, ok: boolean, detail: string): Promise<boolean> {
  try {
    const dir = join(homedir(), ".opencode-remote");
    const cfg = JSON.parse(readFileSync(join(dir, "pilot.json"), "utf8")) as {
      supervisorSession?: string;
    };
    const token = (JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as { apiToken?: string })
      .apiToken;
    if (!cfg.supervisorSession || !token) return false;
    const text =
      `🔍 **Verificação complementar** — pilot ${ok ? "mergeou" : "falhou em"} **${task}**\n\n` +
      `${detail}\n\nAudite o resultado (diff, constituição, backlog) e redirecione se precisar.`;
    const res = await fetch("http://127.0.0.1:8792/api/pilot-notify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ task, ok, text }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
