// P2-241: pure download policy for the desktop shell. Until this module every
// download started inside the app — a link clicked in the P2-092 Browser pane,
// an artifact link, a redirect — fell into Electron's default behavior: a
// native save dialog with the server's raw name, no scheme check, no size
// ceiling, no log line and no completion signal. A native modal is exactly the
// kind of surface the stage-3 product must keep on a leash (P2-221, P2-235,
// P2-238): in a hermetic test session it steals the operator's focus and
// Battery, and for a lay user it pops up a foreign window with a name nobody
// sanitized. This module decides, for one announced download, whether the
// shell saves it (to the documented Downloads folder, no dialog) or refuses
// it — and one static pt-BR phrase that travels to the log and to the
// completion notification.
//
// Same module hygiene as extlink.ts / hotkey.ts: NO electron, no node
// builtins, no I/O of any kind — main.ts resolves the session flag, the scheme verdict
// (P2-178 extlink decision over the download URL), the announced name and
// size, and applies the plan; scripts/unit.test.ts exercises every rule in
// plain Node. Phrases are short static pt-BR strings with no absolute file
// paths, no URL schemes, no session identifiers and no secrets (the P2-140
// bar). Results are deterministic: the same input always yields the same
// plan, so tests can pin the whole table.
//
// OUT OF SCOPE ON PURPOSE: the app NEVER executes and NEVER opens a
// downloaded file — not with a confirmation, not "just to preview". A
// downloaded file is untrusted bytes until a human decides otherwise; the
// shell only ever reveals it in the file manager (the same shell
// .showItemInFolder path the P2-233 installer download uses), so the OS
// default handler stays exactly one deliberate user action away. The module
// also never touches the P2-184 webview navigation guard, the P2-182
// permission decision, the P2-235 context menu or the P2-228 upload
// retention — it governs only the will-download event.
//
// RULE ORDER CONTRACT (the gate depends on it): the harness-session rule
// comes FIRST and must stay first — before any scheme, name or size
// consideration, mirroring P2-221/P2-235/P2-238 — because tools/desktop.mjs
// and the npm run test:desktop-flow battery run on the operator's machine and
// a native dialog (or a write to the real Downloads folder) would steal focus
// and leave stray files behind. The second rule is a refused scheme, the
// third an invalid name, the fourth an announced size above the documented
// ceiling.

import type { ExternalOpenDecision } from "./extlink";

/** Documented ceiling for one download's announced file name (characters). */
export const DOWNLOAD_NAME_MAX = 200;

/** Documented ceiling for one download's announced size (bytes) — 1 GB,
 * generous for any real document, media file or installer, small enough that
 * a runaway link cannot quietly fill the disk. */
export const DOWNLOAD_MAX_BYTES = 1_000_000_000;

/** The documented limits as one object — main.ts passes this verbatim so the
 * numbers live in exactly one place. */
export const DOWNLOAD_LIMITS: DownloadLimits = { nameMax: DOWNLOAD_NAME_MAX, bytesMax: DOWNLOAD_MAX_BYTES };

/** Documented limits, injected by the caller (no environment reads here). */
export interface DownloadLimits {
  /** Name ceiling in characters. */
  nameMax: number;
  /** Size ceiling in bytes. */
  bytesMax: number;
}

/** The two plans: refuse (cancel the item, one log line, nothing on disk) or
 * save (documented Downloads folder, no dialog, reveal + one notification on
 * completion). */
export type DownloadAction = "recusar" | "salvar";

export interface DownloadPlan {
  action: DownloadAction;
  /** Final sanitized file name (empty string when the plan refuses). */
  name: string;
  /** One short static pt-BR phrase — log-safe, notification-safe. */
  reason: string;
}

/** Static refusal phrases. Kept as named constants so every call site (log
 * line, notification) reads the same sentence for the same rule. */
export const DOWNLOAD_PHRASES = {
  harness: "sessão de teste — nenhum download roda neste computador",
  scheme: "link de download recusado — esquema não permitido",
  name: "nome de arquivo recusado — o download foi cancelado",
  size: "arquivo acima do teto de tamanho — o download foi cancelado",
  save: "arquivo salvo na pasta Downloads do computador",
} as const;

