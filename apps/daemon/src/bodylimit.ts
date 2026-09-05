// P2-180: request-body ceiling for the daemon's JSON API routes. Pure module —
// no node:http and no node:fs imports on purpose, because index.ts runs main()
// on import and unit tests must never boot a daemon (same pattern as
// paginate.ts / relayclose.ts / relayurl.ts).
//
// readBody used to concatenate every chunk into a string with no byte ceiling
// and no rejection path, so an endless request body (or a JSON of hundreds of
// MBs) grew the heap until the process died of OOM — and in the stage-3
// packaging that process is the desktop app's sidecar, taking the whole
// user-facing window down with it. The ceiling counts real UTF-8 bytes (not
// characters), stops accumulating at the moment the limit is crossed (a
// truncated body would silently become invalid JSON), and the boot refuses an
// invalid OCR_MAX_BODY_BYTES outright instead of quietly falling back to the
// default (fail-closed, same spirit as the RELAY_URL preflight).

/** Default ceiling for a JSON request body: 1 MB of real bytes. */
export const MAX_JSON_BODY_BYTES = 1_000_000;

/** Documented maximum anyone may set OCR_MAX_BODY_BYTES to. */
export const MAX_JSON_BODY_CEILING_BYTES = 100_000_000;

export interface BodyLimit {
  /** Resolved ceiling in bytes. Only meaningful when problems is empty. */
  limit: number;
  /** Non-empty means the boot must fail closed (exit 1, no listener). */
  problems: string[];
}

/**
 * Resolve the OCR_MAX_BODY_BYTES env var. Missing or blank keeps the default
 * with no problem — the ONLY case that does. Non-numeric, negative, zero,
 * fractional and above-ceiling values are all problems: the daemon must die
 * at boot rather than run with a ceiling the operator never asked for.
 */
export function bodyLimit(env: Record<string, string | undefined>): BodyLimit {
  const raw = env.OCR_MAX_BODY_BYTES;
  if (raw === undefined || raw.trim() === "") {
    return { limit: MAX_JSON_BODY_BYTES, problems: [] };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return {
      limit: MAX_JSON_BODY_BYTES,
      problems: [
        `OCR_MAX_BODY_BYTES=${JSON.stringify(raw)} is not a number: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  if (parsed <= 0) {
    return {
      limit: MAX_JSON_BODY_BYTES,
      problems: [
        `OCR_MAX_BODY_BYTES=${JSON.stringify(raw)} must be a positive number of bytes: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  if (!Number.isInteger(parsed)) {
    return {
      limit: MAX_JSON_BODY_BYTES,
      problems: [
        `OCR_MAX_BODY_BYTES=${JSON.stringify(raw)} must be a whole number of bytes: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  if (parsed > MAX_JSON_BODY_CEILING_BYTES) {
    return {
      limit: MAX_JSON_BODY_BYTES,
      problems: [
        `OCR_MAX_BODY_BYTES=${JSON.stringify(raw)} is above the documented ceiling of ${MAX_JSON_BODY_CEILING_BYTES} bytes: refusing to start the daemon (fail-closed)`,
      ],
    };
  }
  return { limit: parsed, problems: [] };
}

/** True when the accumulated byte count must abort the read (strictly above). */
export function overLimit(accBytes: number, limit: number): boolean {
  return accBytes > limit;
}

/** Recognizable rejection code for an over-limit body. */
export const BODY_LIMIT_ERROR_CODE = "OCR_BODY_LIMIT";

export class BodyLimitError extends Error {
  code = BODY_LIMIT_ERROR_CODE;
  /** Bytes that had arrived when the read was aborted (the refused size). */
  bytes: number;
  /** The ceiling that was enforced. */
  limit: number;

  constructor(bytes: number, limit: number) {
    super(`request body over the ${limit}-byte limit (refused at ${bytes} bytes)`);
    this.name = "BodyLimitError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** Duck-typed on purpose: survives bundling and cross-realm instanceof. */
export function isBodyLimitError(err: unknown): err is BodyLimitError {
  return err instanceof Error && (err as BodyLimitError).code === BODY_LIMIT_ERROR_CODE;
}

/** Minimal reader surface readLimitedBody needs (data, end, error events). */
export interface LimitedBodyReader {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Collect the request body as UTF-8 text under a hard byte ceiling.
 *
 * Bytes (not characters) are counted per chunk; the moment the running total
 * crosses the limit the promise rejects with a BodyLimitError and accumulation
 * stops — later chunks and the end event are ignored, so an oversized body
 * never materializes in memory. A reader error propagates as-is instead of
 * resolving to an empty body.
 */
export function readLimitedBody(reader: LimitedBodyReader, limit: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    reader.on("data", (chunk) => {
      if (settled) return;
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += buf.length;
      if (overLimit(bytes, limit)) {
        settled = true;
        reject(new BodyLimitError(bytes, limit));
        return;
      }
      chunks.push(buf);
    });
    reader.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    reader.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}
