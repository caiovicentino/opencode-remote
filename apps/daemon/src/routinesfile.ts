// P2-256: routines-file load verdict. Pure module — no node:fs, node:path,
// node:child_process or fetch imports on purpose, because index.ts runs
// main() on import and unit tests must never boot a daemon (same pattern as
// identityfile.ts / statefile.ts / readiness.ts, lessons P2-149 and P2-228).
//
// Why this exists: routines.json used to be persisted with a raw
// writeFileSync + chmodSync — no atomic write at all, the exact defect
// P2-165 fixed for the machine identity — and was read inside a try whose
// catch returned an empty list in silence. A power loss mid-write left a
// truncated file, the next boot loaded zero routines and the first
// following save overwrote the file with the empty list, destroying every
// routine the stage-3 user scheduled without a single word. This module is
// the single source of truth for what the daemon does with that file at
// load, and it always answers with a plan plus one short static pt-BR
// sentence that is safe to log.
//
// RULE-ORDER CONTRACT (the unit-test gate depends on this order):
// 1. a missing file is the first run and NEVER a quarantine;
// 2. a filesystem READ FAILURE never becomes an empty list — a transient
//    failure must not be able to erase a single routine (the same reason
//    already recorded in the P2-234 header) — it refuses with the file
//    untouched, never a quarantine;
// 3. text that cannot be parsed refuses WITH the quarantine move;
// 4. text that parses but is not a list refuses WITH the quarantine move;
// 5. only a well-formed list is used — an invalid individual entry is
//    discarded and counted instead of dropping the whole list;
// 6. the same input always yields an identical verdict.
//
// Rules 1 and 2 can never hold at the same time in a real read (a missing
// file is ENOENT, not a failure); when a caller passes both anyway, the
// read failure wins — it is the stronger invariant, so a missing file is
// only ever a first run when the read itself did not fail.
//
// Every message is a static string: no file path, no URL scheme, no secret
// and never any snippet of the file content or of a routine prompt, because
// the sentence goes to the log (P2-182 lesson).

import type { Routine } from "./routines.js";

export type RoutinesPlan = "first-run" | "use" | "refuse";

export interface RoutinesVerdict {
  plan: RoutinesPlan;
  /**
   * True only when the caller must preserve the illegible file beside the
   * original (quarantine move) before continuing. Never true for a missing
   * file or a filesystem read failure — see the rule-order contract above.
   */
  quarantine: boolean;
  /** Normalized list for plan "use" (invalid entries dropped); empty otherwise. */
  routines: Routine[];
  /** How many individual entries were discarded as invalid (plan "use"). */
  discarded: number;
  /** One short actionable pt-BR sentence — static, log-safe, content-free. */
  message: string;
}

export const ROUTINES_FIRST_RUN_MESSAGE =
  "Primeira execução das rotinas — nenhuma rotina salva ainda e a lista começa vazia.";
export const ROUTINES_USE_MESSAGE = "Rotinas lidas com sucesso.";
export const ROUTINES_REFUSE_CONTENT_MESSAGE =
  "O arquivo de rotinas está ilegível e foi preservado ao lado do original — nada foi apagado e a lista fica vazia até o arquivo ser restaurado ou removido.";
export const ROUTINES_REFUSE_READ_MESSAGE =
  "O arquivo de rotinas não pôde ser lido — verifique a permissão dele sem apagar nada; a lista fica vazia apenas nesta sessão.";

function isWellFormedEntry(value: unknown): value is Routine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id !== "" &&
    typeof r.name === "string" &&
    typeof r.prompt === "string" &&
    typeof r.hour === "number" &&
    Number.isFinite(r.hour) &&
    typeof r.minute === "number" &&
    Number.isFinite(r.minute)
  );
}

/**
 * Decide what the load must do with the routines file. Inputs are plain
 * values (the caller owns all I/O):
 *   - `exists`: whether the file was present when read;
 *   - `content`: the file text when the read succeeded, null otherwise;
 *   - `readFailure`: the filesystem error code when the read failed.
 *
 * Plans, in THIS order (see the rule-order contract in the header):
 * 1. read failure → refuse, never quarantine, the file stays untouched;
 * 2. file missing → first run, never quarantine;
 * 3. content that does not parse, or parses but is not a list → refuse
 *    WITH a quarantine move;
 * 4. a well-formed list → use, with invalid individual entries discarded
 *    and counted.
 */
export function routinesVerdict(
  exists: boolean,
  content: string | null,
  readFailure?: string | null,
): RoutinesVerdict {
  if (typeof readFailure === "string" && readFailure !== "") {
    return {
      plan: "refuse",
      quarantine: false,
      routines: [],
      discarded: 0,
      message: ROUTINES_REFUSE_READ_MESSAGE,
    };
  }
  if (!exists) {
    return {
      plan: "first-run",
      quarantine: false,
      routines: [],
      discarded: 0,
      message: ROUTINES_FIRST_RUN_MESSAGE,
    };
  }
  if (content == null) {
    return {
      plan: "refuse",
      quarantine: false,
      routines: [],
      discarded: 0,
      message: ROUTINES_REFUSE_READ_MESSAGE,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      plan: "refuse",
      quarantine: true,
      routines: [],
      discarded: 0,
      message: ROUTINES_REFUSE_CONTENT_MESSAGE,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      plan: "refuse",
      quarantine: true,
      routines: [],
      discarded: 0,
      message: ROUTINES_REFUSE_CONTENT_MESSAGE,
    };
  }
  const routines: Routine[] = [];
  let discarded = 0;
  for (const entry of parsed) {
    if (isWellFormedEntry(entry)) routines.push(entry);
    else discarded++;
  }
  return { plan: "use", quarantine: false, routines, discarded, message: ROUTINES_USE_MESSAGE };
}
