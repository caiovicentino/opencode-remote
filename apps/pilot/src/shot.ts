// P2-011: post-deploy UI screenshots. When a merged task touched the UI, the
// pilot drives the host browser (daemon /api/browse, Playwright) against the
// production dashboard and saves a PNG under pilot/shots/. Reviewers of later
// rounds read the newest shot and cite it in their verdict — a UI regression
// becomes visible evidence in the review log instead of a hunch.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nowLocalISO } from "./log";

export function shotsDir(): string {
  return join(homedir(), ".opencode-remote", "pilot", "shots");
}

/** Newest screenshot by mtime (absolute path) or null. Lexical order is wrong
 * across tasks (`<task>-<sha>-<ts>.png` sorts by task name first), so compare
 * file mtimes — reviewers must cite the most recent evidence. */
export function latestUiShot(dir = shotsDir()): string | null {
  try {
    let best: { path: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".png")) continue;
      const path = join(dir, f);
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

function apiToken(): string | null {
  try {
    return (
      (JSON.parse(readFileSync(join(homedir(), ".opencode-remote", "daemon.json"), "utf8")) as {
        apiToken?: string;
      }).apiToken ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Open the production dashboard in the host browser and screenshot it.
 * Uses a dedicated `pilot-shot` session so it never clobbers a browse session
 * the user (Browser pane) or a reviewer is using. Best-effort: a missing
 * browser or daemon must never fail a deploy — returns the saved path or null.
 */
export async function captureUiShot(taskId: string, sha: string): Promise<string | null> {
  const token = apiToken();
  if (!token) return null;
  const port = Number(process.env.OCR_DAEMON_METRICS_PORT) || Number(process.env.OCR_METRICS_PORT) || 8792;
  const base = `http://127.0.0.1:${port}`;
  const session = "pilot-shot";
  const sfx = `?session=${session}`;
  const headers = { authorization: `Bearer ${token}` };
  try {
    const open = await fetch(`${base}/api/browse/open${sfx}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: `${base}/dashboard` }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!open.ok) return null;
    const shot = await fetch(`${base}/api/browse/screenshot${sfx}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!shot.ok) return null;
    mkdirSync(shotsDir(), { recursive: true });
    const path = join(shotsDir(), `${taskId}-${sha.slice(0, 7)}-${Date.now()}.png`);
    writeFileSync(path, Buffer.from(await shot.arrayBuffer()));
    console.log(
      JSON.stringify({ ts: nowLocalISO(), level: "info", msg: "ui-shot", data: { task: taskId, path } }),
    );
    return path;
  } catch {
    return null;
  }
}
