// P2-213: opencode version-readiness verdict. Pure module — no node:fs,
// node:child_process, node:http or ws imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same
// pattern as voicecap.ts / modelready.ts / pairwindow.ts).
//
// Why a minimum version: the daemon consumes the upstream session/message-part
// API and the /provider catalog shape validated against the 1.18.x line. Older
// upstreams still answer the /global/health probe (so every existing verdict
// says healthy) and then fail with a raw error mid-conversation — exactly the
// late-failure shape P2-201 fixed for transcription and P2-210 for model
// readiness. 1.18.0 is the oldest line the daemon's own eval battery runs
// green against; below it the indicator says too-old BEFORE the first send.
//
// The verdict is derived once at boot from the raw `--version` output of the
// already-resolved binary (all I/O stays in index.ts). Messages are short,
// actionable pt-BR sentences with no file paths, no URLs, no command names
// and no secrets, and the unknown state is deliberately neutral — a probe
// that could not see (no binary, spawn error, stderr output, timeout) must
// never accuse the machine of failing.

export type OpencodeVersionState = "ok" | "too-old" | "unknown";

export interface OpencodeVersionVerdict {
  state: OpencodeVersionState;
  /** Short actionable pt-BR sentence — never a path, URL or command name. */
  message: string;
}

/** Oldest opencode line the daemon is validated against (see header). */
export const MIN_OPENCODE_VERSION = "1.18.0";

const OK_MESSAGE = "O servidor de agentes deste computador está na versão que este app espera.";
const TOO_OLD_MESSAGE =
  "O servidor de agentes deste computador está mais antigo do que este app espera — quem gerencia a máquina pode atualizá-lo e reiniciá-lo para conversar sem erros.";
const UNKNOWN_MESSAGE =
  "Não deu para verificar a versão do servidor de agentes agora — a conversa segue disponível do mesmo jeito.";

/**
 * Extract the first dot-separated numeric sequence in the text: tolerant to a
 * leading letter-v prefix ("v1.18.0"), to pre-release suffixes ("1.18.0-beta.1")
 * and to extra segments ("1.18.0.1"), and to arbitrary noise around the
 * version. At least two segments are required — a lone number is noise (dates,
 * pids, build ids), not a version. Returns null for absent, empty or
 * unrecognizable text.
 */
export function parseVersion(text: string | null | undefined): number[] | null {
  if (!text) return null;
  const m = text.match(/\d+(?:\.\d+)+/);
  if (!m) return null;
  const parts = m[0].split(".").map((s) => Number.parseInt(s, 10));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

/** Segment-by-segment numeric comparison; missing segments count as 0, so
 * "1.18" equals "1.18.0" and "1.18.25" beats "1.18". */
function compareSegs(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Verdict for one raw version string (or null/unrecognizable) against the
 * given minimum: equal or greater is ok, any smaller significant segment
 * (major, minor or patch) is too-old, and anything that cannot be parsed —
 * including an unparseable minimum — lands in the neutral unknown.
 */
export function versionVerdict(raw: string | null | undefined, min: string): OpencodeVersionVerdict {
  const parsed = parseVersion(raw);
  const minParsed = parseVersion(min);
  if (!parsed || !minParsed) return { state: "unknown", message: UNKNOWN_MESSAGE };
  if (compareSegs(parsed, minParsed) < 0) return { state: "too-old", message: TOO_OLD_MESSAGE };
  return { state: "ok", message: OK_MESSAGE };
}
