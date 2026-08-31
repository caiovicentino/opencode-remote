/**
 * Desktop sidecar tests: daemon spawn/reuse/health/stop wiring (P1-D02).
 * Runs the real spawn/stop paths against throwaway fixture scripts on a
 * throwaway port — never touches the production daemon on 8792.
 * Run: npx tsx scripts/desktop-sidecar.test.ts
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
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
// sidecar's single source of truth picks it up. The 401 shape mirrors the
// daemon's send401 (status 401 + JSON body) — healthOnce challenges with an
// unauthenticated request and only sends the bearer token to responders that
// reproduce this signature.
const TOKEN = "tok-test";
const server = createServer((req, res) => {
  const ok = req.headers.authorization === `Bearer ${TOKEN}`;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(
    ok
      ? JSON.stringify({ healthy: true })
      : JSON.stringify({ error: "unauthorized — Authorization: Bearer <apiToken from daemon.json>" }),
  );
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
  getPairUrl,
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

// --- round-3 hardening: a 200-anywhere squatter is never "healthy" -----------
// Simulates the classic local squatter: answers 200 to everything, checks no
// auth. It must never be counted as the daemon — with no token, and even with
// the right token (the challenge requires the daemon's 401 signature first).
const wideOpen = createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ healthy: true }));
});
await new Promise<void>((r) => wideOpen.listen(0, "127.0.0.1", r));
const wideOpenPort = (wideOpen.address() as { port: number }).port;
check("healthOnce: 200-anywhere server with no token is NOT healthy", (await healthOnce(wideOpenPort, null)) === false);
check(
  "healthOnce: 200-anywhere server is NOT healthy even with the token (challenge fails, token withheld)",
  (await healthOnce(wideOpenPort, TOKEN)) === false,
);
check(
  "waitForDaemonHealth: 200-anywhere server never becomes healthy",
  (await waitForDaemonHealth({ port: wideOpenPort, timeoutMs: 1500 })) === false,
);
await new Promise<void>((r) => {
  wideOpen.closeAllConnections();
  wideOpen.close(() => r());
});

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
// Null-token state file: an alive responder cannot be proven to be ours, so
// reuse must be blocked and the sidecar must spawn its own daemon instead.
const tokenlessState = join(tmp, "tokenless-daemon.json");
writeFileSync(tokenlessState, JSON.stringify({ room: "tokenless" }));
process.env.OCR_DAEMON_STATE_FILE = tokenlessState;
const nullTokenEntry = fixture("nulltoken.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = nullTokenEntry;
check(
  "startDaemonSidecar with null token does NOT reuse the responder",
  (await startDaemonSidecar(tmp, undefined)) === true,
);
check("null-token reuse blocked: sidecar spawned its own daemon", await until(() => existsSync(nullTokenEntry + ".pid")));
await stopDaemonSidecar();
check(
  "null-token spawned child is stopped",
  await until(() => !pidAlive(Number(readFileSync(nullTokenEntry + ".pid", "utf8")))),
);
process.env.OCR_DAEMON_STATE_FILE = fakeState;
delete process.env.OCR_DAEMON_ENTRY;
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

// --- stdout capture: boot pairing URI (P0-003) --------------------------------
// Mirrors the daemon's boot banner (apps/daemon/src/index.ts): QR art first,
// then the "or paste:" line carrying the opencode-remote://pair URI.
const PAIR_URI =
  "opencode-remote://pair?v=2&relay=ws%3A%2F%2Frelay.example.com&room=abc123&k=dGVzdA%3D%3D&vapid=abc&name=Mac%20mini";
const pairingEntry = fixture(
  "pairing.cjs",
  `console.log("  (terminal QR art)");\nconsole.log("  or paste: ${PAIR_URI}\\n");\nsetInterval(() => {}, 1000);`,
);
process.env.OCR_DAEMON_ENTRY = pairingEntry;
check("pairing-uri child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("pairing URI captured from stdout", await until(() => getPairUrl() === PAIR_URI));
await stopDaemonSidecar();

// A fresh spawn resets the capture — a silent child must not report the
// previous daemon's URI (each spawn owns exactly one URI).
const silentEntry = fixture("silent.cjs", "setInterval(() => {}, 1000);");
process.env.OCR_DAEMON_ENTRY = silentEntry;
check("silent child spawns", (await startDaemonSidecar(tmp, undefined)) === true);
check("silent child starts", await until(() => existsSync(silentEntry + ".pid")));
check("pairing URI reset on fresh spawn (null until printed)", getPairUrl() === null);
await stopDaemonSidecar();
check(
  "silent child is stopped",
  await until(() => !pidAlive(Number(readFileSync(silentEntry + ".pid", "utf8")))),
);

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

// --- bundled artifact smoke (P2-006) -----------------------------------------
// The packaged app runs dist-daemon/index.js (shipped as resources/daemon/
// index.js), so the eval battery must execute the actual bundle — regex checks
// on source can't catch bundling breakage (e.g. esbuild emptying import.meta
// in CJS output). Builds the bundle if missing (the gate's `npm run build`
// already produces it) and probes it exactly like the packaged app would:
// 401 challenge → authenticated 200 on /api/health → dashboard served.
const bundle = join(repoRoot, "apps", "desktop", "dist-daemon", "index.js");
if (!existsSync(bundle)) {
  const built = spawnSync(process.execPath, ["scripts/bundle-daemon.mjs"], {
    cwd: join(repoRoot, "apps", "desktop"),
    stdio: "inherit",
  });
  check("bundle smoke: dist-daemon bundle built", built.status === 0);
}
if (existsSync(bundle)) {
  const smokeHome = mkdtempSync(join(tmpdir(), "ocr-bundle-"));
  const smokeServer = createServer(() => {});
  await new Promise<void>((r) => smokeServer.listen(0, "127.0.0.1", r));
  const smokePort = (smokeServer.address() as { port: number }).port;
  await new Promise<void>((r) => smokeServer.close(r));
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, HOME: smokeHome, RELAY_URL: "ws://127.0.0.1:1", OCR_METRICS_PORT: String(smokePort) },
    stdio: "ignore",
  });
  process.on("exit", () => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  });

  // wait for the metrics/API server: the unauthenticated request must get the
  // daemon's 401 challenge (same signature healthOnce demands)
  let challenged = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !challenged) {
    try {
      const res = await fetch(`http://127.0.0.1:${smokePort}/api/health`);
      challenged = res.status === 401;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check("bundle smoke: unauthenticated /api/health gets the 401 challenge", challenged);

  const stateFile = join(smokeHome, ".opencode-remote", "daemon.json");
  let token = "";
  for (let i = 0; i < 50 && !token; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      token = (JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken ?? "";
    } catch {
      /* identity not persisted yet */
    }
  }
  const authRes = await fetch(`http://127.0.0.1:${smokePort}/api/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const authBody = (await authRes.json()) as { healthy?: boolean; version?: string };
  check(
    "bundle smoke: authenticated /api/health is 200 healthy",
    authRes.status === 200 && authBody.healthy === true && typeof authBody.version === "string",
  );
  check(
    "bundle smoke: GET /dashboard is 200 (import.meta survives CJS bundling)",
    (await fetch(`http://127.0.0.1:${smokePort}/dashboard`)).status === 200,
  );

  child.kill("SIGTERM");
  check("bundle smoke: child exits on SIGTERM", await until(() => !pidAlive(child.pid ?? -1)));
} else {
  check("bundle smoke: dist-daemon bundle exists", false);
}

console.log(failures === 0 ? "\ndesktop sidecar tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
