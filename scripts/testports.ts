/**
 * Free ports for tests that must hand a concrete port to a child process
 * (the relay reads RELAY_PORT / RELAY_METRICS_PORT and cannot bind 0 and
 * report back; deploy/pwa-server.mjs reads PWA_PORT).
 *
 * Six suites used to pick `40_000 + Math.floor(Math.random() * 20_000)` (or
 * 30_000 + …) and the metrics port right above it. That range sits inside
 * the kernel's ephemeral range (Linux 32768-60999, macOS 49152-65535), so a
 * port already held by any live socket — another test's client connection,
 * a sibling slot's relay — made the child die with EADDRINUSE and the test
 * red: 4 of 300 CI runs between 2026-09-22 and 2026-09-24 (relay-ratelimit
 * twice, relay-liveness, relay-healthz). The kernel knows which ports are
 * free: bind 0 (every interface, like the relay's own `listen(PORT)`), for a
 * pair also prove port+1 is bindable, release, hand over. The window between
 * the release and the child's bind is now microseconds instead of a coin
 * toss against every socket on the machine.
 *
 * Synchronous on purpose — a short node child does the binding — so the
 * call sites' spawn helpers stay synchronous: the fix is one line each.
 */
import { spawnSync } from "node:child_process";

/** Probe run in a node child: `PORT=<p>` on stdout, p (and p+1 when pair=1) bindable. */
const PROBE = `
const net = require("node:net");
const pair = process.argv[1] === "1";
let tries = 0;
function attempt() {
  if (++tries > 50) { console.error("no free port after 50 tries"); process.exit(1); }
  const a = net.createServer();
  a.once("error", attempt);
  a.listen(0, () => {
    const p = a.address().port;
    if (!pair) { a.close(() => console.log("PORT=" + p)); return; }
    if (p >= 65535) { a.close(attempt); return; }
    const b = net.createServer();
    b.once("error", () => a.close(attempt));
    b.listen(p + 1, () => b.close(() => a.close(() => console.log("PORT=" + p))));
  });
}
attempt();
`;

function probe(pair: boolean): number {
  const r = spawnSync(process.execPath, ["-e", PROBE, pair ? "1" : "0"], { encoding: "utf8", timeout: 15_000 });
  const m = /^PORT=(\d+)$/m.exec(r.stdout ?? "");
  const port = m ? Number(m[1]) : NaN;
  if (r.status !== 0 || !Number.isInteger(port) || port <= 0 || port > (pair ? 65534 : 65535)) {
    throw new Error(`testports: no free ${pair ? "port pair" : "port"} (status ${r.status}): ${(r.stderr ?? "").trim() || String(r.error ?? "")}`);
  }
  return port;
}

/** A port that was free on every interface a moment ago. */
export function freePortSync(): number {
  return probe(false);
}

/** A port p such that p and p+1 were both free (relay + its metrics listener at p+1). */
export function freePortPairSync(): number {
  return probe(true);
}
