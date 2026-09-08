/**
 * P2-303: machine-proxy verdict for the daemon's relay dial. Table tests
 * cover every rule of the pure relayproxy.ts module (precedence, fail-closed
 * discards, NO_PROXY, loopback), an integration block proves the dial really
 * traverses a fake HTTP CONNECT proxy on an ephemeral loopback port, that a
 * refused tunnel flows through the existing relaydialerror.ts classifier, and
 * that with NO proxy variables at all the dial is byte-for-byte today's
 * one-argument websocket call.
 * P2-311: a credential-bearing address no longer discards — table tests cover
 * every rule of the pure proxyauth.ts split (empty/ambiguous/undecodable
 * credentials fail closed to no secret), an integration block proves a proxy
 * demanding basic authentication answers 407 without the header and crosses
 * with it, and the secret never reaches any health projection, static copy,
 * error message or classifier hint.
 * Run: npx tsx scripts/relay-proxy.test.ts
 */
import net from "node:net";
import http from "node:http";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  normalizeProxyEnv,
  noProxyCovers,
  parseRelayProxyAddress,
  relayProxyVerdict,
  RELAY_PROXY_REASONS,
} from "../apps/daemon/src/relayproxy";
import { parseProxyAuthority } from "../apps/daemon/src/proxyauth";
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
check(
  "identity: no proxy variables at all -> auth none (P2-311 additive field)",
  empty.state === "direct" && empty.auth === "none" && !("secret" in empty),
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
check("precedence: wss relay picks HTTPS_PROXY over ALL_PROXY", byHttps.state === "tunnel" && byHttps.host === "10.0.0.2");const byHttp = relayProxyVerdict({ HTTP_PROXY: "10.0.0.2:3128", ALL_PROXY: "10.0.0.3:3128" }, PUBLIC_RELAY);
check("precedence: ws relay picks HTTP_PROXY over ALL_PROXY", byHttp.state === "tunnel" && byHttp.host === "10.0.0.2");
const byAll = relayProxyVerdict({ ALL_PROXY: "http://10.0.0.3:3128" }, PUBLIC_RELAY);
check("precedence: ALL_PROXY is the fallback, scheme parsed away", byAll.state === "tunnel" && byAll.host === "10.0.0.3" && byAll.port === 3128);
const httpsOnlyOnWs = relayProxyVerdict({ HTTPS_PROXY: "10.0.0.2:3128" }, PUBLIC_RELAY);
check("precedence: a ws relay ignores HTTPS_PROXY (scheme mismatch)", httpsOnlyOnWs.state === "direct" && httpsOnlyOnWs.reason === RELAY_PROXY_REASONS.none);

// --- 3b. the https:// proxy scheme is honored, never silently downgraded ------
const tlsProxyVerdict = relayProxyVerdict({ OCR_RELAY_PROXY: "https://proxy.corp:3128" }, "wss://relay.example:8787");
check(
  "tls-proxy: an https:// address yields a tunnel verdict with secure=true and the TLS phrase",
  tlsProxyVerdict.state === "tunnel" && tlsProxyVerdict.secure === true && tlsProxyVerdict.reason === RELAY_PROXY_REASONS.tunnelTls,
);
const plainProxyVerdict = relayProxyVerdict({ OCR_RELAY_PROXY: "http://proxy.corp:3128" }, "wss://relay.example:8787");
check(
  "tls-proxy: an http:// address yields a tunnel verdict with secure=false",
  plainProxyVerdict.state === "tunnel" && plainProxyVerdict.secure === false && plainProxyVerdict.reason === RELAY_PROXY_REASONS.tunnel,
);
const bareProxyVerdict = relayProxyVerdict({ OCR_RELAY_PROXY: "proxy.corp" }, "wss://relay.example:8787");
check("tls-proxy: a bare address defaults to the http (cleartext proxy) leg", bareProxyVerdict.state === "tunnel" && bareProxyVerdict.secure === false);

// --- 3c. an empty uppercase variable never shadows a nonempty lowercase twin ---
const shadowed = relayProxyVerdict(normalizeProxyEnv({ HTTPS_PROXY: "", https_proxy: "10.0.0.2:3128" }), "wss://relay.example:8787");
check("normalize: HTTPS_PROXY=\"\" does not shadow a nonempty https_proxy", shadowed.state === "tunnel" && shadowed.host === "10.0.0.2");
const upperWins = relayProxyVerdict(normalizeProxyEnv({ HTTPS_PROXY: "10.0.0.1:3128", https_proxy: "10.0.0.2:3128" }), "wss://relay.example:8787");
check("normalize: a nonempty uppercase value still wins over the lowercase twin", upperWins.state === "tunnel" && upperWins.host === "10.0.0.1");

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

// --- 6b. P2-311: the pure proxyauth module, one table row per rule -------------
const b64 = (s: string) => `Basic ${Buffer.from(s, "utf8").toString("base64")}`;
const authRows: Array<[string, unknown, ProxyAuthExpectation]> = [
  ["non-textual value", 42, { ok: false }],
  ["empty value", "", { ok: false }],
  ["inner whitespace", "h :1", { ok: false }],
  ["path material", "h:1/x", { ok: false }],
  ["bad port", "h:99999", { ok: false }],
  ["bare ipv6", "::1:3128", { ok: false }],
  ["no credential at all", "10.0.0.2:3128", { ok: true, host: "10.0.0.2", port: 3128, secret: null }],
  ["bare authority defaults to port 80", "proxy.corp", { ok: true, host: "proxy.corp", port: 80, secret: null }],
  ["bracketed ipv6", "[2001:db8::10]:3128", { ok: true, host: "2001:db8::10", port: 3128, secret: null }],
  ["tolerated scheme prefix", "http://10.0.0.2:3128", { ok: true, host: "10.0.0.2", port: 3128, secret: null }],
  ["empty userinfo (@ with nothing)", "@10.0.0.2:3128", { ok: true, host: "10.0.0.2", port: 3128, secret: null }],
  ["empty user and password", ":@10.0.0.2:3128", { ok: true, host: "10.0.0.2", port: 3128, secret: null }],
  ["user and password", "u:p@10.0.0.2:3128", { ok: true, host: "10.0.0.2", port: 3128, secret: b64("u:p") }],
  ["user without password", "u@10.0.0.2:3128", { ok: true, host: "10.0.0.2", port: 3128, secret: b64("u:") }],
  ["password without user", ":p@10.0.0.2:3128", { ok: true, host: "10.0.0.2", port: 3128, secret: b64(":p") }],
  ["colon only splits user:password", "u%3Aser:p%40ss@h:1", { ok: true, host: "h", port: 1, secret: b64("u:ser:p@ss") }],
  ["first colon splits, rest stays password", "u:p:q@h:1", { ok: true, host: "h", port: 1, secret: b64("u:p:q") }],
  ["more than one @ -> no secret, host after the last @", "u:p@a@h:1", { ok: true, host: "h", port: 1, secret: null }],
  ["invalid percent-encoding -> no secret", "us%zz:p@h:1", { ok: true, host: "h", port: 1, secret: null }],
  ["truncated percent -> no secret", "u:p%2@h:1", { ok: true, host: "h", port: 1, secret: null }],
];
type ProxyAuthExpectation =
  | { ok: true; host: string; port: number; secret: string | null }
  | { ok: false };
for (const [name, value, want] of authRows) {
  const got = parseProxyAuthority(value);
  const ok =
    want.ok && got.ok
      ? got.host === want.host && got.port === want.port && got.secret === want.secret
      : !want.ok && !got.ok;
  check(`proxyauth: ${name} -> ${want.ok ? `${want.host}:${want.port} secret ${want.secret === null ? "null" : "set"}` : "discarded"}`, ok);
}

// --- 6c. P2-311: a credential address tunnels; only presence is disclosed ------
const credVerdict = relayProxyVerdict({ HTTPS_PROXY: "user:s3cr3t-pw@10.0.0.2:3128" }, "wss://relay.example:8787");
check(
  "credential: user:pass@host tunnels with auth=basic and the credential-free endpoint",
  credVerdict.state === "tunnel" && credVerdict.host === "10.0.0.2" && credVerdict.port === 3128 && credVerdict.auth === "basic",
);
const credSecret = credVerdict.state === "tunnel" ? credVerdict.secret : null;
check(
  "credential: the secret is the ready-to-send Proxy-Authorization value",
  credSecret === b64("user:s3cr3t-pw"),
);
check(
  "credential: a malformed credential (double @) still tunnels, failing closed to no secret",
  (() => {
    const v = relayProxyVerdict({ HTTPS_PROXY: "u:p@a@10.0.0.2:3128" }, "wss://relay.example:8787");
    return v.state === "tunnel" && v.host === "10.0.0.2" && v.auth === "none" && (v.state === "tunnel" ? v.secret === null : false);
  })(),
);
check(
  "credential: an undecodable credential still tunnels, failing closed to no secret",
  (() => {
    const v = relayProxyVerdict({ HTTPS_PROXY: "u:p%zz@10.0.0.2:3128" }, "wss://relay.example:8787");
    return v.state === "tunnel" && v.auth === "none" && (v.state === "tunnel" ? v.secret === null : false);
  })(),
);
check(
  "credential: a loopback relay stays direct even with a credential address",
  (() => {
    const v = relayProxyVerdict({ HTTPS_PROXY: "u:p@10.0.0.2:3128" }, "ws://127.0.0.1:8787");
    return v.state === "direct" && v.auth === "none" && v.reason === RELAY_PROXY_REASONS.loopback;
  })(),
);
check(
  "credential: NO_PROXY still bypasses a credential address",
  (() => {
    const v = relayProxyVerdict({ HTTPS_PROXY: "u:p@10.0.0.2:3128", NO_PROXY: "relay.example" }, "wss://relay.example:8787");
    return v.state === "direct" && v.auth === "none" && v.reason === RELAY_PROXY_REASONS.noProxy;
  })(),
);
check(
  "credential: precedence is untouched (OCR_RELAY_PROXY with credential beats HTTPS_PROXY)",
  (() => {
    const v = relayProxyVerdict({ OCR_RELAY_PROXY: "u1:p1@10.0.0.1:3128", HTTPS_PROXY: "10.0.0.2:3128" }, "wss://relay.example:8787");
    return v.state === "tunnel" && v.host === "10.0.0.1" && v.auth === "basic";
  })(),
);
check(
  "purity: parseRelayProxyAddress now accepts credentials and still rejects unknown schemes",
  parseRelayProxyAddress("http://u@h:1")?.ok === true && parseRelayProxyAddress("q://h")?.ok === false && parseRelayProxyAddress("h:1")?.ok === true,
);

// --- 6d. P2-311: the secret never reaches a health surface, a log-shaped -------
// copy string, an error message or a classifier hint --------------------------------
{
  const surfaces: string[] = [];
  for (const v of [
    credVerdict,
    relayProxyVerdict({ HTTPS_PROXY: "user:s3cr3t-pw@10.0.0.2:3128" }, "ws://localhost:8787"),
    relayProxyVerdict({ HTTPS_PROXY: "user:s3cr3t-pw@10.0.0.2:3128", NO_PROXY: "relay.example" }, "wss://relay.example:8787"),
  ]) {
    // the exact projection /api/health builds its relay object from
    surfaces.push(JSON.stringify({ relayProxyState: v.state, relayProxyReason: v.reason, relayProxyAuth: v.auth }));
  }
  surfaces.push(...Object.values(RELAY_PROXY_REASONS)); // every static copy that may ever surface
  const tunnelErr = new Error("túnel CONNECT recusado pelo proxy (status 407)");
  surfaces.push(tunnelErr.message);
  surfaces.push(relayDialVerdict(null, tunnelErr.message).hint);
  const secretNever = (s: string) => !s.includes("s3cr3t-pw") && !s.includes("Basic ") && !s.includes(credSecret ?? "");
  check("privacy: no health projection, static copy, tunnel error or hint carries the secret", surfaces.every(secretNever));
  check("privacy: relayProxyAuth only ever says none or basic", (() => {
    const direct = relayProxyVerdict({}, PUBLIC_RELAY);
    return (direct.auth === "none" || direct.auth === "basic") && (credVerdict.auth === "none" || credVerdict.auth === "basic");
  })());
  check("privacy: the 407 hint says the proxy asked for authentication and refused", (() => {
    const t = relayDialVerdict(null, "túnel CONNECT recusado pelo proxy (status 407)");
    return t.kind === "refused" && t.hint === "o proxy pediu autenticação e recusou a credencial";
  })());
  check("privacy: a refused status other than 407 keeps the generic relay hint", (() => {
    const t = relayDialVerdict(null, "túnel CONNECT recusado pelo proxy (status 403)");
    return t.kind === "refused" && t.hint === "o relay recusou a conexão: confira o endereço configurado no daemon";
  })());
}

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
  "purity: parseRelayProxyAddress rejects unknown schemes and non-textual values",
  parseRelayProxyAddress("q://h")?.ok === false && parseRelayProxyAddress(42 as unknown as string) === null && parseRelayProxyAddress("h:1")?.ok === true,
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

  // P2-311: a CONNECT proxy that demands basic authentication — without the
  // Proxy-Authorization header the dial receives 407 (and the classifier says
  // the proxy asked for authentication and refused the credential); with the
  // header the tunnel crosses and the websocket handshake completes.
  const authUser = "operador";
  const authPass = "s3cr3t-pw";
  const authHeaderValue = `Basic ${Buffer.from(`${authUser}:${authPass}`, "utf8").toString("base64")}`;
  let proxySawAuthorization: string | null = null;
  let proxySaw407 = false;
  const authProxy = net.createServer((client) => {
    client.once("data", (chunk) => {
      const text = chunk.toString("utf8");
      proxySawAuthorization = /^proxy-authorization: (.*)$/im.exec(text)?.[1] ?? null;
      if (proxySawAuthorization === authHeaderValue) {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const upstream = net.connect(relayPort, "127.0.0.1");
        client.pipe(upstream);
        upstream.pipe(client);
        upstream.on("error", () => client.destroy());
      } else {
        proxySaw407 = true;
        client.write("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
        client.destroy();
      }
    });
  });
  const authProxyPort = await listen(authProxy);
  const authedVerdict = relayProxyVerdict(
    { OCR_RELAY_PROXY: `${authUser}:${authPass}@127.0.0.1:${authProxyPort}` },
    `ws://relay.test:${relayPort}`,
  );
  check("integration: the credential address yields a basic-auth tunnel verdict", authedVerdict.state === "tunnel" && authedVerdict.auth === "basic");
  const authed = dial(
    `ws://relay.test:${relayPort}`,
    authedVerdict.state === "tunnel" ? { createConnection: createRelayTunnelConnect(authedVerdict, false) } : undefined,
  );
  let authedOpened = false;
  try {
    await authed.opened;
    authedOpened = true;
  } catch {
    // recorded by the checks below
  }
  check("integration: with the credential the dial crosses the auth proxy", authedOpened);
  check("integration: the CONNECT carried the encoded Proxy-Authorization value", proxySawAuthorization === authHeaderValue);
  authed.ws.close();

  const unauthedVerdict = relayProxyVerdict({ OCR_RELAY_PROXY: `127.0.0.1:${authProxyPort}` }, `ws://relay.test:${relayPort}`);
  const unauthed = dial(
    `ws://relay.test:${relayPort}`,
    unauthedVerdict.state === "tunnel" ? { createConnection: createRelayTunnelConnect(unauthedVerdict, false) } : undefined,
  );
  const unauthedErr = await unauthed.errored;
  const unauthedMessage = unauthedErr instanceof Error ? unauthedErr.message : "";
  const unauthedTriage = relayDialVerdict(null, unauthedMessage);
  check("integration: without the credential the same proxy answers 407", proxySaw407 && unauthedMessage.includes("(status 407)"));
  check(
    "integration: the 407 flows through the existing classifier with the proxy-auth hint",
    unauthedTriage.kind === "refused" && unauthedTriage.hint === "o proxy pediu autenticação e recusou a credencial",
  );
  check(
    "integration: no 407-path message or hint carries the credential or its secret",
    !unauthedMessage.includes(authPass) && !unauthedMessage.includes(authHeaderValue) && !unauthedTriage.hint.includes(authHeaderValue),
  );
  unauthed.ws.terminate();
  authProxy.close();

  // the https:// proxy leg is really TLS: a self-signed proxy certificate is
  // generated at test time and pinned via ca, so the dial only succeeds when
  // the factory honors the scheme and TLS-connects to the proxy BEFORE the
  // CONNECT (a plaintext CONNECT can never complete a TLS handshake)
  const certDir = mkdtempSync(join(tmpdir(), "ocr-relayproxy-"));
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", join(certDir, "key.pem"),
      "-out", join(certDir, "cert.pem"),
      "-days", "1",
      "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName = IP:127.0.0.1",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const certPem = readFileSync(join(certDir, "cert.pem"));
  let sawTlsConnect = false;
  const tlsProxy = tls.createServer({ key: readFileSync(join(certDir, "key.pem")), cert: certPem }, (client) => {
    client.once("data", (chunk) => {
      sawTlsConnect = chunk.toString("utf8").startsWith(`CONNECT relay.test:${relayPort} `);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const upstream = net.connect(relayPort, "127.0.0.1");
      client.pipe(upstream);
      upstream.pipe(client);
      upstream.on("error", () => client.destroy());
    });
  });
  const tlsProxyPort = await listen(tlsProxy);
  const tlsVerdict = relayProxyVerdict({ OCR_RELAY_PROXY: `https://127.0.0.1:${tlsProxyPort}` }, `ws://relay.test:${relayPort}`);
  check("tls-proxy: the https:// verdict is tunnel with secure=true", tlsVerdict.state === "tunnel" && tlsVerdict.secure === true);
  const tlsDial = dial(
    `ws://relay.test:${relayPort}`,
    tlsVerdict.state === "tunnel" ? { createConnection: createRelayTunnelConnect(tlsVerdict, false, { proxyTls: { ca: [certPem] } }) } : undefined,
  );
  let tlsOpened = false;
  try {
    await tlsDial.opened;
    tlsOpened = true;
  } catch {
    // recorded by the checks below
  }
  check("tls-proxy: the dial completes over the TLS proxy leg", tlsOpened);
  check("tls-proxy: the TLS proxy saw the CONNECT authority-form request", sawTlsConnect);
  tlsDial.ws.close();
  tlsProxy.close();

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
