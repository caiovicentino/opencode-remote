/**
 * Self-serve mission — the user defines what the fleet works on by simply
 * typing in the chat. The chat agent writes `~/.opencode-remote/mission.json`
 * (schema below) and the pilot picks it up on its next boot; the same
 * self-reload path that heals a stale process (P3-101 / P1-056) fires when
 * the file's hash changes since boot, so a mission set from chat is applied
 * with zero operator action.
 *
 *   { "v": 1, "prompt": "<what the user wants>", "repoUrl": "https://github.com/<org>/<repo>.git",
 *     "models": { "<role>": "<provider/model>" }, "setAt": "<ISO>" }
 *
 * `prompt` and `repoUrl` are each optional but at least one must be present.
 * v2 (mission self-serve v2): the optional `models` object maps a fleet role
 * (strategist | researcher | builder | reviewer | scribe — any subset) to an
 * opencode model id (`provider/model`, exactly what `opencode models` prints).
 * Unknown roles or malformed ids reject the whole file (never silently
 * dropped — the chat agent is told to only write ids it verified).
 * Pure helpers (parse, validate, hash, drift) are fs-free so the unit battery
 * pins every branch; the fs wrappers take an injectable io like the daemon's
 * statefile.ts (P2-165) and write atomically with mode 0600.
 */
import { createHash } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MISSION_FILE = join(homedir(), ".opencode-remote", "mission.json");

/** Longest mission prompt kept (chars) — the rest is dropped as invalid. */
export const MISSION_PROMPT_MAX = 4000;

/** Only GitHub https clone URLs: https://github.com/<org>/<repo>(.git)? */
export const GITHUB_REPO_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** Fleet roles a mission may pin to a model (v2). Subset allowed. */
export const MISSION_MODEL_ROLES = ["strategist", "researcher", "builder", "reviewer", "scribe"] as const;
export type MissionModelRole = (typeof MISSION_MODEL_ROLES)[number];
export type MissionModels = Partial<Record<MissionModelRole, string>>;

/**
 * opencode model id: `provider/model`, where the model key may itself carry
 * slashes (`hpc-ai/deepseek/deepseek-v4-flash`). The id reaches `opencode run
 * --model` as ONE argv entry (no shell), but the charset is still pinned so
 * nothing surprising ever lands in a log line or a config file.
 */
export const MISSION_MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63})+$/;
export const MISSION_MODEL_ID_MAX = 128;

export function isMissionModelRole(role: unknown): role is MissionModelRole {
  return typeof role === "string" && (MISSION_MODEL_ROLES as readonly string[]).includes(role);
}

export function validModelId(id: unknown): id is string {
  return typeof id === "string" && id.length <= MISSION_MODEL_ID_MAX && MISSION_MODEL_ID_RE.test(id);
}

export interface MissionSpec {
  v: 1;
  prompt?: string;
  repoUrl?: string;
  /** v2: per-role model override (validated shape; availability is checked at dispatch). */
  models?: MissionModels;
  setAt: string;
}

/** `{ org, repo }` for a valid GitHub repo URL, else null. Dot-only segments
 * (`.`, `..`) are rejected — the slug doubles as a workspace directory key. */
export function repoSlug(url: unknown): { org: string; repo: string } | null {
  if (typeof url !== "string") return null;
  const m = GITHUB_REPO_URL_RE.exec(url.trim());
  if (!m) return null;
  const org = m[1]!;
  const repo = m[2]!;
  if (/^\.+$/.test(org) || /^\.+$/.test(repo)) return null;
  return { org, repo };
}

export function validRepoUrl(url: unknown): url is string {
  return repoSlug(url) !== null;
}

/** Normalized clone URL (always `.git`, no trailing slash) or null. */
export function normalizeRepoUrl(url: unknown): string | null {
  const slug = repoSlug(url);
  return slug ? `https://github.com/${slug.org}/${slug.repo}.git` : null;
}

/**
 * v2: parse the optional `models` block. Returns `{ ok: true, models }` with
 * `models` undefined for an absent/null/empty block, or `{ ok: false }` when
 * the block is not an object, names a role outside MISSION_MODEL_ROLES or
 * carries a value that is not a well-formed model id. Fail-closed by design:
 * a typo in a role must surface as "mission.json invalid" in the pilot log,
 * never as a silently ignored preference.
 */
export function parseMissionModels(raw: unknown): { ok: true; models?: MissionModels } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "models must be an object" };
  const out: MissionModels = {};
  for (const [role, id] of Object.entries(raw as Record<string, unknown>)) {
    if (!isMissionModelRole(role)) return { ok: false, reason: `unknown role "${role}" (valid: ${MISSION_MODEL_ROLES.join("|")})` };
    if (!validModelId(id)) return { ok: false, reason: `invalid model id for ${role} (expected provider/model)` };
    out[role] = id;
  }
  return Object.keys(out).length ? { ok: true, models: out } : { ok: true };
}

/**
 * Parse the raw mission.json text. Returns null for anything that is not a
 * v1 spec with at least one of (non-empty prompt, valid repoUrl). Garbage
 * never throws — an invalid file behaves exactly like an absent one.
 */
