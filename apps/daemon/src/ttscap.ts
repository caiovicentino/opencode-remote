// P2-298: spoken-reply (text-to-speech) capability verdict. Pure module — no
// node:fs, node:child_process, node:http, node:os or fetch imports, and no I/O
// of any kind on purpose, because index.ts runs main() on import and unit
// tests must never boot a daemon (same pattern as voicecap.ts / readiness.ts,
// lessons P2-149, P2-248 and P2-288). All probing (running the platform
// locator, reading the resolved binary path) stays in the caller; this module
// only judges the already-resolved facts.
//
// Why this exists: spoken replies used to repeat, end to end, the dead end the
// P2-201 verdict closed for voice input. The refusal answered 501 with a raw
// English sentence naming the host tool and telling the person to install it
// on the machine — useless for someone holding the phone. Worse, the
// detection itself never worked on Windows: the probe ran a POSIX locator and
// only accepted a result starting with a slash, so a correctly installed tool
// still read as missing. The verdict below restores the same register as the
// other capability verdicts: two states and one short, actionable pt-BR
// sentence.
//
// Verdicts — exactly two, both documented here:
//   - "ready":        the resolved tool path has the absolute form the
//                     platform produces; spoken replies work;
//   - "missing-tool": no path was resolved, the input is not textual, or the
//                     path has an unacceptable form; spoken replies are off.
//
// Decision rules — ttsVerdict evaluates them in THIS order and the order is
// part of the contract:
//   1. non-textual or empty input becomes missing-tool — there is no tool to
//      speak of;
//   2. a platform outside the documented pair falls into the POSIX rule —
//      unknown platforms are judged by the conservative POSIX reading;
//   3. a path whose form is unacceptable for the resolved platform becomes
//      missing-tool, fail-closed: announcing that the machine speaks without
//      a resolved tool is worse than admitting it does not speak;
//   4. an acceptable path becomes ready;
//   5. the result is identical for the same input on every call — no clock,
//      no randomness, no module state.
//
// Message boundary (part of the contract): no phrase ever contains a path, a
// tool name, a script name, a port, an address, a raw environment variable or
// a secret. The sentence must survive being read aloud to whoever owns the
// machine, the same register voicecap.ts established.

export type TtsState = "ready" | "missing-tool";

/** Documented platform pair: "windows" judges by the Windows absolute-path
 * rule, "posix" by the POSIX one — anything else falls into the POSIX rule. */
export type TtsPlatform = "windows" | "posix";

export interface TtsVerdict {
  state: TtsState;
  /** Short actionable pt-BR sentence — never a path, tool or script name. */
  message: string;
}

const READY_MESSAGE = "Respostas faladas prontas neste computador.";
const MISSING_TOOL_MESSAGE =
  "A fala deste computador ainda não está instalada — peça a quem gerencia a máquina para instalar o recurso de voz.";

/**
 * The pure path-form rule per platform: a POSIX absolute path starts with a
 * slash; a Windows absolute path carries a drive letter (`C:\` or `C:/`) or
 * starts with two backslashes (UNC). An unknown platform is judged by the
 * POSIX rule, and anything that is not a non-empty string is unacceptable.
 */
export function isAbsoluteToolPath(toolPath: unknown, platform: unknown): boolean {
  if (typeof toolPath !== "string") return false;
  const p = toolPath.trim();
  if (p === "") return false;
  if (platform === "windows") {
    return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(p);
  }
  return p.startsWith("/");
}

/**
 * Resolve the spoken-reply capability from the already-resolved tool path
 * (null when the probe found nothing) and the platform. See the module
 * header for the rule order; every rule lands on one of the two documented
 * verdicts, deterministically.
 */
export function ttsVerdict(toolPath: unknown, platform: unknown): TtsVerdict {
  // rule 1 — no textual path at all: there is no tool to speak of
  if (typeof toolPath !== "string" || toolPath.trim() === "") {
    return { state: "missing-tool", message: MISSING_TOOL_MESSAGE };
  }
  // rule 2 — a platform outside the documented pair falls into the POSIX rule
  const p: TtsPlatform = platform === "windows" ? "windows" : "posix";
  // rule 3 — unacceptable path form is missing-tool, fail-closed
  if (!isAbsoluteToolPath(toolPath, p)) {
    return { state: "missing-tool", message: MISSING_TOOL_MESSAGE };
  }
  // rule 4 — an acceptable path means spoken replies work
  return { state: "ready", message: READY_MESSAGE };
}
