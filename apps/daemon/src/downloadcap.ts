// P2-314: download-start ceilings for /__ocr/download/start. Pure module —
// no node:fs, node:path, node:http or fetch imports, and no I/O of any kind,
// because index.ts runs main() on import and unit tests must never boot a
// daemon (same hygiene as chunkstore.ts / ttscap.ts — lessons P2-149, P2-194
// and P2-248). All probing (resolving the path, statSync for the size) stays
// in the caller; this module only judges the already-measured facts.
//
// Why this exists: the download-start route used to accept any accessible
// file of any size and register it in a map pruned only by age, so a
// multi-gigabyte video (or a client spamming starts) could sink the phone
// tab assembling the file in memory — and nothing ever said no. The upload
// path already had the documented pattern: a default, a documented ceiling,
// a fail-closed boot refusal and per-start admission control. This module
// gives the download path the same shape.
//
// Resolution rules — downloadCapLimits evaluates them in THIS order and the
// order is part of the contract, exactly like chunkStoreLimits:
//   1. missing or blank OCR_DOWNLOAD_MAX_MB keeps today's defaults with no
//      problem — the ONLY case that does;
//   2. non-numeric, non-positive, fractional and above-ceiling values are all
//      problems: the daemon must die at boot rather than run with a ceiling
//      the operator never asked for (fail-closed, same grammar as
//      OCR_UPLOAD_MAX_MB);
//   3. a valid value resolves the byte ceiling and keeps the open-download
//      ceiling.
//
// Verdict rules — downloadVerdict evaluates them in THIS order:
//   1. a measured size not strictly inside [0, maxBytes] refuses with the
//      static "file-above-cap" reason — fail-closed for degenerate sizes too
//      (NaN, negatives, fractions, infinities);
//   2. a live-download count that is not a non-negative number, or a ceiling
//      that is not a positive integer, refuses with the static
//      "too-many-open" reason — fail-closed again;
//   3. live count at or above the ceiling refuses with "too-many-open";
//   4. anything else is allowed;
//   5. the verdict is identical for the same input on every call — no clock,
//      no randomness, no module state.
//
// Message boundary (part of the contract): no verdict message ever contains
// an absolute path, a file name or the measured size — the phone shows the
// sentence as-is, and the daemon's log lines carry only the static reason.

/** Default decoded ceiling (MB) — matches the OCR_UPLOAD_MAX_MB default. */
export const DEFAULT_DOWNLOAD_MAX_MB = 200;

/** Documented maximum anyone may set OCR_DOWNLOAD_MAX_MB to (MB). */
export const DOWNLOAD_MAX_MB_CEILING = 2000;

/** Simultaneous downloads allowed in the open-downloads map at once. */
export const DEFAULT_MAX_OPEN_DOWNLOADS = 8;

