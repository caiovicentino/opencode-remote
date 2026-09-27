/**
 * P2-110 (eval-19) — GET /api/pilot-stream: SSE framing, the events.jsonl
 * follower that survives events.ts's in-place trim, the hub (snapshot first,
 * pilot frames, status beats, client cap, stalled-client drop), a real HTTP +
 * fs.watch round trip against a temp HOME (the spec's "<500 ms" criterion),
 * and the dashboard's EventSource client (cookie auth, no token in the URL,
 * poll relaxes to 10s, bounded retries, then the poll alone).
 * Run: npx tsx scripts/pilot-stream.test.ts
 */
import "./testhome"; // FIRST: throwaway HOME before any app module resolves ~/.opencode-remote
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventsFollower, createDefaultPilotStream, createPilotStream, sseFrame } from "../apps/daemon/src/pilotstream";
import { DASHBOARD_HTML, json, loadDashboard } from "./dashboard-harness";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (i: number, extra = "") => JSON.stringify({ ts: `2026-09-27T12:00:${String(i).padStart(2, "0")}.000Z`, type: "phase", task: "P2-1", phase: `p${i}${extra}` });

// ── 1. framing ─────────────────────────────────────────────────────────────
check("frame: event + id + data + blank line", sseFrame("pilot", '{"a":1}', "2026-09-27T12:00:00.000Z") === 'event: pilot\nid: 2026-09-27T12:00:00.000Z\ndata: {"a":1}\n\n');
check("frame: objects are JSON-encoded", sseFrame("status", { ok: true }) === 'event: status\ndata: {"ok":true}\n\n');
check("frame: multi-line data becomes one data: line each", sseFrame("x", "a\nb") === "event: x\ndata: a\ndata: b\n\n");
check("frame: newlines can never smuggle a field through the id", !sseFrame("x", "1", "a\nevent: evil").includes("\nevent: evil"));

// ── 2. follower ────────────────────────────────────────────────────────────
{
  let text: string | null = null;
  const f = new EventsFollower(() => text);
  f.prime();
  check("follower: missing file primes to nothing", f.poll().length === 0);
  text = `${line(1)}\n${line(2)}\n`;
  check("follower: a file created later is delivered whole", JSON.stringify(f.poll()) === JSON.stringify([line(1), line(2)]));
  check("follower: no change → nothing", f.poll().length === 0);
  text += `${line(3)}\n${line(4)}\n`;
  check("follower: appends are delivered in order, once", JSON.stringify(f.poll()) === JSON.stringify([line(3), line(4)]));
  text += `${line(5)}`.slice(0, 20);
  check("follower: a torn line (no newline yet) is held back", f.poll().length === 0);
  text = `${line(1)}\n${line(2)}\n${line(3)}\n${line(4)}\n${line(5)}\n`;
  check("follower: …and delivered once complete", JSON.stringify(f.poll()) === JSON.stringify([line(5)]));
  // events.ts trim(): rewrite IN PLACE keeping the tail, then the next append
  text = `${line(4)}\n${line(5)}\n${line(6)}\n`;
  check("follower: shrinking trim-rewrite + append → only the new line", JSON.stringify(f.poll()) === JSON.stringify([line(6)]));
  // a rewrite that keeps the same size (the new line is as long as the dropped one)
  text = `${line(5)}\n${line(6)}\n${line(7)}\n`;
  check("follower: same-size rewrite → only the new line, no duplicates", JSON.stringify(f.poll()) === JSON.stringify([line(7)]));
  // a burst larger than the cap trimmed away the last delivered line
  text = `${line(9)}\n${line(10)}\n${line(11)}\n`;
  check("follower: last delivered line trimmed away → resumes by ts, nothing lost", JSON.stringify(f.poll()) === JSON.stringify([line(9), line(10), line(11)]));
  const g = new EventsFollower(() => `${line(1)}\n`);
  check("follower: the first poll without prime primes (no replay of history)", g.poll().length === 0);
}

