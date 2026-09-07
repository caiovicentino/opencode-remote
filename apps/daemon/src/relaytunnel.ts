// P2-303: HTTP CONNECT tunnel for the daemon's relay dial. When the pure
// verdict in relayproxy.ts says "tunnel", the dial must open its socket
// THROUGH the machine's proxy: an HTTP request with method CONNECT to the
// proxy, the relay's host:port as the authority, and the established socket
// handed to the websocket client as its connection.
//
// PROXY LEG TLS (P2-303 review): an https:// proxy address is HONORED, never
// downgraded — the CONNECT request itself rides a TLS session to the proxy
// (SNI = proxy host, default certificate validation), so the relay authority
// is never exposed in cleartext to passive observers of the corporate
// network. The relay leg (relaySecure) is an independent TLS wrap with the
// relay's hostname as SNI after the tunnel is established.
//
// This module is the I/O half of that decision — node:http + node:tls live
// here, NOT in relayproxy.ts (pure) — but it is still side-effect free on
// import: it only exports functions, so unit tests and the portable suite can
// load it without booting anything (index.ts runs main() on import; this
// module must never be the reason a test chain boots a daemon).
//
// ERROR PATH: every tunnel failure is delivered to the websocket client's
// connection callback as a plain Error (or the raw Node socket error), so the
// existing dial-error classification in relaydialerror.ts keeps triaging it —
// kind + static pt-BR hint only; the raw message (which can embed the proxy
// address) never reaches the log or the API surface, exactly like the direct
// dial errors since P2-260. The reconnection backoff is untouched: ws emits
// `error` + the generic 1006 close and the same retry schedule runs.
//
// HANG GUARD: a proxy that accepts TCP but never answers the CONNECT would
// leave the dial hanging with no error and no close, stalling the reconnect
// loop — the guard below destroys the dial after a fixed budget with a short
// pt-BR message the classifier maps to `timed-out`.

import { request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { Socket } from "node:net";
import type { ClientOptions } from "ws";
import type { RelayProxyTunnel } from "./relayproxy.js";

/** How long the proxy may take to answer the CONNECT before the dial is
 * destroyed and classified as `timed-out` by relaydialerror.ts. */
export const RELAY_TUNNEL_CONNECT_TIMEOUT_MS = 30_000;

/** The connection callback Node's http client uses for createConnection. */
type TunnelCallback = (err: Error | null, socket?: Socket) => void;

/** The shape ws forwards to http.request — host/port carry the relay target. */
interface DialOptions {
  host?: string;
  port?: number;
}

/** Injectable TLS options for the proxy leg (test hatch: a pinned self-signed
 * CA). Production passes nothing — default strict validation applies. */
export interface RelayTunnelOptions {
  proxyTls?: ConnectionOptions;
}

/**
 * Build a `createConnection` function for one relay dial: it opens a CONNECT
 * tunnel to the verdict's proxy (host + port), then hands the established
 * socket to the caller. For an https:// proxy the CONNECT rides a TLS session
 * to the proxy first; for a secure relay the tunneled socket is wrapped in
 * TLS with the relay's hostname as SNI before the callback fires.
 *
 * A non-200 CONNECT answer destroys the tunnel socket and fails with a short
 * pt-BR message that carries NO address and NO credential — the message only
 * feeds relaydialerror.ts's classifier (the "recusad…" text maps to the
 * `refused` kind).
 */
export function createRelayTunnelConnect(
  tunnel: RelayProxyTunnel,
  relaySecure: boolean,
  options?: RelayTunnelOptions,
): NonNullable<ClientOptions["createConnection"]> {
  const connect = (opts: DialOptions, cb: TunnelCallback): void => {
    const destHost = typeof opts.host === "string" ? opts.host : "";
    // ws fills opts.port with the URL's textual port (a string) or the
    // scheme default — accept both shapes.
    const parsedPort = Number(opts.port);
    const destPort = Number.isFinite(parsedPort) && parsedPort >= 1 ? parsedPort : relaySecure ? 443 : 80;
    const authority = `${destHost}:${destPort}`;
    let settled = false;
    // `done` clears the hang guard on first settlement; the guard constant is
    // initialized right after the request is created, and `done` only ever
    // runs from async callbacks, after that initialization.
    const done = (err: Error | null, socket?: Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(answerGuard);
      cb(err, socket);
    };

    // SNI is only meaningful for a hostname — an IP literal is validated, not
    // announced (SNI never carries IP literals).
    const sni = isIP(tunnel.host) ? undefined : tunnel.host;
    const req = httpRequest({
      host: tunnel.host,
      port: tunnel.port,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
      ...(tunnel.secure
        ? {
            createConnection: () => {
              const proxySocket = tlsConnect({
                host: tunnel.host,
                port: tunnel.port,
                servername: sni,
                ...options?.proxyTls,
              });
              proxySocket.once("error", (err) => done(err));
              return proxySocket;
            },
          }
        : {}),
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`túnel CONNECT recusado pelo proxy (status ${res.statusCode ?? "desconhecido"})`));
        return;
      }
      if (!relaySecure) {
        done(null, socket);
        return;
      }
      const tlsSocket = tlsConnect({ socket, servername: destHost }, () => done(null, tlsSocket));
      tlsSocket.on("error", (err) => {
        tlsSocket.destroy();
        done(err);
      });
    });
    req.on("error", (err) => done(err));
    // A silent proxy must not stall the reconnect loop forever: no answer
    // within the budget destroys the dial with a classifier-friendly error.
    const answerGuard = setTimeout(
      () => req.destroy(new Error("o túnel CONNECT esgotou o tempo")),
      RELAY_TUNNEL_CONNECT_TIMEOUT_MS,
    );
    req.end();
  };
  // Single documented bridge at the module that owns the ws contract: ws
  // forwards this value to node's http client, whose createConnection type is
  // the honest surface for it (index.ts needs no cast).
  return connect as unknown as NonNullable<ClientOptions["createConnection"]>;
}
