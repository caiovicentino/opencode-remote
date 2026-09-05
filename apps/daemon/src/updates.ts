// P1-050: staged auto-update folder, served by the daemon's loopback metrics
// server. The desktop shell's autoUpdater cannot attach the Bearer apiToken to
// its fetches, so the feed route is deliberately unauthenticated like
// /dashboard — safe because the server binds 127.0.0.1 only (apps/daemon/src/
// metrics.ts) and this module resolves paths strictly INSIDE one dedicated
// folder (~/.opencode-remote/updates). Anything else → null → 404.
//
// Layout is a versioned folder per release (the "pasta versionada"):
//
//   ~/.opencode-remote/updates/
//     feed.json                      ← Squirrel.Mac pointer doc (version, url)
//     0.2.1/latest-mac.yml           ← electron-builder metadata (visibility)
//     0.2.1/OpenCode-Remote-0.2.1-arm64.zip
//
// feed.json's `url` field points at the absolute artifact URL
// (http://127.0.0.1:<port>/__ocr/updates/0.2.1/<file>), so publishing a new
// release is a plain copy: drop <version>/ + rewrite feed.json.
import { basename, join, resolve, sep } from "node:path";

/** Content types the route may answer with; anything else is rejected. */
export const UPDATE_CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".dmg": "application/x-apple-diskimage",
  ".exe": "application/octet-stream",
  ".blockmap": "application/octet-stream",
};

/** Default folder: <home>/.opencode-remote/updates. */
export function updatesDir(home = process.env.HOME ?? "~"): string {
  return join(home, ".opencode-remote", "updates");
}

/**
 * Resolve one request path (pathname of /__ocr/updates/…) to an absolute file
 * inside baseDir, or null when the request must be rejected:
 *   - path traversal ("..", absolute segments, encoded slashes) → null
 *   - unknown file extension → null (no guessing, no serving of arbitrary files)
 * The comparison runs on resolved absolute paths so even a crafted segment
 * cannot escape the updates folder.
 */
export function resolveUpdatePath(baseDir: string, requestPath: string): string | null {
  if (!requestPath.startsWith("/")) return null;
  const segments = requestPath.slice(1).split("/").filter(Boolean);
  if (segments.length === 0) return null;
  const cleaned: string[] = [];
  for (const raw of segments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null; // malformed escape sequence
    }
    // Only plain filenames win: a leading "." (traversal, dotfiles) is never a
    // valid segment, and neither are separators — the resolved-path check
    // below is the backstop for anything that slips past the charset.
    if (!/^[A-Za-z0-9][A-Za-z0-9 .()-]*$/.test(seg) || seg.includes("..") || seg.includes(sep)) return null;
    cleaned.push(seg);
  }
  const target = resolve(join(baseDir, ...cleaned));
  const base = resolve(baseDir) + sep;
  if (!target.startsWith(base)) return null;
  const ext = basename(target).replace(/^.*?(\.[a-z0-9]+)$/i, "$1").toLowerCase();
  if (!UPDATE_CONTENT_TYPES[ext]) return null;
  return target;
}