// ── 3. hub with fake responses ─────────────────────────────────────────────
interface FakeRes {
  status: number;
  headers: Record<string, string>;
  chunks: string[];
  writable: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  handlers: Map<string, (() => void)[]>;
  writeHead(status: number, headers?: Record<string, string>): FakeRes;
  write(chunk: string): boolean;
  end(chunk?: string): void;
  destroy(): void;
  on(ev: string, fn: () => void): FakeRes;
  once(ev: string, fn: () => void): FakeRes;
  emit(ev: string): void;
}
function fakeRes(): FakeRes {
  const r: FakeRes = {
    status: 0,
    headers: {},
    chunks: [],
    writable: true,
    writableEnded: false,
    destroyed: false,
    handlers: new Map(),
    writeHead(status, headers = {}) {
      r.status = status;
      r.headers = headers;
      return r;
    },
    write(chunk) {
      r.chunks.push(chunk);
      return r.writable;
    },
    end(chunk) {
      if (chunk) r.chunks.push(chunk);
      r.writableEnded = true;
    },
    destroy() {
      r.destroyed = true;
      r.emit("close");
    },
    on(ev, fn) {
      r.handlers.set(ev, [...(r.handlers.get(ev) ?? []), fn]);
      return r;
    },
    once(ev, fn) {
      return r.on(ev, fn);
    },
    emit(ev) {
      for (const fn of r.handlers.get(ev) ?? []) fn();
    },
  };
  return r;
}
{
  let text = `${line(1)}\n${line(2)}\n`;
  let onChange: (() => void) | null = null;
  let unwatched = 0;
  const counts: number[] = [];
  let statusN = 0;
  const hub = createPilotStream({
    eventsFile: "/nowhere/events.jsonl",
    readEvents: () => text,
    snapshot: async () => ({ events: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)), status: { beat: 0 } }),
    status: async () => ({ beat: ++statusN }),
    statusEveryMs: 60,
    coalesceMs: 5,
    stallMs: 30,
    maxClients: 2,
    onClients: (n) => counts.push(n),
    watchFile: (_f, cb) => {
      onChange = cb;
      return () => {
        unwatched++;
      };
    },
  });
  const a = fakeRes();
  await hub.attach({} as never, a as never);
  check("hub: 200 text/event-stream, no caching", a.status === 200 && a.headers["content-type"]?.startsWith("text/event-stream") === true && a.headers["cache-control"] === "no-store");
  check("hub: reconnect hint then the snapshot comes first", a.chunks[0] === "retry: 3000\n\n" && a.chunks[1]!.startsWith("event: snapshot\n") && a.chunks[1]!.includes('"phase":"p2"'));
  text += `${line(3)}\n`;
  onChange!();
  onChange!(); // two change signals inside the window → one read
  await sleep(20);
  const pilotFrames = a.chunks.filter((c) => c.startsWith("event: pilot"));
  check("hub: a new line becomes exactly one pilot frame, id = its ts", pilotFrames.length === 1 && pilotFrames[0]!.includes(`id: 2026-09-27T12:00:03.000Z`) && pilotFrames[0]!.includes('"phase":"p3"'), JSON.stringify(a.chunks));
  await sleep(90);
  check("hub: the status digest beats on its interval", a.chunks.some((c) => c.startsWith("event: status\n")));
  const b = fakeRes();
  await hub.attach({} as never, b as never);
  const c = fakeRes();
  await hub.attach({} as never, c as never);
  check("hub: past maxClients the stream answers 503 + retry-after", c.status === 503 && c.headers["retry-after"] === "10" && hub.clients() === 2);
  // b stops draining: writes return false and no drain ever comes
  b.writable = false;
  text += `${line(4)}\n`;
  onChange!();
  await sleep(15);
  text += `${line(5)}\n`;
  await sleep(40); // past stallMs
  onChange!();
  await sleep(15);
  check("hub: a client that cannot drain for stallMs is destroyed and dropped", b.destroyed && hub.clients() === 1, `clients=${hub.clients()}`);
  check("hub: the healthy client kept receiving", a.chunks.filter((x) => x.startsWith("event: pilot")).length === 3);
  a.emit("close");
  check("hub: closing the last client stops watching", hub.clients() === 0 && unwatched === 1);
  check("hub: the client gauge followed every change", counts.join(",") === "1,2,1,0", counts.join(","));
  hub.close();
}

