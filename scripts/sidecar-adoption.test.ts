/**
 * eval-11: daemon adoption with a fresh identity + the managed-daemon grace
 * (apps/desktop/src/daemon.ts, apps/desktop/src/manageddaemon.ts).
 *
 * 1. Fresh identity. The daemon mints its apiToken lazily, on its first /api
 *    request (authorized() → apiToken() in apps/daemon/src/index.ts). The
 *    shell's healthOnce used to return before sending ANY request while it had
 *    no token, so nothing ever asked a fresh daemon anything: measured on the
 *    real shell + real bundled daemon (fresh HOME), the first window waited out
 *    the whole 30s health timeout and the pairing state stayed null/"down"
 *    forever (the token never appeared). The fakes below mint exactly like the
 *    daemon; every check here failed before the fix.
 * 2. Managed daemon. At login the app's sidecar grabbed :8792 10–19s before
 *    the launchd daemon (4/4 boots in the operator's logs), splitting ONE
 *    identity across two daemons. The pure plan and the bounded wait are
 *    exercised with a daemon that binds late.
 *
 * Hermetic: throwaway ports and state files only — never :8792, never the
 * operator's ~/.opencode-remote. Run: npx tsx scripts/sidecar-adoption.test.ts
 */
import "./testhome";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "ocr-adoption-"));

/** A fake daemon that behaves like apps/daemon on /api/health: it mints its
 * token into `stateFile` on the FIRST request it ever sees (lazy, like
 * apiToken()), answers 401+JSON without the right Bearer and 200 with it.
 * `fixedToken` skips the mint (an identity that already has a token). */
