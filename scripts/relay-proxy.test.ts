/**
 * P2-303: machine-proxy verdict for the daemon's relay dial. Table tests
 * cover every rule of the pure relayproxy.ts module (precedence, fail-closed
 * discards, NO_PROXY, loopback), an integration block proves the dial really
 * traverses a fake HTTP CONNECT proxy on an ephemeral loopback port, that a
 * refused tunnel flows through the existing relaydialerror.ts classifier, and
 * that with NO proxy variables at all the dial is byte-for-byte today's
 * one-argument websocket call.
 * Run: npx tsx scripts/relay-proxy.test.ts
 */
import net from "node:net";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  normalizeProxyEnv,
  noProxyCovers,
  parseRelayProxyAddress,
  relayProxyVerdict,
  RELAY_PROXY_REASONS,
} from "../apps/daemon/src/relayproxy";
import { createRelayTunnelConnect } from "../apps/daemon/src/relaytunnel";
import { relayDialVerdict } from "../apps/daemon/src/relaydialerror";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-proxy test timed out (global 30s)");
  process.exit(1);
}, 30_000).unref();

const PUBLIC_RELAY = "ws://relay.example:8787"; // non-loopback name, never dialed
const loop = (port: number) => `ws://127.0.0.1:${port}`;

// --- 1. normalizeProxyEnv: documented names win over lowercase twins ----------
const norm = normalizeProxyEnv({
  "HTTPS_PROXY": "a",
  https_proxy: "b",
  HTTP_PROXY: "c",
  ALL_PROXY: "d",
  NO_PROXY: "e",
  OCR_RELAY_PROXY: "f",
  UNRELATED: "x",
});
check(
  "normalize: uppercase names win and unknown keys are dropped",
  norm.HTTPS_PROXY === "a" && norm.HTTP_PROXY === "c" && norm.ALL_PROXY === "d" && norm.NO_PROXY === "e" && norm.OCR_RELAY_PROXY === "f" && Object.keys(norm).length === 5,
);
check("normalize: non-object environment yields an empty set", JSON.stringify(normalizeProxyEnv(null)) === "{}");

// --- 2. the empty environment is exactly today's behavior ---------------------
const empty = relayProxyVerdict({}, PUBLIC_RELAY);
check(
  "identity: no proxy variables at all -> direct, the one-argument dial of today",
  empty.state === "direct" && empty.reason === RELAY_PROXY_REASONS.none,
);
const emptyNorm = relayProxyVerdict(normalizeProxyEnv({ http_proxy: "", https_proxy: "", all_proxy: "" }), PUBLIC_RELAY);
check(
  "identity: empty-string variables count as absent -> direct",
  emptyNorm.state === "direct" && emptyNorm.reason === RELAY_PROXY_REASONS.none,
);

// --- 3. precedence: OCR_RELAY_PROXY > scheme variable > ALL_PROXY -------------
const byOwn = relayProxyVerdict({ OCR_RELAY_PROXY: "10.0.0.1:3128", HTTPS_PROXY: "10.0.0.2:3128" }, "wss://relay.example:8787");
check("precedence: OCR_RELAY_PROXY beats the scheme variables", byOwn.state === "tunnel" && byOwn.host === "10.0.0.1" && byOwn.port === 3128);
const byHttps = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", ALL_PROXY: "10.0.0.3:3128" }, "wss://relay.example:8787");
check("precedence: wss relay picks HTTPS_PROXY over ALL_PROXY", byHttps.state === "tunnel" && byHttps.host === "10.0.0.2");
const byHttp = relayProxyVerdict({ HTTP_PROXY: "10.0.0.2:3128", ALL_PROXY: "10.0.0.3:3128" }, PUBLIC_RELAY);
check("precedence: ws relay picks HTTP_PROXY over ALL_PROXY", byHttp.state === "tunnel" && byHttp.host === "10.0.0.2");
const byAll = relayProxyVerdict({ ALL_PROXY: "http://10.0.0.3:3128" }, PUBLIC_RELAY);
check("precedence: ALL_PROXY is the fallback, scheme parsed away", byAll.state === "tunnel" && byAll.host === "10.0.0.3" && byAll.port === 3128);
const httpsOnlyOnWs = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128" }, PUBLIC_RELAY);
check("precedence: a ws relay ignores HTTPS_PROXY (scheme mismatch)", httpsOnlyOnWs.state === "direct" && httpsOnlyOnWs.reason === RELAY_PROXY_REASONS.none);

