import { basename, extname, join, resolve, sep } from "node:path";

/**
 * Static web root decision (P2-188): which file — if any — a relay HTTP
 * request may read from the configured web root (RELAY_WEB_DIR), and whether
 * the configured root is good enough to boot with.
 *
 * Pure decision module: imports only node:path — no node/http, no node:fs,
 * no ws — so the wiring in index.ts stays thin and the decisions stay
 * unit-testable (same pattern as limits.ts / knobs.ts / tlsconfig.ts,
 * including the `problems` format they established). All filesystem I/O is
 * injected by the caller: `webRootPlan` takes probe callbacks, and
 * `resolveWebPath`/`spaFallbackPath` return absolute paths that index.ts
 * opens with its own fs handles.
 *
 * Rigidity mirrors `resolveUpdatePath` (apps/daemon/src/updates.ts): only
 * plain filenames inside the configured root ever win. A request path is
 * rejected (null) when it does not start with `/`, contains a backslash or
 * a NUL byte, carries a segment starting with "." (dotfiles AND traversal in
 * one rule), carries a percent-escape that is malformed or that after ONE
 * decodeURIComponent turns into a traversal or a separator, names an
 * extension outside the content-type allowlist (or no extension at all, for
 * `resolveWebPath`), or — the final backstop — when the resolved absolute
 * path falls outside the resolved root. The backstop runs on paths run
 * through the injected `canonicalize` hook (fs.realpathSync in index.ts), so
 * a symlink planted inside the root that points outside it is rejected too.
 *
 * Fail-closed in the P2-132/P2-141/P2-154 spirit: `webRootPlan` reports one
 * problem per cause (missing directory, not a directory, unreadable
 * directory, missing/unreadable index.html) and the boot must refuse to open
 * a listener while problems exist. An absent or blank RELAY_WEB_DIR is the
 * documented default: the static route stays off and the pre-P2-188 behavior
 * is preserved byte for byte.
 *
 * The relay stays blind here too: no plaintext, no key material, no room ids
 * ever flow through this module, and problem text cites RELAY_WEB_DIR, never
 * the configured path (log shippers get no host-local detail).
 */

/**
 * Extension allowlist — the only content types the static route may answer
 * with. Anything else (executables, archives, server files) is rejected at
 * path-resolution time, before the filesystem is ever touched.
 */
export const WEB_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Default content type for an allowed extension missing from the map. */
export const WEB_CONTENT_TYPE_DEFAULT = "application/octet-stream";

/** Document entry point served for SPA fallback routes. */
export const WEB_INDEX_FILE = "index.html";

export interface WebRootPlan {
  /** Configured root; "" when the static route is off. */
  root: string;
  /** False when RELAY_WEB_DIR is absent/blank or a problem was reported. */
  enabled: boolean;
  /** Non-empty means the boot must NOT open any listener (fail-closed). */
  problems: string[];
}

/** Outcome of the injected directory probe in `webRootPlan`. */
export type DirProbe = "ok" | "missing" | "not-directory" | "unreadable";

/**
 * Resolve the static web root from the process env.
 *
 * - RELAY_WEB_DIR absent or blank: the static route stays off with zero
 *   problems — an empty env reproduces the pre-P2-188 behavior exactly.
 * - A present value probes the directory through the injected callbacks:
 *   one problem per cause, every reason logged once by index.ts before the
 *   process exits 1 without opening a listener.
 *
 * `probeDir` classifies the configured path; `indexReadable` reports whether
 * the entry document inside it can be read. Problem text cites
 * RELAY_WEB_DIR and never the configured value.
 */
export function webRootPlan(
  env: Record<string, string | undefined>,
  probeDir: (dir: string) => DirProbe,
  indexReadable: (dir: string) => boolean,
): WebRootPlan {
  const raw = env.RELAY_WEB_DIR;
  if (raw === undefined || raw.trim() === "") {
    return { root: "", enabled: false, problems: [] };
  }
  const problems: string[] = [];
  const probe = probeDir(raw);
  if (probe === "missing") {
    problems.push(
      "RELAY_WEB_DIR points to a directory that does not exist: " +
        "refusing to boot without the static app bundle it should serve (fail-closed)",
    );
  } else if (probe === "not-directory") {
    problems.push(
      "RELAY_WEB_DIR points to something that is not a directory: " +
        "refusing to boot without the static app bundle it should serve (fail-closed)",
    );
  } else if (probe === "unreadable") {
    problems.push(
      "RELAY_WEB_DIR points to a directory the relay cannot read " +
        "(check existence and permissions for the relay user): refusing to boot with an unusable web root (fail-closed)",
    );
  }
  if (probe === "ok" && !indexReadable(raw)) {
    problems.push(
      "RELAY_WEB_DIR does not contain a readable index.html: " +
        "refusing to boot with a web root that cannot serve the app entry (fail-closed)",
    );
  }
  return { root: raw, enabled: problems.length === 0, problems };
}

