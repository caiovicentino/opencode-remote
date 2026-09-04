// P2-135: pure classifier for the daemon's upstream (agent server / opencode)
// health probes. No ws/net/fetch imports on purpose — index.ts runs main() on
// import, so unit tests must never boot a daemon (same pattern as
// relayretry.ts / localws.ts). The caller performs the actual HTTP probe and
// feeds status + parsed body (or the fetch error) into classifyUpstream.

/** Detailed states a probe can resolve to; `unknown` only exists before the
 * first probe finishes and lives in the daemon, not in classifier output. */
export type UpstreamState = "ok" | "unauthorized" | "unreachable" | "timeout" | "unhealthy";

export interface UpstreamVerdict {
  state: UpstreamState;
  /** short pt-BR description of what was observed */
  reason: string;
  /** actionable pt-BR next step; "" when nothing needs doing */
  hint: string;
}

export interface UpstreamDetail {
  state: UpstreamState | "unknown";
  reason: string;
  hint: string;
  /** ISO timestamp of the last finished probe; null before the first one */
  checkedAt: string | null;
}

/** Probe inputs the daemon feeds into classifyUpstream. */
export interface UpstreamProbe {
  /** HTTP status when the upstream answered (absent when the request failed) */
  status?: number;
  /** parsed JSON body of the response (undefined when there is none) */
  body?: unknown;
  /** false when the body could not be parsed as JSON (default true) */
  bodyOk?: boolean;
  /** fetch error (connection refused, DNS failure, abort…) when it never answered */
  error?: unknown;
  /** true when the caller gave up waiting for the response */
  timedOut?: boolean;
}

/** Cap for a single upstream probe — slow-but-alive servers must surface as
 * `timeout` instead of stalling the watchdog tick forever. */
export const UPSTREAM_PROBE_TIMEOUT_MS = 5_000;

/** Stringify an error for classification: walks the whole `cause` chain (Node/
 * undici fetch wraps connection failures as a top-level `TypeError: fetch failed`
 * with the real `ECONNREFUSED`-class error only in `.cause`) and picks up the
 * `code` property at every link. Depth-capped; deterministic. */
function errText(err: unknown): string {
  let text = "";
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    if (cur instanceof Error) {
      text += ` ${cur.name} ${cur.message}`;
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") text += ` ${code}`;
    } else if (typeof cur === "object") {
      const obj = cur as { code?: unknown; message?: unknown };
      if (typeof obj.code === "string") text += ` ${obj.code}`;
      if (typeof obj.message === "string") text += ` ${obj.message}`;
    } else {
      text += ` ${String(cur)}`;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return text.toLowerCase();
}

function isTimeout(probe: UpstreamProbe, err: string): boolean {
  if (probe.timedOut === true) return true;
  return /timeout|timed out|abort/.test(err);
}

/**
 * Map one upstream probe outcome to (state, reason, hint). Deterministic and
 * secret-free: reason/hint are static strings — the 401 case says the token
 * was refused without ever quoting it, and probe bodies are never echoed.
 */
export function classifyUpstream(probe: UpstreamProbe = {}): UpstreamVerdict {
  const err = probe.error ? errText(probe.error) : "";

  if (probe.error || probe.timedOut) {
    // refused can never be a timeout, so it is checked first — this is the
    // "server not installed / wrong port" case the UI must distinguish
    if (!isTimeout(probe, err) && err.includes("econnrefused")) {
      return {
        state: "unreachable",
        reason: "conexão recusada",
        hint: "o servidor do agente não está aceitando conexões — verifique se o opencode está rodando nesta máquina",
      };
    }
    if (isTimeout(probe, err)) {
      return {
        state: "timeout",
        reason: "opencode não respondeu a tempo",
        hint: "o servidor do agente está lento ou travado; reinicie o opencode se persistir",
      };
    }
    return {
      state: "unreachable",
      reason: "servidor do agente inalcançável",
      hint: "confira a rede e se o opencode está rodando na porta configurada",
    };
  }

  if (probe.status === 401 || probe.status === 403) {
    return {
      state: "unauthorized",
      reason: `autenticação recusada (HTTP ${probe.status})`,
      hint: "a senha/token do opencode mudou — atualize a credencial do agente nas configurações do daemon",
    };
  }

  if (typeof probe.status === "number" && probe.status >= 200 && probe.status < 300) {
    if (probe.bodyOk === false) {
      return {
        state: "unhealthy",
        reason: "resposta malformada do opencode",
        hint: "a resposta veio corrompida; reinicie o opencode e confira a versão do servidor",
      };
    }
    const healthy = (probe.body as { healthy?: unknown } | undefined)?.healthy;
    if (healthy === false) {
      return {
        state: "unhealthy",
        reason: "opencode se declara unhealthy",
        hint: "o servidor respondeu mas se declara doente; reinicie o opencode nesta máquina",
      };
    }
    return { state: "ok", reason: "opencode saudável", hint: "" };
  }

  return {
    state: "unhealthy",
    reason: typeof probe.status === "number" ? `opencode respondeu HTTP ${probe.status}` : "opencode respondeu status inválido",
    hint: "reinicie o servidor do agente; se persistir, confira os logs do opencode",
  };
}
