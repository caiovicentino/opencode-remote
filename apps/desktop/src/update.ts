// Auto-update (P1-050): check → download → restart with consent.
//
// Evolution of the P2-012 spike (staged feed check, log-only) into the real
// client-ready flow. The built-in autoUpdater (Squirrel.Mac) is still the
// engine — see the spike finding below on feed formats — but the decision now
// lands in front of the user: when a newer version is downloaded, a consent
// dialog offers "Restart now" / "Later". Nothing installs without a click.
//
// Spike finding (measured on Electron 44, macOS): the built-in autoUpdater
// only understands the Squirrel.Mac JSON feed format ({url,name,notes}) —
// pointing setFeedURL at an electron-builder `latest-mac.yml` fails with
// "The server sent an invalid response". So this module parses the yml itself
// (parseFeed) to make the update decision + log line work for both formats,
// and only hands JSON feeds to Squirrel for the background download.
//
// Listener-safety contract (P1-050 round-2 review): the autoUpdater is an
// Electron singleton, and runUpdateCheck() runs at boot AND on every tray
// click. Listeners must therefore be attached AT MOST ONCE per updater
// instance — gated by listenerCount — and the update-downloaded handler must
// read the version from the EVENT ARGUMENTS, never from a closure captured at
// check time. Otherwise check #1's stale listener would keep offering a
// version the user already declined after check #2 lands a newer one.
//
// Everything here stays fail-open: a dead feed, a bad feed or a failed
// download is logged and swallowed — it must never block or crash the shell.
import { app, autoUpdater } from "electron";

/** Shape of the subset of Electron's autoUpdater we need (tests inject fakes). */
export interface UpdaterLike {
  setFeedURL(options: { url: string; serverType?: "json" | "default" }): void;
  checkForUpdates(): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Standard EventEmitter surface; optional so unit fakes can omit it. */
  listenerCount?(event: string): number;
  /** Squirrel.Mac applies the downloaded release and restarts the app. */
  quitAndInstall?(): void;
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
  | "update-downloaded"
  | "unrecognized-feed"
  | "feed-unreachable";

/**
 * Tray label for the update-status item. Pure and electron-free like the
 * helpers in tray.ts so the unit battery can exercise every status. Returns
 * null for "disabled" — with no feed configured the tray must stay exactly
 * as it was before P3-019 (no status item at all).
 */
export function updateMenuLabel(status: UpdateStatus): string | null {
  switch (status) {
    case "update-available":
      // Not "restart to install": at this point nothing has been downloaded
      // yet, and under the consent flow a plain restart never installs — the
      // dialog (update-downloaded → quitAndInstall) is the only apply path.
      return "Update available — check for updates";
    case "update-downloaded":
      return "Update ready — restart to install";
    case "update-not-available":
      return "Up to date";
    case "unrecognized-feed":
      return "Update check failed — unrecognized feed";
    case "feed-unreachable":
      return "Update check failed — feed unreachable";
    case "disabled":
      return null;
  }
}

/** Single fetch timeout for the feed document. */
const FEED_TIMEOUT_MS = 10_000;

/** OCR_UPDATE_FEED holds an explicit staged feed URL; unset/empty means "use the packaged default". */
export function feedUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.OCR_UPDATE_FEED?.trim();
  return raw ? raw : null;
}

/**
 * P1-050: the feed actually used. Priority: explicit OCR_UPDATE_FEED (dev /
 * staged tests) → packaged default, the versioned folder the daemon serves at
 * /__ocr/updates (loopback-only). Unpackaged dev runs stay opt-in so a plain
 * `npm start` never fetches anything.
 */
export function resolvedFeedUrl(env: NodeJS.ProcessEnv = process.env, packaged = app?.isPackaged ?? false): string | null {
  const explicit = feedUrlFromEnv(env);
  if (explicit) return explicit;
  if (!packaged) return null;
  const port = Number(env.OCR_DAEMON_METRICS_PORT) || Number(env.OCR_METRICS_PORT) || 8792;
  return `http://127.0.0.1:${port}/__ocr/updates/feed.json`;
}

