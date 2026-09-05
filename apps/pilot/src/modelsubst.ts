/**
 * Mission model substitutions — the visible side of the fail-closed fallback.
 *
 * pickMissionModel (modelcatalog.ts) falls back to the tier default whenever
 * the mission's pinned model is not in the live catalog. Falling back to a
 * KNOWN model is right; doing it with only a warn line in pilot.log is not:
 * the user asked for a model and silently got another. Every fallback is
 * recorded here (one entry per role, upserted; cleared again when a later
 * dispatch finds the model) and the daemon's GET /api/pilot-mission surfaces
 * the entries that still match the active mission's pins, so the Mission
 * Control card and the chat can tell the user. Pure helpers + injectable
 * file path (failureLessons.ts pattern); every write is tolerant.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isMissionModelRole, validModelId } from "./mission";

export interface ModelSubstitution {
  role: string;
  /** The id the mission pinned. */
  wanted: string;
  /** What ran instead: a tier-B id or "tier-A default". */
  usedInstead: string;
  reason: string;
  /** Local timestamp of the latest fallback dispatch. */
  at: string;
}

interface ModelSubstitutionsFile {
  v: 1;
  entries: Record<string, ModelSubstitution>;
}

export const MODEL_SUBST_REASON_MAX = 200;

export function defaultModelSubstitutionsFile(): string {
  return join(homedir(), ".opencode-remote", "pilot", "model-substitutions.json");
}

function readFile(file: string): ModelSubstitutionsFile {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ModelSubstitutionsFile>;
    const entries: Record<string, ModelSubstitution> = {};
    for (const [role, e] of Object.entries(raw?.entries ?? {})) {
      if (!isMissionModelRole(role) || !e || typeof e !== "object") continue;
      if (!validModelId(e.wanted) || typeof e.usedInstead !== "string" || !e.usedInstead) continue;
      entries[role] = {
        role,
        wanted: e.wanted,
        usedInstead: e.usedInstead.slice(0, 128),
        reason: typeof e.reason === "string" ? e.reason.slice(0, MODEL_SUBST_REASON_MAX) : "",
        at: typeof e.at === "string" ? e.at : "",
      };
    }
    return { v: 1, entries };
  } catch {
    return { v: 1, entries: {} };
  }
}

function writeFile(file: string, data: ModelSubstitutionsFile): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    return true;
  } catch {
    return false;
  }
}

/** Every recorded substitution (missing/corrupt file → empty, never throws). */
export function readModelSubstitutions(file: string): ModelSubstitution[] {
  return Object.values(readFile(file).entries);
}

/** Upsert the role's entry. Invalid role/ids are refused (nothing written). */
export function recordModelSubstitution(file: string, sub: ModelSubstitution): boolean {
  if (!isMissionModelRole(sub.role) || !validModelId(sub.wanted) || !sub.usedInstead) return false;
  const data = readFile(file);
  data.entries[sub.role] = { ...sub, reason: sub.reason.slice(0, MODEL_SUBST_REASON_MAX) };
  return writeFile(file, data);
}

/** Drop the role's entry — the pinned model dispatched for real again. */
export function clearModelSubstitution(file: string, role: string): boolean {
  const data = readFile(file);
  if (!(role in data.entries)) return true;
  delete data.entries[role];
  return writeFile(file, data);
}

/**
 * The entries that still describe the ACTIVE mission: the role is pinned and
 * the pin is exactly the id that was substituted. A cleared mission (no
 * models) or a re-pinned role yields nothing — stale records never surface.
 */
export function activeModelSubstitutions(
  models: Record<string, string> | undefined | null,
  entries: ModelSubstitution[],
): ModelSubstitution[] {
  if (!models || typeof models !== "object") return [];
  return entries.filter((e) => models[e.role] === e.wanted);
}

/** One-line rendering for the card/chat: `builder: glm52/glm-5.2 -> tier-A default (reason)`. */
export function formatModelSubstitutions(entries: ModelSubstitution[]): string {
  return entries.map((e) => `${e.role}: ${e.wanted} -> ${e.usedInstead}${e.reason ? ` (${e.reason})` : ""}`).join("; ");
}