/**
 * Resolve a request pathname to an absolute file inside `root`, or null.
 *
 * This is the strict asset resolver: the final segment must carry an
 * extension inside WEB_CONTENT_TYPES (a missing extension means the caller
 * may consider the SPA fallback instead). Rejects — with null — every
 * traversal, encoding and containment escape described in the module doc;
 * when in doubt the answer is always null (404).
 *
 * `canonicalize` (fs.realpathSync in index.ts) lets the containment backstop
 * catch symlinks inside the root that point outside it; the default identity
 * keeps the module pure for tests.
 */
export function resolveWebPath(
  root: string,
  pathname: string,
  canonicalize: (path: string) => string = (p) => p,
): string | null {
  const segments = safeSegments(pathname);
  if (!segments || segments.length === 0) return null;
  const target = resolve(join(resolve(root), ...segments));
  if (!contained(canonicalize, root, target)) return null;
  const ext = extname(basename(target)).toLowerCase();
  if (!WEB_CONTENT_TYPES[ext]) return null;
  return target;
}

/**
 * Resolve a request pathname to the root's index.html for the single-page
 * application fallback — only for safe, extension-less routes. `/healthz`
  * never falls back: the probe path must keep answering its probe (or 404),
 * never the app document. An unsafe path returns null so a missing or
 * malicious route answers 404 and never the entry document.
 */
export function spaFallbackPath(
  root: string,
  pathname: string,
  canonicalize: (path: string) => string = (p) => p,
): string | null {
  if (pathname === "/healthz") return null;
  const segments = safeSegments(pathname);
  if (!segments) return null;
  const last = segments[segments.length - 1];
  if (last !== undefined && extname(last) !== "") return null;
  const index = resolve(join(resolve(root), WEB_INDEX_FILE));
  if (!contained(canonicalize, root, index)) return null;
  return index;
}

/**
 * Content type for an allowed file, from its extension. Files only ever
 * reach here after the allowlist gate, so the default is a formality —
 * it still answers with an honest generic type instead of guessing.
 */
export function contentTypeFor(filePath: string): string {
  return WEB_CONTENT_TYPES[extname(basename(filePath)).toLowerCase()] ?? WEB_CONTENT_TYPE_DEFAULT;
}

/**
 * Hashed asset names (vite emits `name-<8+ hash chars>.<ext>`) may cache
 * forever; the entry document and everything else must revalidate every
 * time so a redeploy is picked up on the next reload.
 */
export function cacheControlFor(filePath: string): string {
  if (/-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(basename(filePath))) {
    return "public, max-age=31536000, immutable";
  }
  return "no-store";
}

/**
 * Shared request-path gate: null unless the pathname is a rooted, decoded,
 * dot-free list of plain filename segments. One decodeURIComponent per raw
 * segment (the "single decode" of the task): a segment whose decode turns
 * into traversal, a separator, a backslash or a NUL byte is rejected, and
 * any segment starting with "." covers both dotfiles and ".." at once.
 */
function safeSegments(pathname: string): string[] | null {
  if (!pathname.startsWith("/")) return null;
  if (pathname.includes("\\")) return null;
  if (pathname.includes("\0")) return null;
  const cleaned: string[] = [];
  for (const raw of pathname.slice(1).split("/")) {
    if (raw === "") continue;
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null; // malformed percent escape
    }
    if (seg === "" || seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null;
    if (seg.startsWith(".")) return null; // dotfiles and traversal in one rule
    cleaned.push(seg);
  }
  return cleaned;
}

/** Final backstop: the (canonicalized) target must live inside the root. */
function contained(canonicalize: (path: string) => string, root: string, target: string): boolean {
  const base = canonicalize(resolve(root)) + sep;
  return canonicalize(target).startsWith(base);
}
