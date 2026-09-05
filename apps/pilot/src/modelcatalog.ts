/**
 * Mission self-serve v2 — model availability at dispatch time.
 *
 * A mission may pin a model per role (`mission.json` → `models`). The chat
 * agent is told to only write ids it verified against `opencode models`, but
 * the pilot never trusts the file alone: right before a dispatch the id is
 * checked against the LIVE catalog of the user's opencode (`GET /provider`,
 * the same endpoint the context gauge reads) and an unknown/unavailable id
 * falls back to the tier default with a warn log — the slot never crashes on
 * a model that vanished (provider removed, key revoked, typo that slipped by).
 *
 * The catalog is ~6MB, so it is cached per process with a short TTL. All
 * network access is injectable; the decision helper is pure.
 */
import { OPENCODE_URL } from "./runner";
import type { MissionModelRole, MissionModels } from "./mission";

/** Shape of `GET /provider` as far as ids go (the rest is ignored). */
export interface ProviderCatalogShape {
  all?: Array<{ id?: unknown; models?: Record<string, unknown> } | null>;
}

/**
 * Every model id the catalog exposes, in the `provider/model` form that
 * `opencode models` prints and `opencode run --model` accepts. The model key
 * may itself contain slashes (`hpc-ai/deepseek/deepseek-v4-flash`); the id is
 * always `<provider.id>/<model key>`.
 */
export function parseProviderCatalog(json: unknown): Set<string> {
  const ids = new Set<string>();
  const all = (json as ProviderCatalogShape | null)?.all;
  if (!Array.isArray(all)) return ids;
  for (const p of all) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id) continue;
    const models = p.models;
    if (!models || typeof models !== "object") continue;
    for (const key of Object.keys(models)) if (key) ids.add(`${p.id}/${key}`);
  }
  return ids;
}

/** Cache TTL for the live catalog (per process). */
export const CATALOG_TTL_MS = 10 * 60_000;

let cached: { at: number; ids: Set<string> } | null = null;

/** Test seam: drop the process-level catalog cache. */
export function resetCatalogCache(): void {
  cached = null;
}

/**
 * Live set of available model ids, or null when the catalog is unreachable
 * or unparseable (the caller treats null as "cannot verify" → tier default).
 * A successful fetch is cached for CATALOG_TTL_MS; a failure is never cached.
 */
export async function fetchAvailableModels(
  opts: { url?: string; fetchImpl?: typeof fetch; now?: number; ttlMs?: number } = {},
): Promise<Set<string> | null> {
  const now = opts.now ?? Date.now();
  const ttl = opts.ttlMs ?? CATALOG_TTL_MS;
  if (cached && now - cached.at < ttl) return cached.ids;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${opts.url ?? OPENCODE_URL}/provider`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const ids = parseProviderCatalog(await res.json());
    if (ids.size === 0) return null; // an empty catalog is indistinguishable from a broken one — cannot verify
    cached = { at: now, ids };
    return ids;
  } catch {
    return null;
  }
}

export type MissionModelPick =
  | { model: string; source: "mission" }
  | { model: null; source: "default"; reason?: string; wanted?: string };

/**
 * Pure dispatch decision (v2): the mission's model for `role` wins ONLY when
 * the live catalog lists it. No model configured → default silently; model
 * configured but the catalog is unavailable (null) or does not contain the id
 * → default with a `reason` the caller logs as a warn. Never throws.
 */
export function pickMissionModel(
  models: MissionModels | undefined,
  role: MissionModelRole,
  available: ReadonlySet<string> | null,
): MissionModelPick {
  const wanted = models?.[role];
  if (!wanted) return { model: null, source: "default" };
  if (!available) return { model: null, source: "default", wanted, reason: "model catalog unavailable — cannot verify the mission model" };
  if (!available.has(wanted)) return { model: null, source: "default", wanted, reason: "mission model not available in this opencode (see `opencode models`)" };
  return { model: wanted, source: "mission" };
}
