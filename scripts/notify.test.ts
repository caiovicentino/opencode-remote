/**
 * P3-357 — supervisor notify eval: fake transport that fails then accepts.
 * The pending queue must drain with no duplicates, failures must carry the
 * real reason into the pilot log + the shared audit trail, repeated refusals
 * must fire one "needs operator" push digest per episode, and entries older
 * than the 24h TTL must expire instead of replaying.
 * Run: npx tsx scripts/notify.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NOTIFY_DIGEST_THRESHOLD,
  NOTIFY_PENDING_MAX,
  NOTIFY_PENDING_TTL_MS,
  flushPending,
  notifySupervisor,
  type NotifyDeps,
  type NotifyTransport,
} from "../apps/pilot/src/notify";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

interface Sent { body: string }
function transportOf(behavior: "deliver" | "delivered-false" | "http-503" | "socket" | "timeout"): {
  transport: NotifyTransport;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const transport: NotifyTransport = async (_url, init) => {
    sent.push({ body: init.body });
    if (behavior === "http-503") return { ok: false, status: 503, json: async () => ({}) };
    if (behavior === "socket") throw new Error("connect ECONNREFUSED 127.0.0.1:8792");
    if (behavior === "timeout") {
      // Node's AbortSignal.timeout rejects with a TimeoutError DOMException
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ delivered: behavior === "deliver" }),
    };
  };
  return { transport, sent };
}

function mkDir(configured: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "notify-test-"));
  if (configured) {
    writeFileSync(join(dir, "pilot.json"), JSON.stringify({ supervisorSession: "ses_test" }));
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({ apiToken: "tok" }));
  }
  return dir;
}

interface LogLine { level: string; msg: string; data?: unknown }
function depsFor(dir: string, transport: NotifyTransport, opts: Partial<NotifyDeps> = {}): {
  deps: NotifyDeps;
  logs: LogLine[];
  pushes: Array<{ title: string; body: string }>;
} {
  const logs: LogLine[] = [];
  const pushes: Array<{ title: string; body: string }> = [];
  return {
    deps: {
      dir,
      transport,
      logFn: (level: string, msg: string, data?: unknown) => {
        logs.push({ level, msg, data });
      },
      push: async (title: string, body: string) => {
        pushes.push({ title, body });
        return true;
      },
      ...opts,
    },
    logs,
    pushes,
  };
}

function auditEvents(dir: string): Array<{ event: string; data: { task: string; ok: boolean; reason?: string } }> {
  try {
    return readFileSync(join(dir, "audit.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function pendingLines(dir: string): string[] {
  try {
    return readFileSync(join(dir, "pilot", "notify-pending.jsonl"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ── 1. unconfigured state: calm warn, nothing parked, nothing audited ──────
{
  const dir = mkDir(false);
  const { transport } = transportOf("socket");
  const { deps, logs } = depsFor(dir, transport);
  const ok = await notifySupervisor("T0", true, "hello", deps);
  check("unconfigured returns false", ok === false);
  check("unconfigured logs warn with the real reason", logs.some((l) => l.level === "warn" && /no supervisorSession/.test(String((l.data as { reason?: string })?.reason))));
  check("unconfigured parks nothing", !existsSync(join(dir, "pilot", "notify-pending.jsonl")));
  check("unconfigured writes no audit line", auditEvents(dir).length === 0);
}

// ── 2. fail → accept: pending drains, no duplicates ────────────────────────
{
  const dir = mkDir(true);
  const fail = transportOf("http-503");
  const failDeps = depsFor(dir, fail.transport);
  const first = await notifySupervisor("P3-357", false, "merge failed", failDeps.deps);
  check("failing transport returns false", first === false);
  check("failure logs warn with HTTP status", failDeps.logs.some((l) => l.level === "warn" && /HTTP 503/.test(String((l.data as { reason?: string })?.reason ?? ""))));
  check("failure parks exactly one entry", pendingLines(dir).length === 1);
  check("failure audits pilot-notify ok:false", auditEvents(dir).some((e) => e.event === "pilot-notify" && e.data.ok === false && e.data.task === "P3-357"));
  check("no notify-last stamp on failure", !existsSync(join(dir, "pilot", "notify-last")));

  const accept = transportOf("deliver");
  const acceptDeps = depsFor(dir, accept.transport);
  const second = await notifySupervisor("P3-358", true, "merged", acceptDeps.deps);
  check("accepting transport returns true", second === true);
  const texts = accept.sent.map((s) => JSON.parse(s.body).text as string);
  check("backlog replayed before the fresh message", texts.length === 2 && texts[0].includes("P3-357") && texts[1].includes("P3-358"));
  check("pending queue drained", pendingLines(dir).length === 0);
  check("notify-last stamped on delivery", existsSync(join(dir, "pilot", "notify-last")));
  check("drain logged as info", acceptDeps.logs.some((l) => l.level === "info" && l.msg === "supervisor notify backlog drained"));
  check("delivery audited ok:true", auditEvents(dir).some((e) => e.event === "pilot-notify" && e.data.ok === true));

  const third = transportOf("deliver");
  const thirdDeps = depsFor(dir, third.transport);
  await notifySupervisor("P3-359", true, "again", thirdDeps.deps);
  check("no duplicate replay after drain", third.sent.length === 1 && JSON.parse(third.sent[0].body).text.includes("P3-359"));
  check("queue stays empty", pendingLines(dir).length === 0);
}

// ── 3. daemon 200 with delivered=false is a failure (the old blind spot) ───
{
  const dir = mkDir(true);
  const { transport, sent } = transportOf("delivered-false");
  const { deps } = depsFor(dir, transport);
  const ok = await notifySupervisor("P3-360", true, "stale session", deps);
  check("delivered=false returns false", ok === false);
  check("delivered=false parks the message", pendingLines(dir).length === 1 && sent.length === 1);
}

// ── 3b. timeout = outcome unknown: warn + audit, but NO queue (no dupes) ───
{
  const dir = mkDir(true);
  const { transport } = transportOf("timeout");
  const { deps, logs } = depsFor(dir, transport);
  const ok = await notifySupervisor("SLOW", true, "long opencode turn", deps);
  check("timeout returns false", ok === false);
  check("timeout logs warn with the unknown-outcome reason", logs.some((l) => l.level === "warn" && /outcome unknown/.test(String((l.data as { reason?: string })?.reason ?? ""))));
  check("timeout does not park (replay would duplicate)", pendingLines(dir).length === 0);
  check("timeout still audits the attempt", auditEvents(dir).some((e) => e.event === "pilot-notify" && e.data.task === "SLOW" && e.data.ok === false));
}

// ── 4. 24h TTL: stale entries expire instead of replaying ──────────────────
{
  const dir = mkDir(true);
  mkdirSync(join(dir, "pilot"), { recursive: true });
  const stale = { ts: Date.now() - NOTIFY_PENDING_TTL_MS - 60_000, task: "OLD", ok: false, text: "stale message" };
  writeFileSync(join(dir, "pilot", "notify-pending.jsonl"), JSON.stringify(stale) + "\n");
  const { transport, sent } = transportOf("deliver");
  const { deps } = depsFor(dir, transport);
  const drained = await flushPending({ session: "ses_test", token: "tok" }, transport, deps);
  check("stale entry is not replayed", drained === 0 && sent.length === 0);
  check("stale entry is dropped from the queue", pendingLines(dir).length === 0);
}

// ── 5. repeated refusal → one "needs operator" push digest per episode ──
{
  const dir = mkDir(true);
  const { transport } = transportOf("socket");
  const { deps, pushes } = depsFor(dir, transport);
  for (let i = 0; i < NOTIFY_DIGEST_THRESHOLD + 1; i++) {
    await notifySupervisor(`FAIL-${i}`, false, "daemon down", deps);
  }
  check(`push digest fires once at the ${NOTIFY_DIGEST_THRESHOLD}th refusal`, pushes.length === 1, `pushes=${pushes.length}`);
  check("digest copy carries needs operator + the parked warnings", pushes.length === 1 && pushes[0].body.includes("needs operator") && pushes[0].body.includes("FAIL-0") && pushes[0].body.includes("FAIL-2"));
  // drained episode resets: a fresh run of failures may push again
  const heal = transportOf("deliver");
  const healDeps = depsFor(dir, heal.transport);
  await notifySupervisor("HEAL", true, "back", healDeps.deps);
  check("recovery drains the refusals", pendingLines(dir).length === 0 && pushes.length === 1);
}

// ── 6. cap: the pending file never exceeds NOTIFY_PENDING_MAX lines ────────
{
  const dir = mkDir(true);
  const { transport } = transportOf("http-503");
  const { deps } = depsFor(dir, transport);
  for (let i = 0; i < NOTIFY_PENDING_MAX + 5; i++) {
    await notifySupervisor(`CAP-${String(i).padStart(3, "0")}`, false, "overflow", deps);
  }
  const lines = pendingLines(dir);
  check("pending file capped at NOTIFY_PENDING_MAX lines", lines.length === NOTIFY_PENDING_MAX, `lines=${lines.length}`);
  check("oldest entries dropped first", lines.length === NOTIFY_PENDING_MAX && JSON.parse(lines[0]).task === "CAP-005" && JSON.parse(lines[lines.length - 1]).task === "CAP-104");
}

// ── 7. a park landing mid-flush survives the flush's rewrite ───────────────
{
  const dir = mkDir(true);
  let resolveSlow: () => void = () => {};
  const slowGate = new Promise<void>((r) => {
    resolveSlow = r;
  });
  const slowSends: string[] = [];
  const transport: NotifyTransport = async (_url, init) => {
    const body = JSON.parse(init.body) as { text: string };
    if (body.text.includes("SLOW-ENTRY")) {
      slowSends.push(body.text);
      await slowGate;
      return { ok: true, status: 200, json: async () => ({ delivered: true }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  mkdirSync(join(dir, "pilot"), { recursive: true });
  writeFileSync(
    join(dir, "pilot", "notify-pending.jsonl"),
    JSON.stringify({ ts: Date.now(), task: "SLOW", ok: false, text: "SLOW-ENTRY body" }) + "\n",
  );
  const { deps } = depsFor(dir, transport);
  const flushing = flushPending({ session: "ses_test", token: "tok" }, transport, deps);
  const parking = notifySupervisor("NEW-TASK", false, "parked during flush", deps);
  await new Promise((r) => setTimeout(r, 30));
  resolveSlow();
  await flushing;
  await parking;
  const lines = pendingLines(dir);
  check("park-during-flush survives the rewrite", lines.length === 1 && lines[0].includes("NEW-TASK"), `lines=${JSON.stringify(lines)}`);
  check("slow entry delivered exactly once", slowSends.length === 1, `sends=${slowSends.length}`);
}

// ── 8. concurrent flushes serialize: each entry delivered once ─────────────
{
  const dir = mkDir(true);
  let resolveGate: () => void = () => {};
  const gate = new Promise<void>((r) => {
    resolveGate = r;
  });
  const sends: string[] = [];
  const transport: NotifyTransport = async (_url, init) => {
    const body = JSON.parse(init.body) as { text: string };
    sends.push(body.text);
    if (sends.length === 1) await gate;
    return { ok: true, status: 200, json: async () => ({ delivered: true }) };
  };
  mkdirSync(join(dir, "pilot"), { recursive: true });
  writeFileSync(
    join(dir, "pilot", "notify-pending.jsonl"),
    JSON.stringify({ ts: Date.now(), task: "DUP", ok: false, text: "dup-entry" }) + "\n",
  );
  const f1 = flushPending({ session: "ses_test", token: "tok" }, transport, depsFor(dir, transport).deps);
  const f2 = flushPending({ session: "ses_test", token: "tok" }, transport, depsFor(dir, transport).deps);
  await new Promise((r) => setTimeout(r, 30));
  resolveGate();
  await f1;
  await f2;
  check("concurrent flushes deliver each entry once", sends.filter((s) => s === "dup-entry").length === 1, `sends=${sends.length}`);
  check("queue empty after both flushes", pendingLines(dir).length === 0);
}

// ── 9. corrupt config: the warn carries the real parse reason ──────────────
{
  const dir = mkDir(true);
  writeFileSync(join(dir, "pilot.json"), "{corrupt");
  const { transport } = transportOf("deliver");
  const { deps, logs } = depsFor(dir, transport);
  const ok = await notifySupervisor("CORRUPT", true, "x", deps);
  check("corrupt config returns false", ok === false);
  check("corrupt config reports the parse failure, not a missing field", logs.some((l) => l.level === "warn" && /pilot\.json unparseable/.test(String((l.data as { reason?: string })?.reason ?? ""))));
  check("corrupt config parks nothing", !existsSync(join(dir, "pilot", "notify-pending.jsonl")));
}

if (failures) process.exit(1);
console.log("notify: all checks passed");