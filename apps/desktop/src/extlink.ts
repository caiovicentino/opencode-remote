// External-open decision for the desktop shell (P2-178). Chat messages, chat
// artifacts and update feeds all carry URLs that end up at
// `shell.openExternal`, and the OS will happily launch whatever handler is
// registered for a scheme — file, smb, a custom app, anything. This module is
// the single gate in front of that: it accepts ONLY http, https and mailto and
// refuses everything else with a reason that is safe to log (never the URL
// itself, so conversation content cannot leak into desktop.log). Pure on
// purpose — no electron, no node builtins — so scripts/unit.test.ts exercises
// the real code (same pattern as deeplink.ts); main.ts injects the raw string
// at runtime.

export const ALLOWED_EXTERNAL_SCHEMES = ["http", "https", "mailto"] as const;

const ALLOWED = new Set<string>(ALLOWED_EXTERNAL_SCHEMES);

/** Schemes with their own refusal reason, so the refusal log reads clearly. */
const DENIED_SCHEME_REASONS: Record<string, string> = {
  file: "file-scheme-denied",
  javascript: "javascript-scheme-denied",
  data: "data-scheme-denied",
  blob: "blob-scheme-denied",
};

export interface ExternalOpenDecision {
  /** true only when href is safe to hand to shell.openExternal. */
  allow: boolean;
  /** Normalized URL when allow, empty string otherwise. */
  href: string;
  /** Stable, log-safe reason (scheme names only, never the URL). */
  reason: string;
}

const REFUSED: ExternalOpenDecision = { allow: false, href: "", reason: "" };

function refuse(reason: string): ExternalOpenDecision {
  return { ...REFUSED, reason };
}

/**
 * Decides whether a raw URL string may leave the app via shell.openExternal.
 * Only http, https and mailto pass; everything else — non-strings, empty
 * input, unparseable URLs, missing schemes, file/javascript/data/blob and any
 * unknown scheme — is refused. The scheme comparison is case-insensitive, so
 * uppercase variants ("FILE://…") cannot slip past the check.
 */
export function externalOpenDecision(raw: unknown): ExternalOpenDecision {
  if (typeof raw !== "string") return refuse("not-a-string");
  const candidate = raw.trim();
  if (!candidate) return refuse("empty");
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return refuse("unparseable-url");
  }
  // WHATWG lowercases the protocol, but keep the explicit toLowerCase so the
  // intent survives even if the parser ever stops normalizing.
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (!scheme) return refuse("missing-scheme");
  if (!ALLOWED.has(scheme)) {
    return refuse(DENIED_SCHEME_REASONS[scheme] ?? `scheme-not-allowed:${scheme}`);
  }
  return { allow: true, href: url.href, reason: "allowed" };
}