/**
 * P2-098: public fallback feed for third-party installs. The staged loopback
 * feed above only exists on a machine that actively stages releases
 * (~/.opencode-remote/updates); a plain DMG install has no daemon staged
 * files, so the packaged default would always end "feed unreachable". The
 * release workflow publishes `latest-mac.yml` on every GitHub release — that
 * is the public fallback (parsed for the decision; the download step still
 * needs a Squirrel JSON feed, see the spike note). OCR_PUBLIC_UPDATE_FEED
 * overrides it for forks/staging.
 */
export function publicFeedUrl(env: NodeJS.ProcessEnv = process.env, packaged = app?.isPackaged ?? false): string | null {
  if (!packaged) return null;
  return env.OCR_PUBLIC_UPDATE_FEED?.trim() || "https://github.com/caiovicentino/opencode-remote/releases/latest/download/latest-mac.yml";
}

/** True when an update source exists (explicit env or packaged default). */
export function updatesEnabled(env: NodeJS.ProcessEnv = process.env, packaged = app?.isPackaged ?? false): boolean {
  return resolvedFeedUrl(env, packaged) != null;
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
  /** Overrides the resolved feed URL (tests); undefined uses resolvedFeedUrl(). */
  feedUrl?: string | null;
  /** Overrides the public fallback feed (tests); undefined uses publicFeedUrl(). */
  publicFeed?: string | null;
  /** Overrides app.isPackaged (tests drive the packaged-default fallback path
   * without a real Electron app). */
  packaged?: boolean;
  /** Overrides app.getVersion() (tests/dev fixtures). */
  currentVersion?: string;
  /** Overrides the real Electron autoUpdater (tests inject fakes). */
  updater?: UpdaterLike | undefined;
  /** Overrides fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Overrides the [desktop] console logger (tests capture lines). */
  log?: (line: string) => void;
  /** Notified of every resolved status (main.ts mirrors it into the tray). */
  onStatus?: (status: UpdateStatus, version: string | null) => void;
  /** Overrides the consent dialog (tests inject fakes). */
  dialog?: UpdateDialogSinks;
}

// --- consent flow -------------------------------------------------------------

/** What the consent dialog needs from its host (main.ts wires Electron's dialog). */
export interface UpdateDialogSinks {
  /** Resolve with "install" (Restart now) or "later" (deferred). Applying the
   * downloaded release is the updater's own job (quitAndInstall). */
  askInstall(version: string): Promise<"install" | "later">;
}

/**
 * Downloaded-release bookkeeping, keyed by the autoUpdater singleton. Kept in
 * a module-level WeakMap so repeated checks (boot + every tray click) never
 * duplicate state — and so unit tests can drive several fake updaters in one
 * process without cross-contamination.
 */
interface DownloadedState {
  /** Version currently being offered in an open dialog (null = none). */
  offering: string | null;
  /** Versions the user deferred this session — never re-prompted until a manual re-check. */
  declined: Set<string>;
  /** Last resolved version for the tray label. */
  version: string | null;
}
const downloaded = new WeakMap<UpdaterLike, DownloadedState>();

function stateFor(updater: UpdaterLike): DownloadedState {
  let st = downloaded.get(updater);
  if (!st) {
    st = { offering: null, declined: new Set(), version: null };
    downloaded.set(updater, st);
  }
  return st;
}

/**
 * Pure decision: may we open the consent dialog for this version right now?
 * Duplicate offers are the exact regression the round-1 review flagged — a
 * stale per-check listener re-offering 0.3.0 after the user had declined it —
 * so the two guards below are the load-bearing fix.
 */
export function shouldOfferInstall(st: DownloadedState, version: string): boolean {
  if (st.offering === version) return false; // dialog already open for it
  if (st.declined.has(version)) return false; // user said "later" this session
  return true;
}

