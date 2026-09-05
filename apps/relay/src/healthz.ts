import type { IncomingMessage, ServerResponse } from "node:http";
import { contentTypeFor, cacheControlFor, resolveWebPath, spaFallbackPath } from "./webroot.js";
import { securityHeaders } from "./webheaders.js";

/**
 * GET /healthz — public, unauthenticated liveness probe for the hosted
 * relay stage (stage 4: relay behind a load balancer). Deliberately
 * minimal: no room ids, no per-peer metadata, only counters. Contrast
 * with /metrics, which stays loopback-only.
 *
 * P2-145: the handler takes an injected drain reader (the shutdown
 * controller's `isShuttingDown`). While the relay is draining, the probe
 * answers 503 with `ok:false` and `draining:true` so the load balancer
 * stops routing NEW peers to this instance instead of admitting sockets
 * that die milliseconds later; a healthy instance keeps answering 200
 * with the exact pre-P2-145 body (byte-for-byte). The relay stays blind
 * here too: no plaintext, no key material, no room ids ever flow through
 * this module.
 *
 * P2-188: an optional third argument enables the static web route
 * (RELAY_WEB_DIR) so a hosted relay can serve the phone PWA itself. All
 * path decisions come from the pure webroot.ts module; this handler only
 * sequences them: /healthz keeps priority and its exact body, a missing
 * `web` keeps the pre-P2-188 behavior byte for byte (plain 404 for every
 * other method and path), the drain answers 503 on the static route too,
 * non-GET/HEAD gets 405, an extension path that does not resolve to an
 * existing file gets 404 (never the entry document), and only a safe,
 * extension-less GET/HEAD falls back to the app's index.html.
 *
 * P2-192: both 200 paths (resolved asset and SPA fallback) carry the security
 * header map from webheaders.ts — content-security-policy, referrer-policy,
 * permissions-policy, framing control and, only when the request arrived
 * under TLS, strict-transport-security. The 404/405/503 responses and the
 * /healthz body stay byte-for-byte as they were: a load balancer reading the
 * probe must not change behavior because of this.
 */

export interface HealthzState {
  version: string;
  startedAt: number;
  rooms: () => number;
  roomsRejected: () => number;
}

export interface HealthzPayload {
  ok: boolean;
  version: string;
  uptimeS: number;
  rooms: number;
  roomsRejected: number;
  /** Additive and only present while draining (P2-145). */
  draining?: true;
}

export function healthzPayload(s: HealthzState, now = Date.now(), draining = false): HealthzPayload {
  const base: HealthzPayload = {
    ok: !draining,
    version: s.version,
    uptimeS: Math.max(0, Math.round((now - s.startedAt) / 1000)),
    rooms: s.rooms(),
    roomsRejected: s.roomsRejected(),
  };
  // healthy body stays byte-identical to the pre-P2-145 probe; the additive
  // field only appears while draining (ok flips to false in the same case)
  return draining ? { ...base, draining: true } : base;
}

/**
 * Injected static-file I/O for the P2-188 web route. `root` is the
 * fail-closed-validated RELAY_WEB_DIR; `isFile` and `send` are the only
 * filesystem touches, owned by index.ts so this module stays testable over
 * real HTTP without stubbing fs.
 */
export interface WebStatic {
  root: string;
  isFile: (abs: string) => boolean;
  send: (abs: string, req: IncomingMessage, res: ServerResponse) => void;
  /** P2-192: the boot-resolved content-security-policy for every 200 document. */
  csp: string;
  /** P2-192: whether the request arrived under TLS — HSTS is announced only then. */
  isTls: (req: IncomingMessage) => boolean;
}

/** 200 with the resolved file's content-type and cache policy, body via `send`. */
function sendDoc(web: WebStatic, abs: string, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": contentTypeFor(abs),
    "cache-control": cacheControlFor(abs),
    // the route is public and unauthenticated: the allowlist already pins
    // what may be served, nosniff keeps browsers from second-guessing it
    "x-content-type-options": "nosniff",
    // P2-192: CSP, framing, referrer and permissions lockdown on both 200
    // paths (resolved asset and SPA fallback); HSTS only under TLS
    ...securityHeaders(web.isTls(req), web.csp),
  });
  web.send(abs, req, res);
}

export function healthzHandler(
  s: HealthzState,
  isDraining: () => boolean = () => false,
  web?: WebStatic,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
      const draining = isDraining();
      res.writeHead(draining ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthzPayload(s, Date.now(), draining)));
      return;
    }
    // WebSocket upgrades never reach the request event; without a configured
    // web root plain HTTP to anything else is answered 404 exactly as before
    // P2-188 (byte-for-byte preserved behavior).
    if (!web) {
      res.writeHead(404).end();
      return;
    }
    // The static route joins the drain protocol: 503 before any method or
    // path decision so the load balancer pulls the instance from rotation
    // no matter which route the probe hits.
    if (isDraining()) {
      res.writeHead(503).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const path = req.url?.split("?")[0] ?? "/";
    const file = resolveWebPath(web.root, path);
    if (file && web.isFile(file)) {
      sendDoc(web, file, req, res);
      return;
    }
    // Single-page application fallback: only a safe, extension-less route
    // reaches the entry document. A missing or unsafe extension path must
    // answer 404 — an asset never resolves to 200 + HTML.
    const index = spaFallbackPath(web.root, path);
    if (index && web.isFile(index)) {
      sendDoc(web, index, req, res);
      return;
    }
    res.writeHead(404).end();
  };
}
