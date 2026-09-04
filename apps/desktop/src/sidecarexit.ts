// P2-140: pure classifier for the desktop sidecar's (daemon child) exit —
// answers WHY the local daemon died instead of leaving the stage-3 user with a
// bare "daemon down" after the backoff. Same shape and spirit as the daemon's
// upstream.ts classifier (P2-135): static, calm, actionable pt-BR strings with
// no paths, tokens or secrets. No electron / child_process imports on purpose
// — scripts/unit.test.ts evaluates this module in plain Node.

/** Detailed exit kinds; `unknown` is the honest fallback when neither the
 * exit code nor the stderr tail carries a recognizable cause. */
export type SidecarExitKind = "port-busy" | "entry-missing" | "runtime-error" | "killed" | "unknown";

export interface SidecarExitVerdict {
  kind: SidecarExitKind;
  /** short pt-BR description of what was observed (log/diagnostic copy) */
  reason: string;
  /** actionable pt-BR next step */
  hint: string;
}

/** Exit inputs the shell feeds into classifySidecarExit. */
export interface SidecarExitProbe {
  /** exit code when the child exited on its own (null when killed by signal) */
  code: number | null;
  /** signal name ("SIGKILL"…) when the child was killed (null otherwise) */
  signal: string | null;
  /** final bounded tail of the child's stderr (may be empty) */
  stderrTail: string;
}

/** Recognizable stderr markers. EADDRINUSE = another application owns the
 * metrics port; ENOENT = the daemon entry file vanished (broken install). */
const PORT_BUSY_RE = /eaddrinuse/i;
const ENTRY_MISSING_RE = /enoent/i;

/**
 * Map one unintentional sidecar exit to (kind, reason, hint). Deterministic
 * and secret-free: reason/hint are static strings, the stderr tail is only
 * searched for markers and never echoed. The caller only invokes this for
 * exits it did not cause itself (stopping), so a code 0 without an
 * intentional stop still reads as `unknown`.
 */
export function classifySidecarExit(probe: SidecarExitProbe): SidecarExitVerdict {
  const tail = (probe.stderrTail ?? "").slice(-8192);

  // Marker checks first: a child killed by SIGKILL after printing EADDRINUSE
  // is still a busy-port story, and that is the actionable one.
  if (PORT_BUSY_RE.test(tail)) {
    return {
      kind: "port-busy",
      reason: "outra aplicação está ocupando a porta local do daemon",
      hint: "feche o programa que usa a porta do daemon ou reinicie a máquina; depois reabra o app",
    };
  }
  if (ENTRY_MISSING_RE.test(tail)) {
    return {
      kind: "entry-missing",
      reason: "os arquivos do daemon não foram encontrados",
      hint: "reinstale o aplicativo para restaurar a instalação e reabra o app",
    };
  }
  if (typeof probe.signal === "string" && probe.signal !== "") {
    return {
      kind: "killed",
      reason: "o daemon foi encerrado pelo sistema",
      hint: "reabra o app; se acontecer com frequência, feche outros programas pesados e tente de novo",
    };
  }
  if (typeof probe.code === "number" && probe.code !== 0 && tail.trim() !== "") {
    return {
      kind: "runtime-error",
      reason: "o daemon falhou durante a inicialização",
      hint: "reinicie o app; se persistir, envie o diagnóstico em Configurações → Ajuda",
    };
  }
  return {
    kind: "unknown",
    reason: "o daemon saiu de forma inesperada",
    hint: "reinicie o app; se persistir, envie o diagnóstico em Configurações → Ajuda",
  };
}
