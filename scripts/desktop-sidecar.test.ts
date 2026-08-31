/**
 * Desktop sidecar tests: daemon spawn/reuse/health/stop wiring (P1-D02).
 * Runs the real spawn/stop paths against throwaway fixture scripts on a
 * throwaway port — never touches the production daemon on 8792.
 * Run: npx tsx scripts/desktop-sidecar.test.ts
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

const tmp = mkdtempSync(join(tmpdir(), "ocr-sidecar-"));
const pidFiles: string[] = [];
function fixture(name: string, body: string): string {
  const file = join(tmp, name);
  writeFileSync(file, `require("node:fs").writeFileSync(${JSON.stringify(file + ".pid")}, String(process.pid));\n${body}`);
  pidFiles.push(file + ".pid");
  return file;
}
process.on("exit", () => {
  for (const f of pidFiles) {
    try {
      process.kill(Number(readFileSync(f, "utf8")), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

// Health server on a free port, bound BEFORE importing the module so the
// sidecar's single source of truth picks it up.
const TOKEN = "tok-test";
const server = createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(ok ? JSON.stringify({ healthy: true }) : JSON.stringify({ error: "unauthorized" }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// Isolated test environment: throwaway port + throwaway state file.
process.env.OCR_DAEMON_METRICS_PORT = String(port);
const fakeState = join(tmp, "daemon.json");
writeFileSync(fakeState, JSON.stringify({ apiToken: TOKEN }));
process.env.OCR_DAEMON_STATE_FILE = fakeState;
delete process.env.OCR_DAEMON_ENTRY;

const {
  DAEMON_METRICS_PORT,
  healthOnce,
  resolveEntry,
  startDaemonSidecar,
  stopDaemonSidecar,
  waitForDaemonHealth,
} = await import("../apps/desktop/src/daemon.ts");

// --- port wiring: one source of truth ---------------------------------------
check("module honors OCR_DAEMON_METRICS_PORT", DAEMON_METRICS_PORT === port);

// --- healthOnce: only an authenticated 200 counts ---------------------------
check("healthOnce 200+token", (await healthOnce(port, TOKEN)) === true);
check("healthOnce 401 without token is NOT healthy", (await healthOnce(port, null)) === false);
check("healthOnce 401 with wrong token is NOT healthy", (await healthOnce(port, "nope")) === false);
check("healthOnce dead port", (await healthOnce(1, TOKEN)) === false);

// --- waitForDaemonHealth positive path --------------------------------------
check(
  "waitForDaemonHealth returns true once healthy",
  (await waitForDaemonHealth({ timeoutMs: 3000 })) === true,
);

// --- resolveEntry ------------------------------------------------------------
const override = fixture("override.cjs", "process.exit(0);");
process.env.OCR_DAEMON_ENTRY = override;
const entry = resolveEntry(tmp, undefined);
check("resolveEntry honors OCR_DAEMON_ENTRY", entry?.file === override);
process.env.OCR_DAEMON_ENTRY = join(tmp, "missing.cjs");
check("resolveEntry missing override → null", resolveEntry(tmp, undefined) === null);
delete process.env.OCR_DAEMON_ENTRY;
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dev = resolveEntry(join(repoRoot, "apps", "desktop"), undefined);
check(
  "resolveEntry dev checkout runs daemon source via tsx",
  dev?.file === join(repoRoot, "apps", "daemon", "src", "index.ts") && dev.args.length === 1,
);

// --- reuse vs spawn ----------------------------------------------------------
// Bogus appPath ⇒ resolveEntry finds nothing, so true is only reachable
// through the "already healthy → reuse" path.
check(
  "startDaemonSidecar reuses a healthy daemon (no spawn)",
  (await startDaemonSidecar(tmp, undefined)) === true,
);
await new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
});
check(
  "startDaemonSidecar without entry and without daemon → false",
  (await startDaemonSidecar(tmp, undefined)) === false,
);

// --- spawn → SIGTERM → exit --------------------------------------------------
const sleepEntry = fixture("sleep.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = sleepEntry;
check("startDaemonSidecar spawns when port is dead", (await startDaemonSidecar(tmp, undefined)) === true);
const pidFile = sleepEntry + ".pid";
check("spawned child starts", await until(() => existsSync(pidFile)));
const pid1 = Number(readFileSync(pidFile, "utf8"));
check("spawned child is alive", pidAlive(pid1));
await stopDaemonSidecar();
check("stopDaemonSidecar SIGTERM kills the child", !pidAlive(pid1));

// --- stubborn child → SIGKILL after the 3s grace -----------------------------
const stubbornEntry = fixture("stubborn.cjs", 'process.on("SIGTERM", () => {});setInterval(() => {}, 1000);');
process.env.OCR_DAEMON_ENTRY = stubbornEntry;
check("stubborn child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("stubborn child starts", await until(() => existsSync(stubbornEntry + ".pid")));
const pid2 = Number(readFileSync(stubbornEntry + ".pid", "utf8"));
const t0 = Date.now();
await stopDaemonSidecar();
const stopMs = Date.now() - t0;
check("SIGKILL fallback after 3s grace", !pidAlive(pid2) && stopMs >= 2500);

// --- already-dead child: fast stop + early health abort ----------------------
const exiterEntry = fixture("exiter.cjs", "process.exit(0);");
process.env.OCR_DAEMON_ENTRY = exiterEntry;
check("exiter child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("exiter child runs", await until(() => existsSync(exiterEntry + ".pid")));
check(
  "exiter child exits by itself",
  await until(() => !pidAlive(Number(readFileSync(exiterEntry + ".pid", "utf8")))),
);
const t1 = Date.now();
check(
  "waitForDaemonHealth aborts early when the child died",
  (await waitForDaemonHealth({ timeoutMs: 10_000 })) === false && Date.now() - t1 < 2000,
);
const t2 = Date.now();
await stopDaemonSidecar();
check("stopDaemonSidecar skips 3s grace for dead child", Date.now() - t2 < 1000);
const t3 = Date.now();
await stopDaemonSidecar();
check("stopDaemonSidecar is idempotent", Date.now() - t3 < 1000);

console.log(failures === 0 ? "\ndesktop sidecar tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
