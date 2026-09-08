// P2-267: pure data-wipe planner for the macOS shell. On the Mac there is no
// uninstaller — the owner drags the bundle to the Trash and the app's own
// data survives: daemon.json (the machine ECDH identity and VAPID keys), the
// paired-phone list, the shell state files and the logs folder stay on a
// computer that may be sold or shared, without a single product screen ever
// having said they exist. This module is the documented, testable model of
// the wipe: whether it may run at all, what its confirmation says, and an
// executor that deletes exactly the immediate children the P2-249 plan
// (uninstallplan.ts, same vocabulary on every platform) marked removable.
//
// Same module hygiene as uninstallplan.ts / loginitem.ts / quithint.ts: NO
// electron, NO node:fs, NO node:path, no fetch, no I/O of any kind. The
// executor takes the filesystem and the path separator as injected values
// (same structural-injection pattern as LogFs in desktop-log.ts), so
// scripts/unit.test.ts exercises it against a fake fs and never touches the
// real disk.
//
// RULE ORDER CONTRACT (the gate depends on it) — rules apply in this exact
// order and the order is part of the API:
//
//  1. an active harness session REFUSES before any other decision — no test
//     path may open a dialog or delete operator files (the P2-235 and P2-238
//     lessons: the harness drives the operator's machine);
//  2. an absent, empty or non-absolute data root REFUSES fail-closed — the
//     wipe never guesses a directory, and a bare filesystem root (a volume,
//     drive or UNC host with no path below it) is refused the same way;
//  3. a missing explicit user confirmation REFUSES — nothing is deleted
//     without a deliberate click;
//  4. an empty removable list becomes NOTHING-TO-DO — there is simply no
//     app data where the root says the app lives;
//  5. only the remainder becomes WIPE.
//
// Every reason and every piece of dialog copy is a short static pt-BR string
// with no file path, no volume name, no public key, no address and no secret
// (the P2-140 and P2-182 bar): the dialog speaks in categories, never in
// paths.

import { isRefusedChildName, type UninstallCleanupPlan } from "./uninstallplan";

/** What the verdict decided. */
export type DataWipeAction = "refuse" | "noop" | "wipe";

export interface DataWipeVerdict {
  action: DataWipeAction;
  /** Short pt-BR motive — static, path-free, volume-free, secret-free. */
  reason: string;
  /** The static confirmation copy; non-empty only for a wipe verdict (a
   * refusal or a nothing-to-do never opens a dialog to explain itself). */
  confirmText: string;
}

/** Everything the decision needs, resolved by the caller (main.ts) at click
 * time. No probe, no request and no timer is created for this. */
export interface DataWipeInput {
  /** True when the hermetic test harness owns this session
   * (OCR_DESKTOP_SESSION) — it must always refuse, before everything else. */
  harnessSession: boolean;
  /** The already-resolved data root (absolute) — or null/undefined when the
   * caller could not resolve one. */
  dataRoot: string | null | undefined;
  /** True only after the user completed the explicit two-step confirmation. */
  confirmed: boolean;
  /** The names uninstallCleanupPlan classified as removable (its `remove`
   * bucket — immediate children of the data root, nothing else). */
  removableNames: readonly string[];
}

/** True when the string is an absolute path on either separator convention
 * (POSIX root, Windows drive with separator, or a UNC share). Deliberately
 * hand-rolled: this module imports nothing, not even node:path. */
export function isAbsoluteDataRoot(root: string): boolean {
  return root.startsWith("/") || root.startsWith("\\") || /^[a-z]:[\\/]/i.test(root);
}

/** True when the root names no directory below a volume/drive/host boundary
 * ("/", "C:\\", "\\\\host", all-separator strings) — deleting its immediate
 * children would act on a whole volume, so the wipe refuses instead. */
export function isFilesystemRoot(root: string): boolean {
  const trimmed = root.replace(/[\\/]+$/, "");
  if (trimmed === "") return true;
  if (/^[a-z]:$/i.test(trimmed)) return true;
  if (trimmed.startsWith("\\\\")) return !trimmed.slice(2).includes("\\");
  return false;
}

/** Static reasons, exported so main.ts can branch on the gate consultation
 * without comparing against string literals. */
