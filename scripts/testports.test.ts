/**
 * scripts/testports.ts — kernel-chosen free ports for tests that hand a port
 * to a child (relay RELAY_PORT/RELAY_METRICS_PORT, pwa-server PWA_PORT).
 *
 * Pins: the returned ports are real and bindable right away (a pair means
 * p and p+1), a port held by a live listener is never handed out, and no
 * suite picks a random port in the ephemeral range again (the idiom behind
 * 4 of 300 CI runs dying with EADDRINUSE, 2026-09-22..24).
 * Run: npx tsx scripts/testports.test.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePortPairSync, freePortSync } from "./testports";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

setTimeout(() => {
  console.error("testports test timed out (global 60s)");
  process.exit(1);
}, 60_000).unref();

/** Bind like the relay does (`listen(port)`, every interface). */
function bind(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.listen(port, () => resolve(s));
  });
}
const close = (s: Server | null) => new Promise<void>((r) => (s ? s.close(() => r()) : r()));

{
  const p = freePortSync();
  check("freePortSync: an integer TCP port", Number.isInteger(p) && p > 0 && p <= 65535, String(p));
  const s = await bind(p);
  check("freePortSync: the port binds right away", s !== null, String(p));
  await close(s);
}

{
  const p = freePortPairSync();
  check("freePortPairSync: p and p+1 are TCP ports", Number.isInteger(p) && p > 0 && p < 65535, String(p));
  const a = await bind(p);
  const b = await bind(p + 1);
  check("freePortPairSync: p (relay) and p+1 (metrics) both bind right away", a !== null && b !== null, String(p));
  await close(a);
  await close(b);
}

{
  // a live listener's port is never handed out, alone or as either half of a pair
  const held = await bind(0);
  const heldPort = (held?.address() as { port: number } | null)?.port ?? -1;
  const singles = Array.from({ length: 5 }, () => freePortSync());
  const pairs = Array.from({ length: 5 }, () => freePortPairSync());
  check(
    "held ports are never returned",
    heldPort > 0 && !singles.includes(heldPort) && !pairs.some((p) => p === heldPort || p + 1 === heldPort),
    JSON.stringify({ heldPort, singles, pairs }),
  );
  await close(held);
}

{
  // Real-repo guard: the random-port idiom must not come back in any suite.
  const here = dirname(fileURLToPath(import.meta.url));
  const RANDOM_PORT = /\b\d{2}_?000\s*\+\s*Math\.floor\(\s*Math\.random\(\)\s*\*\s*\d{1,3}_?\d{3}\s*\)/;
  const offenders = readdirSync(here)
    .filter((f) => f.endsWith(".ts"))
    // testports.ts and this file only quote the idiom in prose
    .filter((f) => f !== "testports.ts" && f !== "testports.test.ts" && RANDOM_PORT.test(readFileSync(join(here, f), "utf8")));
  check(
    "no suite picks a random port in the ephemeral range (use freePortSync/freePortPairSync from scripts/testports.ts)",
    offenders.length === 0,
    offenders.join(", "),
  );
}

if (failures > 0) {
  console.error(`\ntestports tests: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ntestports tests: all green");
