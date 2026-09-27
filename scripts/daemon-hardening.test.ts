/**
 * eval-12 — daemon robustness battery. Every block is a regression for a
 * failure measured on main (d046075) or in the production logs:
 *
 * 1. stdio guard (stdioguard.ts + log.ts): prod daemon.err.log 2026-09-08T03:40Z
 *    — a full disk made one log line kill the daemon ("Unhandled 'error'
 *    event" from the file-backed SyncWriteStream). Child processes reproduce
 *    the same write failure on a real SyncWriteStream (fd closed under it) and
 *    on a pipe whose reader is gone (EPIPE), with and without the guard.
 * 2. AutoMode (automode.ts): pure rules + web-literal parity pins.
 * 3. A REAL hermetic daemon (temp HOME, ephemeral port, dead relay, fake
 *    opencode): /healthz, a malformed request line (`GET //[` crashed the
 *    daemon — exit 1), a corrupt state file under a Bearer route (500, not a
 *    crash), the AutoMode failure push/replay/reply/404 paths over a real E2E
 *    session on the local WS, both stdio pipes torn down, and a second boot
 *    on a read-only state dir (the unconditional identity rewrite made every
 *    boot on a full disk die with "fatal ENOSPC").
 *
 * Run: npx tsx scripts/daemon-hardening.test.ts
 */
// #1409 convention: a throwaway HOME before any app module computes paths
// (the daemons below get their own explicit HOME on top of it).
import "./testhome";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { b64, clientHello, newIdentity, openSealed, seal, seqAad, type OpResponse } from "@ocr/protocol";

import {
  AUTO_APPROVE_FAILED_EVENT,
  AUTO_APPROVED_EVENT,
  AUTO_FAIL_LEDGER_MAX,
  AUTO_FAIL_TTL_MS,
  AutoFailLedger,
  approveAttemptVerdict,
  autoFailPush,
  notFoundOutcome,
  permissionEventFacts,
} from "../apps/daemon/src/automode";
import { installStdioGuard } from "../apps/daemon/src/stdioguard";
import { crashSummary } from "../apps/daemon/src/crashsummary";
import { MAX_ARTIFACT_BYTES, listArtifacts, readArtifact } from "../apps/daemon/src/artifacts";
import { createShutdown } from "../apps/daemon/src/shutdown";
import { HELLO_MAX_SKEW_MS, HelloSeen, helloFreshness } from "../apps/daemon/src/helloguard";

setTimeout(() => {
  console.error("daemon-hardening test timed out (global 150s)");
  process.exit(1);
}, 150_000).unref();

