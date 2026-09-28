/**
 * eval-02 — bounded retention for what the pilot leaves on disk.
 *
 * 1. Pilot artifacts (automatic: hourly from the loop, and at once on every
 *    critical disk-hold entry). builder-<ID>.log, shots/, tmp/, client-logs/
 *    and stray *.log under the pilot state root grew without any bound (224
 *    builder logs on 2026-09-27). Every rule keeps a floor of the newest
 *    files, deletes older-than-N-days beyond it and enforces a hard count cap;
 *    a file written in the last hour is never touched, subdirectories and
 *    symlinks are never matched, nothing outside the named dirs is read.
 *
 * 2. Pilot-created opencode sessions (OPT-IN CLI, dry-run by default).
 *    opencode.db grows +4–8 GB/day with the fleet on; on 2026-09-27 ~28–31 GB
 *    of its 87 GB were sessions whose directory is a pilot slot clone (sampled
 *    read-only). Candidates come from `GET /session?directory=<slot>&limit=N`
 *    (opencode 1.18: default limit 100, newest first — the old sessions a
 *    retention needs are exactly the ones a default listing hides) and are
 *    removed with `DELETE /session/<id>` (cascades children, messages, parts
 *    and the event log). The server does NOT scope the delete — any id is
 *    deleted whatever `directory` says — so ownership is enforced here: exact
 *    directory match against the pilot's own clones, root sessions only (a
 *    child goes with its root), age = newest update across the whole tree,
 *    canonical ids only (a malformed id is a 500 upstream), a per-run cap and
 *    a JSONL audit trail. Deleting frees pages inside the file; the file only
 *    shrinks with a VACUUM (docs/PILOT.md, ops section).
 */
import { appendFileSync, existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "../../daemon/src/auditlog";
import { isSessionId } from "./costs";
import { formatGb } from "./disk";
import { OPENCODE_URL } from "./runner";

const DAY_MS = 24 * 60 * 60_000;

// ── 1. pilot artifacts ───────────────────────────────────────────────────────

export interface ArtifactRule {
  name: string;
  /** Directory relative to the pilot state root ("" = the root itself). */
  dir: string;
  /** Which FILES of `dir` the rule owns (subdirectories never match). */
  match: RegExp;
  /** Always keep this many newest files. */
  keepNewest: number;
  /** Beyond the floor, files older than this go. */
  maxAgeDays: number;
  /** Hard cap: the oldest files beyond it go (the min-age shield still holds). */
  maxFiles: number;
}

/** A file younger than this is never removed (a gate may be citing it). */
export const ARTIFACT_MIN_AGE_MS = 60 * 60_000;

export const ARTIFACT_RULES: readonly ArtifactRule[] = [
  { name: "builder-logs", dir: "", match: /^builder-[A-Za-z0-9._-]+\.log$/, keepNewest: 50, maxAgeDays: 30, maxFiles: 200 },
  { name: "stray-logs", dir: "", match: /^(?:p\d+-[A-Za-z0-9._-]+|last-builder-output(?:-[A-Za-z0-9._-]+)?)\.log$/, keepNewest: 0, maxAgeDays: 14, maxFiles: 20 },
  // shots/*.png is already capped at 20 by shot.ts (P2-011) on every UI
  // deploy; that pass only knows .png, so the builder dir's css/html pile up
  { name: "shots-builder", dir: join("shots", "builder"), match: /^[^.]/, keepNewest: 100, maxAgeDays: 30, maxFiles: 400 },
  // explorer journey shots back backlog findings: a generous floor
  { name: "shots-explorer", dir: join("shots", "explorer"), match: /\.(?:png|jpe?g|webp)$/i, keepNewest: 120, maxAgeDays: 45, maxFiles: 400 },
  { name: "tmp", dir: "tmp", match: /^[^.]/, keepNewest: 0, maxAgeDays: 7, maxFiles: 100 },
  { name: "client-logs", dir: "client-logs", match: /\.txt$/, keepNewest: 20, maxAgeDays: 30, maxFiles: 100 },
];

export interface ArtifactEntry {
  name: string;
  mtimeMs: number;
  size: number;
  isFile: boolean;
}

/** Injectable filesystem (the battery swaps in a fake). */
export interface ArtifactFs {
  /** Entries of `dir` (lstat: a symlink is never a file); null when unreadable. */
  list: (dir: string) => ArtifactEntry[] | null;
  rm: (path: string) => void;
}

export function nodeArtifactFs(): ArtifactFs {
  return {
    list: (dir) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return null;
      }
      const out: ArtifactEntry[] = [];
      for (const name of names) {
        try {
          const s = lstatSync(join(dir, name));
          out.push({ name, mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile() });
        } catch {}
      }
      return out;
    },
    rm: (path) => rmSync(path, { force: true }),
  };
}