/**
 * Extract the version from an autoUpdater "update-downloaded" emission. The
 * argument shape differs per platform/channel (macOS: releaseNotes,
 * releaseName, releaseDate, updateURL; some channels emit a single info
 * object), so accept the first plausible version-looking string or a
 * { version } object. Returns null when nothing plausible is found — callers
 * then fall back to the feed version they just advertised.
 */
export function versionFromDownloadedArgs(args: unknown[]): string | null {
  for (const arg of args) {
    if (typeof arg === "string" && /^[vV]?\d+(?:\.\d+){0,3}$/.test(arg.trim())) return arg.trim();
    if (arg && typeof arg === "object" && typeof (arg as { version?: unknown }).version === "string") {
      return (arg as { version: string }).version;
    }
  }
  return null;
}

/**
 * Attach the singleton's event listeners EXACTLY ONCE per updater instance.
 * This is the load-bearing fix from the round-1 review: runUpdateCheck() runs
 * at boot and on every tray click, so attaching per call would stack N
 * listeners on the shared singleton and one update-downloaded event would
 * invoke N stale handlers (each re-offering the version it captured). The
 * listenerCount gate makes re-invocation idempotent even though the singleton
 * persists across all checks.
 */
export function attachUpdateListeners(
  updater: UpdaterLike,
  hooks: { log: (line: string) => void; dialog: UpdateDialogSinks; onStatus?: (s: UpdateStatus, v: string | null) => void },
): void {
  const count = typeof updater.listenerCount === "function" ? updater.listenerCount.bind(updater) : () => 0;
  if (count("error") > 0 || count("update-downloaded") > 0) return;

  updater.on("error", (err) => {
    const message = err instanceof Error ? err.message : String(err);
    hooks.log(`update check failed (log-only, continuing): ${message}`);
  });
  updater.on("update-available", () => hooks.log("update-available (autoUpdater event) — download continues in background"));
  updater.on("update-downloaded", (...args: unknown[]) => {
    const st = stateFor(updater);
    const version = versionFromDownloadedArgs(args) ?? st.version ?? "";
    hooks.log(`update-downloaded: ${version} (autoUpdater event) — ready to install`);
    st.version = version || st.version;
    if (hooks.onStatus) hooks.onStatus("update-downloaded", version || st.version);
    void offerInstall(updater, version, hooks);
  });
}

/**
 * Open the consent dialog for a downloaded version — once per version. The
 * dialog sinks are awaited so two rapid downloads can't stack dialogs.
 */
async function offerInstall(
  updater: UpdaterLike,
  version: string,
  hooks: { log: (line: string) => void; dialog: UpdateDialogSinks },
): Promise<void> {
  const st = stateFor(updater);
  if (!version || !shouldOfferInstall(st, version)) return;
  st.offering = version;
  try {
    const choice = await hooks.dialog.askInstall(version);
    if (choice === "install") {
      hooks.log(`update install: restarting to apply ${version}`);
      st.offering = null;
      updater.quitAndInstall?.();
      return;
    }
    hooks.log(`update install: deferred ${version} — applied on next restart`);
    st.declined.add(version);
  } catch (err) {
    hooks.log(`update install: dialog failed (${err instanceof Error ? err.message : String(err)}) — staying on current version`);
  } finally {
    if (st.offering === version) st.offering = null;
  }
}

/**
 * Update check driver, shared by the boot path and the tray's "Check for
 * updates" item. Never throws; never blocks (callers use `void`). Returns the
 * decision so tests and the tray can assert on it.
 */
