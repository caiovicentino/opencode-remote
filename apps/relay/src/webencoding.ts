/**
 * Static-asset content negotiation (P2-198): whether the optional web route
 * (P2-188) may answer a request with a gzip-encoded body, decided before any
 * byte is touched. A phone opening the app over the hosted relay used to
 * download the whole bundle uncompressed — several times the gzip size the
 * build itself reports — on first load and on every cache miss, through the
 * same process that routes everyone's sealed frames.
 *
 * Pure decision module — imports nothing (no node/http, node/fs, node/zlib
 * nor ws) so the wiring in healthz.ts stays thin and the decisions stay
 * unit-testable — same pattern as webheaders.ts, webroot.ts and webbudget.ts.
 * The compressed bytes live in the WebEncodingCache below: it stores only
 * what its caller compresses, and its caps are documented constants.
 *
 * The relay stays blind here too: the decision reads a request header and a
 * file extension — no plaintext, no key material, no room ids ever flow
 * through this module, and nothing here touches the WebSocket path (sealed
 * frames are incompressible; per-message deflate would only add CPU and
 * memory per peer).
 */

/**
 * The path extensions the static route may compress: the text-like members
 * of the P2-188 content-type allowlist. `png`, `jpg`, `webp`, `ico` and
 * `woff2` are already-compressed formats and are never in this set, whatever
 * the request header says; anything outside the allowlist (including the
 * generic octet-stream default) is never compressed either.
 */
export const COMPRESSIBLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html",
  ".js",
  ".css",
  ".map",
  ".json",
  ".svg",
  ".txt",
  ".webmanifest",
]);

/**
 * Documented size floor, in bytes: a body smaller than this gains nothing
 * from gzip (the gzip framing overhead can exceed the savings on tiny files)
 * and is always served `identity`, whatever the request header says.
 */
export const WEB_ENCODING_MIN_BYTES = 1024;

/**
 * Documented size ceiling, in bytes: a body larger than this is refused
 * compression for a single request (`identity`), so no request ever pins a
 * large input+output buffer pair — the gzipSync cost per request stays
 * bounded and the memoized cache below keeps the amortized cost at one
 * compression per bundle per process.
 */
export const WEB_ENCODING_MAX_BYTES = 8_388_608; // 8 MiB

/** Hard cap on cached entries (see WebEncodingCache). */
export const WEB_ENCODING_CACHE_MAX_ENTRIES = 64;

/** Hard cap on total cached compressed bytes (see WebEncodingCache). */
export const WEB_ENCODING_CACHE_MAX_BYTES = 32 * 1024 * 1024; // 32 MiB

/** The two content encodings the static route can answer with. */
export type WebContentEncoding = "gzip" | "identity";

export interface WebEncodingDecision {
  /** The encoding the response body must carry. */
  encoding: WebContentEncoding;
  /**
   * Whether the response must carry `vary: accept-encoding` — true whenever
   * the resource has both variants (compressible extension, size in range),
   * so a shared cache never mixes a gzip variant with an identity one. A
   * resource that is always `identity` (already-compressed format, size out
   * of range) has no variants and needs no vary.
   */
  vary: boolean;
}

/**
 * The quality value an `accept-encoding` element may carry: RFC 7231 qvalues
 * are 0, 1 or a decimal fraction with up to three digits. Anything else is a
 * malformed header (the caller treats the whole header as identity).
 */
const QVALUE = /^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/;

interface AcceptElement {
  token: string;
  q: number;
}

/**
 * Parse one comma-separated element ("gzip", " gzip", "gzip;q=0.5",
 "GZIP ; Q = 0") into its lowercase token and quality. Unknown parameters
 * are ignored (RFC 7231 allows them); a present-but-unparseable q value
 * makes the element — and with it the whole header — malformed.
 */
function parseAcceptEncodingElement(element: string): AcceptElement | "malformed" {
  const parts = element.split(";");
  const token = (parts[0] ?? "").trim().toLowerCase();
  if (token === "") return "malformed";
  let q = 1;
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i]!.trim();
    if (param === "") continue;
    if (/^q\s*=/i.test(param)) {
      const value = param.slice(param.indexOf("=") + 1).trim();
      if (!QVALUE.test(value)) return "malformed";
      q = Number(value);
    }
  }
  return { token, q };
}

/**
 * Parse a raw `accept-encoding` header into token → quality. Returns null
 * for a malformed header (any element whose q value does not parse): the
 * caller answers identity. A missing header parses as an empty map — the
 * outcome is identity either way.
 */
function parseAcceptEncoding(raw: unknown): Map<string, number> | null {
  if (raw === undefined) return new Map();
  if (typeof raw !== "string") return null;
  const encodings = new Map<string, number>();
  for (const element of raw.split(",")) {
    if (element.trim() === "") continue; // tolerate extra commas
    const parsed = parseAcceptEncodingElement(element);
    if (parsed === "malformed") return null;
    if (!encodings.has(parsed.token)) encodings.set(parsed.token, parsed.q);
  }
  return encodings;
}