const REPO = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── 1. stdio guard — pure ──────────────────────────────────────────────────
{
  const out = new EventEmitter();
  const err = new EventEmitter();
  const seen: string[] = [];
  const state = installStdioGuard({ stdout: out, stderr: err }, (name, code) => {
    seen.push(`${name}:${code}`);
    throw new Error("observer bug"); // must be swallowed
  });
  let threw = false;
  try {
    out.emit("error", Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    err.emit("error", Object.assign(new Error("reader gone"), { code: "EPIPE" }));
    err.emit("error", "not an error object");
  } catch {
    threw = true;
  }
  check("stdio guard: an 'error' event on a guarded stream never throws", !threw);
  check("stdio guard: every absorbed error is counted", state.errors === 3, JSON.stringify(state));
  check("stdio guard: errno code and stream of the latest error kept", state.lastCode === null && state.lastStream === "stderr");
  check("stdio guard: observer sees stream + code (its own throw swallowed)", seen.join(",") === "stdout:ENOSPC,stderr:EPIPE,stderr:null");
  const again = installStdioGuard({ stdout: out, stderr: err });
  check("stdio guard: re-install is idempotent (same state, one listener)", again === state && out.listenerCount("error") === 1 && err.listenerCount("error") === 1);
  const unguarded = new EventEmitter();
  let rawThrow = false;
  try {
    unguarded.emit("error", new Error("x"));
  } catch {
    rawThrow = true;
  }
  check("premise: an unguarded emitter throws on 'error' (what killed the daemon)", rawThrow);
}

// ─── 1b. stdio guard — real streams in child processes ──────────────────────
const scratch = mkdtempSync(join(tmpdir(), "ocr-eval12-"));
const LOG_TS = join(REPO, "apps", "daemon", "src", "log.ts");

function runChild(
  code: string,
  stdout: "pipe" | number,
  onSpawn?: (child: ChildProcess) => void,
): Promise<{ code: number | null; stderr: string }> {
  const file = join(scratch, `child-${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(file, code);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], {
      cwd: REPO,
      env: { ...process.env, OCR_LOG_LEVEL: "info" },
      stdio: ["ignore", stdout, "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += c));
    onSpawn?.(child);
    const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, stderr });
    });
  });
}

if (!WIN) {
  // SyncWriteStream (file-backed stdout — launchd's StandardOutPath): closing
  // the descriptor under it makes the next write fail exactly like ENOSPC did.
  const fileOut = () => openSync(join(scratch, `out-${Math.random().toString(36).slice(2)}.log`), "a");
  const bare = await runChild(
    `import { closeSync } from "node:fs";
closeSync(1);
console.log("line after the descriptor died");
setTimeout(() => process.stderr.write("SURVIVED\\n"), 300);`,
    fileOut(),
  );
  check(
    "premise: a failed SyncWriteStream write kills an unguarded process",
    bare.code !== 0 && !bare.stderr.includes("SURVIVED") && /Unhandled 'error' event|EBADF/.test(bare.stderr),
    `code=${bare.code} stderr=${bare.stderr.slice(0, 300)}`,
  );
  const guarded = await runChild(
    `import { closeSync } from "node:fs";
import * as L from ${JSON.stringify(LOG_TS)};
closeSync(1);
L.log("info", "first line after the descriptor died");
L.log("info", "second line");
setTimeout(() => process.stderr.write("SURVIVED errors=" + ((L as any).stdioGuard?.errors ?? 0) + "\\n"), 300);`,
    fileOut(),
  );
  check(
    "stdio guard: the daemon's log.ts survives a failed file-backed stdout write",
    guarded.code === 0 && /SURVIVED errors=[1-9]/.test(guarded.stderr),
    `code=${guarded.code} stderr=${guarded.stderr.slice(0, 300)}`,
  );

  // log.ts fallback: once the stream is destroyed the line goes to the fd.
  const outPath = join(scratch, "fallback.log");
  const fd = openSync(outPath, "a");
  const fallback = await runChild(
    `import { log } from ${JSON.stringify(LOG_TS)};
process.stdout.destroy();
log("info", "AFTER-DESTROY-MARKER");`,
    fd,
  );
  closeSync(fd);
  check(
    "log.ts: a destroyed stdout no longer swallows lines (fd fallback)",
    fallback.code === 0 && readFileSync(outPath, "utf8").includes("AFTER-DESTROY-MARKER"),
    `code=${fallback.code} file=${readFileSync(outPath, "utf8").slice(0, 200)}`,
  );

  // Pipe whose reader went away (EPIPE) — the desktop sidecar's stdout.
  const epipeLoop = (useLog: boolean) => `${useLog ? `import * as L from ${JSON.stringify(LOG_TS)};` : ""}
for (let i = 0; i < 120; i++) {
  ${useLog ? `L.log("info", "x".repeat(2000));` : `console.log("x".repeat(2000));`}
  await new Promise((r) => setTimeout(r, 5));
}
process.stderr.write("SURVIVED${useLog ? ` errors=" + ((L as any).stdioGuard?.errors ?? 0) + "` : ""}\\n");`;
  const destroyOnFirstChunk = (child: ChildProcess) => child.stdout!.once("data", () => child.stdout!.destroy());
  const bareEpipe = await runChild(epipeLoop(false), "pipe", destroyOnFirstChunk);
  check(
    "premise: EPIPE on a pipe-backed stdout kills an unguarded process",
    bareEpipe.code !== 0 && !bareEpipe.stderr.includes("SURVIVED"),
    `code=${bareEpipe.code} stderr=${bareEpipe.stderr.slice(0, 300)}`,
  );
  const guardedEpipe = await runChild(epipeLoop(true), "pipe", destroyOnFirstChunk);
  check(
    "stdio guard: the daemon's log.ts survives EPIPE on stdout",
    guardedEpipe.code === 0 && /SURVIVED errors=[1-9]/.test(guardedEpipe.stderr),
    `code=${guardedEpipe.code} stderr=${guardedEpipe.stderr.slice(0, 300)}`,
  );
} else {
  console.log("OK  stdio child-process checks (skipped on Windows: POSIX descriptors)");
}

// ─── 1c. fatal process events: one structured line, drain, exit 1 ──────────
{
  const boom = new Error("apiToken SECRET-SHOULD-NOT-LEAK");
  boom.stack = "Error: apiToken SECRET-SHOULD-NOT-LEAK\n    at handleApi (/Volumes/SSD Major/Major/x/apps/daemon/src/index.ts:4402:7)\n    at next (/y/z.ts:1:1)";
  const s1 = crashSummary("uncaughtException", boom);
  check("crash summary: name + first frame, directories (with spaces) stripped", s1.error === "Error" && s1.frame === "at handleApi (index.ts:4402:7)", JSON.stringify(s1));
  check("crash summary: the message never travels", !JSON.stringify(s1).includes("SECRET"));
  const bare = Object.assign(new TypeError("x"), { stack: "TypeError: x\n    at /Users/a b/c/index.ts:1:2" });
  check("crash summary: frame without a function name", crashSummary("unhandledRejection", bare).frame === "at index.ts:1:2");
  const fileUrl = Object.assign(new RangeError("x"), { stack: "RangeError: x\n    at file:///Users/q/index.ts:3:4" });
  check("crash summary: file:// frames too", crashSummary("uncaughtException", fileUrl).frame === "at index.ts:3:4" && crashSummary("uncaughtException", fileUrl).error === "RangeError");
  check("crash summary: non-errors keep only their kind", JSON.stringify(crashSummary("unhandledRejection", "raw text")) === JSON.stringify({ event: "unhandledRejection", error: "string", frame: "" }) && crashSummary("unhandledRejection", null).error === "null");
  const hostile = { get stack(): string { throw new Error("getter"); } };
  check("crash summary: total on a throwing stack getter", crashSummary("uncaughtException", hostile).error === "unknown");
  check("crash summary: event normalized", crashSummary("bogus" as never, new Error("x")).event === "uncaughtException");

  const exits: number[] = [];
  const { shutdown } = createShutdown({
    activeConnections: () => 0,
    uptimeMs: () => 0,
    stopListeners: async () => {},
    exit: (code) => exits.push(code),
    setTimeout,
    clearTimeout,
  });
  await shutdown("uncaughtException", 1);
  await shutdown("unhandledRejection", 1);
  check("shutdown: the crash drain exits 1 (a 0 reads as a deliberate stop)", exits.join() === "1,1", exits.join());
  const plain: number[] = [];
  await createShutdown({ activeConnections: () => 0, uptimeMs: () => 0, stopListeners: async () => {}, exit: (c) => plain.push(c), setTimeout, clearTimeout }).shutdown("SIGTERM");
  check("shutdown: SIGTERM keeps exit 0", plain.join() === "0");
  const idx = readFileSync(join(REPO, "apps/daemon/src/index.ts"), "utf8");
  check(
    "pin: index.ts routes both fatal events through crashSummary + shutdown(…, 1)",
    idx.includes('crashSummary("uncaughtException", err)') && idx.includes('void shutdown("uncaughtException", 1);') && idx.includes('crashSummary("unhandledRejection", reason)') && idx.includes('void shutdown("unhandledRejection", 1);'),
  );
}

// ─── 1d. artifacts: a symlinked session DIRECTORY must not escape the root ──
if (!WIN) {
  const aroot = join(scratch, "artifacts");
  const outside = join(scratch, "outside");
  mkdirSync(join(aroot, "ses_ok"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(aroot, "ses_ok", "report.md"), "# ok");
  writeFileSync(join(outside, "id_rsa.txt"), "PRIVATE KEY MATERIAL");
  symlinkSync(outside, join(aroot, "ses_evil"));
  const listed = listArtifacts(undefined, aroot).map((a) => `${a.sessionId}/${a.name}`);
  check("artifacts: a symlinked session dir is not listed (main listed ses_evil/id_rsa.txt)", listed.join() === "ses_ok/report.md", listed.join());
  const escaped = readArtifact("ses_evil", "id_rsa.txt", aroot);
  check("artifacts: reading through a symlinked session dir is refused (main served it)", !escaped.ok && escaped.reason === "invalid");
  const fine = readArtifact("ses_ok", "report.md", aroot);
  check("artifacts: a regular artifact still reads byte-exact", fine.ok && fine.data.toString() === "# ok");
  writeFileSync(join(aroot, "ses_ok", "big.bin"), Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 1));
  const big = readArtifact("ses_ok", "big.bin", aroot);
  check("artifacts: the 5MB cap still answers too-large", !big.ok && big.reason === "too-large");
} else {
  console.log("OK  artifact symlink checks (skipped on Windows: symlinks need admin)");
}

// ─── 1e. hello nonce retention covers the token's whole freshness window ───
// (routed from eval-14) A token stamped by a client clock δ ahead stays fresh
// until ts + skew, but its nonce used to expire skew after ADMISSION — the
// identical hello was accepted again inside (t0 + skew, t0 + skew + δ].
{
  const t0 = 1_800_000_000_000;
  const ahead = t0 + 4 * 60_000; // client clock 4 min ahead
  const seen = new HelloSeen();
  check("nonce retention: first hello is new", seen.admit("n-ahead", t0, HELLO_MAX_SKEW_MS, ahead) === "new");
  check("nonce retention: replay inside the daemon window is refused", seen.admit("n-ahead", t0 + 60_000, HELLO_MAX_SKEW_MS, ahead) === "replay");
  const late = t0 + HELLO_MAX_SKEW_MS + 1_000;
  check(
    "nonce retention: a replay after skew but while the token is still fresh is refused (main: accepted)",
    helloFreshness(ahead, late) === "fresh" && seen.admit("n-ahead", late, HELLO_MAX_SKEW_MS, ahead) === "replay",
  );
  const over = ahead + HELLO_MAX_SKEW_MS + 1;
  check("nonce retention: ends once the token can no longer be fresh", helloFreshness(ahead, over) === "stale" && seen.admit("n-ahead", over, HELLO_MAX_SKEW_MS, ahead) === "new");
  const behind = new HelloSeen();
  behind.admit("n-behind", t0, HELLO_MAX_SKEW_MS, t0 - 4 * 60_000);
  check("nonce retention: a past ts never shortens the daemon-clock window", behind.admit("n-behind", t0 + HELLO_MAX_SKEW_MS - 1, HELLO_MAX_SKEW_MS, t0 - 4 * 60_000) === "replay");
  const legacy = new HelloSeen();
  legacy.admit("n-legacy", t0);
  check("nonce retention: calls without ts keep the old window", legacy.admit("n-legacy", t0 + HELLO_MAX_SKEW_MS + 1) === "new");
  const idx = readFileSync(join(REPO, "apps/daemon/src/index.ts"), "utf8");
  check("pin: the handshake passes the token ts to the nonce cache", idx.includes("helloSeen.admit(helloNonce, Date.now(), HELLO_MAX_SKEW_MS, accepted.ts)"));
}

// ─── 2. AutoMode — pure rules ───────────────────────────────────────────────
{
  const asked = permissionEventFacts("permission.asked", {
    id: "per_1",
    sessionID: "ses_1",
    permission: "bash",
    patterns: ["ls"],
    metadata: {},
    always: [],
  });
  check("facts: opencode 1.18 permission.asked is an ask labeled by `permission`", asked.kind === "ask" && asked.permissionID === "per_1" && asked.sessionID === "ses_1" && asked.label === "bash");
  const legacy = permissionEventFacts("permission.updated", { id: "per_2", sessionID: "ses_1", type: "edit" });
  check("facts: legacy permission.updated stays an ask labeled by `type`", legacy.kind === "ask" && legacy.permissionID === "per_2" && legacy.label === "edit");
  const replied = permissionEventFacts("permission.replied", { sessionID: "ses_1", requestID: "per_1", reply: "once" });
  check("facts: permission.replied is a REPLY carrying requestID (was pushed as an ask)", replied.kind === "reply" && replied.permissionID === "per_1");
  check("facts: response/revoke spellings are replies too", permissionEventFacts("permission.response", { permissionID: "p" }).kind === "reply" && permissionEventFacts("Permission.Revoked", {}).kind === "reply");
  check("facts: non-permission events are other", permissionEventFacts("session.idle", { sessionID: "s" }).kind === "other" && permissionEventFacts(42, null).kind === "other");
  check("facts: a free-text tool name never reaches the push line", permissionEventFacts("permission.asked", { id: "p", permission: "rm -rf / && curl evil" }).label === "action");
  check("facts: an ask without id keeps kind ask (manual push still fires)", permissionEventFacts("permission.asked", { sessionID: "s" }).kind === "ask");

  check("attempt: 2xx approved", approveAttemptVerdict(200) === "approved" && approveAttemptVerdict(204) === "approved");
  check("attempt: 404 is not-found (never blindly retried)", approveAttemptVerdict(404) === "not-found");
  check("attempt: 5xx / network error / NaN retry", approveAttemptVerdict(500) === "retry" && approveAttemptVerdict(null) === "retry" && approveAttemptVerdict(Number.NaN) === "retry");

  check("404 outcome: unreadable pending list fails closed", notFoundOutcome(null, "p") === "failed" && notFoundOutcome({}, "p") === "failed");
  check("404 outcome: still listed → failed (approve route broken)", notFoundOutcome([{ id: "p" }], "p") === "failed");
  check("404 outcome: gone from the list → resolved elsewhere", notFoundOutcome([{ id: "other" }, null, 3], "p") === "resolved-elsewhere");

  const push = autoFailPush("bash", "Mac");
  check("push copy names the tool and the machine", push.title === "AutoMode couldn't approve" && push.body.includes("bash") && push.body.includes("Mac"));
  check("push copy without a tool says an action", autoFailPush("action", "Mac").body.startsWith("an action"));

  const ledger = new AutoFailLedger(3, 1_000);
  const e = (id: string, at: number) => ({ sessionID: "s", permissionID: id, action: "bash", error: "HTTP 500", at });
  ledger.record(e("a", 0));
  ledger.record(e("b", 10));
  ledger.record(e("c", 20));
  ledger.record(e("d", 30));
  check("ledger: capped, oldest evicted", ledger.live(40).map((x) => x.permissionID).join() === "b,c,d");
  ledger.record(e("b", 50));
  check("ledger: re-record moves to the end", ledger.live(60).map((x) => x.permissionID).join() === "c,d,b");
  check("ledger: clear reports what it held", ledger.clear("c") && !ledger.clear("zz"));
  ledger.retainPending("not a list");
  check("ledger: unreadable pending list keeps everything", ledger.size === 2);
  ledger.retainPending([{ id: "b" }]);
  check("ledger: answered-while-away asks are dropped", ledger.live(60).map((x) => x.permissionID).join() === "b");
  check("ledger: TTL expiry", ledger.live(50 + 1_000).length === 0 && ledger.size === 0);
  ledger.record({ ...e("", 0) });
  check("ledger: an empty id is never recorded", ledger.size === 0);
  check("ledger: defaults documented (64 entries, 24h)", AUTO_FAIL_LEDGER_MAX === 64 && AUTO_FAIL_TTL_MS === 86_400_000);

  // Contract with the web client: the literals it matches must be the
  // daemon's constants (permissionCards lowercases the type before comparing).
  const cards = readFileSync(join(REPO, "apps/web/src/lib/permissionCards.ts"), "utf8");
  const chat = readFileSync(join(REPO, "apps/web/src/components/ChatView.tsx"), "utf8");
  check("parity: permissionCards.ts matches AUTO_APPROVED_EVENT", cards.includes(`type === "${AUTO_APPROVED_EVENT}"`));
  check("parity: permissionCards.ts matches AUTO_APPROVE_FAILED_EVENT (lowercased)", cards.includes(`type === "${AUTO_APPROVE_FAILED_EVENT.toLowerCase()}"`));
  check("parity: ChatView.tsx matches both event names", chat.includes(`"${AUTO_APPROVED_EVENT}"`) && chat.includes(`"${AUTO_APPROVE_FAILED_EVENT}"`));

  // Source shape (lesson P3-447): the wiring a refactor could silently drop.
  const src = readFileSync(join(REPO, "apps/daemon/src/index.ts"), "utf8");
  check("pin: the inline ask predicate that swallowed replies is gone", !src.includes('!t.includes("response") && !t.includes("revoke")'));
  check("pin: forwardEvents classifies through permissionEventFacts", src.includes("const perm = permissionEventFacts(evt.type, evt.properties);"));
  check("pin: a handshake arms the replay; the first sealed op fires it", src.includes("autoFailReplayDue.add(sessions.get(frame.from)!);") && src.includes("if (autoFailReplayDue.delete(session)) void replayAutoFailures(session)"));
  check("pin: loadIdentity rewrites the state file only when it changed", src.includes("if (serialized !== content) writeStateAtomic(STATE_FILE, serialized);"));
  check("pin: the self-restart boot probe cannot throw at import", !src.includes('const BOOT_HEAD = execSync("git rev-parse HEAD"') && src.includes('log("info", "self-restart watch off: not a git checkout");'));
  const metricsSrc = readFileSync(join(REPO, "apps/daemon/src/metrics.ts"), "utf8");
  check("pin: the loopback server wraps every request in the backstop", metricsSrc.includes("apiRequestFailed(res, err);"));

  // PDF preview: Chromium (Chrome, Electron 44) refuses its PDF viewer in ANY
  // sandboxed frame — the P2-097 `allow-same-origin` frame rendered blank on
  // the desktop. The frame is unsandboxed and the blob type is pinned instead;
  // the HTML preview keeps its script-only sandbox untouched.
  const viewer = readFileSync(join(REPO, "apps/web/src/components/ArtifactViewer.tsx"), "utf8");
  const pdfFrame = viewer.slice(viewer.indexOf('{meta.kind === "pdf" && ('), viewer.indexOf('{meta.kind === "image" && ('));
  check("pin: ArtifactViewer's pdf frame carries no sandbox attribute", pdfFrame.includes("<iframe") && !/\bsandbox=/.test(pdfFrame));
  check("pin: ArtifactViewer pins the pdf blob type on meta.kind, not the declared mime", viewer.includes('b64ToBlob(c.data, meta.kind === "pdf" ? "application/pdf" : c.mime)'));
  check("pin: ArtifactViewer's html frame keeps sandbox=\"allow-scripts\" only", viewer.includes('sandbox="allow-scripts"') && !viewer.includes('sandbox="allow-scripts allow-same-origin"'));
  check(
    "pin: ArtifactViewer fetches once per artifact, not once per app render",
    viewer.includes("}, [meta.sessionId, meta.name, meta.mtime, meta.kind]);") && !viewer.includes("}, [meta, request]);") && viewer.includes("fetchArtifact(requestRef.current, meta.sessionId, meta.name)"),
  );
  const fileCard = readFileSync(join(REPO, "apps/web/src/components/FileCard.tsx"), "utf8");
  check("pin: FileCard's pdf frame only opens for kind pdf (typed by mimeFor)", fileCard.includes('preview?.url && kind === "pdf"') && fileCard.includes('ext === "pdf"'));
}

// ─── 3. a real hermetic daemon ──────────────────────────────────────────────
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// fake opencode: SSE /event we drive, a pending list we own, approve statuses per id
const sse = new Set<ServerResponse>();
let pending: Array<{ id: string; sessionID: string; permission: string }> = [];
const approveStatus = new Map<string, number>();
const approveCalls = new Map<string, number>();
const fake = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const approve = /^\/session\/([^/]+)\/permissions\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && url.pathname === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    sse.add(res);
    req.on("close", () => sse.delete(res));
    return;
  }
  if (req.method === "POST" && approve) {
    const id = approve[2]!;
    approveCalls.set(id, (approveCalls.get(id) ?? 0) + 1);
    const status = approveStatus.get(id) ?? 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? "true" : JSON.stringify({ name: "NotFoundError" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  if (req.method === "POST" && url.pathname === "/session") res.end(JSON.stringify({ id: "ses_eval12new", title: "created" }));
  else if (url.pathname === "/permission") res.end(JSON.stringify(pending));
  else if (url.pathname === "/global/health") res.end(JSON.stringify({ healthy: true, version: "1.18.32" }));
  else res.end("[]");
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
const fakePort = (fake.address() as AddressInfo).port;
function emitEvent(evt: unknown) {
  for (const res of sse) res.write(`data: ${JSON.stringify(evt)}\n\n`);
}

const home = mkdtempSync(join(tmpdir(), "ocr-eval12-home-"));
const stateDir = join(home, ".opencode-remote");
const stateFile = join(stateDir, "daemon.json");

function bootDaemon(port: number, extraEnv: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "apps/daemon/src/index.ts"], {
    cwd: REPO,
    env: {
      ...process.env,
      ...extraEnv,
      HOME: home,
      USERPROFILE: home,
      OCR_METRICS_PORT: String(port),
      RELAY_URL: "ws://127.0.0.1:1", // dead on purpose: local WS only
      OPENCODE_URL: `http://127.0.0.1:${fakePort}`,
      OCR_LOG_LEVEL: "info",
      OCR_ARTIFACT_RETENTION: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
async function waitHealthz(port: number, p: ChildProcess, ms: number): Promise<Response | null> {
  const until = Date.now() + ms;
  while (Date.now() < until && alive(p)) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.status === 200) return r;
    } catch {}
    await sleep(200);
  }
  return null;
}
async function stopDaemon(p: ChildProcess): Promise<void> {
  if (!alive(p)) return;
  const exited = new Promise((r) => p.once("exit", r));
  p.kill("SIGTERM");
  await Promise.race([exited, sleep(6_000)]);
  if (alive(p)) p.kill("SIGKILL");
}
async function metric(port: number, name: string): Promise<number> {
  const m = (await (await fetch(`http://127.0.0.1:${port}/metrics`)).json()) as Record<string, number>;
  return m[name] ?? 0;
}
function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const s = connect(port, "127.0.0.1", () => s.write(text));
    s.on("data", (b) => {
      got += b.toString();
      s.destroy();
    });
    s.on("close", () => resolve(got.split("\r\n")[0] ?? ""));
    s.on("error", () => resolve(got.split("\r\n")[0] ?? ""));
  });
}

