// P2-181: ceilings for the chunked-upload staging area (uploadChunks). Pure
// module — no node:http and no node:fs imports on purpose, because index.ts
// runs main() on import and unit tests must never boot a daemon (same pattern
// as bodylimit.ts / paginate.ts).
//
// The two chunk routes (/__ocr/upload/chunk and /__ocr/transcribe/chunk)
// arrive as E2E tunnel frames, not HTTP bodies, so the P2-180 readBody ceiling
// never sees them. Before this module they accepted unbounded base64 strings
// at unbounded indices from unbounded numbers of ids, and the only product
// cap (OCR_UPLOAD_MAX_MB) was applied at /__ocr/upload/complete — after the
// whole decoded content was already on the heap. In the stage-3 packaging the
// daemon is the desktop app's sidecar, so a runaway staging area took the
// user's whole window down. These helpers bound every dimension up front:
// bytes staged per id, number of simultaneous ids, chunk index range, and how
// long a stalled id may linger.

/** Default decoded ceiling (MB) — matches the /__ocr/upload/complete cap. */
export const DEFAULT_UPLOAD_MAX_MB = 200;

/** Documented maximum anyone may set OCR_UPLOAD_MAX_MB to (MB). */
export const UPLOAD_MAX_MB_CEILING = 2000;

/** Simultaneous upload ids allowed in staging at once. */
export const DEFAULT_MAX_STAGED_IDS = 8;

/** Highest chunk index a client may address (0..N-1 style, sparse-safe). */
export const DEFAULT_MAX_CHUNK_INDEX = 100_000;

/** A staged id untouched for this long is swept on the next chunk arrival. */
export const DEFAULT_EXPIRATION_MS = 5 * 60_000;

/**
 * Fixed slack on top of the base64 expansion: JSON string escaping and the
 * 4*ceil(n/3) rounding of base64 never cost more than a few bytes, so 1 MiB
 * is a comfortable, documented margin.
 */
export const STAGING_MARGIN_BYTES = 1_048_576;

/**
 * Staging ceiling for a decoded ceiling of `decodedBytes`: base64 inflates
 * the wire form by exactly one third (4 chars per 3 bytes) plus rounding, so
 * stagingBytes = ceil(decoded * 4/3) + fixed margin. A legitimate upload of
 * exactly `decoded` bytes must keep passing chunk by chunk.
 */
export function stagingCapBytes(decodedBytes: number): number {
  return Math.ceil((decodedBytes * 4) / 3) + STAGING_MARGIN_BYTES;
}

export interface ChunkStoreLimits {
  /** Decoded ceiling in bytes (the /__ocr/upload/complete cap, for reference). */
  decodedBytes: number;
  /** Max base64 bytes one upload id may keep staged across its parts. */
  stagingBytesPerId: number;
  /** Max simultaneous upload ids in the staging map. */
  maxStagedIds: number;
  /** Highest chunk index accepted on a chunk. */
  maxChunkIndex: number;
  /** Idle time before a staged id becomes sweep-eligible. */
  expirationMs: number;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * Resolve OCR_UPLOAD_MAX_MB into the staging limits. Missing or blank keeps
 * today's defaults with no problem — the ONLY case that does. Non-numeric,
 * negative, zero, fractional and above-ceiling values are all problems: the
 * daemon must die at boot rather than run with a ceiling the operator never
 * asked for (fail-closed, same spirit as bodyLimit / the RELAY_URL preflight).
 */
export function chunkStoreLimits(env: Record<string, string | undefined>): ChunkStoreLimits {
  const decodedDefault = DEFAULT_UPLOAD_MAX_MB * 1_000_000;
  const finish = (decodedBytes: number, problems: string[]): ChunkStoreLimits => ({
    decodedBytes,
    stagingBytesPerId: stagingCapBytes(decodedBytes),
    maxStagedIds: DEFAULT_MAX_STAGED_IDS,
    maxChunkIndex: DEFAULT_MAX_CHUNK_INDEX,
    expirationMs: DEFAULT_EXPIRATION_MS,
    problems,
  });
  const raw = env.OCR_UPLOAD_MAX_MB;
  if (raw === undefined || raw.trim() === "") {
    return finish(decodedDefault, []);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return finish(
      decodedDefault,
      [`OCR_UPLOAD_MAX_MB=${JSON.stringify(raw)} is not a number: refusing to start the daemon (fail-closed)`],
    );
  }
  if (parsed <= 0) {
    return finish(
      decodedDefault,
      [
        `OCR_UPLOAD_MAX_MB=${JSON.stringify(raw)} must be a positive number of megabytes: refusing to start the daemon (fail-closed)`,
      ],
    );
  }
  if (!Number.isInteger(parsed)) {
    return finish(
      decodedDefault,
      [
        `OCR_UPLOAD_MAX_MB=${JSON.stringify(raw)} must be a whole number of megabytes: refusing to start the daemon (fail-closed)`,
      ],
    );
  }
  if (parsed > UPLOAD_MAX_MB_CEILING) {
    return finish(decodedDefault, [
      `OCR_UPLOAD_MAX_MB=${JSON.stringify(raw)} is above the documented ceiling of ${UPLOAD_MAX_MB_CEILING}MB: refusing to start the daemon (fail-closed)`,
    ]);
  }
  return finish(parsed * 1_000_000, []);
}

/**
 * The 400-grade problem with a chunk index, or null when the index is valid.
 * Only a finite, non-negative integer up to maxChunkIndex passes — anything
 * else (fractional, NaN, string, negative, above the max) is refused.
 */
export function chunkIndexProblem(idx: unknown, maxChunkIndex: number): string | null {
  if (typeof idx !== "number" || !Number.isFinite(idx)) return "chunk index must be a number";
  if (!Number.isInteger(idx)) return "chunk index must be a whole number";
  if (idx < 0) return "chunk index must not be negative";
  if (idx > maxChunkIndex) return `chunk index above the maximum of ${maxChunkIndex}`;
  return null;
}

/**
 * True when the entry must be refused: staged bytes plus the incoming chunk
 * strictly above the staging ceiling. Exactly at the ceiling still fits, so a
 * legitimate max-size upload passes byte by byte.
 */
export function stagedOverLimit(stagedBytes: number, incomingBytes: number, stagingCap: number): boolean {
  return stagedBytes + incomingBytes > stagingCap;
}

/** Minimal snapshot of a staged id's last-touch instant. */
export interface StagedAt {
  key: string;
  at: number;
}

/**
 * Keys whose last touch is older than expirationMs — strictly greater, the
 * same boundary the daemon always used. Pure: nothing passed in is mutated.
 */
export function expiredKeys(entries: readonly StagedAt[], now: number, expirationMs: number): string[] {
  return entries.filter((e) => now - e.at > expirationMs).map((e) => e.key);
}

/**
 * Whether one more upload id fits in staging: the live count must be strictly
 * below the ceiling, so the id being admitted is never the (max+1)-th.
 */
export function admitNewUpload(liveCount: number, maxStagedIds: number): boolean {
  return liveCount < maxStagedIds;
}
