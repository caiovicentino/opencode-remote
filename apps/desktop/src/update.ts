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
import { activeDaemonPort } from "./daemon";

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
  | "update-available-manual"
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
    case "update-available-manual":
      // P2-131: yml feeds have no download engine (spike finding) — the shell
      // opens the release page instead of downloading anything in background.
      return "Update available — open release page";
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
  // P2-143: the packaged default follows the RESOLVED daemon port (the
  // fallback-aware getter), not the fixed 8792 — env overrides keep priority.
  const port = Number(env.OCR_DAEMON_METRICS_PORT) || Number(env.OCR_METRICS_PORT) || activeDaemonPort();
  return `http://127.0.0.1:${port}/__ocr/updates/feed.json`;
}

/**
 * P2-098: public fallback feed for third-party installs. The staged loopback
 * feed above only exists on a machine that actively stages releases
 * (~/.opencode-remote/updates); a plain DMG install has no daemon staged
 * files, so the packaged default would always end "feed unreachable". The
 * release workflow publishes an update feed on every GitHub release — that is
 * the public fallback. The file name is platform- and architecture-specific
 * (P2-131, P2-146, P2-191): on darwin the release carries one Squirrel.Mac
 * JSON feed per architecture, so the arm64 build downloads
 * `update-mac-arm64.json`, the Intel build `update-mac-x64.json`, and any
 * other architecture keeps the pre-P2-191 `update-mac.json` (the alias file,
 * arm64 content). Windows keeps `latest.yml`; platforms with no download
 * engine get no default at all — until a platform has a download engine there
 * is no feed to advertise. OCR_PUBLIC_UPDATE_FEED overrides it for
 * forks/staging and, being an absolute override, ignores both the platform
 * and the architecture.
 */
export function publicFeedUrl(
  env: NodeJS.ProcessEnv = process.env,
  packaged = app?.isPackaged ?? false,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (!packaged) return null;
  const override = env.OCR_PUBLIC_UPDATE_FEED?.trim();
  if (override) return override;
  // P2-146: darwin consumes the Squirrel.Mac JSON feed (built by
  // apps/desktop/scripts/update-feed.mjs in the release workflow) so the
  // public fallback downloads in the background instead of stopping at the
  // manual release page. P2-191: the feed name follows process.arch so an
  // Intel Mac never receives the arm64 zip. Windows keeps the yml manual
  // flow; other platforms have no download engine → no feed.
  const asset =
    platform === "darwin"
      ? arch === "arm64"
        ? "update-mac-arm64.json"
        : arch === "x64"
          ? "update-mac-x64.json"
          : "update-mac.json"
      : platform === "win32"
        ? "latest.yml"
        : null;
  if (!asset) return null;
  return `https://github.com/caiovicentino/opencode-remote/releases/latest/download/${asset}`;
}

/** Fallback releases page when the feed URL is not a GitHub download link. */
const RELEASES_PAGE_URL = "https://github.com/caiovicentino/opencode-remote/releases/latest";

/**
 * P2-131: the human-readable page a manual update points at. GitHub
 * `releases/latest/download/<asset>` feeds map to the repo's releases page, so
 * forks land on their own releases; self-hosted overrides (OCR_PUBLIC_UPDATE_
 * FEED) point at the feed's own directory — the release artifacts always live
 * next to the feed file, and silently sending those users to the upstream
 * repo would be surprising (round-2 review).
 */