type Ev = { type: string; properties?: Record<string, unknown> };
/** A sealed E2E client on the daemon's local WS (the desktop's transport). */
class LocalClient {
  events: Ev[] = [];
  /** seq of every sealed frame, in wire (arrival) order */
  seqs: number[] = [];
  /** frames refused by the strict replay guard (seq not above the last one) */
  dropped = 0;
  private seq = 0;
  private lastSeq = 0;
  private waiters = new Map<string, (r: OpResponse) => void>();
  private parts = new Map<string, string[]>();
  private chain: Promise<void> = Promise.resolve();
  private constructor(
    private ws: WebSocket,
    private key: CryptoKey,
    private from: string,
  ) {}

  static async connect(port: number, token: string, identity: Awaited<ReturnType<typeof newIdentity>>, from: string) {
    const daemonPub = (JSON.parse(readFileSync(stateFile, "utf8")) as { ecdhPub: string }).ecdhPub;
    const { hello, sessionKey } = await clientHello(daemonPub, identity);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
    ws.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("local ws never opened")), 4000);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
    });
    const confirmed = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no handshake confirm")), 6000);
      ws.once("message", () => {
        clearTimeout(t);
        resolve();
      });
    });
    ws.send(JSON.stringify({ room: "eval12", from, payload: b64(new TextEncoder().encode(JSON.stringify({ type: "hello", hello }))) }));
    await confirmed;
    const c = new LocalClient(ws, sessionKey, from);
    ws.on("message", (data) => {
      c.chain = c.chain.then(() => c.onFrame(data.toString())).catch(() => {});
    });
    return c;
  }

  // Frames are handled strictly in arrival order with the web client's rule
  // (apps/web/src/lib/client.ts): a seq not above the last accepted one is
  // dropped — exactly what turned a daemon-side send inversion into a lost
  // response or event.
  private async onFrame(raw: string) {
    const frame = JSON.parse(raw) as { from: string; seq?: number; payload: string };
    if (typeof frame.seq !== "number") return; // clear controls
    this.seqs.push(frame.seq);
    if (frame.seq <= this.lastSeq) {
      this.dropped++;
      return;
    }
    const env = await openSealed<{
      type: string;
      res?: OpResponse;
      event?: Ev;
      chunk?: { id: string; status: number; i: number; of: number; part: string };
    }>(frame.payload, this.key, seqAad(frame.from, frame.seq));
    if (!env) return;
    this.lastSeq = frame.seq;
    if (env.type === "event" && env.event) this.events.push(env.event);
    if (env.type === "res" && env.res) this.waiters.get(env.res.id)?.(env.res);
    if (env.type === "res-chunk" && env.chunk) {
      const c = env.chunk;
      const parts = this.parts.get(c.id) ?? new Array<string>(c.of).fill("");
      parts[c.i] = c.part;
      this.parts.set(c.id, parts);
      if (parts.every((x) => x !== "")) {
        this.parts.delete(c.id);
        this.waiters.get(c.id)?.({ id: c.id, status: c.status, body: JSON.parse(parts.join("")) } as OpResponse);
      }
    }
  }

  async op(method: string, path: string, body?: unknown, query?: Record<string, string>, timeoutMs = 8000): Promise<OpResponse> {
    const id = crypto.randomUUID();
    const seq = ++this.seq;
    const payload = await seal({ type: "op", req: { id, method, path, body, query } }, this.key, seqAad(this.from, seq));
    const res = new Promise<OpResponse>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`op ${method} ${path} timed out`)), timeoutMs);
      this.waiters.set(id, (r) => {
        clearTimeout(t);
        this.waiters.delete(id);
        resolve(r);
      });
    });
    this.ws.send(JSON.stringify({ room: "eval12", from: this.from, seq, payload }));
    return await res;
  }

  /** clear heartbeat — a live session answers with a SEALED pong (RT-341) */
  ping() {
    this.ws.send(JSON.stringify({ room: "eval12", from: this.from, payload: b64(new TextEncoder().encode(JSON.stringify({ type: "ping" }))) }));
  }

  async waitEvent(pred: (e: Ev) => boolean, ms: number): Promise<Ev | null> {
    const until = Date.now() + ms;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit || Date.now() > until) return hit ?? null;
      await sleep(50);
    }
  }

  close() {
    this.ws.close();
  }
}
const failedFor = (id: string) => (e: Ev) => e.type === AUTO_APPROVE_FAILED_EVENT && e.properties?.permissionID === id;

