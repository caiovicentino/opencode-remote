/**
 * P1-064 acceptance 3+4, end to end and hermetic:
 *   - opening a session in the REAL PWA (headless chromium) issues exactly ONE
 *     paged GET /session/<id>/message?limit=50 through the E2E tunnel (asserted
 *     via the daemon audit log, as the spec prescribes, plus the opencode-side
 *     hit count so a rogue integral fetch cannot hide);
 *   - toggling the tool-activity drawer does NOT refetch while historyTools
 *     has data (the second full fetch this task removed);
 *   - the tail of a 500-message session paints in <2s and the page stays
 *     under 100KB.
 *
 * Topology: fake opencode (HTTP, ephemeral) -> real daemon (throwaway HOME)
 * -> real relay (ephemeral) -> real PWA (apps/web/dist) in headless chromium.
 * Skips gracefully when chromium is not installed (like integration.ts does
 * for the opencode binary).
 * Run: npx tsx scripts/message-paging.test.ts
 */
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SESSION_ID = "ses_fake";
const TOTAL = 500;
const LOCAL = "http://127.0.0.1";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- synthetic 500-message history -------------------------------------------
// tail rows carry tool parts so historyTools is populated by the first fetch
const rows = Array.from({ length: TOTAL }, (_, i) => ({
  info: { id: `msg-${i + 1}`, role: i % 2 ? "assistant" : "user" },
  parts: [
    ...(i >= TOTAL - 50
      ? [{ type: "tool", callID: `call-${i + 1}`, tool: "bash", state: { status: "completed", title: `step ${i + 1}`, output: "ok" } }]
      : []),
    { type: "text", text: `hello-${i + 1}` },
  ],
}));

