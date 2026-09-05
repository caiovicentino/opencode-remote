// Guest webContents guard for the desktop shell (P2-184). The Browser pane's
// <webview> creates a guest webContents whose attach-time preferences and
// whose navigations (redirects, meta refreshes, clicked links) never crossed
// the main process: a redirect could reach file: and render local user files
// inside the pane, and the renderer-declared preferences were honored as-is.
// Same class of hole P2-178 closed in openExternal and P2-182 in permissions,
// and the same cure: one pure decision in front of the dangerous call.
// Pure on purpose — no electron, no node builtins, no fetch — so
// scripts/unit.test.ts exercises the real code (same pattern as extlink.ts);
// main.ts injects the raw strings at runtime.

/** The only preferences a guest webview is ever allowed to run with. */
export interface GuestWebPreferences {
  contextIsolation: boolean;
  sandbox: boolean;
  nodeIntegration: boolean;
  nodeIntegrationInSubFrames: boolean;
  webviewTag: boolean;
}

export interface GuestAttachDecision {
  /** true only when the guest may attach at all (http/https origin). */
  allow: boolean;
  /** Forced-safe preferences to apply over the renderer's request. */
  webPreferences: GuestWebPreferences;
  /** Stable, log-safe reason; always non-empty, also on the allow path. */
  reason: string;
}

export interface GuestNavigationDecision {
  allow: boolean;
  /** Stable, log-safe reason (scheme names only, never the URL). */
  reason: string;
}

/** Schemes with their own refusal reason, so the refusal log reads clearly. */
const DENIED_SCHEME_REASONS: Record<string, string> = {
  file: "file-scheme-denied",
  javascript: "javascript-scheme-denied",
  data: "data-scheme-denied",
  blob: "blob-scheme-denied",
};

function schemeOf(raw: string): string {
  try {
    return new URL(raw.trim()).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function refuseNavigation(reason: string): GuestNavigationDecision {
  return { allow: false, reason };
}

/**
 * Decides whether a <webview> guest may attach, and with which preferences.
 * Only http/https origins attach; the scheme comparison is case-insensitive,
 * so uppercase variants ("FILE://…") cannot slip past the check. The returned
 * preferences are always the forced-safe set — contextIsolation on, sandbox
 * on, node integration off (subframes included), nested webview off — no
 * matter what the renderer asked for, and a renderer-declared preload never
 * survives (the field is simply absent from the result). Non-strings, empty
 * input and unparseable URLs deny the whole attach. Never throws.
 */
export function guestAttachDecision(originUrl: unknown, prefs: unknown, preload: unknown): GuestAttachDecision {
  if (typeof originUrl !== "string") {
    return { allow: false, webPreferences: safePreferences(), reason: "not-a-string" };
  }
  const candidate = originUrl.trim();
  if (!candidate) {
    return { allow: false, webPreferences: safePreferences(), reason: "empty" };
  }
  const scheme = schemeOf(candidate);
  if (!scheme) {
    return { allow: false, webPreferences: safePreferences(), reason: "unparseable-url" };
  }
  if (scheme !== "http" && scheme !== "https") {
    const reason = DENIED_SCHEME_REASONS[scheme] ?? `scheme-not-allowed:${scheme}`;
    return { allow: false, webPreferences: safePreferences(), reason };
  }
  return {
    allow: true,
    webPreferences: safePreferences(),
    reason: overridesRequested(prefs, preload)
      ? "guest-attach-allowed-request-overridden"
      : "guest-attach-allowed",
  };
}

/**
 * Decides a navigation started inside the guest (link click, redirect, meta
 * refresh). Only http and https pass; everything else — non-strings, empty
 * input, unparseable URLs, missing schemes, file/javascript/data/blob and any
 * unknown scheme — is refused. Never throws.
 */
export function guestNavigationDecision(raw: unknown): GuestNavigationDecision {
  if (typeof raw !== "string") return refuseNavigation("not-a-string");
  const candidate = raw.trim();
  if (!candidate) return refuseNavigation("empty");
  const scheme = schemeOf(candidate);
  if (!scheme) return refuseNavigation("unparseable-url");
  if (scheme === "http" || scheme === "https") {
    return { allow: true, reason: "guest-navigation-allowed" };
  }
  return refuseNavigation(DENIED_SCHEME_REASONS[scheme] ?? `scheme-not-allowed:${scheme}`);
}

function safePreferences(): GuestWebPreferences {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
  };
}

/** True when the renderer asked for a preload or unsafe preferences — the
 * attach still happens (the request is overridden), but the reason records
 * that the request was not honored as-declared. */
function overridesRequested(prefs: unknown, preload: unknown): boolean {
  if (typeof preload === "string" && preload.trim()) return true;
  if (!isRecord(prefs)) return false;
  const declared = prefs as Record<string, unknown>;
  const preloadKey = declared["preload"] ?? declared["preloadURL"];
  if (typeof preloadKey === "string" && preloadKey.trim()) return true;
  return (
    declared["contextIsolation"] === false ||
    declared["sandbox"] === false ||
    declared["nodeIntegration"] === true ||
    declared["nodeIntegrationInSubFrames"] === true ||
    declared["webviewTag"] === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
