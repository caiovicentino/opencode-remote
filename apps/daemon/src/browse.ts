// P2-011: browser self-driving on the host via Playwright (chromium, headless).
// The daemon exposes /api/browse/* (all Bearer-authenticated, loopback-bound
// like the rest of /api/*) so agents and the desktop pane can navigate, click,
// extract text and screenshot pages — e.g. to validate UI changes post-deploy.
// Browsers are only launched on demand; everything is torn down after a short
// idle time so the daemon never keeps a fleet of chromium processes alive.
import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "./log.js";
import { metrics } from "./metrics.js";

const MAX_SESSIONS = 3;
const IDLE_CLOSE_MS = 5 * 60_000;
const MAX_TEXT = 200_000;
const VIEWPORT_MAX = 1920;
const NAV_TIMEOUT_MS = 30_000;
const CLICK_TIMEOUT_MS = 8_000;

export function validSession(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(name);
}

/** Only http(s) — the browser must never reach file://, ftp:, chrome:// …
 * Loopback targets (127.0.0.1) are deliberately allowed: the whole point is to
 * screenshot the local dashboard/running UIs. That is not a privilege boundary —
 * every caller already holds the daemon apiToken, which grants the full
 * /api surface anyway (documented in docs/api.md). */
export function browseTarget(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch {
    return null;
  }
}

const VIEWPORT_MIN = 200;

function clampViewport(n: unknown, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), VIEWPORT_MIN), VIEWPORT_MAX);
}

/**
 * Pure helper for the screenshot route: returns a viewport only when BOTH w and
 * h are present and valid. A missing param must keep the current viewport —
 * coercing absent params to 0 (→ min 200×200) silently shrank every default
 * screenshot and desynced click coordinate mapping in the pane.
 */
export function viewportFromParams(
  w: string | null,
  h: string | null,
): { width: number; height: number } | null {
  if (w === null || h === null) return null;
  const width = Number(w);
  const height = Number(h);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 1 || height < 1) return null;
  return {
    width: clampViewport(width, VIEWPORT_MAX),
    height: clampViewport(height, VIEWPORT_MAX),
  };
}

/** Security-relevant actions land in the same audit.log the app reviews. */
function audit(event: string, data?: Record<string, unknown>) {
  try {
    appendFileSync(
      join(homedir(), ".opencode-remote", "audit.log"),
      JSON.stringify({ ts: new Date().toISOString(), event, ...(data ? { data } : {}) }) + "\n",
    );
  } catch {}
}

interface BrowseSession {
  page: import("playwright-core").Page;
  viewport: { width: number; height: number };
  lastUsed: number;
}

const sessions = new Map<string, BrowseSession>();
let browser: import("playwright-core").Browser | null = null;
let sweeper: ReturnType<typeof setInterval> | null = null;

function touch(name: string) {
  const s = sessions.get(name);
  if (s) s.lastUsed = Date.now();
  metrics.inc("ocr_browse_actions_total");
}

function killSwitch(): boolean {
  return process.env.OCR_BROWSE_DISABLED === "1";
}

async function getBrowser(): Promise<import("playwright-core").Browser> {
  if (browser && browser.isConnected()) return browser;
  const pw = await import("playwright-core");
  const exe = process.env.OCR_BROWSER_PATH;
  // The Chromium renderer sandbox stays ON (default): the browser renders
  // untrusted web content on the user's host, and --no-sandbox would turn any
  // Chromium n-day into host compromise. Only environments where the sandbox
  // is known-broken (some hardened containers) may opt out explicitly.
  const noSandbox = process.env.OCR_BROWSE_NO_SANDBOX === "1";
  try {
    browser = await pw.chromium.launch({
      headless: true,
      ...(exe ? { executablePath: exe } : {}),
      args: [...(noSandbox ? ["--no-sandbox"] : []), "--disable-dev-shm-usage"],
    });
  } catch (err) {
    log("warn", "browse: chromium launch failed", { error: String(err).slice(0, 200) });
    throw new Error(
      "playwright chromium not available — install it with: npx playwright install chromium",
    );
  }
  browser.on("disconnected", () => {
    browser = null;
    sessions.clear();
  });
  return browser;
}

// Serialize the open path: concurrent POSTs must not race the LRU eviction
// (both could pass the size check and overshoot MAX_SESSIONS).
let opening: Promise<unknown> = Promise.resolve();

async function openSession(url: string, name: string, w?: unknown, h?: unknown): Promise<BrowseSession> {
  const run = async (): Promise<BrowseSession> => {
    const target = browseTarget(url);
    if (!target) throw new Error("invalid or non-http(s) url");
    // replace-or-evict: an existing session of the same name is closed first,
    // otherwise its context leaks until the next full teardown
    if (sessions.has(name)) await closeSession(name);
    // LRU: never keep more than MAX_SESSIONS live pages around
    while (sessions.size >= MAX_SESSIONS) {
      let oldest = "";
      let oldestAt = Infinity;
      for (const [k, v] of sessions) {
        if (v.lastUsed < oldestAt) {
          oldestAt = v.lastUsed;
          oldest = k;
        }
      }
      if (oldest) await closeSession(oldest);
      else break;
    }
    const viewport = { width: clampViewport(w, 1280), height: clampViewport(h, 800) };
    const b = await getBrowser();
    const ctx = await b.newContext({ viewport });
    const page = await ctx.newPage();
    const session: BrowseSession = { page, viewport, lastUsed: Date.now() };
    sessions.set(name, session);
    await page.goto(target.toString(), { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
    return session;
  };
  const done = opening.then(run, run);
  opening = done.catch(() => {});
  return done;
}

async function closeSession(name: string): Promise<void> {
  const s = sessions.get(name);
  if (!s) return;
  sessions.delete(name);
  try {
    await s.page.context().close();
  } catch {}
}

async function teardown() {
  for (const name of [...sessions.keys()]) await closeSession(name);
  if (browser) {
    try {
      await browser.close();
    } catch {}
    browser = null;
  }
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) {
      if (now - v.lastUsed > IDLE_CLOSE_MS) void closeSession(k);
    }
    if (sessions.size === 0 && browser) void teardown();
  }, 60_000);
  sweeper.unref?.();
}

