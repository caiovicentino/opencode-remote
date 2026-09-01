// Staged update feed check (P2-012 spike): opt-in, boot-only, log-only.
//
// The desktop app has no update channel yet (packaging/notarization is stage 5
// of docs/VISION.md), so there is no production feed. This spike wires
// Electron's built-in autoUpdater against a staged static feed so the update
// path can be exercised end to end before a real feed exists:
//
//   OCR_UPDATE_FEED=http://127.0.0.1:9310/feed.json npm start --workspace @ocr/desktop
//
// The check runs exactly once at boot and ONLY when OCR_UPDATE_FEED is set —
// without the variable nothing happens at all (no fetch, no listeners). Any
// network/feed failure is logged and swallowed: it must never block or crash
// the window. The check is never awaited by main.ts (fire-and-forget).
//
// Spike finding (measured on Electron 44, macOS): the built-in autoUpdater
// only understands the Squirrel.Mac JSON feed format ({url,name,notes}) —
// pointing setFeedURL at an electron-builder `latest-mac.yml` fails with
// "The server sent an invalid response". So this module parses the yml itself
// (parseFeed) to make the update decision + log line work for both formats,
// and only hands JSON feeds to Squirrel for the background download. A staged
// test feed therefore ships both files from the same directory: latest-mac.yml
// (electron-builder standard, version 0.2.1 + fake release notes) and feed.json
// (the same release in the JSON shape Squirrel consumes).
import { app, autoUpdater } from "electron";

/** Shape of the subset of Electron's autoUpdater we need (tests inject fakes). */
export interface UpdaterLike {
  setFeedURL(options: { url: string; serverType?: "json" | "default" }): void;
  checkForUpdates(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface FeedInfo {
  version: string;
  notes: string;
  /** "json" = Squirrel.Mac feed (autoUpdater consumes it); "yml" = latest-mac.yml (parse+log only). */
  format: "json" | "yml";
}

export type UpdateStatus =
  | "disabled"
  | "update-available"
  | "update-not-available"
  | "unrecognized-feed"
  | "feed-unreachable";

/** Single fetch timeout for the feed document. */
const FEED_TIMEOUT_MS = 10_000;

/** OCR_UPDATE_FEED holds the staged feed URL; unset/empty disables everything. */
export function feedUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OCR_UPDATE_FEED?.trim();
  return raw ? raw : null;
}

/** Numeric dotted-version compare: isNewerVersion("0.2.0", "0.2.1") === true. */
export function isNewerVersion(current: string, candidate: string): boolean {
  const parse = (v: string) =>
    v.trim().replace(/^v/i, "").split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const a = parse(current);
  const b = parse(candidate);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const pa = a[i] ?? 0;
    const pb = b[i] ?? 0;
    if (pb > pa) return true;
    if (pb < pa) return false;
  }
  return false;
}

/**
 * Parse a staged feed document. Accepts the Squirrel.Mac JSON format the
 * built-in autoUpdater consumes ({url, name, notes, releaseDate}) and the
 * electron-builder latest-mac.yml format (version + releaseNotes). Anything
 * else (404 HTML, empty body, garbage) returns null.
 */
export function parseFeed(body: string): FeedInfo | null {
  const text = body.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { url?: unknown; name?: unknown; notes?: unknown };
      if (parsed && typeof parsed.url === "string" && typeof parsed.name === "string") {
        return {
          version: parsed.name,
          notes: typeof parsed.notes === "string" ? parsed.notes : "",
          format: "json",
        };
      }
    } catch {
      return null;
    }
    return null;
  }
  const version = /^version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(text)?.[1];
  if (!version) return null;
  return { version, notes: parseYmlNotes(text), format: "yml" };
}

/** Minimal yml release-notes reader: inline scalar or `|`/`>` indented block. */
function parseYmlNotes(text: string): string {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^releaseNotes:\s*(.*)$/.exec(lines[i] ?? "");
    if (!m) continue;
    const inline = m[1]?.trim() ?? "";
    if (inline && !/^[|>]/.test(inline)) return inline.replace(/^["']|["']$/g, "");
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (!/^\s+\S/.test(next)) break;
      block.push(next.trim());
    }
    return block.join("\n");
  }
  return "";
}

export interface UpdateCheckOptions {
  /** Overrides OCR_UPDATE_FEED (tests); undefined reads the env var. */
  feedUrl?: string | null;
  /** Overrides app.getVersion() (tests/dev fixtures). */
  currentVersion?: string;
  /** Overrides the real Electron autoUpdater (tests inject fakes). */
  updater?: UpdaterLike | undefined;
  /** Overrides fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Overrides the [desktop] console logger (tests capture lines). */
  log?: (line: string) => void;
}

/**
 * Boot-time update check. Never throws; never blocks (main.ts calls it with
 * `void`). Returns the decision so tests (and future UI) can assert it.
 */
export async function checkForUpdatesOnBoot(opts: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  const log = opts.log ?? ((line: string) => console.log(`[desktop] ${line}`));
  const feedUrl = opts.feedUrl !== undefined ? opts.feedUrl : feedUrlFromEnv();
  // No env var → the feature is off: no fetch, no listeners, no log noise.
  if (!feedUrl) return "disabled";
  // Under plain node (unit tests) the electron import degrades to undefined;
  // callers there inject a fake via opts.updater.
  const updater = opts.updater !== undefined ? opts.updater : (autoUpdater as UpdaterLike | undefined);

  let body: string;
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(feedUrl, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.text();
  } catch (err) {
    // Feed unreachable/down: log-only by design — a dead feed must never
    // crash the shell or delay startup.
    log(`update check: feed unreachable (${feedUrl}): ${err instanceof Error ? err.message : String(err)}`);
    return "feed-unreachable";
  }

  const feed = parseFeed(body);
  if (!feed) {
    log(`update check: unrecognized feed at ${feedUrl} — ignoring`);
    return "unrecognized-feed";
  }
  const current = opts.currentVersion ?? app?.getVersion?.() ?? "0.0.0";
  if (!isNewerVersion(current, feed.version)) {
    log(`update check: no update (current ${current} >= feed ${feed.version})`);
    return "update-not-available";
  }

  // Decision made: log the spike's acceptance line, then (JSON feeds only)
  // hand the feed to Squirrel.Mac so a packaged install downloads it in the
  // background. Download/apply errors land on the error listener: log-only.
  log(`update-available: ${feed.version}${feed.notes ? ` — ${feed.notes}` : ""}`);
  if (feed.format === "json" && updater) {
    try {
      updater.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`update check failed (log-only, continuing): ${message}`);
      });
      updater.on("update-available", () => log("update-available (autoUpdater event) — download continues in background"));
      updater.on("update-downloaded", () => log("update-downloaded (autoUpdater event) — applied on next restart"));
      updater.setFeedURL({ url: feedUrl, serverType: "json" });
      updater.checkForUpdates();
    } catch (err) {
      log(`update check failed (log-only, continuing): ${err instanceof Error ? err.message : String(err)}`);
      return "update-available";
    }
  } else if (feed.format === "yml") {
    log("update check: yml feed parsed (built-in autoUpdater needs a Squirrel JSON feed for the download step)");
  }
  return "update-available";
}