export async function checkForUpdatesOnBoot(opts: UpdateCheckOptions = {}): Promise<UpdateStatus> {
  const log = opts.log ?? ((line: string) => console.log(`[desktop] ${line}`));
  // An explicitly injected feedUrl (tests, tray re-checks) is authoritative —
  // the public fallback only applies to the resolved packaged default.
  const injected = opts.feedUrl !== undefined;
  const packaged = opts.packaged ?? app?.isPackaged ?? false;
  let feedUrl = injected ? opts.feedUrl! : resolvedFeedUrl(process.env, packaged);
  // No feed source → the feature is off: no fetch, no listeners, no log noise.
  if (!feedUrl) return "disabled";
  const updater = opts.updater !== undefined ? opts.updater : (autoUpdater as UpdaterLike | undefined);
  const finish = (status: UpdateStatus, version: string | null = null): UpdateStatus => {
    if (opts.onStatus) opts.onStatus(status, version);
    return status;
  };

  const fetchBody = async (url: string, fetchImpl: typeof fetch): Promise<string> => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };

  let body: string;
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    body = await fetchBody(feedUrl, fetchImpl);
  } catch (err) {
    // Staged feed unreachable: P2-098 — a plain DMG install has no staged
    // loopback feed, so retry once against the public release feed before
    // giving up. Still fail-open: every failure is log-only by design.
    //
    // Round-4 guard: the fallback fires for the PACKAGED LOOPBACK DEFAULT
    // only. A feed explicitly configured via OCR_UPDATE_FEED (dev / staging)
    // must never cause a surprise outbound request to github.com — it fails
    // with feed-unreachable so the operator sees the misconfiguration.
    const fallback = injected || feedUrlFromEnv(process.env)
      ? null
      : opts.publicFeed !== undefined
        ? opts.publicFeed
        : publicFeedUrl(process.env, packaged);
    if (!fallback || fallback === feedUrl) {
      log(`update check: feed unreachable (${feedUrl}): ${err instanceof Error ? err.message : String(err)}`);
      return finish("feed-unreachable");
    }
    log(`update check: staged feed unreachable (${feedUrl}): ${err instanceof Error ? err.message : String(err)}`);
    try {
      const fetchImpl = opts.fetchImpl ?? fetch;
      feedUrl = fallback;
      body = await fetchBody(feedUrl, fetchImpl);
    } catch (err2) {
      log(`update check: public feed unreachable (${feedUrl}): ${err2 instanceof Error ? err2.message : String(err2)}`);
      return finish("feed-unreachable");
    }
  }

  const feed = parseFeed(body);
  if (!feed) {
    log(`update check: unrecognized feed at ${feedUrl} — ignoring`);
    return finish("unrecognized-feed");
  }
  const current = opts.currentVersion ?? app?.getVersion?.() ?? "0.0.0";
  if (!isNewerVersion(current, feed.version)) {
    log(`update check: no update (current ${current} >= feed ${feed.version})`);
    return finish("update-not-available");
  }

  // Decision made: hand the release to the shell. JSON feeds go to
  // Squirrel.Mac so a packaged install downloads them in the background;
  // yml feeds stay parse+log (see the spike finding at the top).
  log(`update-available: ${feed.version}${feed.notes ? ` — ${feed.notes}` : ""}`);
  if (feed.format === "json" && updater) {
    // P1-050: listeners attach at most once per updater instance (see
    // attachUpdateListeners) and the downloaded handler reads its version
    // from the event args — a second check here never stacks stale offers.
    const dialog = opts.dialog ?? { askInstall: async () => "later", quitAndInstall: () => {} };
    attachUpdateListeners(updater, { log, dialog, onStatus: opts.onStatus });
    stateFor(updater).version = feed.version;
    try {
      updater.setFeedURL({ url: feedUrl, serverType: "json" });
      updater.checkForUpdates();
    } catch (err) {
      log(`update check failed (log-only, continuing): ${err instanceof Error ? err.message : String(err)}`);
      return finish("update-available", feed.version);
    }
  } else if (feed.format === "yml") {
    log("update check: yml feed parsed (built-in autoUpdater needs a Squirrel JSON feed for the download step)");
  }
  return finish("update-available", feed.version);
}