// ── 4. real HTTP + fs.watch round trip ─────────────────────────────────────
{
  const home = mkdtempSync(join(tmpdir(), "pilot-stream-home-"));
  const dir = join(home, ".opencode-remote", "pilot");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "events.jsonl");
  writeFileSync(file, `${line(1)}\n${line(2)}\n${line(3)}\n`);
  const hub = createDefaultPilotStream({ home, status: async () => ({ pilot: { state: "down" } }) });
  const server = createServer((req, res) => void hub.attach(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: { event: string; data: string; at: number }[] = [];
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const ev = /^event: (.*)$/m.exec(raw)?.[1];
          const data = [...raw.matchAll(/^data: (.*)$/gm)].map((m) => m[1]).join("\n");
          if (ev) frames.push({ event: ev, data, at: Date.now() });
        }
      }
    } catch {
      // aborted
    }
  })();
  const until = async (pred: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await sleep(10);
    return pred();
  };
  await until(() => frames.some((f) => f.event === "snapshot"), 3_000);
  const snap = frames.find((f) => f.event === "snapshot");
  const parsed = snap ? (JSON.parse(snap.data) as { events: { phase: string }[]; status: { pilot: { state: string } } }) : null;
  check("http: the first frame is the snapshot (events + status digest)", frames[0]?.event === "snapshot" && parsed?.events.length === 3 && parsed.status.pilot.state === "down");
  const t0 = Date.now();
  appendFileSync(file, `${line(4)}\n`);
  const got = await until(() => frames.some((f) => f.event === "pilot" && f.data.includes('"phase":"p4"')), 2_000);
  const latency = (frames.find((f) => f.event === "pilot" && f.data.includes('"phase":"p4"'))?.at ?? Infinity) - t0;
  check(`http: echo >> events.jsonl reaches the client in <500 ms (${latency} ms)`, got && latency < 500);
  // events.ts trim(): in-place rewrite that keeps the tail, then one more append
  writeFileSync(file, `${line(3)}\n${line(4)}\n${line(5)}\n`);
  await until(() => frames.some((f) => f.data.includes('"phase":"p5"')), 2_000);
  await sleep(250);
  const pilotPhases = frames.filter((f) => f.event === "pilot").map((f) => (JSON.parse(f.data) as { phase: string }).phase);
  check("http: after the trim-rewrite only the new line arrives — no replay, no loss", JSON.stringify(pilotPhases) === JSON.stringify(["p4", "p5"]), JSON.stringify(pilotPhases));
  check("http: one connected client", hub.clients() === 1);
  ctrl.abort();
  await pump;
  await until(() => hub.clients() === 0, 2_000);
  check("http: a closed connection leaves the hub", hub.clients() === 0);
  hub.close();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
}

// ── 5. daemon wiring (source) ──────────────────────────────────────────────
{
  const daemon = readFileSync(new URL("../apps/daemon/src/index.ts", import.meta.url), "utf8");
  const auth = daemon.indexOf("if (!authorized(req)) {\n    send401(res);\n    return true;\n  }\n  const op =");
  const route = daemon.indexOf('seg[1] === "pilot-stream" && req.method === "GET"');
  check("wiring: /api/pilot-stream sits behind the Bearer/cookie gate", auth > 0 && route > auth);
  check("wiring: the hub reports ocr_pilot_stream_clients", daemon.includes('metrics.gauge("ocr_pilot_stream_clients", n)'));
  check("dashboard: EventSource opens /api/pilot-stream with no query string (token never in a URL)", DASHBOARD_HTML.includes('new EventSource("/api/pilot-stream")') && !/new EventSource\([^)]*token/.test(DASHBOARD_HTML));
}