const REFUSED = (reason: string): DownloadPlan => ({ action: "recusar", name: "", reason });

/** Windows reserved device names — invalid as file names with or without an
 * extension, in any case (CON.txt is as hostile as con). */
const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/**
 * Fail-closed name sanitization: returns the trimmed name with its extension
 * preserved, or null when the name is empty, only spaces, longer than the
 * documented ceiling, carries a path separator (/ or \), a traversal
 * sequence (..), a colon, a control character or a Windows reserved name —
 * or when the input is not a string at all. Everything the caller needs to
 * refuse is refused here; nothing is "fixed up" into a different name.
 */
export function safeDownloadName(raw: unknown, nameMax: number = DOWNLOAD_NAME_MAX): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name) return null;
  if (name.length > nameMax) return null;
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.includes("..")) return null;
  if (name.includes(":")) return null;
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  const stem = name.split(".")[0]!.toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) return null;
  return name;
}

/**
 * Given a sanitized name and the names already present in the destination
 * folder, returns a name that NEVER overwrites an existing file: the plain
 * name when free, otherwise "name (1)", "name (2)", … with the extension
 * preserved. Pure — the caller lists the folder and owns the disk.
 */
export function uniqueDownloadName(sanitized: string, existingNames: readonly string[]): string {
  if (!existingNames.includes(sanitized)) return sanitized;
  const dot = sanitized.lastIndexOf(".");
  const stem = dot > 0 ? sanitized.slice(0, dot) : sanitized;
  const ext = dot > 0 ? sanitized.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existingNames.includes(candidate)) return candidate;
  }
}

/** Everything the decision needs, resolved by the caller (main.ts) once per
 * will-download event. No probe, no request and no timer is created for this. */
export interface DownloadVerdictInput {
  /** True when the hermetic test harness owns this session (the
   * OCR_DESKTOP_SESSION hatch) — it must never save bytes or show a dialog. */
  harnessSession: boolean;
  /** The P2-178 extlink verdict over the download's URL (not the raw URL). */
  schemeVerdict: ExternalOpenDecision;
  /** The announced file name (item.getFilename()) — never trusted. */
  announcedName: unknown;
  /** The announced size in bytes (item.getTotalBytes()) — unknown sizes
   * (non-numbers, non-finite, zero or negative) never refuse by themselves. */
  announcedBytes: unknown;
  /** The documented limits (DOWNLOAD_LIMITS in production). */
  limits: DownloadLimits;
}

/**
 * Decide the shell's behavior for one announced download. Rules apply in this
 * exact order:
 *
 *  1. a test-harness session NEVER downloads — no dialog, no bytes on disk
 *     (first rule by contract, see the header);
 *  2. a scheme the P2-178 gate refuses (file, javascript, data, blob, …)
 *     refuses — a download has no more business leaving the app over a
 *     non-http(s) scheme than an external open does;
 *  3. an invalid announced name (safeDownloadName) refuses — fail-closed;
 *  4. an announced size above the documented ceiling refuses — an unknown
 *     size never refuses on its own;
 *  5. anything left is saved to the documented Downloads folder under the
 *     sanitized name, revealed (never executed) on completion.
 */
export function downloadVerdict(input: DownloadVerdictInput): DownloadPlan {
  if (input.harnessSession) {
    return REFUSED(DOWNLOAD_PHRASES.harness);
  }
  if (!input.schemeVerdict.allow) {
    return REFUSED(DOWNLOAD_PHRASES.scheme);
  }
  const name = safeDownloadName(input.announcedName, input.limits.nameMax);
  if (name === null) {
    return REFUSED(DOWNLOAD_PHRASES.name);
  }
  if (
    typeof input.announcedBytes === "number" &&
    Number.isFinite(input.announcedBytes) &&
    input.announcedBytes > input.limits.bytesMax
  ) {
    return REFUSED(DOWNLOAD_PHRASES.size);
  }
  return { action: "salvar", name, reason: DOWNLOAD_PHRASES.save };
}