// One daemon at a time; a scenario that kills it (every crash below did on
// main d046075) is recorded and the next scenario gets a fresh boot on the
// same HOME, so each regression is judged on its own.
let port = 0;
let daemon: ChildProcess | null = null;
async function boot(): Promise<boolean> {
  port = await freePort();
  const p = bootDaemon(port);
  daemon = p;
  p.stdout!.on("data", () => {});
  p.stderr!.on("data", () => {});
  const until = Date.now() + 30_000;
  while (Date.now() < until && alive(p)) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/metrics`)).ok) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}
async function ensureUp(): Promise<void> {
  if (daemon && alive(daemon)) return;
  if (!(await boot())) throw new Error("daemon never came up");
}
process.on("exit", () => {
  if (daemon && alive(daemon)) daemon.kill("SIGKILL");
});
const authed = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

try {
  await ensureUp();

  const hz = await fetch(`http://127.0.0.1:${port}/healthz`);
  check("/healthz: unauthenticated liveness answers 200", hz.status === 200, `status=${hz.status}`);
  const hzBody = hz.status === 200 ? ((await hz.json()) as { ok?: boolean; service?: string }) : {};
  check("/healthz: fixed literal body, nothing else", hzBody.ok === true && hzBody.service === "ocr-daemon" && Object.keys(hzBody).length === 2);

  await fetch(`http://127.0.0.1:${port}/api/health`, authed("warmup")).catch(() => {});
  let token = "";
  for (let i = 0; i < 25 && !token; i++) {
    try {
      token = (JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken ?? "";
    } catch {}
    if (!token) await sleep(200);
  }
  check("apiToken minted in the hermetic state file", token.length > 0);

  // ── AutoMode over a real E2E session (non-crashing scenarios first) ──
  for (let i = 0; i < 50 && sse.size === 0; i++) await sleep(100);
  check("daemon attached to the fake opencode event stream", sse.size > 0);
  const identity = await newIdentity(false);
  const c1 = await LocalClient.connect(port, token, identity, "c1");
  const settings = await c1.op("PATCH", "/__ocr/settings", { autoMode: true, notify: { permission: true } });
  check("AutoMode switched on over the tunnel", settings.status === 200 && (settings.body as { autoMode?: boolean }).autoMode === true);
  const pushAt = async (c: LocalClient) => ((await c.op("GET", "/__ocr/push/status")).body as { last?: { at?: number } | null }).last?.at ?? 0;
  const ask = (id: string) => ({ type: "permission.asked", properties: { id, sessionID: "ses_eval12", permission: "bash", patterns: ["ls"], metadata: {}, always: [] } });

  // A: a real failure → live broadcast + push attempt
  pending = [{ id: "per_fail1", sessionID: "ses_eval12", permission: "bash" }];
  approveStatus.set("per_fail1", 500);
  const pushBeforeA = await pushAt(c1);
  emitEvent(ask("per_fail1"));
  const liveFail = await c1.waitEvent(failedFor("per_fail1"), 6000);
  check("failure: autoFailed broadcast to the live client, labeled by the tool", liveFail !== null && liveFail.properties?.action === "bash", JSON.stringify(liveFail));
  check("failure: two approve attempts on a 5xx", approveCalls.get("per_fail1") === 2);
  await sleep(300);
  check("failure: a push is attempted (phone asleep must still hear it)", (await pushAt(c1)) > pushBeforeA);

  // D: 404 + gone from the pending list → resolved elsewhere, no alarm
  approveStatus.set("per_gone", 404);
  const pushBeforeD = await pushAt(c1);
  emitEvent(ask("per_gone"));
  await sleep(2000);
  check("404 resolved elsewhere: no autoFailed event", !c1.events.some(failedFor("per_gone")));
  check("404 resolved elsewhere: the same 404 is not retried", approveCalls.get("per_gone") === 1, `calls=${approveCalls.get("per_gone")}`);
  check("404 resolved elsewhere: no push", (await pushAt(c1)) === pushBeforeD);

  // E: 404 while still pending → a real failure (approve route broken)
  pending = [...pending, { id: "per_stuck", sessionID: "ses_eval12", permission: "bash" }];
  approveStatus.set("per_stuck", 404);
  emitEvent(ask("per_stuck"));
  check("404 still pending: reported as a failure", (await c1.waitEvent(failedFor("per_stuck"), 4000)) !== null);
  check("404 still pending: one call, no blind retry", approveCalls.get("per_stuck") === 1, `calls=${approveCalls.get("per_stuck")}`);

  // B: a client that connects later gets the replay after its first op
  c1.close();
  const c2 = await LocalClient.connect(port, token, identity, "c2");
  await c2.op("GET", "/__ocr/settings");
  const replay1 = await c2.waitEvent(failedFor("per_fail1"), 3000);
  const replay2 = await c2.waitEvent(failedFor("per_stuck"), 3000);
  check("replay: a reconnecting client receives every pending failure", replay1 !== null && replay2 !== null);
  check("replay: marked replayed:true", replay1?.properties?.replayed === true);

  // C: the reply clears the ledger — and pushes nothing
  const pushBeforeC = await pushAt(c2);
  emitEvent({ type: "permission.replied", properties: { sessionID: "ses_eval12", requestID: "per_fail1", reply: "once" } });
  await sleep(1200);
  check("reply: no spurious 'Approve needed' push for permission.replied", (await pushAt(c2)) === pushBeforeC);
  c2.close();
  const c3 = await LocalClient.connect(port, token, identity, "c3");
  await c3.op("GET", "/__ocr/settings");
  check("reply: the replied ask is no longer replayed", (await c3.waitEvent(failedFor("per_stuck"), 3000)) !== null && !c3.events.some(failedFor("per_fail1")));
  c3.close();

  // answered while nobody listened (no replied event): the pending list wins
  pending = [];
  const c4 = await LocalClient.connect(port, token, identity, "c4");
  await c4.op("GET", "/__ocr/settings");
  await sleep(1500);
  check("replay: asks no longer pending are dropped before replaying", !c4.events.some((e) => e.type === AUTO_APPROVE_FAILED_EVENT));
  c4.close();

  // ── seal order (eval-14 P1): wire order must be seq order ──
  // One ~4 MB artifact (9 res-chunks, slow seals) raced by 40 heartbeats
  // (tiny sealed pongs) and a burst of broadcast events. Before the per-
  // session send chain, pongs overtook chunks on the wire and the strict
  // client dropped the lower seq — the artifact never finished.
  {
    const bigDir = join(stateDir, "artifacts", "ses_eval12big");
    mkdirSync(bigDir, { recursive: true });
    const big = Buffer.alloc(4_000_000);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    writeFileSync(join(bigDir, "big.bin"), big);
    const c6 = await LocalClient.connect(port, token, identity, "c6");
    await c6.op("GET", "/__ocr/settings");
    const bigOp = c6.op("GET", "/__ocr/artifact", undefined, { session: "ses_eval12big", name: "big.bin" }, 20_000).catch((e: Error) => e);
    for (let i = 0; i < 40; i++) {
      c6.ping();
      if (i % 4 === 0) emitEvent({ type: "session.status", properties: { sessionID: "ses_eval12", i } });
      await sleep(5);
    }
    const got = await bigOp;
    await sleep(500);
    const inversions = c6.seqs.filter((s, i) => i > 0 && s <= c6.seqs[i - 1]!).length;
    check("seal order: every sealed frame reaches the wire in seq order", inversions === 0 && c6.dropped === 0, `inversions=${inversions} dropped=${c6.dropped} frames=${c6.seqs.length}`);
    const data = got instanceof Error ? null : (got.body as { data?: string }).data;
    check("seal order: a 4 MB artifact raced by pongs and events arrives byte-exact", !!data && Buffer.from(data, "base64").equals(big), got instanceof Error ? got.message : `status=${got.status}`);
    c6.close();
  }

  // ── POST /api/session/new (the P1-057 cookie exchange owns POST /api/session) ──
  {
    const created = await fetch(`http://127.0.0.1:${port}/api/session/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "created" }),
    });
    const createdBody = (await created.json().catch(() => ({}))) as { id?: string };
    check("POST /api/session/new creates a session (SDK createSession)", created.status === 200 && createdBody.id === "ses_eval12new", `status=${created.status} body=${JSON.stringify(createdBody)}`);
    const cookie = await fetch(`http://127.0.0.1:${port}/api/session`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const cookieBody = (await cookie.json().catch(() => ({}))) as { ok?: boolean; expiresAt?: number };
    check("POST /api/session stays the P1-057 cookie exchange", cookie.status === 200 && cookieBody.ok === true && typeof cookieBody.expiresAt === "number");
  }

  // ── crash scenarios: each one judged on its own boot ──
  const bad = await rawRequest(port, "GET //[ HTTP/1.1\r\nHost: x\r\n\r\n");
  await sleep(400);
  check("malformed request line (`GET //[`) answers 400, daemon alive (main: exit 1)", bad.includes(" 400 ") && alive(daemon!), `status line: ${bad} exit=${daemon!.exitCode}`);
  await ensureUp();
  // eval-15: the same crash from ANY web page on the machine — WHATWG keeps
  // `//a:99999/` as the path of http://127.0.0.1:8792//a:99999/, so a no-cors
  // fetch sends exactly this request line (no auth, no DNS rebinding).
  const fromPage = await rawRequest(port, "GET //a:99999/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  await sleep(400);
  check("web-page reachable target (`GET //a:99999/`) answers 400, daemon alive", fromPage.includes(" 400 ") && alive(daemon!), `status line: ${fromPage} exit=${daemon!.exitCode}`);
  await ensureUp();

  const stateBefore = readFileSync(stateFile, "utf8");
  writeFileSync(stateFile, "{");
  const r500 = await fetch(`http://127.0.0.1:${port}/api/health`, authed(token)).catch(() => null);
  writeFileSync(stateFile, stateBefore);
  await sleep(400);
  check("unreadable state file under /api/health → 500, daemon alive (main: exit 1)", r500?.status === 500 && alive(daemon!), `status=${r500?.status} exit=${daemon!.exitCode}`);
  check("backstop counted in /metrics (ocr_api_handler_errors_total)", alive(daemon!) && (await metric(port, "ocr_api_handler_errors_total")) === 1);
  await ensureUp();
  const r200 = await fetch(`http://127.0.0.1:${port}/api/health`, authed(token));
  check("state file restored → /api/health 200 again", r200.status === 200);

  // stdio pipes torn down under the live daemon: EPIPE on stdout…
  daemon!.stdout!.destroy();
  daemon!.stderr!.destroy();
  await sleep(200);
  try {
    const c5 = await LocalClient.connect(port, token, identity, "c5"); // "client paired" → stdout
    await c5.op("GET", "/__ocr/settings");
    c5.close();
  } catch {
    // main: the stdout EPIPE killed the daemon mid-handshake — judged below
  }
  await sleep(800);
  check("EPIPE on stdout: the daemon stays up (main: exit 1)", alive(daemon!), `exit=${daemon!.exitCode} signal=${daemon!.signalCode}`);
  check("EPIPE absorbed and counted (ocr_log_write_errors_total)", alive(daemon!) && (await metric(port, "ocr_log_write_errors_total")) >= 1);
  await ensureUp();
  // …and on stderr: the backstop's error line is the on-demand stderr write
  daemon!.stdout!.destroy();
  daemon!.stderr!.destroy();
  await sleep(200);
  const stateNow = readFileSync(stateFile, "utf8");
  writeFileSync(stateFile, "{");
  await fetch(`http://127.0.0.1:${port}/api/health`, authed(token)).catch(() => {});
  writeFileSync(stateFile, stateNow);
  await sleep(800);
  check("EPIPE on stderr while logging a handler error: the daemon stays up", alive(daemon!), `exit=${daemon!.exitCode} signal=${daemon!.signalCode}`);
} catch (err) {
  check("hermetic daemon scenario ran to the end", false, String(err));
} finally {
  if (daemon) await stopDaemon(daemon);
}

// ─── boot outside a git checkout (tarball, Docker without .git, no git) ─────
// Liveness via /metrics (exists on main too), so only the boot itself is judged.
{
  const portC = await freePort();
  const daemonC = bootDaemon(portC, { GIT_DIR: join(scratch, "no-such-git-dir") });
  let errC = "";
  daemonC.stderr!.on("data", (c) => (errC += c));
  daemonC.stdout!.on("data", () => {});
  let upC = false;
  for (let i = 0; i < 150 && !upC && alive(daemonC); i++) {
    upC = await fetch(`http://127.0.0.1:${portC}/metrics`).then((r) => r.ok).catch(() => false);
    if (!upC) await sleep(200);
  }
  check(
    "no git checkout: the daemon boots (main: `git rev-parse HEAD` threw at import, exit 1)",
    upC && alive(daemonC),
    `exit=${daemonC.exitCode} stderr=${errC.split("\n").filter((l) => /rev-parse|fatal/.test(l)).join(" ").slice(0, 300)}`,
  );
  await stopDaemon(daemonC);
}

// ─── boot on a state dir that cannot be written (full disk / read-only) ─────
if (!WIN && existsSync(stateDir)) {
  chmodSync(stateDir, 0o555);
  const portB = await freePort();
  const daemonB = bootDaemon(portB);
  let errB = "";
  daemonB.stderr!.on("data", (c) => (errB += c));
  daemonB.stdout!.on("data", () => {});
  try {
    const up = await waitHealthz(portB, daemonB, 30_000);
    check(
      "read-only state dir: an established daemon still boots (no identity rewrite)",
      up !== null && alive(daemonB),
      `exit=${daemonB.exitCode} stderr=${errB.split("\n").filter((l) => l.includes("fatal")).join(" ").slice(0, 300)}`,
    );
  } finally {
    await stopDaemon(daemonB);
    chmodSync(stateDir, 0o755);
  }
} else if (WIN) {
  console.log("OK  read-only boot (skipped on Windows: POSIX modes)");
} else {
  check("read-only state dir: an established daemon still boots (no identity rewrite)", false, "the first daemon never created its state dir");
}

// ─── PWA origin (deploy/pwa-server.mjs): hardening headers on every answer ──
{
  const dist = join(scratch, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<html>ocr-pwa</html>");
  writeFileSync(join(dist, "assets", "app-B3iKfWlp.js"), "console.log(1)");
  const pwaPort = await freePort();
  const pwa = spawn(process.execPath, [join(REPO, "deploy", "pwa-server.mjs")], {
    env: { ...process.env, PWA_PORT: String(pwaPort), PWA_DIST_DIR: dist, PWA_HOST: "127.0.0.1" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const base = `http://127.0.0.1:${pwaPort}`;
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = await fetch(`${base}/healthz`).then((r) => r.ok).catch(() => false);
    if (!up) await sleep(100);
  }
  check("pwa-server: up on an ephemeral port", up);
  const hardened = (r: Response) =>
    r.headers.get("x-content-type-options") === "nosniff" &&
    r.headers.get("x-frame-options") === "DENY" &&
    r.headers.get("referrer-policy") === "no-referrer";
  const answers: Array<[string, Response]> = [
    ["GET / (the shell)", await fetch(`${base}/`)],
    ["HEAD /", await fetch(`${base}/`, { method: "HEAD" })],
    ["hashed asset", await fetch(`${base}/assets/app-B3iKfWlp.js`)],
    ["/healthz", await fetch(`${base}/healthz`)],
    ["404", await fetch(`${base}/nope`)],
    ["405", await fetch(`${base}/`, { method: "POST" })],
  ];
  for (const [what, r] of answers) check(`pwa-server: ${what} carries nosniff + DENY framing + no-referrer`, hardened(r), `status=${r.status}`);
  check("pwa-server: no CSP (a srcdoc artifact would inherit it)", answers.every(([, r]) => r.headers.get("content-security-policy") === null));
  check("pwa-server: caching contract unchanged", answers[0]![1].headers.get("cache-control") === "no-cache" && (answers[2]![1].headers.get("cache-control") ?? "").includes("immutable"));
  pwa.kill("SIGTERM");
}

for (const res of sse) res.end();
fake.closeAllConnections();
fake.close();
rmSync(home, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall daemon-hardening checks passed");
process.exit(0);