// ── 6. the dashboard's stream client ───────────────────────────────────────
class FakeES {
  static all: FakeES[] = [];
  readyState = 0;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((m: { data: string }) => void)[]>();
  closed = false;
  constructor(public url: string) {
    FakeES.all.push(this);
  }
  addEventListener(ev: string, fn: (m: { data: string }) => void) {
    this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
  }
  fire(ev: string, data: unknown) {
    this.readyState = 1;
    for (const fn of this.listeners.get(ev) ?? []) fn({ data: JSON.stringify(data) });
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.();
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
}
{
  const calls: string[] = [];
  let sessionStatus = 200;
  const fetchStub = async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
    calls.push(`${init?.method ?? "GET"} ${url} ${init?.headers?.authorization ?? ""}`);
    if (url === "/api/session") return json(sessionStatus, { ok: sessionStatus === 200 });
    if (url === "/api/pilot-events") return json(200, { state: {}, heartbeatMs: 1_000, events: [], cfg: {} });
    if (url === "/api/pilot-ready") return json(200, { ready: [], blocked: [] });
    // a partial digest (older/newer daemon shape) — the page must shrug it off
    if (url === "/api/pilot-status") return json(200, { installed: true, attention: [], pilot: { state: "alive" } });
    return json(200, {});
  };
  const dash = await loadDashboard({ fetch: fetchStub, EventSource: FakeES });
  check("client: the cookie is minted once from the Bearer (POST /api/session)", calls.filter((c) => c.startsWith("POST /api/session Bearer test-token")).length === 1, calls.join(" | "));
  check("client: one EventSource on /api/pilot-stream", FakeES.all.length === 1 && FakeES.all[0]!.url === "/api/pilot-stream");
  const es = FakeES.all[0]!;
  const ev1 = { ts: "2026-09-27T12:00:01.000Z", type: "deploy", phase: "disk-guard", ok: false, detail: "disk low" };
  const digest = (down: boolean) => ({
    installed: true,
    attention: down ? [{ kind: "pilot-down", level: "critical" }] : [],
    pilot: { state: down ? "down" : "alive", heartbeatAgeMs: down ? 9e6 : 1_000, since: null, pid: null, pidAlive: null },
    deploy: { behind: down ? 1 : 0, hold: null, prodSha: null, mainSha: null, pendingSince: null, fetchedAt: null },
    disk: { freeBytes: 80e9, totalBytes: 200e9, minFreeBytes: 5e9 },
    queue: { ready: 0, blocked: 0, source: "origin/main" },
    cost: { day: { merges: 0, tokens: 0, usd: null, unpricedTokens: 0 }, week: { merges: 0, tokens: 0, usd: null, unpricedTokens: 0 } },
    alerts: { undelivered: 0, lastDeliveredAgeMs: null },
  });
  check("client: a partial digest from the poll was ignored (no status, poll alive)", dash.world.status === null && dash.timeouts.length > 0);
  es.fire("snapshot", { events: [ev1], status: digest(true) });
  check("client: the snapshot hydrates events and the status digest", (dash.world.lastEvent as { phase?: string })?.phase === "disk-guard" && (dash.world.status as { pilot: { state: string } }).pilot.state === "down");
  check("client: …and paints the chip right away", dash.el("c-pilot").classList.contains("on"));
  const ev2 = { ts: "2026-09-27T12:00:02.000Z", type: "phase", task: "P2-9", phase: "builder", detail: "round 1" };
  es.fire("pilot", ev2);
  check("client: a pilot frame is applied at once", (dash.world.lastEvent as { phase?: string })?.phase === "builder");
  es.fire("status", { installed: true, attention: [] }); // malformed beat: ignored
  check("client: a malformed status beat keeps the last good digest", dash.el("c-pilot").classList.contains("on"));
  es.fire("status", digest(false));
  check("client: a status beat replaces the digest (chip clears)", !dash.el("c-pilot").classList.contains("on"));
  const before = dash.timeouts.length;
  await (dash.fn.poll as () => Promise<void>)();
  check("client: with the stream live the poll relaxes to 10 s", dash.timeouts.length > before && dash.timeouts[dash.timeouts.length - 1] === 10_000, JSON.stringify(dash.timeouts));
  es.fail(false);
  check("client: a transient drop (CONNECTING) leaves the browser's own retry in charge", FakeES.all.length === 1 && !es.closed);
  dash.restore();

  // a stream that never opens (desktop iframe: third-party cookie → 401)
  FakeES.all = [];
  const dash2 = await loadDashboard({ fetch: fetchStub, EventSource: FakeES });
  FakeES.all[0]!.fail(true);
  check("client: a stream refused before its snapshot schedules a retry", FakeES.all[0]!.closed && dash2.timeouts.includes(3_000), JSON.stringify(dash2.timeouts));
  await (dash2.fn.startStream as () => Promise<void>)();
  FakeES.all[1]!.fail(true);
  await (dash2.fn.startStream as () => Promise<void>)();
  FakeES.all[2]!.fail(true);
  await (dash2.fn.startStream as () => Promise<void>)();
  check("client: after 3 refusals the page stays on the poll (no 4th EventSource)", FakeES.all.length === 3, `sources=${FakeES.all.length}`);
  const after = dash2.timeouts.length;
  await (dash2.fn.poll as () => Promise<void>)();
  check("client: without the stream the poll keeps its 2 s cadence", dash2.timeouts[after] === 2_000, JSON.stringify(dash2.timeouts.slice(after)));
  dash2.restore();

  // a daemon that refuses the session exchange: no EventSource at all
  FakeES.all = [];
  sessionStatus = 401;
  const dash3 = await loadDashboard({ fetch: fetchStub, EventSource: FakeES });
  check("client: a refused cookie exchange never opens a stream", FakeES.all.length === 0);
  dash3.restore();
}

if (failures) process.exit(1);
console.log("pilot-stream: all checks passed");
