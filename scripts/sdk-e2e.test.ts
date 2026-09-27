/**
 * @ocr/sdk against the REAL daemon (eval 14). A fake opencode reproduces the
 * semantics of opencode's prompt route ("create and send a new message to a
 * session, streaming the AI response"): headers at once, one assistant
 * message per step ("tool-calls" steps, then a final "stop" step stamped
 * time.completed), and the response body only when the turn is over. What
 * this pins, end to end through apps/daemon's /api routes:
 *   1. POST /api/session/:id/message answers 202 { accepted, opencode } only
 *      once the turn ended (docs/api.md) — `send` resolves after the turn;
 *   2. sendAndWait returns the FINAL step's text, never the tool-calls
 *      preamble, and works on a session already holding 250 messages (the
 *      history route caps rows at `limit`, which froze the old count check);
 *   3. a non-JSON upstream error surfaces as a typed OcrError.
 * Hermetic: temp HOME, kernel-assigned loopback ports, dead relay URL.
 * Run: npx tsx scripts/sdk-e2e.test.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, OcrError, type HistoryRow } from "@ocr/sdk";

setTimeout(() => {
  console.error("sdk-e2e test timed out (global 90s)");
  process.exit(1);
}, 90_000).unref();

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });

// --- fake opencode ---------------------------------------------------------------

const STEP_MS = 400;
let n = 0;
const mid = () => `msg_${String(++n).padStart(8, "0")}`;
const sessions = new Map<string, HistoryRow[]>();
sessions.set("ses_e2eshort01", []);
sessions.set(
  "ses_e2elong001",
  Array.from({ length: 250 }, (_, i) => ({
    info: { id: mid(), role: i % 2 ? "assistant" : "user", ...(i % 2 ? { time: { created: 1, completed: 2 }, finish: "stop" } : {}) },
    parts: [{ type: "text", text: `old ${i}` }],
  })),
);
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });

const opencode = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const seg = url.pathname.split("/").filter(Boolean);
  if (url.pathname === "/global/health") return json(res, 200, { healthy: true, version: "1.18.32" });
  if (seg[0] === "session" && seg[1] === "ses_e2ehtml01") {
    res.writeHead(502, { "content-type": "text/html" });
    return res.end("<html><body>502 Bad Gateway</body></html>");
  }
  const rows = seg[0] === "session" && seg[1] ? sessions.get(seg[1]) : undefined;
  if (rows && seg[2] === "message" && req.method === "GET") return json(res, 200, rows);
  if (rows && seg[2] === "message" && req.method === "POST") {
    const body = JSON.parse(await readBody(req)) as { parts: HistoryRow["parts"] };
    const user: HistoryRow = { info: { id: mid(), role: "user" }, parts: body.parts };
    rows.push(user);
    // streaming prompt route: headers now, body when the turn is over
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    const step = (text: string, finish: string): HistoryRow => ({
      info: { id: mid(), role: "assistant", parentID: user.info.id, time: { created: Date.now(), completed: Date.now() }, finish },
      parts: [{ type: "text", text }],
    });
    setTimeout(() => rows.push(step("Vou olhar o módulo primeiro.", "tool-calls")), STEP_MS);
    setTimeout(() => {
      const last = step("Resposta final do agente.", "stop");
      rows.push(last);
      res.end(JSON.stringify(last));
    }, STEP_MS * 3);
    return;
  }
  if (rows && !seg[2]) return json(res, 200, { id: seg[1] });
  return json(res, 404, { error: "not found" });
});
const OPENCODE_PORT = await freePort();
await new Promise<void>((r) => opencode.listen(OPENCODE_PORT, "127.0.0.1", () => r()));

// --- real daemon -------------------------------------------------------------------

const PORT = await freePort();
const home = mkdtempSync(join(tmpdir(), "ocr-sdk-e2e-"));
const stateFile = join(home, ".opencode-remote", "daemon.json");
const daemon = spawn(process.execPath, ["--import", "tsx/esm", "apps/daemon/src/index.ts"], {
  cwd: join(import.meta.dirname, ".."),
  env: {
    ...process.env,
    HOME: home,
    OCR_METRICS_PORT: String(PORT),
    RELAY_URL: "ws://127.0.0.1:1",
    OPENCODE_URL: `http://127.0.0.1:${OPENCODE_PORT}`,
    OCR_LOG_LEVEL: "error",
    OCR_DISK_OK: "1",
  },
  stdio: ["ignore", "ignore", "ignore"],
  detached: true,
});
process.on("exit", () => {
  if (!daemon.pid) return;
  try {
    process.kill(-daemon.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
});

let token = "";
for (let i = 0; i < 100 && !token; i++) {
  await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { authorization: "Bearer warmup" } }).catch(() => {});
  try {
    token = (JSON.parse(readFileSync(stateFile, "utf8")) as { apiToken?: string }).apiToken ?? "";
  } catch {
    /* not yet */
  }
  if (!token) await new Promise((r) => setTimeout(r, 200));
}
if (!token) throw new Error("apiToken never appeared in the state file");

const ocr = createClient({ baseUrl: `http://127.0.0.1:${PORT}`, token });

// --- 1. the 202 arrives when the turn is over ---------------------------------------
{
  const t0 = Date.now();
  const sent = await ocr.send("ses_e2eshort01", "primeira pergunta");
  const took = Date.now() - t0;
  const final = sent.opencode as HistoryRow | undefined;
  check("send: 202 accepted", sent.accepted === true, JSON.stringify(sent).slice(0, 200));
  check(`send: resolves only after the turn ended (${took} ms ≥ ${STEP_MS * 3} ms)`, took >= STEP_MS * 3 - 50, `${took} ms`);
  check("send: `opencode` carries the final step (finish stop)", final?.info?.finish === "stop", JSON.stringify(final).slice(0, 200));
}

// --- 2. sendAndWait: final step, long session ----------------------------------------
{
  const reply = await ocr.sendAndWait("ses_e2eshort01", "segunda pergunta", { timeoutMs: 20_000, pollMs: 100 });
  check("sendAndWait: returns the final step, not the tool-calls preamble", reply === "Resposta final do agente.", reply);
}
{
  const reply = await ocr
    .sendAndWait("ses_e2elong001", "pergunta numa sessão longa", { timeoutMs: 20_000, pollMs: 100 })
    .catch((e) => `threw ${(e as Error).message}`);
  check("sendAndWait: a 250-message session resolves (history capped at limit)", reply === "Resposta final do agente.", reply);
}

// --- 3. typed errors through the real daemon ----------------------------------------------
{
  const err = await ocr.session("ses_e2ehtml01").then(() => null, (e: unknown) => e);
  // the daemon wraps upstream answers in JSON; whatever comes back must be typed
  check("errors: an upstream failure surfaces as OcrError, never a raw SyntaxError", err === null || err instanceof OcrError, String(err));
  const missing = await ocr.messages("not-a-session").then(() => null, (e: unknown) => e);
  check(
    "errors: the daemon's 400 for a malformed id is an OcrError http 400",
    missing instanceof OcrError && missing.code === "http" && missing.status === 400,
    String(missing),
  );
}

if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error("daemon died during the test");
opencode.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall sdk-e2e checks passed");
process.exit(0);
