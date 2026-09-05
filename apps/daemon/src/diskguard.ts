// P2-215: disk-space readiness verdict. Pure module — no node:fs,
// node:child_process, node:http or ws imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same
// pattern as opencodever.ts / modelready.ts / artifactretention.ts).
//
// Why: the daemon writes without pause on a lay user's machine — per-session
// artifacts (artifacts.ts), chunked upload staging (P2-181), the rotated
// audit log (P2-167) and the state file — and the P2-207 retention janitor
// trims only artifacts, which may not be enough. A full volume turns every
// write into a raw filesystem error mid-conversation: exactly the late, mute
// failure shape P2-210 closed for provider credentials and P2-213 for the
// opencode version. The verdict is derived from readings of the volume
// hosting the state dir, taken at boot and on the janitor's existing
// interval (all I/O stays in index.ts).
//
// Threshold rationale: the warning ceilings (2 GB free / 10% free) give the
// machine's owner time to act before writes start failing — media files the
// app handles routinely reach hundreds of MB, and the artifacts janitor only
// frees up to the 1 GB retention ceiling. The alert ceilings (500 MB / 5%)
// sit just above where small state writes (state file, audit tail, upload
// staging) already fail on some filesystems. The absolute-bytes rule governs
// roomy volumes; the fraction rule catches small volumes where 2 GB free is
// impossible. Both rules are always evaluated and the MORE SEVERE wins, so a
// huge nearly-full volume is never called ok just because it still has 2 GB.
//
// Messages are short, actionable pt-BR sentences with no file paths, no
// URLs, no command names and no secrets, and the unknown state is
// deliberately neutral — a reading that could not happen (probe error,
// absent value, zero, negative or non-finite numbers) must never accuse the
// machine of failing.

export type DiskSpaceState = "ok" | "low" | "critical" | "unknown";

export interface DiskVerdict {
  state: DiskSpaceState;
  /** Short actionable pt-BR sentence — never a path, URL or command name. */
  message: string;
}

/** Warn below this many free bytes on the volume hosting the state dir. */
export const DISK_WARN_FREE_BYTES = 2_000_000_000; // 2 GB
/** Alert (critical) below this many free bytes. */
export const DISK_ALERT_FREE_BYTES = 500_000_000; // 500 MB
/** Warn when less than this fraction of the volume is free. */
export const DISK_WARN_FREE_FRACTION = 0.1; // 10 %
/** Alert (critical) when less than this fraction is free. */
export const DISK_ALERT_FREE_FRACTION = 0.05; // 5 %

const OK_MESSAGE = "Espaço em disco suficiente nesta máquina.";
const LOW_MESSAGE =
  "O disco desta máquina está ficando sem espaço — quem gerencia a máquina pode liberar arquivos para a conversa continuar sem erros.";
const CRITICAL_MESSAGE =
  "O disco desta máquina está quase cheio — liberar espaço logo evita erros ao conversar e ao salvar arquivos.";
const UNKNOWN_MESSAGE =
  "Não deu para verificar o espaço em disco agora — a conversa segue disponível do mesmo jeito.";

const SEVERITY: Record<Exclude<DiskSpaceState, "unknown">, number> = { ok: 0, low: 1, critical: 2 };

type RuledState = Exclude<DiskSpaceState, "unknown">;

function bytesRule(free: number): RuledState {
  if (free < DISK_ALERT_FREE_BYTES) return "critical";
  if (free < DISK_WARN_FREE_BYTES) return "low";
  return "ok";
}

function fractionRule(fraction: number): RuledState {
  if (fraction < DISK_ALERT_FREE_FRACTION) return "critical";
  if (fraction < DISK_WARN_FREE_FRACTION) return "low";
  return "ok";
}

/**
 * Verdict for one reading of the volume hosting the state dir: `freeBytes`
 * and `totalBytes` come from the caller's statfs (null when the reading
 * failed). A missing reading, a zero total and negative or non-finite
 * numbers all land in the neutral unknown — never a guess, never an
 * accusation. Otherwise the bytes rule and the fraction rule are both
 * evaluated and the more severe state wins.
 */
export function diskVerdict(freeBytes: number | null, totalBytes: number | null): DiskVerdict {
  if (
    freeBytes === null ||
    totalBytes === null ||
    !Number.isFinite(freeBytes) ||
    !Number.isFinite(totalBytes) ||
    freeBytes < 0 ||
    totalBytes <= 0
  ) {
    return { state: "unknown", message: UNKNOWN_MESSAGE };
  }
  const byBytes = bytesRule(freeBytes);
  const byFraction = fractionRule(freeBytes / totalBytes);
  const state = SEVERITY[byBytes] >= SEVERITY[byFraction] ? byBytes : byFraction;
  if (state === "critical") return { state, message: CRITICAL_MESSAGE };
  if (state === "low") return { state, message: LOW_MESSAGE };
  return { state, message: OK_MESSAGE };
}