// --- 4. loopback is always direct ---------------------------------------------
for (const url of ["ws://localhost:8787", "ws://127.0.0.1:8787", "wss://[::1]:8787"]) {
  const v = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", OCR_RELAY_PROXY: "10.0.0.1:3128" }, url);
  check(`loopback: ${url} stays direct even with a proxy set`, v.state === "direct" && v.reason === RELAY_PROXY_REASONS.loopback);
}

// --- 5. NO_PROXY precedes every address ----------------------------------------
const np = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", NO_PROXY: "other.net, relay.example" }, "wss://relay.example:8787");
check("no_proxy: bare-domain entry bypasses the proxy", np.state === "direct" && np.reason === RELAY_PROXY_REASONS.noProxy);
const npSub = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", NO_PROXY: ".example" }, "wss://relay.example:8787");
check("no_proxy: leading-dot entry matches the subdomain", npSub.state === "direct");
const npPort = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", NO_PROXY: "relay.example:8787" }, "wss://relay.example:8787");
check("no_proxy: port-qualified entry matches host:port", npPort.state === "direct");
const npStar = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", NO_PROXY: "*" }, "wss://relay.example:8787");
check("no_proxy: * bypasses everything", npStar.state === "direct");
const npMiss = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", NO_PROXY: "other.net" }, "wss://relay.example:8787");
check("no_proxy: a non-matching list keeps the tunnel", npMiss.state === "tunnel");
const npWeird = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128", NO_PROXY: 42 }, "wss://relay.example:8787");
check("no_proxy: a non-textual list fails closed to direct", npWeird.state === "direct" && npWeird.reason === RELAY_PROXY_REASONS.noProxyUnreadable);
check(
  "no_proxy: covers() matches subdomains but not dotted lookalikes",
  noProxyCovers("example.com", "sub.example.com", 80) === true && noProxyCovers("example.com", "notexample.com", 80) === false,
);

// --- 6. invalid addresses fail closed to direct, never guessed -----------------
const cases: Array<[string, unknown, string]> = [
  ["embedded credential", "user:pass@10.0.0.2:3128", RELAY_PROXY_REASONS.credential],
  ["socks scheme", "socks5://10.0.0.2:3128", RELAY_PROXY_REASONS.scheme],
  ["ftp scheme", "ftp://10.0.0.2:3128", RELAY_PROXY_REASONS.scheme],
  ["empty authority", "http://", RELAY_PROXY_REASONS.unparseable],
  ["path material", "http://10.0.0.2:3128/path", RELAY_PROXY_REASONS.unparseable],
  ["bad port", "10.0.0.2:99999", RELAY_PROXY_REASONS.unparseable],
  ["alpha port", "10.0.0.2:proxy", RELAY_PROXY_REASONS.unparseable],
  ["inner whitespace", "10.0.0.2 :3128", RELAY_PROXY_REASONS.unparseable],
  ["bare ipv6", "http://::1:3128", RELAY_PROXY_REASONS.unparseable],
];
for (const [name, value, reason] of cases) {
  const v = relayProxyVerdict({ HTTPS_PROXY: value }, "wss://relay.example:8787");
  check(`discard: ${name} -> direct (${reason === v.reason ? "reason ok" : `got "${v.reason}"`})`, v.state === "direct" && v.reason === reason);
}
const nonTextual = relayProxyVerdict({ HTTPS_PROXY: 42 as unknown as string }, "wss://relay.example:8787");
check("discard: non-textual value fails closed", nonTextual.state === "direct" && nonTextual.reason === RELAY_PROXY_REASONS.nonTextual);
// an invalid OCR_RELAY_PROXY does not promote the weaker variables behind it
const ownInvalid = relayProxyVerdict({ OCR_RELAY_PROXY: "socks5://10.0.0.9:1080", HTTPS_PROXY: "10.0.0.2:3128" }, "wss://relay.example:8787");
check(
  "discard: an invalid owner choice is NOT silently replaced by the environment",
  ownInvalid.state === "direct" && ownInvalid.reason === RELAY_PROXY_REASONS.scheme,
);
const badRelay = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128" }, "not a url");
check("discard: unparseable relay URL -> direct", badRelay.state === "direct" && badRelay.reason === RELAY_PROXY_REASONS.relayUrl);

