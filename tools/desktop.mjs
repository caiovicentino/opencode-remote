#!/usr/bin/env node
// P1-051: Playwright _electron harness for the real desktop shell. Same DX as
// tools/browse.mjs (silent stdout, exit code = verdict), but drives the actual
// Electron app instead of a host browser:
//   node tools/desktop.mjs open [shot.png [w h]]   launch (or reuse) the app
//   node tools/desktop.mjs see <texto>             assert visible text
//   node tools/desktop.mjs click <selector>        real click (Playwright)
//   node tools/desktop.mjs type <selector> <texto> fill a form field
//   node tools/desktop.mjs shot <out.png> [w h]    window screenshot (w/h = content px)
//   node tools/desktop.mjs ipc <expr>              eval against window.ocrDesktop, JSON out
//   node tools/desktop.mjs close                   quit the app + keeper
// The app is launched hermetically by a detached keeper process (temp
// userData, no daemon sidecar) that survives between CLI calls until the idle
// TTL expires. OCR_DESKTOP_SESSION keys the keeper socket so a gate run never
// reuses (or kills) a builder's leftover session.
// Security (P1-051 round 2 review): all session state lives in a 0700
// session-owned dir — a world-connectable socket in /tmp would let any local
// account run JS in the renderer (ipc), drive input (click/type) or overwrite
// files (shot), and a predictable /tmp log path follows pre-placed symlinks.
// The Unix socket is chmod 0600 after listen and every request must carry the
// per-session random token (0600 file in the same dir), so a peer that cannot
// read the token can neither drive the app nor spoof gate verdicts.
import { spawn } from "node:child_process";
import { connect as netConnect, createServer } from "node:net";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, "..");
const SESSION = process.env.OCR_DESKTOP_SESSION || "main";
const SESSION_DIR = join(tmpdir(), `ocr-desktop-${SESSION}`);
const SOCK = join(SESSION_DIR, "keeper.sock");
const LOG = join(SESSION_DIR, "keeper.log");
const TOKEN_FILE = join(SESSION_DIR, "token");
const IDLE_TTL_MS = Number(process.env.OCR_DESKTOP_TTL_MS) || 5 * 60_000;
const CLOSE_DEADLINE_MS = 12_000;
const BOOT_TIMEOUT_MS = 90_000;
const CMD_TIMEOUT_MS = 20_000;

const [, , cmd, ...args] = process.argv;

if (process.env.OCR_DESKTOP_KEEPER === "1") {
  keeperMain().catch((err) => {
    keeperLog("keeper crashed:", err?.stack ?? err);
    process.exit(1);
  });
} else {
  clientMain().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exit(1);
  });
}

// --- client -------------------------------------------------------------------

/** The keeper mints a per-session token at boot (0600 file in the 0700
 * session dir); every request carries it. null = no keeper (or mid-boot). */
function readToken() {
  try {
    const token = readFileSync(TOKEN_FILE, "utf8").trim();
    return token || null;
  } catch {
    return null;
  }
}

/** Fail closed: a session dir we cannot lock down (e.g. planted by another
 * account before us) must never carry the socket — that is the spoof surface. */
function ensureSessionDir() {
  mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(SESSION_DIR, 0o700);
  } catch (err) {
    throw new Error(`session dir ${SESSION_DIR} is not ours to chmod 0700 (${err?.code ?? err})`);
  }
}

