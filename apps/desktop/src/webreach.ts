// P2-197: reach classifier for the app address shown in the pairing QR.
// webAppUrlProblems (webappurl.ts) is purely syntactic — a hosted relay that is
// down, a DNS name that never existed, an expired certificate or a stranger's
// server all pass it and mint a "perfect" QR that lands the phone on a blank
// page. This module classifies ONE probe attempt of that address so the
// overlay can say, calmly, that the culprit is the relay and not the camera.
//
// Same module hygiene as webappurl.ts / sidecarexit.ts: NO electron, NO
// node:fs, no fetch, no I/O — main.ts performs the actual probe at runtime and
// scripts/unit.test.ts exercises every branch in plain Node. Messages are
// static, actionable pt-BR with no paths, no URL schemes and no secrets (the
// P2-140 bar): a short phrase a stage-3 user can act on.

/** Documented probe ceiling — mirrors PROBE_TIMEOUT_MS in main.ts (2s). */
export const WEB_REACH_TIMEOUT_MS = 2_000;

export type ReachState =
  | "ok"
  | "unreachable"
  | "timeout"
  | "tls-error"
  | "dns-error"
  | "http-error"
  | "not-our-app";

export interface ReachVerdict {
  state: ReachState;
  /** short actionable pt-BR phrase — static, never echoes the address */
  message: string;
}

/** Inputs of one probe attempt, already normalized by the caller. */
export interface ReachProbe {
  /** HTTP status of the answer, or null when the attempt failed before one */
  status: number | null;
  elapsedMs: number;
  /** short error name (err.cause.code ?? err.name, "" when none) */
  errorName: string;
  /** true when the 200 body carries one of the real app markers */
  appMarker: boolean;
}

const ABORT_RE = /aborterror|timeouterror|abort_err/i;
const DNS_RE = /enotfound|eai_again|eai_nodata|getaddrinfo/i;
const TLS_RE = /cert_|err_tls|unable_to_verify_leaf_signature|depth_zero_self_signed_cert|self_signed_cert_in_chain|eproto/i;

/**
 * True only when the body carries a marker of the REAL app — the two stable
 * markers of apps/web/index.html (`id="root"` and the product wordmark). A
 * captive portal or an nginx default page must read as "not ours".
 */
export function hasAppMarker(bodyPrefix: string): boolean {
  const body = bodyPrefix ?? "";
  return body.includes('id="root"') || body.includes("OpenCode Remote");
}

/**
 * Map one probe attempt to (state, message). Deterministic and secret-free.
 * A named network error without a status decides first (abort → timeout, name
 * resolution → dns-error, certificate → tls-error, anything else →
 * unreachable); with a status, only a 200 carrying the app marker is "ok",
 * any 4xx/5xx is "http-error" and everything else (including a marker-less
 * 200) is "not-our-app".
 */
export function probeVerdict(p: ReachProbe): ReachVerdict {
  const errorName = p.errorName ?? "";
  if (p.status === null && errorName !== "") {
    if (ABORT_RE.test(errorName)) {
      return { state: "timeout", message: "o endereço do app não respondeu a tempo — teste de novo" };
    }
    if (DNS_RE.test(errorName)) {
      return {
        state: "dns-error",
        message: "o nome do endereço do app não foi encontrado — confira o endereço salvo nas configurações",
      };
    }
    if (TLS_RE.test(errorName)) {
      return {
        state: "tls-error",
        message: "o certificado do endereço do app não é confiável — renove-o no relay hospedado",
      };
    }
    return {
      state: "unreachable",
      message: "o endereço do app não respondeu — confira se o relay hospedado está no ar e teste de novo",
    };
  }
  if (typeof p.status === "number") {
    if (p.status === 200 && p.appMarker) {
      return { state: "ok", message: "o endereço do app respondeu" };
    }
    if (p.status >= 400) {
      return {
        state: "http-error",
        message: "o endereço do app respondeu com erro — confira o relay hospedado e teste de novo",
      };
    }
  }
  return {
    state: "not-our-app",
    message: "quem respondeu nesse endereço não é este app — confira se o relay hospedado serve o app",
  };
}
