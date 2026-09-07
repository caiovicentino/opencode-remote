// P2-303: HTTP CONNECT tunnel for the daemon's relay dial. When the pure
// verdict in relayproxy.ts says "tunnel", the dial must open its socket
// THROUGH the machine's proxy: an HTTP request with method CONNECT to the
// proxy, the relay's host:port as the authority, and the established socket
// handed to the websocket client as its connection.
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

import { request as httpRequest } from "node:http";
import { connect as tlsConnect } from "node:tls";
import type { Socket } from "node:net";
import type { RelayProxyTunnel } from "./relayproxy.js";

/** The connection callback Node's http client uses for createConnection. */
type TunnelCallback = (err: Error | null, socket?: Socket) => void;

/** The shape ws forwards to http.request — host/port carry the relay target. */
interface DialOptions {
  host?: string;
  port?: number;
}

/**
 * Build a `createConnection` function for one relay dial: it opens a CONNECT
 * tunnel to the verdict's proxy (host + port), then hands the established
 * socket to the caller. For a secure relay the tunneled socket is wrapped in
 * TLS with the relay's hostname as SNI before the callback fires.
 *
 * A non-200 CONNECT answer destroys the tunnel socket and fails with a short
 * pt-BR message that carries NO address and NO credential — the message only
 * feeds relaydialerror.ts's classifier (the "recusad…" text maps to the
 * `refused` kind).
 */
export function createRelayTunnelConnect(
  tunnel: RelayProxyTunnel,
  secure: boolean,
): (opts: DialOptions, cb: TunnelCallback) => void {
  return (opts, cb) => {
    const destHost = typeof opts.host === "string" ? opts.host : "";
    // ws fills opts.port with the URL's textual port (a string) or the
    // scheme default — accept both shapes.
    const parsedPort = Number(opts.port);
    const destPort = Number.isFinite(parsedPort) && parsedPort >= 1 ? parsedPort : secure ? 443 : 80;
    const authority = `${destHost}:${destPort}`;
    let settled = false;
    const done = (err: Error | null, socket?: Socket) => {
      if (settled) return;
      settled = true;
      cb(err, socket);
    };

    const req = httpRequest({
      host: tunnel.host,
      port: tunnel.port,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        done(new Error(`túnel CONNECT recusado pelo proxy (status ${res.statusCode ?? "desconhecido"})`));
        return;
      }
      if (!secure) {
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
    req.end();
  };
}
