/**
 * RT-453: boundary verdict for the tunneled op path before it can reach the
 * opencode passthrough. `req.path` is attacker-controllable content inside a
 * sealed envelope (the relay is not trusted by the threat model), and
 * `new URL(req.path, OPENCODE_URL)` discards the base whenever the value
 * carries a scheme or an authority — a sealed `{"path":"http://evil/x"}`
 * would make the daemon fetch an attacker host **with the opencode
 * credential attached** (SSRF with read, since the body flows back sealed).
 *
 * Pure on purpose (frameguard/helloguard house pattern): one verdict function
 * plus one anchored allowlist, evaluated at the single point both transports
 * (relay + local /api bridge) pass through. No I/O, no clock, no logging —
 * and the call site must never echo the rejected path back (log-injection).
 */

import type { OpRequest } from "@ocr/protocol";

export type PathRejectReason =
  | "not-string"
  | "too-long"
  | "not-absolute"
  | "authority"
  | "control-char"
  | "query-or-fragment"
  | "traversal"
  | "bad-method"
  | "not-allowlisted";

export type PathVerdict =
  | { ok: true; path: string; method: OpRequest["method"] }
  | { ok: false; reason: PathRejectReason };

const OP_METHODS = new Set<string>(["GET", "POST", "DELETE", "PATCH", "PUT"]);

/** NUL..US, DEL and every whitespace: the URL parser strips these at the
 * edge, so ` http://evil` must never survive as a valid-looking path. */
const CONTROL_OR_SPACE = /[\u0000-\u001F\u007F\s]/;

const MAX_PATH_LENGTH = 512;

/**
 * Validate the raw op path + method shape. Rules are evaluated in order and
 * exactly one reason is returned. The allowlist of real upstream routes is a
 * second, separate step (`allowedUpstreamPath`) so daemon-local `/__ocr/…`
 * routes pass here but never reach opencode.
 */
export function relativePathVerdict(rawPath: unknown, rawMethod: unknown): PathVerdict {
  if (typeof rawPath !== "string") return { ok: false, reason: "not-string" };
  if (rawPath.length > MAX_PATH_LENGTH) return { ok: false, reason: "too-long" };
  if (CONTROL_OR_SPACE.test(rawPath)) return { ok: false, reason: "control-char" };
  if (!rawPath.startsWith("/")) return { ok: false, reason: "not-absolute" };
  // WHATWG special-scheme semantics: `//host` is an authority and `\` is
  // normalized to `/` — both would escape the base. Any backslash anywhere
  // is refused, not only a leading one.
  if (rawPath.startsWith("//") || rawPath.startsWith("/\\") || rawPath.includes("\\")) {
    return { ok: false, reason: "authority" };
  }
  if (rawPath.includes("?") || rawPath.includes("#")) {
    return { ok: false, reason: "query-or-fragment" };
  }
  const segments = rawPath.split("/");
  if (segments.some((s) => s === "..")) return { ok: false, reason: "traversal" };
  if (typeof rawMethod !== "string" || !OP_METHODS.has(rawMethod)) {
    return { ok: false, reason: "bad-method" };
  }
  return { ok: true, path: rawPath, method: rawMethod as OpRequest["method"] };
}

/**
 * Anchored allowlist of the opencode routes the tunnel serves. `ID` accepts
 * the charset opencode ids actually use (alphanumeric plus `_ . -`, which are
 * not URL-encoded by clients) — a lone `..` is already refused upstream by
 * `relativePathVerdict`. Anything not listed fails closed.
 */
const ID = "[A-Za-z0-9_.-]{1,128}";

export const UPSTREAM_ROUTES: RegExp[] = [
  /^\/(session|provider|permission|question)$/,
  new RegExp(`^/session/${ID}$`),
  new RegExp(`^/session/${ID}/(message|diff|revert|unrevert|abort)$`),
  new RegExp(`^/session/${ID}/permissions/${ID}$`),
  new RegExp(`^/question/${ID}/(reply|reject)$`),
  // RT-453 deviation from the planned allowlist: the post-deploy live soak
  // (invariants --live), smoke and the chunk regression all probe the
  // tunnel with the fixed literal `GET /global/health` — a fixed string, no
  // host/authority or traversal control, so the SSRF surface stays closed.
  /^\/global\/health$/,
];

export function allowedUpstreamPath(path: string): boolean {
  return UPSTREAM_ROUTES.some((re) => re.test(path));
}