export function releasePageUrl(feedUrl: string): string {
  const gh = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/releases\/latest\/download\/[^/?#\s]+$/.exec(feedUrl.trim());
  if (gh) return `https://github.com/${gh[1]}/${gh[2]}/releases/latest`;
  try {
    const url = new URL(feedUrl.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return RELEASES_PAGE_URL;
    const dir = url.pathname.endsWith("/") ? url.pathname : url.pathname.replace(/[^/]*$/, "");
    return `${url.protocol}//${url.host}${dir}`;
  } catch {
    return RELEASES_PAGE_URL;
  }
}

/**
 * P2-131 (round-2 review): manual-update versions whose release page was
 * already opened this session. The JSON path has the offering/declined
 * bookkeeping in stateFor; the manual path has no updater instance to key a
 * WeakMap on, so a plain session set keeps repeated checks (boot + every tray
 * click) from spamming a browser tab per re-check.
 */
const manualOpened = new Set<string>();

/** True when an update surface exists for this platform: an explicitly staged
 * feed, or a packaged build on a platform with a public feed default. Mirrors
 * the boot-check gate so the tray never offers "Check for updates" on a
 * platform whose check would only ever answer "disabled" (round-2 review). */
export function updatesEnabled(
  env: NodeJS.ProcessEnv = process.env,
  packaged = app?.isPackaged ?? false,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (feedUrlFromEnv(env)) return true;
  return packaged && publicFeedUrl(env, packaged, platform) != null;
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
  /** Overrides process.platform (tests drive the darwin/win32/other paths). */
  platform?: NodeJS.Platform;
  /** P2-211: the boot install-location verdict (installloc.ts, computed once
   * in main.ts). When the bundle cannot be replaced by the updater (DMG
   * volume / translocated copy) the consent dialog is never opened — offering
   * a restart the updater has no way to complete would be worse than offering
   * nothing. Fail-open: an unknown/absent verdict never blocks. */
  installLocation?: { state: string; message: string } | null;
  /** P2-131: invoked when an update is detected through a yml feed — a format
   * with no download engine — and handed the release page URL. main.ts wires
   * it to shell.openExternal for user-initiated tray re-checks only; the boot
   * check never auto-opens a browser, and each version opens at most once per
   * session. */
  openReleasePage?: (url: string) => void;
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
 * P2-211: pure gate for the consent dialog. True ONLY when the boot
 * install-location verdict proves the bundle is not replaceable — running
 * from a mounted DMG volume or from Gatekeeper's quarantine translocation
 * copy — because Squirrel.Mac cannot swap a read-only/random bundle: the
 * restart would come back as the very same version. Every other state (ok,
 * downloads, unknown, absent) is fail-open: the dialog flow works exactly as
 * before, and nothing here blocks any other use of the app.
 */
export function installBlocksUpdate(verdict: { state: string; message: string } | null | undefined): boolean {
  return verdict?.state === "dmg-volume" || verdict?.state === "translocated";
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
  hooks: {
    log: (line: string) => void;
    dialog: UpdateDialogSinks;
    onStatus?: (s: UpdateStatus, v: string | null) => void;
    /** P2-211: boot install-location verdict (see installBlocksUpdate). */
    installLocation?: { state: string; message: string } | null;
  },
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
 * P2-211: the consent dialog is only reachable AFTER consulting the boot
 * install-location verdict — an un-replaceable bundle (DMG volume /
 * translocated copy) gets ONE log line (state + the same verdict phrase) and
 * no dialog, because offering a restart the updater cannot complete would be
 * worse than offering nothing. Fail-open on unknown/absent, and nothing here
 * blocks the rest of the module.
 */
async function offerInstall(
  updater: UpdaterLike,
  version: string,
  hooks: {
    log: (line: string) => void;
    dialog: UpdateDialogSinks;
    installLocation?: { state: string; message: string } | null;
  },
): Promise<void> {
  if (installBlocksUpdate(hooks.installLocation)) {
    const verdict = hooks.installLocation!;
    hooks.log(`update install not offered (${verdict.state}): ${verdict.message}`);
    return;
  }
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
  const platform = opts.platform ?? process.platform;
  let feedUrl = injected ? opts.feedUrl! : resolvedFeedUrl(process.env, packaged);
  // P2-131: the public feed for the platform is also the feature gate. A
  // platform for which electron-builder publishes no yml (no default and no
  // OCR_PUBLIC_UPDATE_FEED override) has no update surface at all — not even
  // the staged Squirrel.Mac loopback default, which only a macOS autoUpdater
  // could consume. Disabled means zero network requests.
  const publicFeed =
    opts.publicFeed !== undefined ? opts.publicFeed : publicFeedUrl(process.env, packaged, platform);
  if (!injected && !feedUrlFromEnv(process.env) && !publicFeed) return "disabled";
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
    const fallback = injected || feedUrlFromEnv(process.env) ? null : publicFeed;
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
  if (feed.format === "json") {
    // P1-050: listeners attach at most once per updater instance (see
    // attachUpdateListeners) and the downloaded handler reads its version
    // from the event args — a second check here never stacks stale offers.
    // setFeedURL is called ONLY here: yml feeds have no download engine, and
    // handing a latest-*.yml to the built-in autoUpdater fails outright.
    if (updater) {
      const dialog = opts.dialog ?? { askInstall: async () => "later", quitAndInstall: () => {} };
      attachUpdateListeners(updater, { log, dialog, onStatus: opts.onStatus, installLocation: opts.installLocation });
      stateFor(updater).version = feed.version;
      try {
        updater.setFeedURL({ url: feedUrl, serverType: "json" });
        updater.checkForUpdates();
      } catch (err) {
        log(`update check failed (log-only, continuing): ${err instanceof Error ? err.message : String(err)}`);
        return finish("update-available", feed.version);
      }
    }
    return finish("update-available", feed.version);
  }
  // P2-131: yml feed → no background download exists for this format, so the
  // update is manual: surface the dedicated status and point the user at the
  // release page. The page only opens when the caller wired the sink (main.ts
  // does that for user-initiated tray re-checks, never for the boot check —
  // an outdated install must not auto-open a browser at every launch) and at
  // most once per version per session.
  log("update check: yml feed has no download engine — update is manual, opening the release page");
  if (opts.openReleasePage && !manualOpened.has(feed.version)) {
    manualOpened.add(feed.version);
    opts.openReleasePage(releasePageUrl(feedUrl));
  }
  return finish("update-available-manual", feed.version);
}
