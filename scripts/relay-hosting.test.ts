/**
 * Hosted-relay readiness regressions (eval-13), each against real relay
 * subprocesses booted from this checkout (hermetic: throwaway HOME, free
 * ports the kernel assigns to two probe listeners held open at once —
 * relay and metrics independent —, killed by PID):
 *
 *   1. the per-connection frame budget passes the daemon's measured bursts
 *      (the old 600/min + 1000 burst closed it 26 times in production);
 *   2. malformed frames cost a token, and a socket closed for policy gets no
 *      more work — one "rate limited" line and one counter increment per
 *      socket instead of one per buffered frame;
 *   3. a log line that cannot be written never takes the router down
 *      (production relay.err.log: two ENOSPC crash traces), counted instead;
 *   4. the crash hatch is inert outside the test harness;
 *   5. the two-replica trap (P3-401/P3-459) end to end: behind a round-robin
 *      balancer the pair never meets, the /healthz instanceId test and the
 *      unrouted-frame counter both expose it, and routing by URL path — which
 *      today's clients already dial verbatim from the pairing code — heals it.
 *
 * Run: npx tsx scripts/relay-hosting.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { get as httpGet } from "node:http";
import { connect as tcpConnect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { relayKnobs, RATE_BURST_DEFAULT, RATE_PER_MIN_DEFAULT } from "../apps/relay/src/knobs";
import { TokenBucket } from "../apps/relay/src/ratelimit";
import { RELAY_WIRE_PROTOCOL } from "../packages/protocol/src/relaywire.js";
import { imageSmokeVerdict } from "./relay-image-smoke";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}
setTimeout(() => {
  console.error("relay-hosting test timed out (global 90s)");
  process.exit(1);
}, 90_000).unref();

const ROOT = join(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const homes: string[] = [];
const procs: ChildProcess[] = [];
process.on("exit", () => {
  for (const p of procs) p.kill("SIGKILL");
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

interface Relay {
  port: number;
  mport: number;
  proc: ChildProcess;
  stdout: () => string;
  exitCode: () => number | null | undefined;
}

// eval-13 fix round: two probe listeners held open AT THE SAME TIME so the
// kernel hands out two distinct free ports — relay and metrics independent,
// and no EADDRINUSE against another suite's relay or a stray listener (the
// same EADDRINUSE class the eval-03/eval-17 suites are removing; a CI run of
// this suite lost the hatch relay's boot to one).
function freePortPair(): Promise<[number, number]> {
  const take = (srv: Server) =>
    new Promise<number>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
    });
  const a = createServer();
  const b = createServer();
  return Promise.all([take(a), take(b)]).then(
    ([p1, p2]) =>
      new Promise<[number, number]>((resolve) => {
        a.close(() => b.close(() => resolve([p1, p2])));
      }),
  );
}

async function startRelay(env: Record<string, string>, opts: { preload?: string; stdoutFd?: number } = {}): Promise<Relay> {
  const [port, mport] = await freePortPair();
  const home = mkdtempSync(join(tmpdir(), "ocr-relay-hosting-"));
  homes.push(home);
  const argv = ["--import", "tsx/esm", ...(opts.preload ? ["--import", opts.preload] : []), "apps/relay/src/index.ts"];
  const proc = spawn(process.execPath, argv, {
    cwd: ROOT,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "",
      OCR_E2E_MARKER: "1",
      RELAY_PORT: String(port),
      RELAY_METRICS_PORT: String(mport),
      ...env,
    },
    stdio: ["ignore", opts.stdoutFd ?? "pipe", opts.stdoutFd ?? "pipe"],
  });
  procs.push(proc);
  let out = "";
  proc.stdout?.on("data", (c) => (out += String(c)));
  proc.stderr?.on("data", (c) => (out += String(c)));
  let code: number | null | undefined;
  proc.on("exit", (c) => (code = c));
  return { port, mport, proc, stdout: () => out, exitCode: () => code };
}

async function healthz(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } catch {
    return { status: 0, body: {} };
  }
}
async function waitUp(r: { port: number }): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if ((await healthz(r.port)).status === 200) return true;
    await sleep(200);
  }
  return false;
}
async function metrics(mport: number): Promise<Record<string, number>> {
  return (await (await fetch(`http://127.0.0.1:${mport}/metrics`)).json()) as Record<string, number>;
}
function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    // a relay that dies under a live socket must fail a check, not this runner
    ws.on("error", () => {});
  });
}
const closeCode = (ws: WebSocket, ms: number) =>
  new Promise<number>((resolve) => {
    ws.once("close", (code) => resolve(code));
    setTimeout(() => resolve(-1), ms).unref();
  });
function countMessages(ws: WebSocket): () => number {
  let n = 0;
  ws.on("message", () => n++);
  return () => n;
}

// --- 1. the frame budget passes measured daemon bursts ------------------------
{
  const k = relayKnobs({});
  check("defaults: 45000 frames/min sustained and a 1500 burst", k.ratePerMin === 45_000 && k.rateBurst === 1_500);
  check(
    "defaults: the exported constants are what an empty env resolves",
    k.ratePerMin === RATE_PER_MIN_DEFAULT && k.rateBurst === RATE_BURST_DEFAULT && k.problems.length === 0,
  );
  // the production daemon's measured shape (relay log, 2026-08-30..09-06):
  // 1,144 frames in one second, 22,906 in one minute, 80,949 in five —
  // replayed through the relay's own bucket at the default config
  let t = 0;
  const b = new TokenBucket(RATE_BURST_DEFAULT, RATE_PER_MIN_DEFAULT, () => t);
  let refused = 0;
  const burst = (frames: number, overMs: number) => {
    for (let i = 0; i < frames; i++) {
      t += overMs / frames;
      if (!b.take()) refused++;
    }
  };
  burst(1_144, 1_000); // the one-second peak
  burst(22_906 - 1_144, 59_000); // the rest of the peak minute
  burst(80_949 - 22_906, 240_000); // the rest of the peak five minutes
  check("defaults: the recorded peak second, minute and five minutes all pass", refused === 0, { refused });
  const old = new TokenBucket(1000, 600, () => 0);
  let oldRefused = 0;
  for (let i = 0; i < 1_144; i++) if (!old.take()) oldRefused++;
  check("control: the old 600/min + 1000 burst refuses the measured one-second peak", oldRefused === 144);
}

const dflt = await startRelay({});
const strict = await startRelay({ RELAY_RATE_PER_MIN: "60", RELAY_RATE_BURST: "5" });
check("boot: default and strict relays answer /healthz", (await waitUp(dflt)) && (await waitUp(strict)));

{
  // a daemon-shaped storm: one socket, from === room, replaying the recorded
  // production peak — 1,144 frames in one second (relay.log, 2026-08-30..09-06)
  const room = `hostingstorm${Date.now()}`;
  const listener = await open(`ws://127.0.0.1:${dflt.port}`);
  listener.send(JSON.stringify({ room, from: "phone-1", payload: "" }));
  const got = countMessages(listener);
  await sleep(150);
  const daemon = await open(`ws://127.0.0.1:${dflt.port}`);
  const closed = closeCode(daemon, 8_000);
  for (let i = 0; i < 1_144; i++) {
    daemon.send(JSON.stringify({ room, from: room, payload: `f${i}` }));
    await sleep(1);
  }
  for (let i = 0; i < 60 && got() < 1_144; i++) await sleep(100);
  check("storm: the recorded peak second (1,144 frames) reaches the phone at the default budget", got() === 1_144, got());
  check("storm: the daemon socket is never closed for rate", (await closed) === -1);
  // the healthy-relay baseline for the unrouted split: with the phone gone,
  // the daemon's mid-response tail finds nobody — owner frames land in
  // frames_unrouted_owner_total and never in the phone-symptom counter
  listener.terminate();
  await sleep(250);
  const tailBefore = await metrics(dflt.mport);
  for (let i = 0; i < 5; i++) daemon.send(JSON.stringify({ room, from: room, payload: `tail${i}` }));
  await sleep(400);
  const tailAfter = await metrics(dflt.mport);
  check(
    "unrouted: the daemon's tail into an empty room counts as owner, not as the phone symptom",
    (tailAfter.frames_unrouted_owner ?? 0) - (tailBefore.frames_unrouted_owner ?? 0) === 5 &&
      (tailAfter.frames_unrouted ?? 0) - (tailBefore.frames_unrouted ?? 0) === 0,
    {
      before: tailBefore.frames_unrouted,
      after: tailAfter.frames_unrouted,
      beforeOwner: tailBefore.frames_unrouted_owner,
      afterOwner: tailAfter.frames_unrouted_owner,
    },
  );
  daemon.terminate();
  // control: the same relay still closes a glued flood — the 1500 burst is
  // the queue one abusive socket may build before the cut
  const blast = await open(`ws://127.0.0.1:${dflt.port}`);
  const blastClosed = closeCode(blast, 3_000);
  const blastRoom = `hostingblast${Date.now()}`;
  for (let i = 0; i < 3_000; i++) blast.send(JSON.stringify({ room: blastRoom, from: "phone-2", payload: `p${i}` }));
  check("storm: a glued 3,000-frame flood still closes at the default (4029)", (await blastClosed) === 4029);
  blast.terminate();
}

// --- 2. malformed frames cost a token; a closed socket gets no more work ------
{
  const ws = await open(`ws://127.0.0.1:${strict.port}`);
  const closed = closeCode(ws, 3_000);
  ws.send(JSON.stringify({ room: "hostingjunk01", from: "junk", payload: "" }));
  for (let i = 0; i < 12; i++) ws.send("{not json");
  check("malformed: invalid JSON frames exhaust the bucket (close 4029)", (await closed) === 4029);
}
{
  const before = (await metrics(strict.mport)).rate_limited_total ?? 0;
  const ws = await open(`ws://127.0.0.1:${strict.port}`);
  const closed = closeCode(ws, 3_000);
  const room = "hostingflood01";
  // one write carrying 60 frames' worth of sends: ws hands them to the relay
  // back to back, the 6th is over budget, the other 54 were buffered behind it
  for (let i = 0; i < 60; i++) ws.send(JSON.stringify({ room, from: "flood", payload: `p${i}` }));
  check("flood: the socket is closed with 4029", (await closed) === 4029);
  await sleep(200);
  const after = (await metrics(strict.mport)).rate_limited_total ?? 0;
  check("flood: exactly one rate-limit increment for one socket", after - before === 1, { before, after });
  const lines = strict.stdout().split("\n").filter((l) => l.includes('"rate limited, dropping device"'));
  check("flood: one warn line per closed socket, not one per buffered frame", lines.length === 2, lines.length);
}

// --- 3. a failed log write never takes the router down -------------------------
// The preload makes process.stdout's own write fail right after the boot line,
// through the same Writable error path an ENOSPC takes (fs.writeSync throws →
// the stream is destroyed → 'error' is emitted). Before eval-13 that event had
// no listener and became an uncaught exception.
{
  const failWrites = [
    "const err = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });",
    "const s = process.stdout; const w = s.write.bind(s); let armed = false;",
    "s.write = (chunk, ...rest) => { const r = w(chunk, ...rest);",
    "  if (!armed && String(chunk).includes('relay listening')) { armed = true;",
    "    s._write = (c, e, cb) => cb(err); s._writev = (c, cb) => cb(err); }",
    "  return r; };",
  ].join("\n");
  const relay = await startRelay({}, { preload: `data:text/javascript,${encodeURIComponent(failWrites)}` });
  const up = await waitUp(relay);
  // before eval-13 the relay died on the first failed write, so every dial
  // below may fail — that must surface as a failed check, not a crash here
  const dial = () => open(`ws://127.0.0.1:${relay.port}`).catch(() => undefined);
  const a = await dial(); // "connection open" → the first failed write
  await sleep(300);
  const b = await dial();
  const room = "hostingdisk001";
  a?.send(JSON.stringify({ room, from: "a", payload: "" }));
  const got = a ? countMessages(a) : () => 0;
  await sleep(100);
  b?.send(JSON.stringify({ room, from: "b", payload: "still routing" }));
  await sleep(700);
  check("log errors: the relay booted and kept running after its log writes failed", up && relay.exitCode() === undefined);
  check("log errors: /healthz still answers 200", (await healthz(relay.port)).status === 200);
  check("log errors: frames still route between peers", got() === 1, got());
  const m = await metrics(relay.mport).catch(() => ({}) as Record<string, number>);
  check("log errors: the failures are counted on /metrics (log_write_errors_total)", (m.log_write_errors_total ?? 0) >= 1, m.log_write_errors_total);
  const prom = await fetch(`http://127.0.0.1:${relay.mport}/metrics?format=prom`).then((r) => r.text(), () => "");
  check("log errors: the Prometheus text carries relay_log_write_errors_total", /^relay_log_write_errors_total [1-9]\d*$/m.test(prom));
  a?.terminate();
  b?.terminate();
}
// Real ENOSPC where the platform offers one (Linux /dev/full — the CI runner):
// every write of stdout AND stderr fails, from the very first boot line.
if (existsSync("/dev/full")) {
  const fd = openSync("/dev/full", "w");
  const relay = await startRelay({}, { stdoutFd: fd });
  const up = await waitUp(relay);
  check("log errors (/dev/full): the relay boots and serves with every log write failing", up && relay.exitCode() === undefined);
  check("log errors (/dev/full): failures counted", ((await metrics(relay.mport)).log_write_errors_total ?? 0) >= 1);
} else {
  console.log("SKIP log errors (/dev/full): not available on this platform (the preload case above covers the path)");
}

// --- 4. the crash hatch is inert outside the test harness ---------------------
{
  const secret = "throw:hatch-value-7f3a";
  const relay = await startRelay({ OCR_E2E_MARKER: "", OCR_RELAY_CRASH_HATCH: secret });
  const up = await waitUp(relay);
  await sleep(600);
  check("hatch: without the harness marker the relay stays up", up && relay.exitCode() === undefined);
  check("hatch: one warn line names the variable", relay.stdout().includes('"test crash hatch ignored outside the test harness"'));
  check("hatch: the hatch value never reaches the log", !relay.stdout().includes("hatch-value-7f3a"));
}

// --- 5. the two-replica trap, its diagnosis and the path-affinity recipe ------
// A tiny TCP balancer in front of two real replicas: it reads the HTTP
// request line of each new connection and picks a backend.
function startBalancer(backends: number[], pick: (requestLine: string, n: number) => number): Promise<{ port: number; srv: Server }> {
  let n = 0;
  const srv = createServer((client) => {
    client.on("error", () => {});
    client.once("data", (head) => {
      client.pause();
      const line = head.toString("latin1").split("\r\n", 1)[0] ?? "";
      const up = tcpConnect(backends[pick(line, n++)]!, "127.0.0.1", () => {
        up.write(head);
        client.pipe(up).pipe(client);
      });
      up.on("error", () => client.destroy());
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as { port: number }).port, srv })));
}
{
  const a = await startRelay({});
  const b = await startRelay({});
  check("replicas: both boot", (await waitUp(a)) && (await waitUp(b)));
  const roundRobin = await startBalancer([a.port, b.port], (_line, n) => n % 2);
  // one TCP connection per probe (no keep-alive reuse), like two separate
  // curl calls through the public address
  const probeId = (port: number) =>
    new Promise<unknown>((resolve) => {
      httpGet({ host: "127.0.0.1", port, path: "/healthz", agent: false }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve((JSON.parse(body) as { instanceId?: unknown }).instanceId));
      }).on("error", () => resolve(undefined));
    });
  const ids = [await probeId(roundRobin.port), await probeId(roundRobin.port)];
  check("trap: the documented /healthz test shows two instanceIds behind one address", typeof ids[0] === "string" && ids[0] !== ids[1], ids);
  const room = "hostingsplit01";
  const daemon = await open(`ws://127.0.0.1:${roundRobin.port}/`); // → replica A
  daemon.send(JSON.stringify({ room, from: room, payload: "" }));
  const daemonGot = countMessages(daemon);
  await sleep(100);
  const phone = await open(`ws://127.0.0.1:${roundRobin.port}/`); // → replica B
  phone.send(JSON.stringify({ room, from: "phone", payload: "hello" }));
  await sleep(600);
  check("trap: the phone's hello never reaches the daemon on the other replica", daemonGot() === 0);
  const mb = await metrics(b.mport);
  check("trap: replica B counts the frame that found nobody (frames_unrouted)", mb.frames_unrouted === 1, mb.frames_unrouted);
  check("trap: both replicas report one single-peer room each (the ambiguous signal)", (await metrics(a.mport)).rooms_single_peer === 1 && mb.rooms_single_peer === 1);
  daemon.terminate();
  phone.terminate();
  roundRobin.srv.close();

  // the recipe: route by URL path; daemon and phone dial the same URL (the
  // pairing code carries it verbatim), so every socket of a room meets
  const byPath = await startBalancer([a.port, b.port], (line) => {
    const path = line.split(" ")[1] ?? "/";
    let h = 0;
    for (const ch of path) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 2;
  });
  const url = `ws://127.0.0.1:${byPath.port}/t/tenant-42`;
  const room2 = "hostingpaired1";
  const d2 = await open(url);
  d2.send(JSON.stringify({ room: room2, from: room2, payload: "" }));
  const d2Got = countMessages(d2);
  await sleep(100);
  const p2 = await open(url);
  p2.send(JSON.stringify({ room: room2, from: "phone", payload: "hello" }));
  await sleep(600);
  check("affinity: with path routing the phone's hello reaches the daemon", d2Got() === 1, d2Got());
  d2.terminate();
  p2.terminate();
  byPath.srv.close();
}

// --- 6. the published image must carry the replica identity ------------------
// (the P3-459 idea of the blocked PR #1316): the release/PR image smoke
// refuses an image whose /healthz lacks a valid instanceId, so the two-minute
// replica test above can never silently lose its only input.
{
  const healthzProbe = (extra: Record<string, unknown>) => ({
    name: "healthz",
    status: 200,
    body: JSON.stringify({ ok: true, version: "0.2.0", protocol: RELAY_WIRE_PROTOCOL, uptimeS: 3, rooms: 1, roomsRejected: 0, ...extra }),
  });
  const problemsOf = (extra: Record<string, unknown>) =>
    imageSmokeVerdict([healthzProbe(extra)]).filter((p) => p.includes("instanceId"));
  check("smoke: a generated instanceId passes", problemsOf({ instanceId: "relay-i-0f3a9c2b7d5e4a18" }).length === 0);
  check("smoke: an operator id at the 64-char ceiling passes", problemsOf({ instanceId: "a".repeat(64) }).length === 0);
  check("smoke: an image without instanceId fails (fail-closed)", problemsOf({}).length === 1);
  for (const [label, bad] of [
    ["empty", ""],
    ["number", 42],
    ["above the ceiling", "a".repeat(65)],
    ["space", "replica b"],
    ["address-like", "10.0.0.1:8787"],
  ] as const) {
    check(`smoke: instanceId ${label} fails`, problemsOf({ instanceId: bad }).length === 1);
  }
}

for (const p of procs) p.kill("SIGTERM");
if (failures > 0) {
  console.error(`relay-hosting: ${failures} failure(s)`);
  process.exit(1);
}
console.log("relay-hosting: ALL OK");
process.exit(0);