export const WIPE_REASON_HARNESS = "sessão de teste do harness — nenhum dado é apagado";
export const WIPE_REASON_ROOT = "raiz de dados ausente, vazia ou não absoluta — recusado sem adivinhar";
export const WIPE_REASON_UNCONFIRMED = "confirmação explícita ausente — nada é apagado sem clique";
export const WIPE_REASON_NOTHING = "nenhum dado do app para apagar";
export const WIPE_REASON_WIPE = "confirmação em duas etapas concluída — apagar e encerrar";

/** Decide whether the data wipe may run. Rules apply in this exact order:
 * 1. harness session refuses (before everything — no dialog, no deletion);
 * 2. absent/empty/non-absolute (or bare filesystem) root refuses fail-closed;
 * 3. missing explicit confirmation refuses;
 * 4. empty removable list is nothing-to-do;
 * 5. only the remainder wipes. */
export function dataWipeVerdict(input: DataWipeInput): DataWipeVerdict {
  if (input.harnessSession) {
    return { action: "refuse", reason: WIPE_REASON_HARNESS, confirmText: "" };
  }
  const root = input.dataRoot;
  if (typeof root !== "string" || root.length === 0 || !isAbsoluteDataRoot(root) || isFilesystemRoot(root)) {
    return { action: "refuse", reason: WIPE_REASON_ROOT, confirmText: "" };
  }
  if (!input.confirmed) {
    return { action: "refuse", reason: WIPE_REASON_UNCONFIRMED, confirmText: "" };
  }
  if (input.removableNames.length === 0) {
    return { action: "noop", reason: WIPE_REASON_NOTHING, confirmText: "" };
  }
  return { action: "wipe", reason: WIPE_REASON_WIPE, confirmText: WIPE_STEP1_MESSAGE };
}

// --- native two-step confirmation copy (static, pt-BR, category-speak) --------

export const WIPE_DIALOG_TITLE = "Apagar os dados do OpenCode Remote?";
export const WIPE_STEP1_MESSAGE =
  "Isto apaga, nesta máquina, os dados do próprio app — a identidade desta máquina, a lista de celulares pareados, os arquivos de estado e os logs.";
export const WIPE_STEP1_DETAIL =
  "O que fica — nenhum arquivo seu fora dos dados do app é aberto, movido ou apagado.";
export const WIPE_STEP2_MESSAGE =
  "Depois de apagar, todos os celulares pareados perdem o acesso a esta máquina e o app encerra sozinho.";
export const WIPE_STEP2_DETAIL =
  "Para usar o app de novo nesta máquina, será preciso parear o celular novamente.";
export const WIPE_BUTTON_NEXT = "Continuar";
export const WIPE_BUTTON_WIPE = "Apagar dados e encerrar";
export const WIPE_BUTTON_CANCEL = "Cancelar";

/** Dialog button positions, fixed by the buttons array order in main.ts:
 * every step puts its primary action first and Cancel last (Escape). */
export const WIPE_BUTTON_INDEX = { primary: 0, cancel: 1 } as const;

// --- executor (fs injected — the unit tests never touch the real disk) --------

/** Structural subset of node:fs the executor touches (tests inject fakes). */
export interface WipeFs {
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
}

/** Outcome report: names removed and, per failed removal, the bare name plus
 * the stable errno-style code only — never the error text, which carries the
 * full path and would leak it into the log (the P2-140 bar). */
export interface WipeReport {
  removed: string[];
  failed: { name: string; code: string }[];
}

/** Delete exactly the immediate children the plan marked removable, building
 * each child path as root + separator + name. Defense in depth, in order:
 * a structurally unsafe name (empty, separator, parent jump, absolute) is
 * skipped even if a hand-built plan smuggled it into `remove`; nothing
 * outside the root is ever addressable; and a removal failure becomes a
 * report line, never an exception that takes the window down. */
export function wipePlannedChildren(
  dataRoot: string,
  plan: UninstallCleanupPlan,
  fs: WipeFs,
  sep: string,
): WipeReport {
  const report: WipeReport = { removed: [], failed: [] };
  const base = dataRoot.endsWith(sep) ? dataRoot : dataRoot + sep;
  for (const name of plan.remove) {
    if (isRefusedChildName(name)) continue;
    try {
      // force: an entry that already vanished is the goal reached, not a
      // failure; recursive: the plan's vocabulary includes directories.
      fs.rmSync(base + name, { recursive: true, force: true });
      report.removed.push(name);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      report.failed.push({ name, code: typeof code === "string" ? code : "erro" });
    }
  }
  return report;
}
