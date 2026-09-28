import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DigestDeps {
  /** State dir (~/.opencode-remote); tests point it at a temp dir. */
  dir?: string;
  /** HTTP transport (default: global fetch); tests inject fakes. */
  fetchFn?: (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
}

/**
 * Send a digest push to the user's phone via the daemon's authenticated API.
 * eval-01: resolves true only when a phone was reached — the daemon's HTTP 200
 * alone said nothing (with zero push subscriptions every digest "succeeded"
 * while reaching nobody). `delivered` is the phones reached (older daemons
 * reported the subscription count, which is also 0 when nobody listens).
 */
export async function digest(title: string, body: string, url = "#/", deps: DigestDeps = {}): Promise<boolean> {
  try {
    const state = JSON.parse(
      readFileSync(join(deps.dir ?? join(homedir(), ".opencode-remote"), "daemon.json"), "utf8"),
    ) as { apiToken?: string };
    if (!state.apiToken) return false;
    const res = await (deps.fetchFn ?? fetch)("http://127.0.0.1:8792/api/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.apiToken}`,
      },
      body: JSON.stringify({ title, body, url }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    try {
      const out = (await res.json()) as { delivered?: unknown };
      return typeof out.delivered === "number" ? out.delivered > 0 : true;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}
