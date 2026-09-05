/**
 * Web security headers (P2-192) for the static PWA route (P2-188): the
 * document the hosted relay serves is exactly the page where the user's E2E
 * keys live in the phone's browser, so a single compromised asset, a
 * third-party iframe or an injected script must face a locked-down origin —
 * and the browser must never leak the room URL as a referrer to an external
 * destination.
 *
 * Pure decision module — imports nothing (no node/http, no node/fs, no ws) so
 * the wiring in index.ts stays thin and the decisions stay unit-testable —
 * same pattern as limits.ts, knobs.ts, loglevel.ts, tlsconfig.ts and
 * webroot.ts, including the `problems` format they established
 * (P2-132/P2-141).
 *
 * Fail-closed in the P2-114 spirit: a RELAY_WEB_CSP value that is not a
 * string, carries a newline or any other control byte (header-injection
 * vector), exceeds the documented length ceiling or does not declare the
 * `default-src` directive is a problem. Any problem means the relay must not
 * open its listener: index.ts logs every reason once at boot and exits 1
 * instead of serving the page where the keys live with an unvalidated policy.
 * An absent or blank variable is the only case that keeps the default policy
 * with zero problems, so an empty env reproduces the documented default
 * exactly.
 *
 * The relay stays blind here too: only static header values are resolved —
 * no plaintext, no key material, no room ids ever flow through this module.
 */

/**
 * The default content-security-policy, built for the generated PWA bundle:
 * everything pins to the same origin (default/script/font/base), style
 * additionally allows inline because the generated bundle injects style
 * tags, images allow data: and blob: (canvas/render previews), connect
 * allows wss: and https: because the app dials the relay — which may be a
 * different origin than the one serving the page — and framing, form
 * submission and plugins are shut off entirely.
 */
export const WEB_CSP_DEFAULT =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; " +
  "img-src 'self' data: blob:; " +
  "connect-src 'self' wss: https:; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'; " +
  "form-action 'none'; " +
  "object-src 'none'";

/** Env variable that overrides the default content-security-policy. */
export const WEB_CSP_ENV = "RELAY_WEB_CSP";

/**
 * Documented length ceiling for an override policy. A real policy is a few
 * hundred bytes; anything past 1024 is only ever a paste mistake or an
 * injection attempt.
 */
export const WEB_CSP_MAX_LENGTH = 1024;

export interface WebCspPlan {
  /** The policy served in content-security-policy (the default on problems). */
  csp: string;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve the override policy from the env.
 *
 * - RELAY_WEB_CSP absent or blank: the documented default with zero problems
 *   — the only case that does not refuse the boot.
 * - A present value must be a string, free of newlines and control bytes,
 *   at or below WEB_CSP_MAX_LENGTH, and it must declare the `default-src`
 *   directive (a policy without a fallback directive silently widens every
 *   directive it forgot to list). Anything else is a problem and the boot
 *   refuses to start; the resolved value falls back to the default, which is
 *   never served because the boot exits first.
 */
export function resolveWebCsp(env: Record<string, unknown>): WebCspPlan {
  const problems: string[] = [];
  const raw = env[WEB_CSP_ENV];
  if (raw === undefined) return { csp: WEB_CSP_DEFAULT, problems };
  if (typeof raw !== "string") {
    problems.push(
      `${WEB_CSP_ENV}=${JSON.stringify(raw)} is not a string: ` +
        "refusing to start with an unvalidated content policy (fail-closed)",
    );
    return { csp: WEB_CSP_DEFAULT, problems };
  }
  if (raw.trim() === "") return { csp: WEB_CSP_DEFAULT, problems };
  // a control byte (CR/LF included) in a header value is a response-splitting
  // vector: Node refuses to write such headers, but the refusal must be a
  // boot problem, never a runtime surprise on the request path
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    problems.push(
      `${WEB_CSP_ENV} carries a newline or control byte: ` +
        "refusing to start with a policy that cannot be a safe header value (fail-closed)",
    );
    return { csp: WEB_CSP_DEFAULT, problems };
  }
  if (raw.length > WEB_CSP_MAX_LENGTH) {
    problems.push(
      `${WEB_CSP_ENV} is above the ${WEB_CSP_MAX_LENGTH}-character ceiling: ` +
        "values this long only serve misconfiguration (fail-closed)",
    );
    return { csp: WEB_CSP_DEFAULT, problems };
  }
  if (!/(^|;)\s*default-src\b/i.test(raw)) {
    problems.push(
      `${WEB_CSP_ENV} does not declare the default-src directive: ` +
        "a policy without the fallback directive silently widens every unlisted directive (fail-closed)",
    );
    return { csp: WEB_CSP_DEFAULT, problems };
  }
  return { csp: raw.trim(), problems };
}

/**
 * The security header map applied to every 200 document response of the
 * static route, keyed lowercase. `tls` — whether the request arrived under
 * TLS — gates strict-transport-security only: announcing HSTS on an http://
 * origin locks an operator who is still bringing the service up (browsers
 * upgrade the origin to https:// before it terminates TLS). The relay stays
 * blind: these are static values plus the resolved policy, nothing else.
 */
export function securityHeaders(tls: boolean, csp: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-security-policy": csp,
    "referrer-policy": "no-referrer",
    "permissions-policy": "geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=()",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
  if (tls) {
    // one year, no includeSubDomains: the operator's other subdomains on the
    // same host name are out of this relay's reach and must stay so
    headers["strict-transport-security"] = "max-age=31536000";
  }
  return headers;
}