// --- 7. verdict shape and determinism ------------------------------------------
const shaped = relayProxyVerdict({ OCR_RELAY_PROXY: "http://[2001:db8::10]:3128" }, "wss://relay.example:8787");
check("shape: bracketed IPv6 proxy parses host+port", shaped.state === "tunnel" && shaped.host === "2001:db8::10" && shaped.port === 3128);
check("shape: no default port invention for bare host", (() => {
  const v = relayProxyVerdict({ OCR_RELAY_PROXY: "proxy.corp" }, "wss://relay.example:8787");
  return v.state === "tunnel" && v.host === "proxy.corp" && v.port === 80;
})());
check(
  "determinism: the same input yields the exact same verdict",
  JSON.stringify(relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128" }, PUBLIC_RELAY)) ===
    JSON.stringify(relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128" }, PUBLIC_RELAY)),
);
check(
  "purity: parseRelayProxyAddress rejects credentials and unknown schemes",
  parseRelayProxyAddress("http://u@h:1")?.ok === false && parseRelayProxyAddress("q://h")?.ok === false && parseRelayProxyAddress("h:1")?.ok === true,
);

// --- 8. integration: the dial really traverses a fake CONNECT proxy ------------
async function listen(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function dial(url: string, opts?: Record<string, unknown>): { ws: WebSocket; opened: Promise<void>; errored: Promise<Error> } {
  const socket = opts ? new WebSocket(url, opts as never) : new WebSocket(url); // direct branch = today's exact call
  const opened = new Promise<void>((resolve, reject) => {
    socket.on("open", resolve);
    socket.on("error", (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
  return { ws: socket, opened, errored: opened.then(() => new Error("no error"), (e) => e) };
}

await (async () => {
  // the fake relay: a real websocket endpoint the tunnel connects through to
  const relay = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  relay.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => ws.close()));
  const relayPort = await listen(relay);

  let sawConnect = "";
  const proxy = net.createServer((client) => {
    client.once("data", (chunk) => {
      sawConnect = chunk.toString("utf8").split("\r\n")[0] ?? "";
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const upstream = net.connect(relayPort, "127.0.0.1");
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on("error", () => client.destroy());
    });
  });
  const proxyPort = await listen(proxy);

  const tunnelVerdict = relayProxyVerdict({ OCR_RELAY_PROXY: `127.0.0.1:${proxyPort}` }, `ws://relay.test:${relayPort}`);
  const tunneled = dial(`ws://relay.test:${relayPort}`, tunnelVerdict.state === "tunnel" ? { createConnection: createRelayTunnelConnect(tunnelVerdict, false) } : undefined);
  let opened = false;
  try {
    await tunneled.opened;
    opened = true;
  } catch {
    // the checks below record the failure; nothing to clean up here
  }
  check("integration: the websocket handshake completes through the CONNECT tunnel", opened);
  check("integration: the proxy saw CONNECT relay.test:<port> (authority-form)", sawConnect === `CONNECT relay.test:${relayPort} HTTP/1.1`);
  tunneled.ws.close();
  proxy.close();

  // the same verdict shape the daemon boots with, but refused by the proxy
  let sawReject = false;
  const rejecting = net.createServer((client) => {
    client.once("data", () => {
      sawReject = true;
      client.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
  });
  const rejectPort = await listen(rejecting);
  const refusedVerdict = relayProxyVerdict({ OCR_RELAY_PROXY: `127.0.0.1:${rejectPort}` }, `ws://relay.test:${relayPort}`);
  const refused = dial(`ws://relay.test:${relayPort}`, refusedVerdict.state === "tunnel" ? { createConnection: createRelayTunnelConnect(refusedVerdict, false) } : undefined);
  const err = await refused.errored;
  const code = (err as NodeJS.ErrnoException).code ?? null;
  const triage = relayDialVerdict(typeof code === "string" ? code : null, err instanceof Error ? err.message : "");
  check("integration: a 403 CONNECT really reaches the dial", sawReject);
  check(
    "integration: the refused tunnel flows through the existing dial-error classifier (refused, static hint)",
    triage.kind === "refused" && triage.hint === "o relay recusou a conexão: confira o endereço configurado no daemon",
  );
  check(
    "integration: the raw tunnel error carries no address and no credential",
    !/(relay\.test|127\.0\.0\.1)/.test(err instanceof Error ? err.message : ""),
  );
  refused.ws.terminate();
  rejecting.close();

  // identity: with no proxy variables the dial is the one-argument call
  const directVerdict = relayProxyVerdict({}, loop(relayPort));
  check("identity: loopback relay with empty env -> direct", directVerdict.state === "direct");
  const directDial = dial(loop(relayPort), directVerdict.state === "direct" ? undefined : {});
  let directOpened = false;
  try {
    await directDial.opened;
    directOpened = true;
  } catch {
    // recorded by the check below
  }
  check("identity: the direct dial opens with the exact pre-P2-303 call shape", directOpened);
  directDial.ws.close();
  relay.close();
})();

if (failures) process.exit(1);
console.log("relay-proxy: ALL OK");
process.exit(0);