async function textOf(page: import("playwright-core").Page): Promise<string> {
  try {
    // MAX_TEXT is passed as an argument: evaluate() serializes the callback,
    // so closure variables from the daemon do not exist in the page context.
    return await page.evaluate((max) => (document.body?.innerText ?? "").slice(0, max), MAX_TEXT);
  } catch (err) {
    log("debug", "browse: text extraction failed", { error: String(err).slice(0, 100) });
    return "";
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Browse bodies are tiny (url + selector); anything bigger is an attack. */
const MAX_BODY = 64 * 1024;

async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new Error("body too large");
  }
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function fail(res: ServerResponse, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  log("warn", "browse action failed", { error: msg.slice(0, 200) });
  json(res, 502, { error: msg.slice(0, 300) });
}

/**
 * Handles `/api/browse`* (already Bearer-authenticated by handleApi).
 * Returns false when the request is not a browse route.
 */
export async function handleBrowse(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  seg: string[],
): Promise<boolean> {
  if (seg[1] !== "browse") return false;
  if (killSwitch()) {
    json(res, 503, { error: "browse disabled (OCR_BROWSE_DISABLED=1)" });
    return true;
  }
  startSweeper();
  const action = seg[2] ?? "";
  const sessionName = url.searchParams.get("session") ?? "main";
  if (!validSession(sessionName)) {
    json(res, 400, { error: "bad session name" });
    return true;
  }
  try {
    // GET /api/browse — list live sessions
    if (req.method === "GET" && !action) {
      json(res, 200, {
        sessions: [...sessions.entries()].map(([name, s]) => ({
          name,
          url: s.page.url(),
          ...s.viewport,
        })),
      });
      return true;
    }
    // POST /api/browse/open {url, session?, width?, height?}
    if (req.method === "POST" && action === "open") {
      const body = await bodyJson(req);
      const target = browseTarget(String(body.url ?? ""));
      if (!target) {
        json(res, 400, { error: "url required (http/https)" });
        return true;
      }
      const s = await openSession(
        String(body.url),
        sessionName,
        body.width,
        body.height,
      );
      touch(sessionName);
      audit("browse.open", { url: target.host });
      json(res, 200, {
        url: s.page.url(),
        title: await s.page.title(),
        viewport: s.viewport,
        text: await textOf(s.page),
      });
      return true;
    }
    // POST /api/browse/click {selector? | text? | x,y}
    if (req.method === "POST" && action === "click") {
      const s = sessions.get(sessionName);
      if (!s) {
        json(res, 404, { error: "no such browse session — open a url first" });
        return true;
      }
      const body = await bodyJson(req);
      if (typeof body.selector === "string" && body.selector.length <= 500) {
        await s.page.click(body.selector, { timeout: CLICK_TIMEOUT_MS });
      } else if (typeof body.text === "string" && body.text.length <= 200) {
        await s.page
          .getByText(body.text, { exact: false })
          .first()
          .click({ timeout: CLICK_TIMEOUT_MS });
      } else {
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
          json(res, 400, { error: "selector, text or x/y required" });
          return true;
        }
        await s.page.mouse.click(
          Math.min(x, s.viewport.width),
          Math.min(y, s.viewport.height),
        );
      }
      touch(sessionName);
      await s.page
        .waitForLoadState("load", { timeout: NAV_TIMEOUT_MS })
        .catch(() => {});
      audit("browse.click", { session: sessionName });
      json(res, 200, { url: s.page.url(), title: await s.page.title(), text: await textOf(s.page) });
      return true;
    }
    // GET /api/browse/text?session=
    if (req.method === "GET" && action === "text") {
      const s = sessions.get(sessionName);
      if (!s) {
        json(res, 404, { error: "no such browse session — open a url first" });
        return true;
      }
      touch(sessionName);
      json(res, 200, { url: s.page.url(), title: await s.page.title(), text: await textOf(s.page) });
      return true;
    }
    // GET /api/browse/screenshot?session=&w=&h= — PNG of the live viewport
    if (req.method === "GET" && action === "screenshot") {
      const s = sessions.get(sessionName);
      if (!s) {
        json(res, 404, { error: "no such browse session — open a url first" });
        return true;
      }
      // absent/invalid w or h keeps the live viewport (never shrink to min)
      const vp = viewportFromParams(url.searchParams.get("w"), url.searchParams.get("h"));
      if (vp) {
        s.viewport = vp;
        await s.page.setViewportSize(vp);
      }
      touch(sessionName);
      const shot = await s.page.screenshot({ type: "png" });
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(shot);
      return true;
    }
    // POST /api/browse/close {session?}
    if (req.method === "POST" && action === "close") {
      await closeSession(sessionName);
      json(res, 200, { ok: true });
      return true;
    }
    json(res, 404, { error: "unknown browse route" });
    return true;
  } catch (err) {
    fail(res, err);
    return true;
  }
}

/** Test hook + graceful shutdown path. */
export async function closeAllBrowsers(): Promise<void> {
  await teardown();
}