/**
 * Decide the encoding for one static-asset request (P2-198).
 *
 * `rawAcceptEncoding` is the raw `accept-encoding` header (undefined when
 * absent); `extension` is the file's path extension (case-insensitive, with
 * or without the leading dot); `sizeBytes` is the file size in bytes.
 *
 * - An extension outside COMPRESSIBLE_EXTENSIONS, or a size outside
 *   [WEB_ENCODING_MIN_BYTES, WEB_ENCODING_MAX_BYTES], is always `identity`
 *   with no vary: the response cannot depend on the header.
 * - A missing or malformed header, a zero quality (`gzip;q=0` means
 *   "refused", not "preferred"), or no gzip mention at all is `identity`
 *   with vary — the resource still has a gzip variant for other clients.
 * - An explicit `gzip` element wins over the `*` wildcard; `*` alone counts
 *   as accepting gzip.
 */
export function negotiateEncoding(
  rawAcceptEncoding: string | undefined,
  extension: string,
  sizeBytes: number,
): WebEncodingDecision {
  const ext = extension.trim().toLowerCase();
  const extWithDot = ext.startsWith(".") ? ext : `.${ext}`;
  if (!COMPRESSIBLE_EXTENSIONS.has(extWithDot)) {
    return { encoding: "identity", vary: false };
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes < WEB_ENCODING_MIN_BYTES || sizeBytes > WEB_ENCODING_MAX_BYTES) {
    return { encoding: "identity", vary: false };
  }
  const encodings = parseAcceptEncoding(rawAcceptEncoding);
  if (encodings === null) return { encoding: "identity", vary: true };
  const explicit = encodings.get("gzip");
  const wildcard = encodings.get("*");
  const q = explicit ?? wildcard ?? 0;
  return { encoding: q > 0 ? "gzip" : "identity", vary: true };
}

/**
 * The cache key for a compressed body: absolute path + size + mtime, so a
 * changed file (new deploy, rewritten entry document) never answers with a
 * previous build's compressed bytes even when its path stays the same.
 */
export function webEncodingCacheKey(absPath: string, sizeBytes: number, mtimeMs: number): string {
  return JSON.stringify([absPath, sizeBytes, mtimeMs]);
}

/**
 * In-memory cache of compressed bodies (P2-198): the same bundle is never
 * compressed twice in one process, so a burst inside the request budget
 * (P2-195) never turns into a CPU amplifier. Keys are
 * `webEncodingCacheKey` values; values are the compressed bytes.
 *
 * Two documented caps bound the memory — WEB_ENCODING_CACHE_MAX_ENTRIES and
 * WEB_ENCODING_CACHE_MAX_BYTES. When either is reached the entry inserted
 * longest ago is discarded. A body larger than the byte cap is never stored
 * at all (the per-request ceiling already refuses to compress one, but the
 * cache defends its own invariant too). No timers, no node imports: the
 * caller owns compression via the injected callback.
 */
export class WebEncodingCache {
  private readonly entries = new Map<string, Buffer>();
  private totalBytes = 0;
  private hitsCount = 0;
  private missesCount = 0;

  constructor(
    private readonly maxEntries: number = WEB_ENCODING_CACHE_MAX_ENTRIES,
    private readonly maxBytes: number = WEB_ENCODING_CACHE_MAX_BYTES,
  ) {}

  /** Live entry count (exposed for tests and the caps' sanity). */
  get size(): number {
    return this.entries.size;
  }

  /** Total compressed bytes currently cached. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Requests answered from the cache (exposed for tests). */
  get hits(): number {
    return this.hitsCount;
  }

  /** Requests that had to compress (exposed for tests). */
  get misses(): number {
    return this.missesCount;
  }

  /**
   * Return the cached body for `key`, computing and storing it with
   * `compress` exactly once per key. The compressed buffer is reused for
   * every response, so callers must treat it as immutable.
   */
  getOrCompute(key: string, compress: () => Buffer): Buffer {
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.hitsCount++;
      return hit;
    }
    this.missesCount++;
    const compressed = compress();
    this.store(key, compressed);
    return compressed;
  }

  private store(key: string, bytes: Buffer): void {
    if (bytes.length > this.maxBytes) return;
    if (this.entries.has(key)) {
      const previous = this.entries.get(key)!;
      this.totalBytes -= previous.length;
      this.entries.delete(key);
    }
    this.entries.set(key, bytes);
    this.totalBytes += bytes.length;
    while (
      this.entries.size > 1 &&
      (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes)
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest)!;
      this.totalBytes -= evicted.length;
      this.entries.delete(oldest);
    }
  }
}