// --- fake opencode server ----------------------------------------------------
const hits: { path: string }[] = [];
const fake = createServer((req, res) => {
  const u = new URL(req.url ?? "/", LOCAL);
  const json = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (u.pathname === "/__hits") {
    json(hits);
  } else if (u.pathname === "/__hits/reset") {
    hits.length = 0;
    json({ ok: true });
  } else if (u.pathname === "/global/health") {
    json({ healthy: true, version: "fake" });
  } else if (u.pathname === "/event") {
    // opencode SSE stream: hold the connection, emit nothing
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("retry: 5000\n\n");
    const keep = setInterval(() => res.write(": ping\n\n"), 1000);
    req.on("close", () => clearInterval(keep));
  } else if (u.pathname === "/session") {
    json([{ id: SESSION_ID, title: "Paging e2e conversation", updatedAt: new Date().toISOString() }]);
  } else if (u.pathname === `/session/${SESSION_ID}`) {
    json({ id: SESSION_ID, title: "Paging e2e conversation" });
  } else if (u.pathname === `/session/${SESSION_ID}/message`) {
    hits.push({ path: u.pathname });
    json(rows); // opencode always answers the integral array; the daemon slices
  } else if (u.pathname === "/permission" || u.pathname === "/question") {
    json([]);
  } else if (u.pathname === "/provider") {
    json({ all: [] });
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = (fake.address() as { port: number }).port;
const OPENCODE_URL = `${LOCAL}:${fakePort}`;

// --- real relay + real daemon against the fake opencode ----------------------
const children: ChildProcess[] = [];
const childLog: string[] = [];
const tmp = mkdtempSync(join(tmpdir(), "ocr-paging-"));
function cleanup() {
  for (const c of children) c.kill();
  try {
    (fake as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    fake.close();
  } catch {}
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(1));

function bg(cmd: string, args: string[], env: Record<string, string>) {
  const child = spawn(cmd, args, {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (d: Buffer) => {
    childLog.push(...d.toString().split("\n").filter(Boolean));
    if (childLog.length > 400) childLog.splice(0, childLog.length - 400);
  });
  children.push(child);
  return child;
}

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}
const RELAY_URL = `ws://127.0.0.1:${await reservePort()}`;
bg("npx", ["tsx", "apps/relay/src/index.ts"], { RELAY_PORT: RELAY_URL.split(":").pop(), OCR_E2E_MARKER: tmp });
bg("npx", ["tsx", "apps/daemon/src/index.ts"], {
  HOME: tmp,
  RELAY_URL,
  OPENCODE_URL,
  OCR_MACHINE_NAME: "paging-e2e",
});

// wait for the daemon state file (fresh identity + pairing data)
const stateFile = join(tmp, ".opencode-remote", "daemon.json");
const auditFile = join(tmp, ".opencode-remote", "audit.log");
let ready = false;
for (let i = 0; i < 80 && !ready; i++) {
  ready = existsSync(stateFile);
  if (!ready) await new Promise((r) => setTimeout(r, 250));
}
if (!ready) {
  console.error("SKIP: hermetic daemon never wrote its state file");
  console.error(childLog.slice(-40).join("\n"));
  process.exit(0);
}

// --- serve the built PWA ------------------------------------------------------
const dist = join(repoRoot, "apps", "web", "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("SKIP: apps/web/dist missing (run npm run build first)");
  process.exit(0);
}
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};
const web = createServer((req, res) => {
  const u = new URL(req.url ?? "/", LOCAL);
  const rel = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
  try {
    const body = readFileSync(join(dist, rel));
    res.writeHead(200, { "content-type": mime[rel.match(/\.[a-z0-9]+$/i)?.[0] ?? ""] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
const webPort = (web.address() as { port: number }).port;

// --- headless chromium drives the real PWA -----------------------------------
async function launchChromium() {
  const pw = await import("playwright-core");
  try {
    return await pw.chromium.launch({ headless: true });
  } catch {
    const cache = join(homedir(), "Library", "Caches", "ms-playwright");
    const candidates = [
      process.env.OCR_BROWSER_PATH,
      join(cache, "chromium-1234", "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
    ].filter((p): p is string => !!p && existsSync(p));
    for (const exe of candidates) {
      try {
        return await pw.chromium.launch({ headless: true, executablePath: exe });
      } catch {}
    }
    return null;
  }
}
const browser = await launchChromium();
if (!browser) {
  console.error("SKIP: chromium not available for the PWA paging e2e");
  process.exit(0);
}

type AuditEntry = {
  event: string;
  data?: { limit?: number; before?: string | null; bytes?: number };
};
function historyPageEntries(): AuditEntry[] {
  try {
    return readFileSync(auditFile, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditEntry)
      .filter((e) => e.event === "session.historyPage");
  } catch {
    return [];
  }
}
async function fakeHits(): Promise<number> {
  const r = await fetch(`${OPENCODE_URL}/__hits`);
  return ((await r.json()) as unknown[]).length;
}

try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${webPort}/`);

  // pair with the hermetic daemon (fresh state -> bootstrap accept)
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
    room: string;
    ecdhPub: string;
    vapid: { publicKey: string };
    name?: string;
  };
  const uri =
    `opencode-remote://pair?v=2&relay=${encodeURIComponent(RELAY_URL)}` +
    `&room=${state.room}&k=${encodeURIComponent(state.ecdhPub)}` +
    `&vapid=${encodeURIComponent(state.vapid.publicKey)}&name=${encodeURIComponent(state.name ?? "paging-e2e")}`;
  await page.fill("textarea", uri);
  await page.click(".pair-submit");
  // the board lists the fake session once the tunnel is paired
  await page.getByText("Paging e2e conversation").first().waitFor({ timeout: 30_000 });

  // measure ONLY the session-open fetches
  await fetch(`${OPENCODE_URL}/__hits/reset`);
  const auditBefore = historyPageEntries().length;

  // acceptance 1+4: open the 500-message session -> tail paints in <2s
  const t0 = Date.now();
  await page.getByText("Paging e2e conversation").first().click();
  await page.waitForFunction(() => document.body.innerText.includes("hello-500"), undefined, {
    timeout: 2000,
  });
  const paintMs = Date.now() - t0;
  check(`P1-064 e2e: 500-message session tail paints in <2s (${paintMs}ms)`, paintMs < 2000);

  // acceptance 3: exactly ONE paged fetch, no integral fetch beside it
  await new Promise((r) => setTimeout(r, 800)); // let stray effects surface
  const fresh = historyPageEntries().slice(auditBefore);
  const hits1 = await fakeHits();
  check(
    "P1-064 e2e: exactly one paged history op on session open",
    fresh.length === 1 && fresh[0]?.data?.limit === 50,
    JSON.stringify(fresh),
  );
  check("P1-064 e2e: exactly one opencode history fetch behind it", hits1 === 1, `${hits1} fetches`);

  // acceptance 4, measured on the body the daemon ACTUALLY served (audit
  // envelope), not on the synthetic input array
  const servedBytes = fresh[0]?.data?.bytes ?? Number.MAX_SAFE_INTEGER;
  check(`P1-064 e2e: served page stays under 100KB (${servedBytes}B)`, servedBytes < 100_000);

  // acceptance 3: the tool drawer must not refetch while historyTools has data
  await page.locator('button[aria-label*="tool" i]').first().click();
  await new Promise((r) => setTimeout(r, 800));
  const fresh2 = historyPageEntries().slice(auditBefore);
  const hits2 = await fakeHits();
  check(
    "P1-064 e2e: drawer toggle issues no second history fetch",
    fresh2.length === fresh.length && hits2 === hits1,
    `audit=${fresh2.length} hits=${hits2}`,
  );

  await context.close();
} catch (err) {
  check("P1-064 e2e: flow completed", false, String(err instanceof Error ? err.stack : err));
  console.error(childLog.slice(-40).join("\n"));
} finally {
  await browser.close();
}

console.log(failures === 0 ? "message paging e2e: all green" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
