/**
 * eval-01 — hermetic end-to-end proof on a REAL daemon process.
 * Temp HOME with a dead pilot (stale heartbeat, dead pid, pilot.json pointing
 * at a supervisor session the fake opencode reports as deleted — the exact
 * production failure of 22–24/09), a fake opencode (GET /session/:id,
 * POST /session/:id/prompt_async) and a fake Web Push service over TLS with
 * one subscribed "phone" whose keys this test owns. Proves:
 *   1. GET /api/pilot-liveness reports down with the real reasons;
 *   2. the watchdog pages the phone with a real Web Push the phone can
 *      decrypt (RFC 8291 aes128gcm, VAPID, TTL/urgency, tag ocr-pilot);
 *   3. POST /api/pilot-notify to the deleted session answers
 *      session-not-found + fallback push and the phone gets the digest —
 *      the legacy synchronous /message endpoint is never called;
 *   4. a live session receives the prompt through prompt_async (204);
 *   5. /api/push reports the phones actually reached;
 *   6. the pilot coming back sends exactly one recovery page.
 * Ports are ephemeral; nothing touches ~/.opencode-remote or the production
 * services. Without openssl the push beats are skipped (the API/relay beats
 * still run).
 * Run: npx tsx scripts/pilotwatch-daemon.test.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("   ", detail);
  }
}

const cleanups: Array<() => void> = [];
function finish(code: number): never {
  for (const c of cleanups.reverse()) {
    try {
      c();
    } catch {}
  }
  process.exit(code);
}
setTimeout(() => {
  console.error("pilotwatch-daemon test timed out (global 150s)");
  finish(1);
}, 150_000).unref();

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

const home = mkdtempSync(join(tmpdir(), "ocr-pilotwatch-"));
cleanups.push(() => rmSync(home, { recursive: true, force: true }));
const state = join(home, ".opencode-remote");
mkdirSync(join(state, "pilot"), { recursive: true });
// the launchd agent dir + plist make the watcher probe launchctl; a fake
// launchctl FIRST on PATH keeps the probe hermetic (read-only `print` only,
// always "not loaded" — the production outage shape, independent of what the
// real launchd says on whichever host runs this)
mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
writeFileSync(join(home, "Library", "LaunchAgents", "com.ocr.pilot.plist"), "<plist/>");
mkdirSync(join(home, "bin"), { recursive: true });
writeFileSync(
  join(home, "bin", "launchctl"),
  '#!/bin/sh\n# hermetic read-only fake: the pilot label is never loaded here\nif [ "$1" = "print" ]; then\n  echo \'Could not find service "com.ocr.pilot" in domain for user gui\'\n  exit 113\nfi\necho "unsupported verb: $1" >&2\nexit 1\n',
  { mode: 0o755 },
);
const daemonPath = `${join(home, "bin")}:${process.env.PATH ?? ""}`;

// a pid that is certainly dead: a child we spawned and reaped ourselves
const deadPid = spawnSync(process.execPath, ["-e", ""], { cwd: home }).pid ?? 999_999;
writeFileSync(join(state, "pilot.json"), JSON.stringify({ supervisorSession: "ses_deleted0001", slots: 1 }));
writeFileSync(join(state, "pilot", "heartbeat"), String(Date.now() - 2 * 3_600_000));
writeFileSync(join(state, "pilot", "pilot.pid"), String(deadPid));

// ── fake opencode ────────────────────────────────────────────────────────────
const opencodeCalls: Array<{ method: string; path: string; body: string }> = [];
const NOT_FOUND = (id: string) => JSON.stringify({ name: "NotFoundError", data: { message: `Session not found: ${id}` } });
const opencode = createHttpServer(async (req, res) => {
  const body = (await readBody(req)).toString("utf8");
  const path = (req.url ?? "/").split("?")[0]!;
  opencodeCalls.push({ method: req.method ?? "", path, body });
  const m = /^\/session\/(ses_[A-Za-z0-9_]+)(\/prompt_async|\/message)?$/.exec(path);
  if (path === "/global/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ healthy: true, version: "1.18.32" }));
  }
  if (m) {
    const [, id, sub] = m;
    if (id === "ses_alive00001") {
      if (req.method === "POST" && sub === "/prompt_async") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET" && !sub) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id }));
      }
    }
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(NOT_FOUND(id!));
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
const opencodePort = await freePort();
await new Promise<void>((r) => opencode.listen(opencodePort, "127.0.0.1", () => r()));
cleanups.push(() => opencode.close());

// ── fake Web Push service (TLS) + the phone's subscription keys ──────────────
interface PushHit { headers: IncomingMessage["headers"]; body: Buffer }
const pushHits: PushHit[] = [];
const phone = createECDH("prime256v1");
phone.generateKeys();
const phonePublic = phone.getPublicKey();
const phoneAuth = randomBytes(16);
const b64u = (b: Buffer) => b.toString("base64url");
let pushPort = 0;
let pushOk = false;
if (spawnSync("openssl", ["version"]).status === 0) {
  const certDir = join(home, "tls");
  mkdirSync(certDir);
  const gen = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"),
      "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { stdio: "ignore" },
  );
  if (gen.status === 0) {
    const pushSrv = createHttpsServer(
      { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) },
      async (req, res) => {
        pushHits.push({ headers: req.headers, body: await readBody(req) });
        res.writeHead(201);
        res.end();
      },
    );
    pushPort = await freePort();
    await new Promise<void>((r) => pushSrv.listen(pushPort, "127.0.0.1", () => r()));
    cleanups.push(() => pushSrv.close());
    writeFileSync(
      join(state, "subscriptions.json"),
      JSON.stringify([{ endpoint: `https://127.0.0.1:${pushPort}/push/phone1`, keys: { p256dh: b64u(phonePublic), auth: b64u(phoneAuth) } }]),
    );
    pushOk = true;
  }
}
if (!pushOk) console.log("SKIP  push beats (openssl not available)");

/** RFC 8291 / RFC 8188 aes128gcm, single record — what the phone's browser does. */
function decryptPush(body: Buffer): { title?: string; body?: string; data?: { url?: string; tag?: string } } {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const serverPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ecdhSecret = phone.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), phonePublic, serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, phoneAuth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--; // padding, then the 0x02 delimiter
  return JSON.parse(plain.subarray(0, end).toString("utf8"));
}
const pages = () => pushHits.map((h) => decryptPush(h.body));

