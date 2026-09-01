import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * GET /healthz — public, unauthenticated liveness probe for the hosted
 * relay stage (stage 4: relay behind a load balancer). Deliberately
 * minimal: no room ids, no per-peer metadata, only counters. Contrast
 * with /metrics, which stays loopback-only.
 */

export interface HealthzState {
  version: string;
  startedAt: number;
  rooms: () => number;
}

export function healthzPayload(s: HealthzState, now = Date.now()) {
  return {
    ok: true,
    version: s.version,
    uptimeS: Math.max(0, Math.round((now - s.startedAt) / 1000)),
    rooms: s.rooms(),
  };
}

export function healthzHandler(
  s: HealthzState,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthzPayload(s)));
      return;
    }
    // WebSocket upgrades never reach the request event; plain HTTP to
    // anything else is answered 404 instead of hanging the socket.
    res.writeHead(404).end();
  };
}
