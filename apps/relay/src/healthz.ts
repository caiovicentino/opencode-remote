import type { IncomingMessage, ServerResponse } from "node:http";

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

export function healthzHandler(
  s: HealthzState,
  isDraining: () => boolean = () => false,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    if (req.method === "GET" && req.url?.split("?")[0] === "/healthz") {
      const draining = isDraining();
      res.writeHead(draining ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(healthzPayload(s, Date.now(), draining)));
      return;
    }
    // WebSocket upgrades never reach the request event; plain HTTP to
    // anything else is answered 404 instead of hanging the socket.
    res.writeHead(404).end();
  };
}