export interface DownloadCapLimits {
  /** Decoded file ceiling in bytes (the /__ocr/download/start cap). */
  maxBytes: number;
  /** Max simultaneous entries in the open-downloads map. */
  maxOpenDownloads: number;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * Resolve OCR_DOWNLOAD_MAX_MB into the download ceilings. Missing or blank
 * keeps today's defaults with no problem — the ONLY case that does. The
 * refusal grammar is byte-for-byte the OCR_UPLOAD_MAX_MB one with the
 * variable name substituted.
 */
export function downloadCapLimits(env: Record<string, string | undefined>): DownloadCapLimits {
  const finish = (maxBytes: number, problems: string[]): DownloadCapLimits => ({
    maxBytes,
    maxOpenDownloads: DEFAULT_MAX_OPEN_DOWNLOADS,
    problems,
  });
  const raw = env.OCR_DOWNLOAD_MAX_MB;
  if (raw === undefined || raw.trim() === "") {
    return finish(DEFAULT_DOWNLOAD_MAX_MB * 1_000_000, []);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return finish(
      DEFAULT_DOWNLOAD_MAX_MB * 1_000_000,
      [`OCR_DOWNLOAD_MAX_MB=${JSON.stringify(raw)} is not a number: refusing to start the daemon (fail-closed)`],
    );
  }
  if (parsed <= 0) {
    return finish(
      DEFAULT_DOWNLOAD_MAX_MB * 1_000_000,
      [
        `OCR_DOWNLOAD_MAX_MB=${JSON.stringify(raw)} must be a positive number of megabytes: refusing to start the daemon (fail-closed)`,
      ],
    );
  }
  if (!Number.isInteger(parsed)) {
    return finish(
      DEFAULT_DOWNLOAD_MAX_MB * 1_000_000,
      [
        `OCR_DOWNLOAD_MAX_MB=${JSON.stringify(raw)} must be a whole number of megabytes: refusing to start the daemon (fail-closed)`,
      ],
    );
  }
  if (parsed > DOWNLOAD_MAX_MB_CEILING) {
    return finish(DEFAULT_DOWNLOAD_MAX_MB * 1_000_000, [
      `OCR_DOWNLOAD_MAX_MB=${JSON.stringify(raw)} is above the documented ceiling of ${DOWNLOAD_MAX_MB_CEILING}MB: refusing to start the daemon (fail-closed)`,
    ]);
  }
  return finish(parsed * 1_000_000, []);
}

/** Static refusal reasons — stable identifiers, safe for logs and tests. */
export type DownloadRefusalReason = "file-above-cap" | "too-many-open";

export type DownloadVerdict =
  | { allow: true }
  | { allow: false; reason: DownloadRefusalReason; message: string };

/** Short pt-BR refusal for a file above the configured ceiling. */
export const DOWNLOAD_FILE_ABOVE_CAP_MESSAGE = "Arquivo grande demais para transferir por aqui.";

/** Short pt-BR refusal for too many simultaneous open downloads. */
export const DOWNLOAD_TOO_MANY_OPEN_MESSAGE =
  "Muitas transferências abertas ao mesmo tempo — tente de novo em instantes.";

/**
 * The allow/refuse decision for one download start, from the measured size
 * and the number of already-open downloads. See the module header for the
 * rule order; every input lands on one of the documented verdicts,
 * deterministically.
 */
export function downloadVerdict(
  sizeBytes: unknown,
  liveDownloads: unknown,
  maxBytes: unknown,
  maxOpenDownloads: unknown,
): DownloadVerdict {
  // rule 1 — only a finite size within [0, maxBytes] can pass; everything
  // else (NaN, negative, fractional, infinite, above the ceiling) refuses
  if (
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 0 ||
    !Number.isInteger(sizeBytes) ||
    typeof maxBytes !== "number" ||
    !Number.isFinite(maxBytes) ||
    maxBytes <= 0 ||
    sizeBytes > maxBytes
  ) {
    return { allow: false, reason: "file-above-cap", message: DOWNLOAD_FILE_ABOVE_CAP_MESSAGE };
  }
  // rule 2 — degenerate live counts or ceilings refuse, fail-closed
  if (
    typeof liveDownloads !== "number" ||
    !Number.isFinite(liveDownloads) ||
    liveDownloads < 0 ||
    !Number.isInteger(liveDownloads) ||
    typeof maxOpenDownloads !== "number" ||
    !Number.isInteger(maxOpenDownloads) ||
    maxOpenDownloads <= 0
  ) {
    return { allow: false, reason: "too-many-open", message: DOWNLOAD_TOO_MANY_OPEN_MESSAGE };
  }
  // rule 3 — at or above the ceiling there is no room for one more
  if (liveDownloads >= maxOpenDownloads) {
    return { allow: false, reason: "too-many-open", message: DOWNLOAD_TOO_MANY_OPEN_MESSAGE };
  }
  // rule 4 — inside every ceiling the download starts
  return { allow: true };
}

/** Minimal snapshot of an open download's registration instant. */
export interface OpenDownloadAt {
  key: string;
  at: number;
}

/**
 * Keys to discard so the open-downloads map never holds more than
 * `maxEntries` entries: the oldest go first (ties break by the given order,
 * which is the map's insertion order). Pure: nothing passed in is mutated.
 * Backstop for the admission verdict — a caller that only ever inserts after
 * an allowed verdict never has anything to evict.
 */
export function evictOldestKeys(entries: readonly OpenDownloadAt[], maxEntries: number): string[] {
  if (entries.length <= maxEntries) return [];
  return entries
    .slice()
    .sort((a, b) => a.at - b.at)
    .slice(0, entries.length - maxEntries)
    .map((e) => e.key);
}
