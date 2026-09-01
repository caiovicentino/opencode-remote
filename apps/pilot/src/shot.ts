// P2-011: post-deploy UI screenshots. When a merged task touched the UI, the
// pilot drives the host browser (daemon /api/browse, Playwright) against the
// production dashboard and saves a PNG under pilot/shots/. Reviewers of later
// rounds read the newest shot and cite it in their verdict — a UI regression
// becomes visible evidence in the review log instead of a hunch.
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { nowLocalISO } from "./log";

export function shotsDir(): string {
  return join(homedir(), ".opencode-remote", "pilot", "shots");
}

/** Builder self-validation shots live in their own subdir: they are pre-merge
 * and must never be mistaken for post-deploy evidence (the dir split makes
 * that structural, not name-based). */
export function builderShotsDir(): string {
  return join(shotsDir(), "builder");
}

/** Retention: reviewers only need the newest few; shots are rendered captures
 * of internal pages, so they must not accumulate forever. */
const KEEP_SHOTS = 20;

/** Delete all but the newest `keep` files (by mtime) in dir. */
export function pruneShots(dir: string, keep = KEEP_SHOTS): void {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .map((f) => {
        const path = join(dir, f);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of files.slice(keep)) rmSync(f.path, { force: true });
  } catch {}
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Newest post-deploy screenshot (absolute path) or null. Evidence is scoped:
 * only files with the deploy-shot shape `<taskId>-<sha7>-<ts>.png` for the
 * requested task count — builder self-shots (separate dir) and other tasks'
 * shots are never served as this task's evidence. Newest wins by mtime
 * (lexical order would sort by task name first).
 */
export function latestUiShot(taskId?: string, dir = shotsDir()): string | null {
  try {
    const shape = taskId
      ? new RegExp(`^${escapeRe(taskId)}-[0-9a-f]{7}-\\d+\\.png$`)
      : null;
    let best: { path: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".png")) continue;
      if (shape && !shape.test(f)) continue;
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
    pruneShots(shotsDir());
    pruneShots(builderShotsDir());
    return path;
  } catch {
    return null;
  }
}
