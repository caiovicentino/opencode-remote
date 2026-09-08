// P2-210: model-readiness verdict. Pure module — no node:fs,
// node:child_process, node:http or ws imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same
// pattern as voicecap.ts / pairwindow.ts).
//
// A lay user pairs, types the first message and only then hits a raw
// upstream error because no provider has a credential — exactly the
// late-failure shape P2-201 fixed for voice transcription. The verdict is
// derived from the provider catalog the context ruler already fetches and
// caches, so "nothing usable configured" can surface BEFORE the first send.
// Messages are short, actionable pt-BR sentences with no file paths, no
// URLs, no provider identifiers and no secrets, and the unknown state is
// deliberately neutral — a probe that could not see must never accuse the
// machine of failing.

export type ModelReadyState = "ready" | "no-provider" | "no-model" | "unknown";

export interface ModelReadyVerdict {
  state: ModelReadyState;
  /** Short actionable pt-BR sentence — never a path, URL or provider id. */
  message: string;
}

/** One configured provider and how many models it exposes in the catalog. */
export interface ProviderSummary {
  id: string;
  models: number;
}

/**
 * The slice of the opencode /provider response the summary derives from:
 * `all` is the full known-provider catalog, `connected` lists the providers
 * with a configured credential. Older servers without `connected` cannot
 * answer "is anything usable" — the derivation returns null and the verdict
 * says unknown instead of guessing.
 */
export interface ProviderCatalogLike {
  all?: { id?: string; models?: unknown }[];
  connected?: unknown;
}

const READY_MESSAGE = "Modelos prontos para conversar neste computador.";
const NO_PROVIDER_MESSAGE =
  "Este computador ainda não tem nenhum modelo configurado — peça a quem gerencia a máquina para adicionar a credencial de um modelo antes de começar a conversa.";
const NO_MODEL_MESSAGE =
  "O computador tem credenciais de modelos, mas nenhuma delas tem modelos disponíveis — quem gerencia a máquina precisa concluir a configuração.";
const UNKNOWN_MESSAGE =
  "Não deu para verificar os modelos deste computador agora — a conversa continua disponível do mesmo jeito.";

/**
 * Derive the provider summary from the SAME catalog the context ruler already
 * fetches and caches — never from a new request. Only providers listed in
 * `connected` count (a credential is what makes a provider usable); the model
 * count comes from each provider's entry in `all`, so a connected provider
 * missing from the catalog counts zero models.
 */
export function providerSummary(catalog: ProviderCatalogLike | null | undefined): ProviderSummary[] | null {
  if (!catalog || !Array.isArray(catalog.all) || !Array.isArray(catalog.connected)) return null;
  const byId = new Map<string, { models?: unknown }>();
  for (const p of catalog.all) {
    if (p && typeof p.id === "string") byId.set(p.id, p);
  }
  const summary: ProviderSummary[] = [];
  for (const id of catalog.connected) {
    if (typeof id !== "string" || summary.some((s) => s.id === id)) continue;
    const entry = byId.get(id);
    summary.push({ id, models: entry && entry.models ? Object.keys(entry.models).length : 0 });
  }
  return summary;
}

/**
 * Resolve the model-readiness verdict from the catalog summary. A fetch-error
 * indicator and a missing summary both land in the neutral unknown (fail
 * open, never accuse); an empty list means no provider has a credential;
 * providers present but all exposing zero models mean the setup is
 * incomplete; any provider with at least one model is ready.
 */
export function modelReadyVerdict(
  summary: ProviderSummary[] | null | undefined,
  fetchFailed = false,
): ModelReadyVerdict {
  if (fetchFailed || !Array.isArray(summary)) {
    return { state: "unknown", message: UNKNOWN_MESSAGE };
  }
  if (summary.length === 0) {
    return { state: "no-provider", message: NO_PROVIDER_MESSAGE };
  }
  const usable = summary.some((p) => p && typeof p.id === "string" && Number.isFinite(p.models) && p.models > 0);
  if (!usable) {
    return { state: "no-model", message: NO_MODEL_MESSAGE };
  }
  return { state: "ready", message: READY_MESSAGE };
}