async function clientMain() {
  if (!cmd || cmd === "help") {
    console.log(
      "usage: node tools/desktop.mjs open [shot.png [w h]] | see <texto> | click <sel> | " +
        "type <sel> <texto> | shot <out.png> [w h] | ipc <expr> | close",
    );
    process.exit(cmd ? 0 : 2);
  }
  if (cmd === "open") {
    const [shotOut, w, h] = args;
    let res = await send({ cmd: "ping" }, 5_000);
    let reused = !!res?.ok;
    if (!reused) {
      spawnKeeper();
      res = await pollKeeper();
      reused = false;
      if (!res) {
        console.error(`desktop keeper did not boot within ${BOOT_TIMEOUT_MS}ms; keeper log tail:`);
        console.error(logTail());
        process.exit(1);
      }
    }
    if (shotOut) {
      const shot = await send({ cmd: "shot", out: shotOut, w, h });
      fail(shot);
      console.log(JSON.stringify({ ...shot, reused, session: SESSION }));
      return;
    }
    console.log(JSON.stringify({ ok: true, reused, session: SESSION }));
    return;
  }
  if (cmd === "see") {
    fail(await send({ cmd: "see", text: args[0] }));
  } else if (cmd === "click") {
    fail(await send({ cmd: "click", selector: args[0] }));
  } else if (cmd === "type") {
    fail(await send({ cmd: "type", selector: args[0], text: args[1] ?? "" }));
  } else if (cmd === "shot") {
    fail(await send({ cmd: "shot", out: args[0] ?? "shot.png", w: args[1], h: args[2] }));
  } else if (cmd === "ipc") {
    fail(await send({ cmd: "ipc", expr: args[0] }));
  } else if (cmd === "close") {
    fail(await send({ cmd: "close" }, CLOSE_DEADLINE_MS + 5_000));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
}

function fail(res) {
  if (!res) {
    console.error(`desktop keeper not running (session ${SESSION}) — run: node tools/desktop.mjs open`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(res.error ?? "unknown desktop harness failure");
    process.exit(1);
  }
  if (res.result !== undefined) console.log(JSON.stringify(res.result, null, 2));
  else if (res.path) console.log(JSON.stringify(res, null, 2));
  else console.log(JSON.stringify({ ok: true, session: SESSION }));
}

/** One JSON-line request to the keeper; null when it is not running. The
 * session token is attached to every request, and the keeper must answer with
 * sha256(token:nonce) — proof only the real keeper (or the owner of the token
 * file) can produce. A hijacked socket path answering blind {ok:true} fails
 * the proof, so a spoofed keeper can never turn a gate green. */
async function send(msg, timeoutMs = CMD_TIMEOUT_MS) {
  const token = readToken();
  if (!token) return null;
  const nonce = randomBytes(8).toString("hex");
  const sock = await new Promise((resolveSock, rejectSock) => {
    const s = netConnect(SOCK);
    s.once("error", rejectSock);
    s.once("connect", () => {
      s.removeListener("error", rejectSock);
      resolveSock(s);
    });
  }).catch(() => null);
  if (!sock) return null;
  try {
    return await new Promise((resolveRes, rejectRes) => {
      let buf = "";
      const timer = setTimeout(() => rejectRes(new Error(`${msg.cmd}: no reply in ${timeoutMs}ms`)), timeoutMs);
      sock.setEncoding("utf8");
      sock.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        clearTimeout(timer);
        const res = JSON.parse(buf.slice(0, nl));
        if (res.ok === true && res.proof !== createHash("sha256").update(`${token}:${nonce}`).digest("hex")) {
          rejectRes(new Error("keeper failed the token proof — something else is answering on this socket"));
          return;
        }
        resolveRes(res);
      });
      sock.on("error", (err) => {
        clearTimeout(timer);
        rejectRes(err);
      });
      sock.write(JSON.stringify({ ...msg, token, nonce }) + "\n");
    });
  } finally {
    sock.destroy();
  }
}

function spawnKeeper() {
  ensureSessionDir();
  try {
    unlinkSync(SOCK); // stale socket of a dead keeper
    unlinkSync(TOKEN_FILE); // stale token — the fresh keeper mints its own
  } catch {}
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: "ignore",
    cwd: repoRoot,
    env: { ...process.env, OCR_DESKTOP_KEEPER: "1" },
  });
  child.unref();
}

async function pollKeeper() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await send({ cmd: "ping" }, 5_000).catch(() => null);
    if (res?.ok) return res;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function logTail() {
  try {
    return readFileSync(LOG, "utf8").split("\n").slice(-15).join("\n");
  } catch {
    return "(no keeper log)";
  }
}

