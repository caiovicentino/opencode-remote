// P2-201: speech-to-text capability verdict. Pure module — no node:fs,
// node:child_process, node:http or ws imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same
// pattern as pairwindow.ts / devicetouch.ts).
//
// The transcription route used to answer 501 with an English terminal
// instruction naming a host-only setup script — a dead end for someone
// holding a phone. The verdict surfaces the real reason instead: the binary
// is missing, or the binary is there but its model file is not (a case that
// used to collapse into "null" and die in a host log). The message is a
// short, actionable pt-BR sentence with no file paths, no script names and
// no URL schemes — the phone user can read it aloud to whoever owns the
// machine and act on it.

export type SttState = "ready" | "missing-binary" | "missing-model";

export interface SttVerdict {
  state: SttState;
  /** Short actionable pt-BR sentence — never a path, script name or URL. */
  message: string;
}

const READY_MESSAGE = "Transcrição de voz pronta neste computador.";
const MISSING_BINARY_MESSAGE =
  "A transcrição de voz ainda não está instalada neste computador — peça a quem gerencia a máquina para instalar o recurso de voz.";
const MISSING_MODEL_MESSAGE =
  "O computador tem o motor de transcrição, mas falta o modelo de voz — quem gerencia a máquina precisa concluir a instalação.";

/**
 * Resolve the speech-to-text capability from the raw detection facts:
 * `toolType` is the transcription engine found on the host (null when none),
 * `modelPresent` says whether its model file exists. Only whisper-cpp needs
 * a separate model; every other known engine (and the unknown type) is
 * classified on the binary alone, and no tool at all is a missing binary.
 */
export function sttVerdict(toolType: string | null, modelPresent: boolean): SttVerdict {
  if (toolType === "whisper-cpp") {
    return modelPresent
      ? { state: "ready", message: READY_MESSAGE }
      : { state: "missing-model", message: MISSING_MODEL_MESSAGE };
  }
  if (toolType === "mlx" || toolType === "openai") {
    return { state: "ready", message: READY_MESSAGE };
  }
  return { state: "missing-binary", message: MISSING_BINARY_MESSAGE };
}
