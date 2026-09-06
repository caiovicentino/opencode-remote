// P2-233: Windows update feed — pure decision layer for the explicit-action
// installer download. On Windows the public feed is electron-builder's
// latest.yml (update.ts keeps it parse+log: the built-in autoUpdater has no
// Windows engine), so until now a Windows user with a newer release available
// was dropped on the release page to pick one file out of seven. This module
// turns that same feed into a verified installer download performed ONLY on
// an explicit user action on the existing update item.
//
// Module hygiene (same bar as hotkey.ts / installloc.ts): NO electron, no
// filesystem access, no fetch, no timers — every branch is exercised by
// scripts/desktop-update.test.ts in plain Node, and main.ts keeps the only
// disk- and network-touching code.
//
// WHY THE APP NEVER RUNS THE INSTALLER: executing a freshly downloaded
// binary is an execution surface this product does not need to open to solve
// today's problem. The installer is downloaded, digest-verified fail-closed
// and revealed in the file manager — running it is always the user's own,
// explicit act (double-click), exactly like the manual release-page flow it
// improves. Nothing here schedules or triggers execution, with or without
// confirmation, and no future change may add it.
//
// Messages are static pt-BR phrases with no absolute paths, no URL schemes
// and no secrets (the P2-140 bar, same as installloc.ts).

/** A Windows feed body reduced to the three facts the download needs. */
export interface WindowsFeedInfo {
  /** Dotted numeric version of the release (e.g. "0.2.1"). */
  version: string;
  /** Installer file name exactly as announced by the feed. */
  file: string;
  /** Digest of the installer as announced by the feed (sha512, base64). */
  digest: string;
}

/**
 * Parse an electron-builder latest.yml body (the Windows public feed).
 * Accepts only a document carrying every required top-level field — `version`
 * (dotted numeric), `path` (installer file name) and `sha512` (digest) — with
 * surrounding whitespace tolerated. Returns null for an empty body, an HTML
 * error page, a document missing any required field and a version outside
 * the dotted numeric format. Only TOP-LEVEL keys count: the per-file entries
 * inside the indented `files:` block never satisfy the parse.
 */
export function parseWindowsFeed(body: string): WindowsFeedInfo | null {
  const text = typeof body === "string" ? body.trim() : "";
  if (!text) return null;
  // An HTML error page (404/5xx from a CDN) is not a feed, not a parse error.
  if (text.startsWith("<")) return null;
  const version = /^version:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  const file = /^path:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  const digest = /^sha512:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1];
  if (!version || !file || !digest) return null;
  // Dotted numeric only — "0.2.1" yes, "v0.2.1"/"0.2.1-beta"/"abc" no.
  if (!/^\d+(?:\.\d+)+$/.test(version)) return null;
  return { version, file, digest };
}

/** Documented ceiling for an installer file name (bytes of the name itself). */
export const MAX_INSTALLER_NAME = 200;

/**
 * Fail-closed name hygiene shared by the URL resolver and the disk writer:
 * an installer name must be a plain file name — non-empty, at or under
 * MAX_INSTALLER_NAME, without path separators (/ or \), without "..", without
 * ":" (which also kills embedded schemes like https:) — so the name can never
 * escape the staging folder or carry a scheme of its own.
 */
export function installerNameIsSafe(name: string): boolean {
  if (typeof name !== "string") return false;
  if (!name || name.length > MAX_INSTALLER_NAME) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  if (name.includes("..")) return false;
  if (name.includes(":")) return false;
  return true;
}

/**
 * Resolve the installer URL NEXT TO the feed URL: same directory, file name
 * appended (percent-encoded). Fail-closed — null for an empty/oversized
 * name, any name carrying a path separator, ".." or ":", and for a feed URL
 * that does not parse as http(s).
 */
export function assetUrlFrom(feedUrl: string, fileName: string): string | null {
  if (!installerNameIsSafe(typeof fileName === "string" ? fileName.trim() : "")) return null;
  let url: URL;
  try {
    url = new URL(typeof feedUrl === "string" ? feedUrl.trim() : "");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const dir = url.pathname.endsWith("/") ? url.pathname : url.pathname.replace(/[^/]*$/, "");
  return `${url.protocol}//${url.host}${dir}${encodeURIComponent(fileName)}`;
}

/** Static verdict phrases — reused verbatim by the log line (P2-140 bar). */
export const INTEGRITY_ACCEPTED = "integridade confirmada — o instalador baixado confere com o digest publicado no feed";
export const INTEGRITY_REFUSED = "integridade não confere — instalador descartado";
export const INTEGRITY_MISSING = "integridade não verificada — digest ausente no feed";

export interface IntegrityVerdict {
  ok: boolean;
  /** One short static pt-BR sentence. Never a path, a URL scheme or a secret. */
  message: string;
}

/**
 * Compare the digest announced by the feed with the digest measured on the
 * downloaded bytes. Case-insensitive on purpose (the digest may arrive with
 * mixed case); anything missing/empty refuses — fail-closed, the file is
 * discarded by the caller, and the manual release-page flow stays intact.
 */
export function integrityVerdict(expected: string | null, measured: string | null): IntegrityVerdict {
  const e = (expected ?? "").trim().toLowerCase();
  const m = (measured ?? "").trim().toLowerCase();
  if (!e || !m) return { ok: false, message: INTEGRITY_MISSING };
  return e === m ? { ok: true, message: INTEGRITY_ACCEPTED } : { ok: false, message: INTEGRITY_REFUSED };
}

// --- download decision ---------------------------------------------------------
//
// RULE-ORDER CONTRACT (the gate reads this): the harness-session rule is the
// FIRST consulted and stays first, before any platform, packaged or version
// consideration (the P2-221 lesson) — tools/desktop.mjs, the
// npm run test:desktop-flow battery and the packaged-boot smokes must never
// download a byte from the internet. The second rule keeps unpackaged dev
// runs download-free as well. Only after both may a packaged Windows build
// act — and even then only on an explicit user action: never at boot, never
// from a timer, never from the P2-155 periodic recheck.

export type WinDownloadAction = "download" | "skip";

export interface WinDownloadDecisionInput {
  /** process.env.OCR_DESKTOP_SESSION presence — the hermetic harness marker. */
  harnessSession: boolean;
  /** app.isPackaged — dev runs never download. */
  packaged: boolean;
  /** process.platform — this path is Windows-only; macOS keeps Squirrel.Mac. */
  platform: string;
  /** True only for an explicit user action on the existing update item. */
  explicitAction: boolean;
}

export interface WinDownloadDecision {
  action: WinDownloadAction;
  /** Static snake_case reason, carried into the single log line on skip. */
  reason: string;
}

export function winDownloadDecision(input: WinDownloadDecisionInput): WinDownloadDecision {
  if (input.harnessSession) return { action: "skip", reason: "harness-session" };
  if (!input.packaged) return { action: "skip", reason: "not-packaged" };
  if (input.platform !== "win32") return { action: "skip", reason: "platform-not-windows" };
  if (!input.explicitAction) return { action: "skip", reason: "no-explicit-action" };
  return { action: "download", reason: "explicit-action" };
}
