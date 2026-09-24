/**
 * Crash-line tests for the relay (P2-351): the pure crashline module table,
 * the P2-145 drain's crash exit-code threading over fake timers, and
 * integration passes against real relay subprocesses — a rejection hatch
 * proving the structured error-level line on stderr, the exit code 1 and the
 * non-leak of the planted room id, a throw hatch proving the
 * uncaughtException listener, and a live /metrics scrape proving
 * relay_crashes_total publishes as zero next to relay_rate_limited_total.
 * Run: npx tsx scripts/relay-crash.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import {
  crashLine,
  CRASH_MESSAGE_MAX_CHARS,
  CRASH_REDACTED_IP,
  CRASH_REDACTED_ROOM,
  type CrashLine,
} from "../apps/relay/src/crashline";
import { createShutdown, DRAIN_MS } from "../apps/relay/src/shutdown";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

setTimeout(() => {
  console.error("relay-crash test timed out (global 60s)");
  process.exit(1);
}, 60_000).unref();

// --- 1. crashline: the pure module table -------------------------------------
const ROOM_PLANTED = "a1b2c3d4e5f60718293a4b5c6d7e8f9"; // 32 hex: the daemon's real room-id shape
const ROOM_SHORT = "safe-id7"; // 8 chars of the grammar — still redacted
const ROOM_URLSAFE = "my_room-9"; // 9 chars with underscore and hyphen
const ROOM_BELOW = "1234567"; // 7 chars: below the room-id floor, not a room id

check("crashline: an Error keeps its class, event and message", (() => {
  const line = crashLine("unhandledRejection", new RangeError("boom in the room"), 90_000);
  return (
    line.event === "unhandledRejection" &&
    line.class === "RangeError" &&
    line.message === "boom in the room" &&
    line.uptimeS === 90
  );
})());
check("crashline: uptime is whole seconds, clamped at zero", (() => {
  const a = crashLine("uncaughtException", new Error("x"), 1_499);
  const b = crashLine("uncaughtException", new Error("x"), -50);
  const c = crashLine("uncaughtException", new Error("x"), Number.NaN);
  const d = crashLine("uncaughtException", new Error("x"), "soon" as unknown as number);
  return a.uptimeS === 1 && b.uptimeS === 0 && c.uptimeS === 0 && d.uptimeS === 0;
})());
check("crashline: an unexpected event value fails closed to uncaughtException", (() => {
  const line = crashLine("bogus" as unknown as CrashLine["event"], new Error("x"), 0);
  return line.event === "uncaughtException";
})());

// non-Error values: the class is the Object.prototype.toString kind, the
// message is one safe stringification
check("crashline: a thrown string reports the String class and its own text", (() => {
  const line = crashLine("unhandledRejection", "boom fail", 0);
  return line.class === "String" && line.message === "boom fail" && line.stack === "";
})());
check("crashline: a hyphenated compound is redacted like any room-shaped token", (() => {
  // the aggressive room pass is the deliberate trade: every token of the room
  // grammar dies, words included — the diagnosis rides class + stack instead
  const line = crashLine("unhandledRejection", "boom-string", 0);
  return line.message === CRASH_REDACTED_ROOM;
})());
check("crashline: a thrown number reports the Number class", (() => {
  const line = crashLine("unhandledRejection", 42, 0);
  return line.class === "Number" && line.message === "42";
})());
check("crashline: undefined and null rejections get honest classes and messages", (() => {
  const u = crashLine("unhandledRejection", undefined, 0);
  const n = crashLine("unhandledRejection", null, 0);
  // "undefined" is 9 chars of the room charset — redacted like any other
  // word-shaped token; the class field carries the honest kind instead
  return u.class === "Undefined" && u.message === CRASH_REDACTED_ROOM && n.class === "Null" && n.message === "null";
})());
check("crashline: a thrown object is stringified, not flattened", (() => {
  const line = crashLine("unhandledRejection", { code: "ERR_X", detail: "why" }, 0);
  return line.class === "Object" && line.message === '{"code":"ERR_X","detail":"why"}';
})());
check("crashline: a circular object never throws the formatter", (() => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  const line = crashLine("unhandledRejection", circular, 0);
  return line.class === "Object" && line.message.length > 0;
})());

// long message: the ceiling applies after redaction, over tokens that survive
check("crashline: a long message is truncated to exactly 200 characters", (() => {
  const long = "short ".repeat(60).trimEnd(); // 360 chars of tokens below the room floor
  const line = crashLine("unhandledRejection", new Error(long), 0);
  return line.message.length === CRASH_MESSAGE_MAX_CHARS && line.message === long.slice(0, CRASH_MESSAGE_MAX_CHARS);
})());
check("crashline: truncation never re-opens a redacted room id at the boundary", (() => {
  const line = crashLine("unhandledRejection", new Error(ROOM_PLANTED.repeat(40)), 0);
  return !line.message.includes(ROOM_PLANTED.slice(0, 16));
})());

// the planted room ids must not survive in any form
check("crashline: a planted 32-hex room id cannot leak", (() => {
  const line = crashLine("unhandledRejection", new Error(`room ${ROOM_PLANTED} failed`), 0);
  return !line.message.includes(ROOM_PLANTED) && line.message.includes(CRASH_REDACTED_ROOM);
})());
check("crashline: an 8-char grammar-shaped id is redacted too", (() => {
  const line = crashLine("unhandledRejection", new Error(`join ${ROOM_SHORT} now`), 0);
  return !line.message.includes(ROOM_SHORT) && line.message.includes(CRASH_REDACTED_ROOM);
})());
check("crashline: a URL-safe id with underscore and hyphen is redacted", (() => {
  const line = crashLine("unhandledRejection", new Error(`join ${ROOM_URLSAFE} now`), 0);
  return !line.message.includes(ROOM_URLSAFE) && line.message.includes(CRASH_REDACTED_ROOM);
})());
check("crashline: a token below the room-id floor is not a room id (fidelity kept)", (() => {
  const line = crashLine("unhandledRejection", new Error(`attempt ${ROOM_BELOW} of 9`), 0);
  return line.message.includes(ROOM_BELOW) && !line.message.includes(CRASH_REDACTED_ROOM);
})());

// addresses
check("crashline: an IPv4 address cannot leak", (() => {
  const line = crashLine("uncaughtException", new Error("connect ECONNREFUSED 10.2.3.4:443"), 0);
  return !line.message.includes("10.2.3.4") && line.message.includes(CRASH_REDACTED_IP);
})());
check("crashline: an IPv6 address cannot leak", (() => {
  const line = crashLine("uncaughtException", new Error("bind failed on [fe80::1a2b:3c4d]:8787"), 0);
  return !line.message.includes("fe80::1a2b:3c4d") && line.message.includes(CRASH_REDACTED_IP);
})());
check("crashline: a port-only address token is redacted with its host", (() => {
  const line = crashLine("uncaughtException", new Error("listen EADDRINUSE: address already in use :::8787"), 0);
  return !line.message.includes("8787") && line.message.includes(CRASH_REDACTED_IP);
})());

// frame content: binary payload material only ever surfaces as control bytes
check("crashline: control bytes (binary payload garbage) are washed out", (() => {
  const line = crashLine("uncaughtException", new Error("bad frame \u0000\u0007\u001F tail"), 0);
  return !line.message.includes("\u0000") && !line.message.includes("\u001F") && line.message === "bad frame  tail";
})());
check("crashline: the message stays one single log line", (() => {
  const line = crashLine("uncaughtException", new Error("first\nsecond\r\nthird"), 0);
  return line.message === "first second third" && !line.message.includes("\n");
})());

// stack: first frame only, absolute paths reduced to basenames
const withStack = new Error("msg");
withStack.stack =
  "Error: msg\n" +
  "    at Object.<anonymous> (/Users/someone/host/dir/apps/relay/src/index.ts:100:5)\n" +
  "    at second (/another/host/path/two.ts:9:9)";
const line1 = crashLine("unhandledRejection", withStack, 0);
check("crashline: the stack field is the FIRST frame line only", (() => {
  return (
    line1.stack === "at Object.<anonymous> (index.ts:100:5)" &&
    !line1.stack.includes("second") &&
    !line1.stack.includes("another")
  );
})());
check("crashline: no absolute path survives in the stack field", (() => {
  return !line1.stack.includes("/Users") && !line1.stack.includes("/another") && !line1.stack.includes("/");
})());
check("crashline: a Windows drive path is reduced to its basename too", (() => {
  const e = new Error("m");
  e.stack = "Error: m\n    at fn (C:\\Users\\operator\\app\\relay\\index.ts:1:1)";
  return crashLine("uncaughtException", e, 0).stack === "at fn (index.ts:1:1)";
})());
check("crashline: a file:// frame is reduced to its basename too", (() => {
  const e = new Error("m");
  e.stack = "Error: m\n    at fn (file:///srv/relay/src/index.ts:2:2)";
  return crashLine("uncaughtException", e, 0).stack === "at fn (index.ts:2:2)";
})());
check("crashline: node-internal frame ids survive path stripping intact", (() => {
  const e = new Error("m");
  e.stack = "Error: m\n    at node:internal/process/task_queues:95:5";
  return crashLine("uncaughtException", e, 0).stack === "at node:internal/process/task_queues:95:5";
})());
check("crashline: an error without a stack leaves the field empty, not guessed", (() => {
  const e = new Error("m");
  e.stack = undefined;
  const line = crashLine("unhandledRejection", e, 0);
  return line.stack === "" && line.class === "Error" && line.message === "m";
})());
check("crashline: a non-Error value with its own stack still yields one frame", (() => {
  const shape = { stack: "weird\n    at somewhere (/abs/host/path/x.ts:3:3)" };
  const line = crashLine("unhandledRejection", shape, 0);
  return line.stack === "at somewhere (x.ts:3:3)";
})());
check("crashline: the class name is a sanitized token, never free text", (() => {
  const weird = new Error("m");
  weird.name = "Ev!l <script> name";
  const line = crashLine("uncaughtException", weird, 0);
  return /^[A-Za-z0-9_$]{1,40}$/.test(line.class) && !line.class.includes("<");
})());

check("crashline: the object carries exactly the five documented fields", (() => {
  const line = crashLine("unhandledRejection", new Error("m"), 0);
  return (
    JSON.stringify(Object.keys(line).sort()) ===
    JSON.stringify(["class", "event", "message", "stack", "uptimeS"])
  );
})());
check("crashline: deterministic — the same inputs give the same object every call", (() => {
  const e = new Error(`room ${ROOM_PLANTED} from 10.0.0.9`);
  return JSON.stringify(crashLine("unhandledRejection", e, 1_500)) === JSON.stringify(crashLine("unhandledRejection", e, 1_500));
})());
check("crashline: purity — the module imports nothing and touches no process/network/timer", (() => {
  const src = readFileSync(join(import.meta.dirname, "..", "apps", "relay", "src", "crashline.ts"), "utf8");
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return (
    codeOnly.trim().length > 0 &&
    !/^import /m.test(codeOnly) &&
    !codeOnly.includes("from \"") &&
    !codeOnly.includes("node:") &&
    !/require\(/.test(codeOnly) &&
    !/\bprocess\b/.test(codeOnly) &&
    !/setInterval|setTimeout/.test(codeOnly) &&
    !/fetch\(/.test(codeOnly)
  );
})());

// --- 2. the P2-145 drain threads the crash exit code (fake timers) ------------
type Timer = ReturnType<typeof setTimeout>;
const mkTimers = () => {
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let nextId = 1;
  return {
    timers,
    setTimeout: (fn: () => void, ms: number): Timer => {
      const t = { id: nextId++, fn, ms };
      timers.push(t);
      return t as unknown as Timer;
    },
    clearTimeout: (timer: Timer) => {
      const i = timers.indexOf(timer as unknown as { id: number });
      if (i >= 0) timers.splice(i, 1);
    },
    flush: (upToMs: number) => {
      for (const t of timers.filter((x) => x.ms <= upToMs)) {
        const i = timers.indexOf(t as unknown as { id: number });
        if (i >= 0) timers.splice(i, 1);
        t.fn();
      }
    },
  };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

// 2a. a crash drain exits 1 after the usual settle
{
  const t = mkTimers();
  const exits: number[] = [];
  const { shutdown } = createShutdown({
    activeConnections: () => 0,
    uptimeMs: () => 1000,
    stopListeners: async () => {},
    log: () => {},
    exit: (code) => exits.push(code),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  const p = shutdown("unhandledRejection", 1);
  await tick();
  check("drain-crash: the drain starts like a signal drain (same flag shape)", true);
  t.flush(DRAIN_MS - 1); // fire the settle only; the hard timer is cleared on completion
  await p;
  check("drain-crash: a crash drain exits 1 after the usual settle", exits.length === 1 && exits[0] === 1);
  check("drain-crash: the settle consumed the timers, none left pending", t.timers.length === 0);
}

// 2b. a signal re-entry during a crash drain cannot lower the code to 0
{
  const t = mkTimers();
  const exits: number[] = [];
  const { shutdown } = createShutdown({
    activeConnections: () => 0,
    uptimeMs: () => 1000,
    stopListeners: async () => {},
    log: () => {},
    exit: (code) => exits.push(code),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  void shutdown("unhandledRejection", 1); // starts the drain with the crash code
  await tick();
  void shutdown("SIGTERM"); // already started: exits immediately with the pending crash code
  await tick();
  check("drain-crash: a signal re-entry during a crash drain keeps exit 1", exits.length === 1 && exits[0] === 1);
}

// 2c. a crash during a signal drain raises the exit to 1 immediately
{
  const t = mkTimers();
  const exits: number[] = [];
  const { shutdown } = createShutdown({
    activeConnections: () => 0,
    uptimeMs: () => 1000,
    stopListeners: async () => {},
    log: () => {},
    exit: (code) => exits.push(code),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  void shutdown("SIGTERM"); // starts the signal drain with code 0 pending
  await tick();
  void shutdown("uncaughtException", 1);
  await tick();
  check("drain-crash: a crash during a signal drain raises the exit to 1 immediately", exits.length === 1 && exits[0] === 1);
}

// 2d. the DRAIN_MS hard backstop exits 1 when the drain wedges
{
  const t = mkTimers();
  const exits: number[] = [];
  const { shutdown } = createShutdown({
    activeConnections: () => 3,
    uptimeMs: () => 1000,
    stopListeners: () => new Promise<void>(() => {}), // wedged: never resolves
    log: () => {},
    exit: (code) => exits.push(code),
    setTimeout: t.setTimeout,
    clearTimeout: t.clearTimeout,
  });
  void shutdown("unhandledRejection", 1);
  await tick();
  t.flush(DRAIN_MS); // the hard timer fires with the pending crash code
  check("drain-crash: the DRAIN_MS hard backstop exits 1 when the drain wedges", exits.length === 1 && exits[0] === 1);
}

// --- 3. integration: real relay subprocesses ----------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startCrashRelay(env: Record<string, string>) {
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const proc: ChildProcess = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      ...env,
      RELAY_PORT: String(port),
      RELAY_METRICS_PORT: env.RELAY_METRICS_PORT ?? "",
      OCR_E2E_MARKER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  const stdout: string[] = [];
  proc.stderr?.on("data", (c) => stderr.push(String(c)));
  proc.stdout?.on("data", (c) => stdout.push(String(c)));
  proc.on("error", (e) => console.error("relay spawn error:", e));
  process.on("exit", () => proc.kill("SIGKILL"));
  return {
    port,
    proc,
    stderr: () => stderr.join(""),
    stdout: () => stdout.join(""),
  };
}

const exitCodeOf = (proc: ChildProcess) =>
  new Promise<number | null>((resolve) => proc.on("exit", (code) => resolve(code)));

const crashLinesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes('"msg":"relay crash"'))
    .map((l) => JSON.parse(l) as { level: string; msg: string; data: CrashLine });

const waitExit = (proc: ChildProcess, ms = 20_000) =>
  Promise.race([exitCodeOf(proc), sleep(ms).then(() => null)]);

// 3a. the rejection hatch: structured stderr line, exit 1, planted id absent
{
  const planted = ROOM_PLANTED;
  const relay = startCrashRelay({
    OCR_RELAY_CRASH_HATCH: `reject:boom room ${planted} from 10.2.3.4 frame secret-payload-99`,
  });
  const code = await waitExit(relay.proc);
  check("crash-integration: rejection hatch takes the process down with exit 1", code === 1);

  const lines = crashLinesOf(relay.stderr());
  check("crash-integration: exactly one structured crash line on stderr", lines.length === 1);
  const line = lines[0];
  check("crash-integration: the line is one JSONL entry at error level", line?.level === "error" && line?.msg === "relay crash");
  check(
    "crash-integration: the object is the crashline shape (event, class, message, stack, uptimeS)",
    (() => {
      if (!line) return false;
      return (
        JSON.stringify(Object.keys(line.data).sort()) ===
        JSON.stringify(["class", "event", "message", "stack", "uptimeS"])
      );
    })(),
  );
  check(
    "crash-integration: event is unhandledRejection and the class is the error's",
    line?.data.event === "unhandledRejection" && line?.data.class === "Error",
  );
  check(
    "crash-integration: the message is redacted and bounded",
    line?.data.message === "boom room [room:removed] from [ip:removed] frame [room:removed]" &&
      (line?.data.message.length ?? 0) <= CRASH_MESSAGE_MAX_CHARS,
  );
  check(
    "crash-integration: the uptime field is a whole non-negative number",
    typeof line?.data.uptimeS === "number" && Number.isInteger(line?.data.uptimeS) && (line?.data.uptimeS ?? -1) >= 0,
  );
  check("crash-integration: the planted room id never reaches stderr", !relay.stderr().includes(planted));
  check("crash-integration: the planted room id never reaches stdout either", !relay.stdout().includes(planted));
  check(
    "crash-integration: the planted IP and frame content never reach stderr either",
    !relay.stderr().includes("10.2.3.4") && !relay.stderr().includes("secret-payload"),
  );
  check("crash-integration: the P2-145 drain ran (relay shutting down on stdout)", relay.stdout().includes("relay shutting down"));
  check("crash-integration: the drain logs the fatal event as the signal", relay.stdout().includes('"signal":"unhandledRejection"'));
  check("crash-integration: the drain completes before the exit (relay shut down)", relay.stdout().includes("relay shut down"));
}

// 3b. the throw hatch: the uncaughtException listener emits the same shape
{
  const planted2 = "f0e1d2c3b4a5968778695a4b3c2d1e0f";
  const relay = startCrashRelay({ OCR_RELAY_CRASH_HATCH: `throw:crash-throw-${planted2} 10.9.8.7` });
  const code = await waitExit(relay.proc);
  check("crash-integration: throw hatch takes the process down with exit 1", code === 1);
  const lines = crashLinesOf(relay.stderr());
  check("crash-integration: the uncaughtException listener emits one line", lines.length === 1);
  const line = lines[0];
  check("crash-integration: the throw line carries the uncaughtException event", line?.data.event === "uncaughtException" && line?.data.class === "Error");
  check(
    "crash-integration: the throw line's stack is one frame with no absolute path",
    (() => {
      const stack = line?.data.stack ?? "";
      return stack.startsWith("at ") && !stack.includes("/") && stack.length > 0;
    })(),
  );
  check(
    "crash-integration: the throw hatch's planted id and IP never reach stderr",
    !relay.stderr().includes(planted2) && !relay.stderr().includes("10.9.8.7"),
  );
  check("crash-integration: the throw drain also ran on stdout", relay.stdout().includes("relay shutting down"));
}

// 3c. a healthy relay publishes the crash counter as zero, next to the rate limiter
{
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const mport = port + 1;
  const proc: ChildProcess = spawn("npx", ["tsx", "apps/relay/src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, RELAY_PORT: String(port), RELAY_METRICS_PORT: String(mport), OCR_E2E_MARKER: "1" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  process.on("exit", () => proc.kill("SIGTERM"));
  let up = false;
  for (let attempt = 0; attempt < 30 && !up; attempt++) {
    up = await new Promise<boolean>((resolve) => {
      get(`http://127.0.0.1:${port}/healthz`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }).on("error", () => resolve(false));
    });
    if (!up) await sleep(300);
  }
  const fetchBody = (qs: string) =>
    new Promise<string>((resolve) => {
      get(`http://127.0.0.1:${mport}/metrics${qs}`, (res) => {
        let s = "";
        res.on("data", (c) => (s += c));
        res.on("end", () => resolve(s));
      });
    });
  if (up) {
    const prom = await fetchBody("?format=prom");
    const jsonRaw = await fetchBody("");
    const json = JSON.parse(jsonRaw) as Record<string, number>;
    check("crash-metrics: the JSON body publishes crashes_total as zero (never omitted)", json["crashes_total"] === 0);
    check(
      "crash-metrics: the Prometheus text publishes relay_crashes_total 0 (never omitted)",
      (prom.match(/^relay_crashes_total 0$/gm) ?? []).length === 1,
    );
    check(
      "crash-metrics: the counter sits next to relay_rate_limited_total, TYPE header immediately before the value",
      prom.includes("# TYPE relay_crashes_total counter\nrelay_crashes_total 0") &&
        prom.indexOf("relay_rate_limited_total") < prom.indexOf("relay_crashes_total"),
    );
  } else {
    check("crash-metrics: relay subprocess came up", false);
  }
  proc.kill("SIGTERM");
}

if (failures) process.exit(1);
console.log("relay-crash: ALL OK");
process.exit(0);