function fakeDaemon(stateFile: string, fixedToken?: string): { server: Server; requests: () => number; token: () => string | null } {
  let token: string | null = fixedToken ?? null;
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (token === null) {
      token = `lazy-${Math.random().toString(36).slice(2)}`;
      writeFileSync(stateFile, JSON.stringify({ room: "fresh-room", apiToken: token }));
    }
    const ok = req.headers.authorization === `Bearer ${token}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(ok ? JSON.stringify({ healthy: true }) : JSON.stringify({ error: "unauthorized" }));
  });
  return { server, requests: () => requests, token: () => token };
}

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  return (server.address() as { port: number }).port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function hasToken(file: string): boolean {
  try {
    return typeof (JSON.parse(readFileSync(file, "utf8")) as { apiToken?: unknown }).apiToken === "string";
  } catch {
    return false;
  }
}

// Capture the shell's log lines (desktop-log falls back to console before init).
const logLines: string[] = [];
for (const stream of [process.stdout, process.stderr] as const) {
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string") logLines.push(...chunk.split("\n"));
    return original(chunk, ...rest);
  }) as typeof stream.write;
}

// --- environment BEFORE importing the module (it reads the port at import) ----
const stateA = join(tmp, "daemon-a.json");
writeFileSync(stateA, JSON.stringify({ room: "fresh-room" })); // identity, no token yet
const daemonA = fakeDaemon(stateA);
const portA = await listen(daemonA.server);
process.env.OCR_DAEMON_METRICS_PORT = String(portA);
process.env.OCR_DAEMON_STATE_FILE = stateA;
process.env.OCR_DAEMON_ENTRY = join(tmp, "no-daemon-entry.js"); // a spawn would fail loudly
delete process.env.OCR_DAEMON_FORCE_DOWN;
delete process.env.OCR_DAEMON_FORCE_RECONNECTING;

const { awaitManagedDaemon, daemonPortReason, healthOnce, readApiToken, startDaemonSidecar, stopDaemonSidecar, waitForDaemonHealth } =
  await import("../apps/desktop/src/daemon.ts");
const { MANAGED_DAEMON_GRACE_MS, MANAGED_DAEMON_PORT, MANAGED_REASONS, managedDaemonPlan, managedDaemonPlistPath } =
  await import("../apps/desktop/src/manageddaemon.ts");

// --- 1a. the port walk adopts a live daemon whose token did not exist yet ------
check("fresh identity: the state file starts without a token", !hasToken(stateA) && daemonA.requests() === 0);
check("fresh identity: startDaemonSidecar ADOPTS the live daemon (no second daemon)", (await startDaemonSidecar(tmp, undefined)) === true);
check("fresh identity: the walk verdict is reused", daemonPortReason() === "reused");
check("fresh identity: the shell's own nudge minted the token", hasToken(stateA) && readApiToken() === daemonA.token());
check("fresh identity: no spawn was attempted", !logLines.some((l) => l.includes("no daemon entry found")));
check("fresh identity: the adoption is logged", logLines.some((l) => l.includes(`daemon already running on :${portA} — reusing it`)));
await stopDaemonSidecar(); // disarms the adopted-daemon watchdog
await closeServer(daemonA.server);

// --- 1b. the health wait confirms a fresh daemon on its own ----------------------
{
  const stateB = join(tmp, "daemon-b.json");
  writeFileSync(stateB, JSON.stringify({ room: "fresh-room-b" }));
  process.env.OCR_DAEMON_STATE_FILE = stateB;
  const daemonB = fakeDaemon(stateB);
  const portB = await listen(daemonB.server);
  const t0 = Date.now();
  const healthy = await waitForDaemonHealth({ port: portB, timeoutMs: 5_000, token: null });
  const ms = Date.now() - t0;
  check(`fresh identity: waitForDaemonHealth confirms it without outside help (${ms}ms)`, healthy === true && ms < 3_000);
  check("fresh identity: the shell's nudge was the request that minted the token", daemonB.requests() >= 2 && hasToken(stateB));
  // The hardening survives: healthOnce itself never trusts (or even asks)
  // anything without a token.
  const before = daemonB.requests();
  check("hardening: healthOnce with no token answers false and sends nothing", (await healthOnce(portB, null)) === false && daemonB.requests() === before);
  await closeServer(daemonB.server);
  process.env.OCR_DAEMON_STATE_FILE = stateA;
}

// --- 1c. no identity, no request -------------------------------------------------
// The harness hands the shell a "{}" state (no room): there is no daemon of
// this identity to nudge, so the wait must never send a request — on the
// operator's machine the candidate ports include the production daemon.
{
  const stateEmpty = join(tmp, "daemon-empty.json");
  writeFileSync(stateEmpty, "{}");
  process.env.OCR_DAEMON_STATE_FILE = stateEmpty;
  const bystander = fakeDaemon(join(tmp, "bystander.json"), "someone-elses-token");
  const portX = await listen(bystander.server);
  const healthy = await waitForDaemonHealth({ port: portX, timeoutMs: 1_500, token: null });
  check("no identity: the wait gives up without a single request to the responder", healthy === false && bystander.requests() === 0);
  await closeServer(bystander.server);
  process.env.OCR_DAEMON_STATE_FILE = stateA;
}

// --- 2a. the managed-daemon plan (pure, rule order) -------------------------------
{
  const base = { platform: "darwin", harnessSession: false, stateFileOverride: false, preferredPort: MANAGED_DAEMON_PORT, plistInstalled: true };
  const wait = managedDaemonPlan(base);
  check("managed plan: an installed launchd daemon on the default port gets the grace", wait.action === "wait" && "graceMs" in wait && wait.graceMs === MANAGED_DAEMON_GRACE_MS);
  check("managed plan: rule 1 — a harness session never waits", managedDaemonPlan({ ...base, harnessSession: true }).reason === MANAGED_REASONS.harness);
  check("managed plan: rule 2 — an overridden state file never waits", managedDaemonPlan({ ...base, stateFileOverride: true }).reason === MANAGED_REASONS.stateOverride);
  check("managed plan: rule 3 — another port never waits", managedDaemonPlan({ ...base, preferredPort: 8793 }).reason === MANAGED_REASONS.portOverride);
  check("managed plan: rule 4 — Windows/Linux never wait", managedDaemonPlan({ ...base, platform: "win32" }).reason === MANAGED_REASONS.platform && managedDaemonPlan({ ...base, platform: "linux" }).action === "spawn");
  check("managed plan: rule 5 — no plist, no wait", managedDaemonPlan({ ...base, plistInstalled: false }).reason === MANAGED_REASONS.notInstalled);
  check(
    "managed plan: the harness rule wins even on a managed Mac with every other fact true",
    managedDaemonPlan({ ...base, harnessSession: true, stateFileOverride: true }).reason === MANAGED_REASONS.harness,
  );
  check(
    "managed plan: the plist lives where deploy/install.sh puts the com.ocr.daemon agent",
    managedDaemonPlistPath("/Users/x") === join("/Users/x", "Library", "LaunchAgents", "com.ocr.daemon.plist"),
  );
  check("managed plan: the grace covers the worst measured login delta (18.7s) with margin", MANAGED_DAEMON_GRACE_MS >= 25_000 && MANAGED_DAEMON_GRACE_MS <= 45_000);
  const reasons = Object.values(MANAGED_REASONS);
  check("managed plan: reasons are static — no path, no port number, no URL", reasons.every((r) => !/[/\\]|\d{4}|:\/\//.test(r)));
}

// --- 2b. the bounded wait adopts a daemon that binds late --------------------------
{
  const tokenA = readApiToken(); // the identity the shell already holds
  const latePort = await freePort();
  const late = fakeDaemon(join(tmp, "late.json"), tokenA ?? "x");
  setTimeout(() => void listen(late.server, latePort), 1_200);
  const t0 = Date.now();
  const adopted = await awaitManagedDaemon(latePort, 8_000);
  const ms = Date.now() - t0;
  check(`managed wait: a daemon binding 1.2s late is adopted inside the grace (${ms}ms)`, adopted === true && ms >= 1_000 && ms < 5_000);
  await closeServer(late.server);
  const deadPort = await freePort();
  const t1 = Date.now();
  const gaveUp = await awaitManagedDaemon(deadPort, 1_200);
  const ms1 = Date.now() - t1;
  check(`managed wait: nothing answering → false once the grace runs out (${ms1}ms)`, gaveUp === false && ms1 >= 1_100 && ms1 < 4_000);
}

// --- 3. the real daemon.ts wiring ------------------------------------------------
{
  const src = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "daemon.ts"), "utf8");
  const nudge = src.slice(src.indexOf("async function nudgeTokenMint("), src.indexOf("async function provesIdentity("));
  check(
    "wiring: the mint nudge only fires for an identity (room) that has no token yet",
    nudge.includes('if (!state || typeof state.room !== "string" || typeof state.apiToken === "string") return;') &&
      nudge.indexOf("return;") < nudge.indexOf("await fetch("),
  );
  const wait = src.slice(src.indexOf("export async function waitForDaemonHealth("), src.indexOf("export function getPairUrl("));
  check("wiring: the health wait nudges before re-reading a missing token", /if \(token === null\) \{\s*\n\s*await nudgeTokenMint\(port\);\s*\n\s*token = readApiToken\(\);/.test(wait));
  check("wiring: the port walk proves identity through provesIdentity", src.includes("(p) => provesIdentity(p),"));
  const start = src.slice(src.indexOf("export async function startDaemonSidecar("), src.indexOf("// --- P2-187: phone relay address"));
  const bootAt = start.indexOf("if (!reuse && firstResolution) reuse = await adoptManagedDaemonWithinGrace();");
  check(
    "wiring: the boot consults the managed grace only when nobody answered, before any spawn",
    bootAt > -1 && bootAt < start.indexOf("spawnChild(entry);"),
  );
  const restart = src.slice(src.indexOf("export async function restartDaemon("));
  const restartAt = restart.indexOf("if (await adoptManagedDaemonWithinGrace()) {");
  check(
    "wiring: a manual restart gives the managed daemon the same grace before spawning",
    restartAt > -1 && restartAt < restart.indexOf("spawnChild(entry);"),
  );
  const helper = src.slice(src.indexOf("async function adoptManagedDaemonWithinGrace("), src.indexOf("export interface HealthWaitOptions"));
  check(
    "wiring: the managed facts come from the real environment (session, state override, port, plist)",
    helper.includes("harnessSession: !!process.env.OCR_DESKTOP_SESSION,") &&
      helper.includes("stateFileOverride: process.env.OCR_DAEMON_STATE_FILE !== undefined,") &&
      helper.includes("preferredPort: DAEMON_METRICS_PORT,") &&
      helper.includes("plistInstalled: existsSync(managedDaemonPlistPath(homedir())),") &&
      helper.includes("if (managed.action !== \"wait\") return false;"),
  );
  const managedSrc = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "manageddaemon.ts"), "utf8");
  check(
    "manageddaemon.ts is pure — no electron, no fs, no child_process, no timers",
    !/from "electron"|node:fs|child_process|setTimeout|setInterval|fetch\(/.test(managedSrc),
  );
}

console.log(failures === 0 ? "\nsidecar adoption: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