// --- keeper -------------------------------------------------------------------

function keeperLog(...parts) {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${parts.join(" ")}\n`);
  } catch {}
}

/** Deterministic launch env: temp userData (isolates bounds/logs AND the
 * single-instance lock), a state file without apiToken (daemon.ts never
 * reuses the production daemon) and a nonexistent OCR_DAEMON_ENTRY so NO
 * sidecar is spawned (app log shows "no daemon entry found"). OCR_DAEMON_
 * FORCE_DOWN makes isDaemonDown() deterministic — the pairing state is the
 * stable daemon-down object instead of null. Same test-only pattern as the
 * other OCR_DAEMON_* escape hatches. */
function hermeticEnv() {
  const dir = mkdtempSync(join(tmpdir(), "ocr-desktop-app-"));
  const stateFile = join(dir, "daemon-state.json");
  writeFileSync(stateFile, "{}");
  return {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    OCR_USER_DATA_DIR: dir,
    OCR_DAEMON_STATE_FILE: stateFile,
    OCR_DAEMON_ENTRY: join(dir, "no-daemon-entry.js"),
    OCR_DAEMON_FORCE_DOWN: "1",
  };
}

async function keeperMain() {
  process.on("uncaughtException", (err) => {
    keeperLog("uncaught:", err?.stack ?? err);
    process.exit(1);
  });
  ensureSessionDir();
  // Per-session auth token (P1-051 round 2): written 0600 inside the 0700
  // session dir BEFORE the socket is bound. Peers that cannot read it are
  // rejected, so binding the well-known socket path alone buys nothing.
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
  const req = createRequire(join(repoRoot, "package.json"));
  const { _electron } = req("playwright-core");
  const env = hermeticEnv();
  // P1-053: the desktop-flow gate records the "reconnecting…" banner state in
  // a second hermetic launch — mutually exclusive with the daemon-down one,
  // so the caller opts in via the session env and FORCE_DOWN is dropped.
  if (process.env.OCR_DAEMON_FORCE_RECONNECTING === "1") {
    delete env.OCR_DAEMON_FORCE_DOWN;
    env.OCR_DAEMON_FORCE_RECONNECTING = "1";
  }
  keeperLog("launching electron (session", SESSION + ")");
  const electronApp = await _electron.launch({
    args: [join(repoRoot, "apps", "desktop")],
    cwd: repoRoot,
    executablePath: req("electron"),
    env,
  });
  const page = await electronApp.firstWindow();
  try {
    await page.waitForSelector("#root > *", { timeout: 30_000 });
  } catch {
    keeperLog("#root never mounted — is apps/web/dist built? (npm run build --workspace @ocr/web)");
    await quit(electronApp);
    process.exit(1);
  }
  keeperLog("app ready, userData:", env.OCR_USER_DATA_DIR);

  let idleTimer = setTimeout(() => {
    keeperLog("idle TTL expired");
    void shutdown(electronApp, 0);
  }, IDLE_TTL_MS);
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      keeperLog("idle TTL expired");
      void shutdown(electronApp, 0);
    }, IDLE_TTL_MS);
  };

  const server = createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // Token check + signed reply: only the token holder gets work done,
        // and only the token holder can produce proofs the client accepts —
        // a fake server on this path can answer, but never convincingly.
        if (msg.token !== token) {
          keeperLog("unauthorized request (bad token) — ignored");
          sock.write(JSON.stringify({ ok: false, error: "unauthorized: bad session token" }) + "\n");
          return;
        }
        const reply = (res) => {
          if (res.ok === true) {
            res.proof = createHash("sha256").update(`${token}:${String(msg.nonce)}`).digest("hex");
          }
          sock.write(JSON.stringify(res) + "\n");
        };
        if (msg.cmd === "close") {
          reply({ ok: true });
          sock.end();
          keeperLog("close requested");
          void shutdown(electronApp, 0);
          return;
        }
        resetIdle();
        handle(electronApp, page, msg)
          .then(reply)
          .catch((err) => reply({ ok: false, error: String(err?.message ?? err).split("\n")[0] }));
      }
    });
  });
  server.on("error", (err) => {
    keeperLog("server error:", err);
    process.exit(1);
  });
  try {
    unlinkSync(SOCK);
  } catch {}
  server.listen(SOCK, () => {
    // Defense in depth: even inside the 0700 dir, only the owner may connect.
    try {
      chmodSync(SOCK, 0o600);
    } catch (err) {
      keeperLog("socket chmod failed:", err);
    }
  });

  const stop = () => void shutdown(electronApp, 0);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

async function handle(electronApp, page, msg) {
  switch (msg.cmd) {
    case "ping": {
      // Liveness probe, not a stub: the renderer target can die while the
      // Electron process lingers — the next real command must not be the
      // first to find out.
      try {
        await page.evaluate("1");
      } catch (err) {
        keeperLog("app target is dead:", String(err).split("\n")[0]);
        void shutdown(electronApp, 1);
        return { ok: false, error: "app target is dead; keeper restarting" };
      }
      return { ok: true, session: SESSION };
    }
    case "see": {
      try {
        await page.getByText(msg.text).first().waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        throw new Error(`text not visible: ${msg.text}`);
      }
      return { ok: true };
    }
    case "click":
      try {
        await page.click(msg.selector, { timeout: 10_000 });
      } catch {
        throw new Error(`click failed: ${msg.selector}`);
      }
      return { ok: true };
    case "type":
      try {
        await page.fill(msg.selector, msg.text, { timeout: 10_000 });
      } catch {
        throw new Error(`fill failed: ${msg.selector}`);
      }
      return { ok: true };
    case "shot":
      return shot(page, electronApp, msg);
    case "ipc": {
      const result = await page.evaluate(msg.expr);
      return { ok: true, result };
    }
    default:
      throw new Error(`unknown command: ${msg.cmd}`);
  }
}

async function shot(page, electronApp, msg) {
  const out = resolve(msg.out ?? "shot.png");
  if (msg.w && msg.h) {
    // _electron pages cannot emulate a viewport: resize the native window's
    // content area, so `shot out.png 1440 900` yields an exact 1440x900 PNG.
    // P1-053: evidence shots below the app's UX minimum (390px mobile) first
    // drop the minimum constraint — test-only session, restored on close.
    await electronApp.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      const [minW, minH] = win.getMinimumSize();
      if (Number(size.w) < minW || Number(size.h) < minH) win.setMinimumSize(0, 0);
      win.setContentSize(size.w, size.h);
    }, { w: Number(msg.w), h: Number(msg.h) });
    await page.waitForTimeout(300);
  }
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, scale: "css", timeout: 10_000 });
  const buf = readFileSync(out);
  return { ok: true, path: out, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function quit(electronApp) {
  // 12s deadline: if the app refuses to quit (stuck will-quit), SIGKILL it —
  // the message must name the real deadline so debugging is not misled.
  const killer = setTimeout(() => {
    keeperLog(`app did not quit within ${CLOSE_DEADLINE_MS}ms — sending SIGKILL`);
    try {
      electronApp.process().kill("SIGKILL");
    } catch {}
  }, CLOSE_DEADLINE_MS);
  try {
    await electronApp.close();
  } catch (err) {
    keeperLog("close failed:", err);
  }
  clearTimeout(killer);
}

async function shutdown(electronApp, code) {
  // Stop accepting new work immediately: once shutdown starts the socket must
  // go away, or a concurrent `open` would adopt a keeper that is quitting.
  // The token goes with it — a session without a keeper has no credentials.
  try {
    unlinkSync(SOCK);
    unlinkSync(TOKEN_FILE);
  } catch {}
  // Hard-exit guarantee: electronApp.close() can hang forever when the app
  // already died or refuses to quit — the keeper must still die, or the
  // session leaks past the idle TTL.
  setTimeout(() => process.exit(code), CLOSE_DEADLINE_MS + 3_000);
  await quit(electronApp);
  process.exit(code);
}
