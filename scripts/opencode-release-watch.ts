/**
 * P2-100: opencode release watcher — a freshness signal for the runtime.
 *
 * The pipeline's runtime (the opencode CLI) ships releases almost daily, and a
 * provider-behavior change (timeouts, Anthropic binding rules) can burn builder
 * attempts in ways that look like task failures. This watcher compares the
 * latest GitHub release against the locally installed version and, when they
 * diverge, records `lastOpencodeRelease` in the pilot state.json and appends an
 * event to events.jsonl so Mission Control can surface a "runtime desatualizado"
 * chip.
 *
 * STRICTLY READ-ONLY with respect to the runtime itself: it never upgrades,
 * installs or downloads anything — it only observes and reports.
 *
 * Run: npx tsx scripts/opencode-release-watch.ts
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../apps/pilot/src/state";

const RELEASES_URL = "https://api.github.com/repos/anomalyco/opencode/releases/latest";
export const FETCH_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 5_000;
const USER_AGENT = "opencode-remote-release-watch";
const EVENTS_MAX_LINES = 400; // same bound as apps/pilot/src/events.ts

export interface ReleaseInfo {
  tag: string;
  publishedAt: string;
}

export type ReleaseWatchOutcome =
  | "diverged" // latest release differs from the local runtime → recorded + event
  | "unchanged" // divergence already recorded → no-op (no duplicate events)
  | "fresh" // local runtime matches the latest release → no-op
  | "api-down" // fetch failed or non-200 → warn, no crash
  | "api-malformed" // response lacks a usable tag_name → warn
  | "local-unknown" // `opencode --version` unusable → warn
  | "state-corrupt"; // state.json unreadable → never clobber the pilot's file

export interface ReleaseWatchDeps {
  fetchImpl?: typeof fetch;
  /** Local runtime version, already parsed (null = unknown/unavailable). */
  runVersion?: () => string | null;
  stateFile?: string;
  eventsFile?: string;
  log?: (msg: string) => void;
}

/** Extract a comparable semver from strings like "v1.18.27" or "opencode 1.18.27". */
export function normalizeVersion(raw: string): string | null {
  const m = /v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(raw);
  return m ? m[1]! : null;
}

function defaultRunVersion(): string | null {
  try {
    const out = execFileSync("opencode", ["--version"], { timeout: VERSION_TIMEOUT_MS, encoding: "utf8" });
    return normalizeVersion(out);
  } catch {
    return null;
  }
}

/** Tolerant state read — returns null when the file is missing or corrupt. */
export function readStateRaw(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Append one event line to the dashboard feed, keeping the file bounded. */
export function appendEvent(file: string, evt: Record<string, unknown>): void {
  appendFileSync(file, JSON.stringify(evt) + "\n");
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > EVENTS_MAX_LINES) {
      writeFileSync(file, lines.slice(-EVENTS_MAX_LINES).join("\n") + "\n");
    }
  } catch {}
}

export async function checkRelease(deps: ReleaseWatchDeps = {}): Promise<ReleaseWatchOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const runVersion = deps.runVersion ?? defaultRunVersion;
  const stateFile = deps.stateFile ?? join(homedir(), ".opencode-remote", "pilot", "state.json");
  const eventsFile = deps.eventsFile ?? join(homedir(), ".opencode-remote", "pilot", "events.jsonl");
  const log = deps.log ?? ((msg: string) => console.log(msg));

  let res: Response;
  try {
    res = await fetchImpl(RELEASES_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    log(`[release-watch] GitHub API unreachable: ${(err as Error).message}`);
    return "api-down";
  }
  if (!res.ok) {
    log(`[release-watch] GitHub API returned ${res.status} — skipping check`);
    return "api-down";
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    log("[release-watch] GitHub API returned non-JSON body — skipping check");
    return "api-malformed";
  }
  const fields = (payload ?? {}) as { tag_name?: unknown; published_at?: unknown };
  if (typeof fields.tag_name !== "string" || !normalizeVersion(fields.tag_name)) {
    log("[release-watch] GitHub API payload without a usable tag_name — skipping check");
    return "api-malformed";
  }
  const latest: ReleaseInfo = {
    tag: fields.tag_name,
    publishedAt: typeof fields.published_at === "string" ? fields.published_at : "",
  };

  const local = runVersion();
  if (!local) {
    log("[release-watch] local opencode version unknown — nothing to compare");
    return "local-unknown";
  }

  const state = readStateRaw(stateFile);
  if (!state) {
    log(`[release-watch] state.json unreadable at ${stateFile} — refusing to touch it (run the doctor)`);
    return "state-corrupt";
  }

  // Fresh runtime → nothing to signal; drop a stale divergence record if any.
  // This must run BEFORE the recorded-tag short-circuit below: when the local
  // runtime catches up to the recorded latest tag, the "unchanged" branch would
  // never be reached and the stale record would keep the chip lit forever.
  if (normalizeVersion(local) === normalizeVersion(latest.tag)) {
    if ("lastOpencodeRelease" in state) {
      delete state.lastOpencodeRelease;
      writeJsonAtomic(stateFile, state);
    }
    return "fresh";
  }

  // Already recorded → the event was emitted when this release first diverged;
  // re-emitting on every run would spam the dashboard feed.
  const recorded = (state.lastOpencodeRelease ?? {}) as { tag?: unknown };
  if (typeof recorded.tag === "string" && normalizeVersion(recorded.tag) === normalizeVersion(latest.tag)) {
    return "unchanged";
  }

  // Diverged: emit the dashboard event FIRST, then record. If the append fails,
  // the state must NOT say "recorded" — every later run would no-op on the
  // recorded tag and the signal would be lost permanently. Event-first means
  // the next run retries the append; a duplicate event (state write failing
  // after a successful append) is mild feed noise, a dead signal is not.
  const evt = {
    ts: new Date().toISOString(),
    type: "audit",
    detail: `runtime desatualizado: local ${local}, latest ${latest.tag} (published ${latest.publishedAt || "unknown"})`,
  };
  try {
    appendEvent(eventsFile, evt);
  } catch (err) {
    log(`[release-watch] failed to append event — state left unrecorded, next run retries: ${(err as Error).message}`);
    return "diverged";
  }
  try {
    writeJsonAtomic(stateFile, { ...state, lastOpencodeRelease: { tag: latest.tag, publishedAt: latest.publishedAt } });
  } catch (err) {
    log(`[release-watch] failed to record state: ${(err as Error).message}`);
  }
  log(evt.detail);
  return "diverged";
}

async function main() {
  const outcome = await checkRelease();
  console.log(`release-watch: ${outcome}`);
}

if (process.argv[1]?.endsWith("opencode-release-watch.ts")) {
  void main();
}