/** Pure rule decision: which files of one directory listing go. */
export function planArtifactRule(entries: ArtifactEntry[], rule: ArtifactRule, now: number): ArtifactEntry[] {
  const files = entries
    .filter((e) => e.isFile && rule.match.test(e.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const out: ArtifactEntry[] = [];
  files.forEach((e, i) => {
    const age = now - e.mtimeMs;
    if (age < ARTIFACT_MIN_AGE_MS || i < rule.keepNewest) return;
    if (i >= rule.maxFiles || age > rule.maxAgeDays * DAY_MS) out.push(e);
  });
  return out;
}

export interface ArtifactSweepResult {
  ok: boolean;
  /** false = dry-run: `removed`/`freedBytes` are what an apply would do. */
  applied: boolean;
  removed: number;
  freedBytes: number;
  byRule: Record<string, { removed: number; freedBytes: number }>;
  errors: string[];
  detail: string;
}

/** Sweep the pilot state root. Never throws; a failed rm is ok:false. */
export function sweepPilotArtifacts(
  stateRoot: string,
  opts: { fs?: ArtifactFs; now?: number; apply?: boolean; rules?: readonly ArtifactRule[] } = {},
): ArtifactSweepResult {
  const fs = opts.fs ?? nodeArtifactFs();
  const now = opts.now ?? Date.now();
  const apply = opts.apply ?? true;
  const byRule: ArtifactSweepResult["byRule"] = {};
  const errors: string[] = [];
  let removed = 0;
  let freedBytes = 0;
  for (const rule of opts.rules ?? ARTIFACT_RULES) {
    const dir = rule.dir ? join(stateRoot, rule.dir) : stateRoot;
    const entries = fs.list(dir);
    if (!entries) continue;
    let n = 0;
    let bytes = 0;
    for (const e of planArtifactRule(entries, rule, now)) {
      if (apply) {
        try {
          fs.rm(join(dir, e.name));
        } catch (err) {
          errors.push(`${rule.name}/${e.name}: ${String(err).slice(0, 80)}`);
          continue;
        }
      }
      n++;
      bytes += e.size;
    }
    if (n > 0) byRule[rule.name] = { removed: n, freedBytes: bytes };
    removed += n;
    freedBytes += bytes;
  }
  const verb = apply ? "removed" : "would remove";
  const size = freedBytes >= 1024 ** 3 ? `${formatGb(freedBytes)}gb` : `${(freedBytes / 1024 ** 2).toFixed(1)}mb`;
  const detail = removed
    ? `${verb} ${removed} file(s), ${size}: ${Object.entries(byRule).map(([k, v]) => `${k} ${v.removed}`).join(", ")}`
    : "nothing past retention";
  return { ok: errors.length === 0, applied: apply, removed, freedBytes, byRule, errors, detail };
}

// ── 2. pilot-created opencode sessions ───────────────────────────────────────

export interface OcSession {
  id: string;
  directory: string;
  parentID?: string;
  title?: string;
  time: { created: number; updated: number };
}

/** Tolerant shape check for one `GET /session` row. */
function asSession(v: unknown): OcSession | null {
  if (!v || typeof v !== "object") return null;
  const s = v as { id?: unknown; directory?: unknown; parentID?: unknown; title?: unknown; time?: { created?: unknown; updated?: unknown } };
  if (typeof s.id !== "string" || typeof s.directory !== "string") return null;
  const updated = s.time?.updated;
  const created = s.time?.created;
  if (typeof updated !== "number" || !Number.isFinite(updated)) return null;
  return {
    id: s.id,
    directory: s.directory,
    parentID: typeof s.parentID === "string" ? s.parentID : undefined,
    title: typeof s.title === "string" ? s.title : undefined,
    time: { created: typeof created === "number" ? created : updated, updated },
  };
}

/**
 * The pilot's own workspaces — the only directories whose sessions this tool
 * may ever touch: slot clones `repo-<n>` (this repo and every foreign
 * mission), the explorer clone and the pre-slot legacy `repo`. Existing dirs
 * only: listing an unknown directory boots an opencode instance for it.
 */
export function pilotSessionDirs(stateRoot: string, fsx: { exists: (p: string) => boolean; list: (p: string) => string[] } = defaultDirFs()): string[] {
  const out: string[] = [];
  const addClones = (root: string) => {
    let names: string[] = [];
    try {
      names = fsx.list(root);
    } catch {}
    for (const n of names.sort()) if (/^repo-\d+$/.test(n)) out.push(join(root, n));
  };
  addClones(stateRoot);
  for (const extra of ["repo-explorer", "repo"]) {
    const p = join(stateRoot, extra);
    if (fsx.exists(p)) out.push(p);
  }
  let missions: string[] = [];
  try {
    missions = fsx.list(join(stateRoot, "mission"));
  } catch {}
  for (const key of missions.sort()) addClones(join(stateRoot, "mission", key));
  return out;
}

function defaultDirFs() {
  return {
    exists: (p: string) => existsSync(p),
    list: (p: string) => readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
  };
}

export interface SessionCandidate {
  id: string;
  directory: string;
  title: string;
  /** Newest `time.updated` across the root and its whole subtree. */
  updatedAt: number;
  /** Descendants the cascade takes along. */
  children: number;
}

export interface SessionPlan {
  listed: number;
  candidates: SessionCandidate[];
  kept: { recent: number; protected: number; foreign: number; invalid: number; capped: number };
}

/**
 * Pure planning over the per-directory listings. `listing` maps an owned
 * directory to what the server returned for it; rows whose `directory` is not
 * EXACTLY that owned directory are ignored (counted `foreign`), never trusted.
 */
export function planSessionRetention(
  listing: Map<string, unknown[]>,
  o: { maxAgeDays: number; now: number; maxDeletes: number; protect?: Set<string> },
): SessionPlan {
  const cutoff = o.now - Math.max(1, o.maxAgeDays) * DAY_MS;
  const kept = { recent: 0, protected: 0, foreign: 0, invalid: 0, capped: 0 };
  const byId = new Map<string, OcSession>();
  let listed = 0;
  for (const [dir, rows] of listing) {
    for (const row of rows) {
      const s = asSession(row);
      if (!s || !isSessionId(s.id) || (s.parentID !== undefined && !isSessionId(s.parentID))) {
        kept.invalid++;
        continue;
      }
      if (s.directory !== dir) {
        kept.foreign++;
        continue;
      }
      if (!byId.has(s.id)) listed++;
      byId.set(s.id, s);
    }
  }
  const kids = new Map<string, string[]>();
  for (const s of byId.values()) {
    if (s.parentID && byId.has(s.parentID)) kids.set(s.parentID, [...(kids.get(s.parentID) ?? []), s.id]);
  }
  const candidates: SessionCandidate[] = [];
  for (const root of byId.values()) {
    if (root.parentID && byId.has(root.parentID)) continue; // goes with its root
    if (root.parentID) {
      // its root lives outside the pilot's clones (a deleted root would have
      // cascaded it): the tree is someone else's — never cut a branch of it
      kept.foreign++;
      continue;
    }
    // whole subtree: age = newest update anywhere in it; a protected member protects it all
    const tree: OcSession[] = [];
    const stack = [root.id];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      tree.push(byId.get(id)!);
      stack.push(...(kids.get(id) ?? []));
    }
    const updatedAt = Math.max(...tree.map((s) => s.time.updated));
    if (tree.some((s) => o.protect?.has(s.id))) {
      kept.protected++;
      continue;
    }
    if (updatedAt >= cutoff) {
      kept.recent++;
      continue;
    }
    candidates.push({ id: root.id, directory: root.directory, title: (root.title ?? "").slice(0, 80), updatedAt, children: tree.length - 1 });
  }
  candidates.sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
  const cap = Math.max(0, Math.floor(o.maxDeletes));
  kept.capped = Math.max(0, candidates.length - cap);
  return { listed, candidates: candidates.slice(0, cap), kept };
}

export interface SessionRetentionOpts {
  baseUrl?: string;
  dirs: string[];
  maxAgeDays: number;
  maxDeletes: number;
  apply: boolean;
  now?: number;
  protect?: Set<string>;
  fetchImpl?: typeof fetch;
  /** One JSON record per action (apply) — the audit trail. */
  audit?: (rec: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pause between deletes: each one is a large write on a live, shared DB. */
  pauseMs?: number;
  listLimit?: number;
}

export interface SessionRetentionResult {
  mode: "dry-run" | "apply";
  plan: SessionPlan;
  truncatedDirs: string[];
  listErrors: string[];
  deleted: string[];
  gone: string[];
  failed: { id: string; status: number | null; detail: string }[];
  stoppedEarly: boolean;
}

/** Consecutive delete failures that stop a run (the server is not well). */
export const RETENTION_MAX_CONSECUTIVE_FAILURES = 5;

export async function runSessionRetention(o: SessionRetentionOpts): Promise<SessionRetentionResult> {
  const base = (o.baseUrl ?? OPENCODE_URL).replace(/\/+$/, "");
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now();
  const limit = o.listLimit ?? 10_000;
  const listing = new Map<string, unknown[]>();
  const truncatedDirs: string[] = [];
  const listErrors: string[] = [];
  for (const dir of o.dirs) {
    try {
      const res = await fetchImpl(`${base}/session?directory=${encodeURIComponent(dir)}&limit=${limit}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        listErrors.push(`${dir}: HTTP ${res.status}`);
        continue;
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        listErrors.push(`${dir}: listing is not an array`);
        continue;
      }
      if (body.length >= limit) truncatedDirs.push(dir);
      listing.set(dir, body);
    } catch (err) {
      listErrors.push(`${dir}: ${String(err).slice(0, 120)}`);
    }
  }
  const plan = planSessionRetention(listing, { maxAgeDays: o.maxAgeDays, now, maxDeletes: o.maxDeletes, protect: o.protect });
  const result: SessionRetentionResult = {
    mode: o.apply ? "apply" : "dry-run",
    plan,
    truncatedDirs,
    listErrors,
    deleted: [],
    gone: [],
    failed: [],
    stoppedEarly: false,
  };
  if (!o.apply) return result;
  const audit = o.audit ?? (() => {});
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let streak = 0;
  for (const c of plan.candidates) {
    let status: number | null = null;
    let detail = "";
    try {
      const res = await fetchImpl(`${base}/session/${encodeURIComponent(c.id)}?directory=${encodeURIComponent(c.directory)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(120_000),
      });
      status = res.status;
      if (!res.ok) detail = (await res.text().catch(() => "")).slice(0, 160);
    } catch (err) {
      detail = String(err).slice(0, 160);
    }
    const outcome = status === 200 ? "deleted" : status === 404 ? "gone" : "failed";
    audit({
      ts: new Date().toISOString(),
      event: "session-delete",
      id: c.id,
      directory: c.directory,
      title: c.title,
      updatedAt: new Date(c.updatedAt).toISOString(),
      children: c.children,
      outcome,
      status,
      ...(detail ? { detail } : {}),
    });
    if (outcome === "deleted") result.deleted.push(c.id);
    else if (outcome === "gone") result.gone.push(c.id);
    else result.failed.push({ id: c.id, status, detail });
    streak = outcome === "failed" ? streak + 1 : 0;
    if (streak >= RETENTION_MAX_CONSECUTIVE_FAILURES) {
      result.stoppedEarly = true;
      break;
    }
    if (o.pauseMs !== 0) await sleep(o.pauseMs ?? 250);
  }
  return result;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
//   npx tsx apps/pilot/src/retention.ts sessions  [--apply] [--days N] [--max N] [--url URL]
//   npx tsx apps/pilot/src/retention.ts artifacts [--apply]
// Dry-run unless --apply. Never run it against a DB you do not own.

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cli(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;
  const apply = args.includes("--apply");
  const stateRoot = join(homedir(), ".opencode-remote", "pilot");
  const print = (rec: unknown) => console.log(JSON.stringify(rec));
  if (cmd === "artifacts") {
    print({ cmd, ...sweepPilotArtifacts(stateRoot, { apply }) });
    return 0;
  }
  if (cmd === "sessions") {
    const days = Number(argValue(args, "--days") ?? 14);
    const max = Number(argValue(args, "--max") ?? 500);
    if (!Number.isFinite(days) || days < 1 || !Number.isFinite(max) || max < 0) {
      console.error("--days must be >= 1 and --max >= 0");
      return 2;
    }
    const auditFile = join(stateRoot, "retention-audit.jsonl");
    const dirs = pilotSessionDirs(stateRoot);
    const r = await runSessionRetention({
      baseUrl: argValue(args, "--url"),
      dirs,
      maxAgeDays: days,
      maxDeletes: max,
      apply,
      audit: (rec) => {
        try {
          appendFileSync(auditFile, `${JSON.stringify(rec)}\n`);
        } catch {}
      },
    });
    for (const c of r.plan.candidates) print({ candidate: c.id, directory: c.directory, updatedAt: new Date(c.updatedAt).toISOString(), children: c.children, title: c.title });
    const summary = {
      mode: r.mode,
      days,
      dirs: dirs.length,
      listed: r.plan.listed,
      candidates: r.plan.candidates.length,
      kept: r.plan.kept,
      deleted: r.deleted.length,
      gone: r.gone.length,
      failed: r.failed.length,
      stoppedEarly: r.stoppedEarly,
      truncatedDirs: r.truncatedDirs,
      listErrors: r.listErrors,
    };
    print({ summary });
    if (apply) {
      try {
        appendFileSync(auditFile, `${JSON.stringify({ ts: new Date().toISOString(), event: "session-retention", ...summary })}\n`);
      } catch {}
      appendAudit(
        join(homedir(), ".opencode-remote", "audit.log"),
        `${JSON.stringify({ ts: new Date().toISOString(), event: "pilot-retention", data: summary })}\n`,
      );
    }
    return r.listErrors.length || r.failed.length ? 1 : 0;
  }
  console.error("usage: tsx apps/pilot/src/retention.ts <sessions [--apply] [--days N] [--max N] [--url URL] | artifacts [--apply]>");
  return 2;
}

if (process.argv[1]?.endsWith("retention.ts")) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(String(err));
      process.exit(1);
    },
  );
}
