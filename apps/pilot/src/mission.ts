/**
 * Self-serve mission — the user defines what the fleet works on by simply
 * typing in the chat. The chat agent writes `~/.opencode-remote/mission.json`
 * (schema below) and the pilot picks it up on its next boot; the same
 * self-reload path that heals a stale process (P3-101 / P1-056) fires when
 * the file's hash changes since boot, so a mission set from chat is applied
 * with zero operator action.
 *
 *   { "v": 1, "prompt": "<what the user wants>", "repoUrl": "https://github.com/<org>/<repo>.git", "setAt": "<ISO>" }
 *
 * `prompt` and `repoUrl` are each optional but at least one must be present.
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

export interface MissionSpec {
  v: 1;
  prompt?: string;
  repoUrl?: string;
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
  const m = obj as { v?: unknown; prompt?: unknown; repoUrl?: unknown; setAt?: unknown };
  if (m.v !== 1) return null;
  const prompt = typeof m.prompt === "string" ? m.prompt.trim() : "";
  if (prompt.length > MISSION_PROMPT_MAX) return null;
  if (m.repoUrl !== undefined && m.repoUrl !== null && m.repoUrl !== "" && !validRepoUrl(m.repoUrl)) return null;
  const repoUrl = normalizeRepoUrl(m.repoUrl) ?? undefined;
  if (!prompt && !repoUrl) return null;
  const setAt = typeof m.setAt === "string" && !Number.isNaN(Date.parse(m.setAt)) ? m.setAt : "";
  const spec: MissionSpec = { v: 1, setAt };
  if (prompt) spec.prompt = prompt;
  if (repoUrl) spec.repoUrl = repoUrl;
  return spec;
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
  if (!parseMissionSpec(text)) throw new Error("invalid mission spec — needs a prompt and/or a GitHub repo url");
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