export function parseMissionSpec(raw: string | null | undefined): MissionSpec | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const m = obj as { v?: unknown; prompt?: unknown; repoUrl?: unknown; models?: unknown; setAt?: unknown };
  if (m.v !== 1) return null;
  const prompt = typeof m.prompt === "string" ? m.prompt.trim() : "";
  if (prompt.length > MISSION_PROMPT_MAX) return null;
  if (m.repoUrl !== undefined && m.repoUrl !== null && m.repoUrl !== "" && !validRepoUrl(m.repoUrl)) return null;
  const repoUrl = normalizeRepoUrl(m.repoUrl) ?? undefined;
  if (!prompt && !repoUrl) return null;
  const models = parseMissionModels(m.models);
  if (!models.ok) return null;
  const setAt = typeof m.setAt === "string" && !Number.isNaN(Date.parse(m.setAt)) ? m.setAt : "";
  const spec: MissionSpec = { v: 1, setAt };
  if (prompt) spec.prompt = prompt;
  if (repoUrl) spec.repoUrl = repoUrl;
  if (models.models) spec.models = models.models;
  return spec;
}

/** Model the mission pins for a role, or undefined (fleet default). */
export function missionModelFor(spec: Pick<MissionSpec, "models"> | null | undefined, role: MissionModelRole): string | undefined {
  return spec?.models?.[role];
}

/** sha256 hex of the raw file text; undefined when the file is absent. */
export function missionHash(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * True when the mission file changed since boot: a different hash, a file
 * that appeared (boot: absent) or one that vanished (boot: present). Two
 * absent readings never drift, so a host without a mission never flaps.
 */
export function missionDrifted(bootHash: string | undefined, nowHash: string | undefined): boolean {
  return bootHash !== nowHash;
}

/** Workspace directory key for a foreign mission repo (`org--repo`), or null
 * when the mission targets this repo (no repoUrl). */
export function missionWorkspaceKey(spec: MissionSpec | null | undefined): string | null {
  const slug = repoSlug(spec?.repoUrl);
  return slug ? `${slug.org}--${slug.repo}` : null;
}

/**
 * Per-mission namespace for state that is keyed by task id (v2 hardening c):
 * `taskAttempts`/`specFails` entries of a foreign mission are prefixed with
 * the workspace key, so its `P2-001` can never collide with ours. This repo
 * (no mission key) keeps bare ids — the pre-v2 state file stays valid.
 */
export function attemptsKey(missionKey: string | null | undefined, taskId: string): string {
  return missionKey ? `${missionKey}/${taskId}` : taskId;
}

/** Inverse of attemptsKey for consumers that match branch names (`pilot/<id>`):
 * the task id without any mission namespace. Bare ids pass through. */
export function bareTaskId(key: string): string {
  const i = key.lastIndexOf("/");
  return i >= 0 ? key.slice(i + 1) : key;
}

export interface MissionRead {
  /** raw file text, null when absent/unreadable */
  raw: string | null;
  spec: MissionSpec | null;
  hash: string | undefined;
}

/** Read + parse + hash the mission file. Never throws. */
export function readMission(file = MISSION_FILE, read: (f: string) => string = (f) => readFileSync(f, "utf8")): MissionRead {
  let raw: string | null = null;
  try {
    raw = read(file);
  } catch {
    raw = null;
  }
  return { raw, spec: parseMissionSpec(raw), hash: missionHash(raw) };
}

/** Structural fs subset the atomic writer touches (tests inject fakes). */
export interface MissionFileIo {
  writeFileSync(file: string, data: string, opts: { mode: number }): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

export const nodeMissionFileIo: MissionFileIo = {
  writeFileSync: (file, data, opts) => writeFileSync(file, data, opts),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (file) => unlinkSync(file),
};

/**
 * Atomic 0600 write of a mission spec — same tmp+rename contract as the
 * daemon's daemon.json (statefile.ts, P2-165): the payload lands in a sibling
 * `.tmp` created 0600 and is renamed over the destination, so a reader (the
 * pilot's per-tick hash probe) only ever sees the old or the new full file.
 * Throws on an invalid spec — never writes something the pilot would ignore.
 */
export function writeMissionSpec(spec: MissionSpec, file = MISSION_FILE, io: MissionFileIo = nodeMissionFileIo): string {
  const text = JSON.stringify(spec, null, 2);
  if (!parseMissionSpec(text)) throw new Error("invalid mission spec — needs a prompt and/or a GitHub repo url, and a valid models block");
  const tmp = `${file}.tmp`;
  try {
    io.writeFileSync(tmp, text, { mode: 0o600 });
    io.renameSync(tmp, file);
  } catch (err) {
    try {
      io.unlinkSync(tmp);
    } catch {}
    throw err;
  }
  return text;
}

/**
 * v2 mission clear path: remove the mission file (unlink is atomic — a
 * concurrent reader sees the whole old file or none). A missing file is
 * already the desired state and reports `removed: false`; any other fs error
 * is rethrown so the daemon route can answer 500 instead of lying.
 */
export function removeMissionFile(file = MISSION_FILE, io: Pick<MissionFileIo, "unlinkSync"> = nodeMissionFileIo): { removed: boolean } {
  try {
    io.unlinkSync(file);
    return { removed: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { removed: false };
    throw err;
  }
}
