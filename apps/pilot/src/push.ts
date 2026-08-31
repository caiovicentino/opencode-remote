import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Send a digest push to the user's phone via the daemon's authenticated API. */
export async function digest(title: string, body: string, url = "#/"): Promise<boolean> {
  try {
    const state = JSON.parse(
      readFileSync(join(homedir(), ".opencode-remote", "daemon.json"), "utf8"),
    ) as { apiToken?: string };
    if (!state.apiToken) return false;
    const res = await fetch("http://127.0.0.1:8792/api/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.apiToken}`,
      },
      body: JSON.stringify({ title, body, url }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