// ── the real daemon ──────────────────────────────────────────────────────────
const port = await freePort();
const daemon = spawn(process.execPath, ["--import", "tsx/esm", "apps/daemon/src/index.ts"], {
  cwd: join(import.meta.dirname, ".."),
  env: {
    ...process.env,
    HOME: home,
    PATH: daemonPath,
    OCR_METRICS_PORT: String(port),
    OPENCODE_URL: `http://127.0.0.1:${opencodePort}`,
    RELAY_URL: "ws://127.0.0.1:1",
    OCR_LOG_LEVEL: "warn",
    OCR_PILOTWATCH_INTERVAL_MS: "250",
    OCR_PILOTWATCH_INITIAL_DELAY_MS: "100",
    // the fake push service uses a throwaway self-signed cert
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    NODE_NO_WARNINGS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let daemonLog = "";
daemon.stdout.on("data", (c: Buffer) => (daemonLog += c.toString()));
daemon.stderr.on("data", (c: Buffer) => (daemonLog += c.toString()));
cleanups.push(() => daemon.kill("SIGTERM"));

const stateFile = join(state, "daemon.json");
let token = "";
for (let i = 0; i < 200 && !token; i++) {
  await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { authorization: "Bearer warmup" } }).catch(() => {});
  try {
    token = (JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken ?? "";
  } catch {}
  if (!token) await sleep(200);
}
if (!token) {
  console.error("daemon never produced an apiToken\n", daemonLog.slice(-2_000));
  finish(1);
}
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};
async function until<T>(fn: () => Promise<T | null> | T | null, ms = 30_000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  return null;
}

// ── 1. liveness verdict ──────────────────────────────────────────────────────
const unauth = await fetch(`http://127.0.0.1:${port}/api/pilot-liveness`);
check("api: /api/pilot-liveness is Bearer-gated like every /api route", unauth.status === 401);
const down = await until(async () => {
  const r = await api("GET", "/api/pilot-liveness");
  return r.json?.state === "down" && (r.json.reasons as unknown[]).length >= 2 ? r.json : null;
});
const reasons = (down?.reasons ?? []) as Array<{ code: string; severity: string; detail: string }>;
check("api: dead pilot → state down", down?.state === "down", JSON.stringify(down).slice(0, 400));
// The launchd probe only runs on darwin (where it answers "not loaded" via the
// hermetic fake launchctl), so the primary reason is the boot-out there and
// the dead process elsewhere — both are the production outage shape.
const primaryCode = process.platform === "darwin" ? "unloaded" : "dead";
check(`api: primary reason is the ${primaryCode} (the production outage shape)`, reasons[0]?.code === primaryCode && reasons[0]?.severity === "down", JSON.stringify(reasons));
check("api: deleted supervisor session detected by a read-only probe", reasons.some((r) => r.code === "supervisor-missing"));
check(
  "api: v1 contract fields present",
  down?.v === 1 && typeof down.checkedAt === "number" && (down.process as { pid?: number })?.pid === deadPid && (down.notify as { supervisor?: string })?.supervisor === "missing",
);

// ── 2. the watchdog pages the phone ─────────────────────────────────────────
if (pushOk) {
  const hit = await until(() => (pushHits.length >= 1 ? pushHits[0]! : null));
  check("push: the watchdog sent a Web Push to the subscribed phone", hit !== null, daemonLog.slice(-1_500));
  if (hit) {
    const page = decryptPush(hit.body);
    check("push: the phone decrypts it (RFC 8291) — title 🛑 Pilot parado", page.title === "🛑 Pilot parado", JSON.stringify(page));
    check("push: body carries the real reason", /não está (carregado no launchd|rodando)/.test(page.body ?? "") && /supervisor inacessível/.test(page.body ?? ""));
    check("push: dedicated tag so routine notifications cannot replace it", page.data?.tag === "ocr-pilot");
    check("push: VAPID-signed, urgent, with a TTL", /^vapid t=/.test(String(hit.headers.authorization)) && hit.headers.urgency === "high" && Number(hit.headers.ttl) > 0);
  }
  await sleep(1_500); // several more ticks: the episode must not re-page
  check("push: dedupe — one page for one outage (no page per tick)", pushHits.length === 1, `hits=${pushHits.length}`);
}

// ── 3. supervisor relay to a deleted session → phone digest ─────────────────
const before = pushHits.length;
const relay = await api("POST", "/api/pilot-notify", {
  text: "🔍 **Verificação complementar** — pilot falhou em **deploy**\n\ndisk low: 2.1gb free (need 5.0gb)",
  task: "deploy",
  ok: false,
  detail: "disk low: 2.1gb free (need 5.0gb)",
});
check(
  "relay: deleted session → session-not-found + fallback push (was a bare delivered:false)",
  relay.json?.delivered === false && relay.json.reason === "session-not-found" && relay.json.fallback === "push",
  JSON.stringify(relay.json),
);
check(
  "relay: prompt_async used; the synchronous /message endpoint never called",
  opencodeCalls.some((c) => c.method === "POST" && c.path === "/session/ses_deleted0001/prompt_async") &&
    !opencodeCalls.some((c) => c.method === "POST" && c.path.endsWith("/message")),
);
if (pushOk) {
  const digestHit = await until(() => (pushHits.length > before ? pushHits[before]! : null));
  const digest = digestHit ? decryptPush(digestHit.body) : null;
  check("relay: the phone gets the undeliverable failure", digest?.title === "📮 Pilot: deploy falhou" && /disk low/.test(digest.body ?? ""), JSON.stringify(digest));
  check("relay: the digest explains why the supervisor is out", /sessão do supervisor não existe mais/.test(digest.body ?? ""));
  check("relay: the digest carries its own tag (never replaces a 🛑 page)", digest?.data?.tag === "ocr-pilot-digest", JSON.stringify(digest));
  const again = await api("POST", "/api/pilot-notify", { text: "x\n\ndisk low: 0.1gb free (need 5.0gb)", task: "deploy", ok: false, detail: "disk low: 0.1gb free (need 5.0gb)" });
  await sleep(600);
  check("relay: a repeat of the same (task, kind) is folded, not re-pushed", again.json?.fallback === "push" && again.json.pushed === false && pushHits.length === before + 1);
}
const info = await api("POST", "/api/pilot-notify", { text: "merged", task: "P2-1", ok: true });
check("relay: informational message to a dead session is dropped (owned, no page)", info.json?.fallback === "drop");

// ── 4. a live supervisor session gets the prompt via prompt_async ───────────
writeFileSync(join(state, "pilot.json"), JSON.stringify({ supervisorSession: "ses_alive00001", slots: 1 }));
const live = await api("POST", "/api/pilot-notify", { text: "hello supervisor", task: "P2-2", ok: true });
const sent = opencodeCalls.find((c) => c.method === "POST" && c.path === "/session/ses_alive00001/prompt_async");
check("relay: live session → delivered:true", live.json?.delivered === true, JSON.stringify(live.json));
check("relay: the prompt body is opencode's parts shape", sent !== undefined && JSON.parse(sent.body).parts?.[0]?.text === "hello supervisor");

// ── 5. /api/push reports phones actually reached ────────────────────────────
if (pushOk) {
  const p = await api("POST", "/api/push", { title: "t", body: "b" });
  check("api/push: delivered = phones reached, subscribers = listed", p.json?.delivered === 1 && p.json.subscribers === 1, JSON.stringify(p.json));
}

// ── 6. the pilot comes back → exactly one recovery page ─────────────────────
const beforeRecovery = pushHits.length;
writeFileSync(join(state, "pilot", "pilot.pid"), String(process.pid));
writeFileSync(join(state, "pilot", "heartbeat"), String(Date.now()));
const ok = await until(async () => {
  writeFileSync(join(state, "pilot", "heartbeat"), String(Date.now()));
  const r = await api("GET", "/api/pilot-liveness");
  return r.json?.state === "ok" ? r.json : null;
});
check("api: live pid + fresh heartbeat + live supervisor → ok", ok?.state === "ok", JSON.stringify(ok).slice(0, 300));
if (pushOk) {
  const recovery = await until(() => {
    const got = pages().slice(beforeRecovery).find((p) => p.title === "✅ Pilot de volta ao normal");
    return got ?? null;
  });
  check("push: one '✅ Pilot de volta ao normal' page", recovery !== null);
  await sleep(1_000);
  check("push: nothing more once healthy (exactly one page since the pilot came back)", pushHits.length - beforeRecovery === 1, `pages=${JSON.stringify(pages().slice(beforeRecovery).map((p) => p.title))}`);
}

// ── persisted evidence ───────────────────────────────────────────────────────
const audit = existsSync(join(state, "audit.log")) ? readFileSync(join(state, "audit.log"), "utf8") : "";
check("audit: pages recorded as pilot-liveness", /"event":"pilot-liveness"/.test(audit));
check("state: episode persisted for dedupe across restarts", existsSync(join(state, "pilotwatch.json")));

daemon.kill("SIGTERM");
await new Promise((r) => {
  daemon.once("exit", () => r(null));
  setTimeout(() => r(null), 3_000).unref();
});
if (failures) {
  console.error(`pilotwatch-daemon: ${failures} failure(s)\n--- daemon log tail ---\n${daemonLog.slice(-2_500)}`);
  finish(1);
}
console.log("pilotwatch-daemon: all checks passed");
finish(0);
