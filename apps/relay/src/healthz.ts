import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { gzipSync } from "node:zlib";
import { contentTypeFor, cacheControlFor, resolveWebPath, spaFallbackPath } from "./webroot.js";
import { securityHeaders } from "./webheaders.js";
import {
  negotiateEncoding,
  WebEncodingCache,
  webEncodingCacheKey,
  WEB_ENCODING_CACHE_MAX_BYTES,
  WEB_ENCODING_CACHE_MAX_ENTRIES,
  type WebEncodingDecision,
} from "./webencoding.js";

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
 *
 * P2-195: an optional fourth argument enables the per-identity request
 * budget for the static route (webbudget.ts). Every non-probe request
 * consumes one token; an over-budget identity answers 429 with retry-after
 * and a short body, plus the same security header set the 200 documents
 * carry — rejection leaks nothing new about the origin. The /healthz probe
 * returns before the budget is ever consulted: a load balancer cannot be
 * starved out of its own probe, and the probe consumes no tokens. The drain
 * keeps priority over the budget so the LB protocol stays intact, and the
 * WebSocket upgrade path never reaches this handler at all.
 *
 * P2-198: a 200 document whose extension and size pass the pure
 * webencoding.ts negotiation and whose client accepts gzip is served
 * content-encoding: gzip — the bytes compressed once per process and
 * memoized in WEB_ENCODING_CACHE (path + size + mtime keyed, capped in
 * entries and total bytes). Both 200 variants carry vary: accept-encoding
 * so a shared cache never mixes them; the identity variant keeps streaming
 * through the injected `send` exactly as before. The 404/405/503 answers and
 * the /healthz body stay byte-for-byte as they were: no compression, no
 * vary — a load balancer reading the probe must not change behavior because
 * of this. The relay stays blind: only public static assets from the
 * allowlisted root pass through here, never a sealed frame.
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
 * filesystem touches of the identity path, owned by index.ts so this module
 * stays testable over real HTTP without stubbing fs. P2-198: the gzip path
 * additionally reads the file (readFileSync) and compresses it (gzipSync)
 * inside this module — the decision comes from the pure webencoding.ts and
 * the bytes are memoized in WEB_ENCODING_CACHE.
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

/**
 * P2-195: injected request budget for the static route. The implementation
 * lives in index.ts (identity derivation via clientIp + the P2-174 ipTag,
 * buckets in webbudget.ts's WebBudgets map) and is passed only alongside a
 * configured web root — with no static route there is nothing to budget.
 */
export interface WebBudgetGate {
  /** Consume one token for this request's derived identity. */
  take(req: IncomingMessage, nowMs: number): { allow: boolean; retryAfterS: number };
}

/**
 * P2-198: process-wide memoized gzip bodies for the static route. Keyed by
 * absolute path + size + mtime; capped in entries and total bytes by the
 * documented webencoding.ts constants, oldest entry discarded first. One
 * bundle is compressed at most once per process.
 */
export const WEB_ENCODING_CACHE = new WebEncodingCache(
  WEB_ENCODING_CACHE_MAX_ENTRIES,
  WEB_ENCODING_CACHE_MAX_BYTES,
);

/**
 * P2-198: the encoding decision for a 200 document, plus the stat the
 * decision needs (size for the thresholds, mtime for the cache key). A file
 * that vanished between isFile() and this stat falls back to identity — the
 * injected sender re-answers through its own error path, exactly as before.
 */
function planEncoding(
  abs: string,
  req: IncomingMessage,
): { decision: WebEncodingDecision; sizeBytes: number; mtimeMs: number } {
  try {
    const st = statSync(abs);
    if (st.isFile()) {
      return {
        decision: negotiateEncoding(req.headers["accept-encoding"], extname(abs), st.size),
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      };
    }
  } catch {
    // fall through: identity, streamed through the injected sender
  }
  return { decision: { encoding: "identity", vary: false }, sizeBytes: -1, mtimeMs: 0 };
}

/**
 * 200 with the resolved file's content-type and cache policy, body via `send`.
 * P2-198: when the negotiation returns gzip, the compressed bytes come from
 * WEB_ENCODING_CACHE (compressed once, memoized) and are written with
 * content-encoding, vary and the already-compressed content-length — the
 * P2-192 header set passes through untouched. HEAD is answered with the same
 * headers and no body (Node suppresses the body of a HEAD response). Any
 * failure reading or compressing falls back to the identity path below.
 */
function sendDoc(web: WebStatic, abs: string, req: IncomingMessage, res: ServerResponse): void {
  const headers = {
    "content-type": contentTypeFor(abs),
    "cache-control": cacheControlFor(abs),
    // the route is public and unauthenticated: the allowlist already pins
    // what may be served, nosniff keeps browsers from second-guessing it
    "x-content-type-options": "nosniff",
    // P2-192: CSP, framing, referrer and permissions lockdown on both 200
    // paths (resolved asset and SPA fallback); HSTS only under TLS
    ...securityHeaders(web.isTls(req), web.csp),
  };
  const plan = planEncoding(abs, req);
  if (plan.decision.encoding === "gzip") {
    try {
      const body = WEB_ENCODING_CACHE.getOrCompute(
        webEncodingCacheKey(abs, plan.sizeBytes, plan.mtimeMs),
        () => gzipSync(readFileSync(abs)),
      );
      res.writeHead(200, {
        ...headers,
        "content-encoding": "gzip",
        vary: "Accept-Encoding",
        "content-length": String(body.length),
      });
      res.end(body);
      return;
    } catch {
      // the file vanished between isFile() and the read, or compression
      // failed: fall through to the identity path, which streams as before
    }
  }
  // identity variant: same headers as before (byte for byte) plus vary so a
  // shared cache never mixes this variant with the gzip one (P2-198)
  res.writeHead(200, plan.decision.vary ? { ...headers, vary: "Accept-Encoding" } : headers);
  web.send(abs, req, res);
}

export function healthzHandler(
  s: HealthzState,
  isDraining: () => boolean = () => false,
  web?: WebStatic,
  budget?: WebBudgetGate,
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
    // no matter which route the probe hits. Drain also keeps priority over
    // the budget: a closing instance 503s regardless of bucket state.
    if (isDraining()) {
      res.writeHead(503).end();
      return;
    }
    // P2-195: every non-probe request to the static route consumes one
    // token — 404s and 405s cost stat calls too, so they are budgeted as
    // well. An over-budget identity gets 429 with retry-after, a short
    // body and the same security header set as the 200 documents (P2-192).
    if (budget) {
      const verdict = budget.take(req, Date.now());
      if (!verdict.allow) {
        res.writeHead(429, {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": String(verdict.retryAfterS),
          ...securityHeaders(web.isTls(req), web.csp),
        });
        res.end("too many requests\n");
        return;
      }
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
