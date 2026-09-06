/**
 * Desktop update feed tests (P2-012 spike): the opt-in staged update check.
 *
 * Two layers:
 *  1. unit — parseFeed/isNewerVersion/feedUrlFromEnv + checkForUpdatesOnBoot
 *     driven with an injected fake updater/fetch (runs under plain tsx).
 *  2. e2e — the compiled dist-electron/update.js inside the real Electron,
 *     pointed at a staged feed served on loopback (latest-mac.yml with version
 *     0.2.1 + fake release notes, and the same release as Squirrel.Mac JSON).
 *     Asserts the "update-available" log, that the built-in autoUpdater really
 *     fires its event, and that a dead feed never crashes the shell.
 *
 * Never touches the production daemon. Run: npx tsx scripts/desktop-update.test.ts
 * Pass --unit-only (or set OCR_UPDATE_UNIT_ONLY=1) to run only the unit layer
 * without spawning Electron — that is how the root test:unit chain consumes
 * this file (P2-107: an orphan test file never runs in the gate).
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// P2-131: unit-only mode skips the Electron e2e layer (no electron spawn, no
// dist-electron build) so the fast root test:unit battery can include it.
const UNIT_ONLY = process.argv.includes("--unit-only") || process.env.OCR_UPDATE_UNIT_ONLY === "1";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const {
  checkForUpdatesOnBoot,
  feedUrlFromEnv,
  isNewerVersion,
  parseFeed,
  publicFeedUrl,
} = await import("../apps/desktop/src/update.ts");
// P2-146: pure Squirrel.Mac feed builder (CLI in the release workflow).
const { buildSquirrelFeed } = await import("../apps/desktop/scripts/update-feed.mjs");
// P2-233: Windows explicit-action installer download (pure decision layer).
const {
  parseWindowsFeed,
  assetUrlFrom,
  installerNameIsSafe,
  integrityVerdict,
  winDownloadDecision,
  MAX_INSTALLER_NAME,
} = await import("../apps/desktop/src/winupdate.ts");

// --- feedUrlFromEnv ----------------------------------------------------------
check("feedUrlFromEnv: unset → null", feedUrlFromEnv({}) === null);
check("feedUrlFromEnv: empty → null", feedUrlFromEnv({ OCR_UPDATE_FEED: "  " }) === null);
check("feedUrlFromEnv: set → value", feedUrlFromEnv({ OCR_UPDATE_FEED: "http://127.0.0.1:9/feed.json" }) === "http://127.0.0.1:9/feed.json");
check("feedUrlFromEnv: default env is read", feedUrlFromEnv() === (process.env.OCR_UPDATE_FEED ?? null));

// --- isNewerVersion ----------------------------------------------------------
check("isNewerVersion: patch bump", isNewerVersion("0.2.0", "0.2.1") === true);
check("isNewerVersion: equal → false", isNewerVersion("0.2.1", "0.2.1") === false);
check("isNewerVersion: downgrade → false", isNewerVersion("0.2.1", "0.2.0") === false);
check("isNewerVersion: numeric not lexicographic (0.10.0 > 0.9.0)", isNewerVersion("0.9.0", "0.10.0") === true);
check("isNewerVersion: v-prefix tolerated", isNewerVersion("0.2.0", "v0.2.1") === true);
check("isNewerVersion: short candidate padded", isNewerVersion("0.2.1", "0.3") === true);

// --- parseFeed ---------------------------------------------------------------
const YML = `version: 0.2.1
files:
  - url: OpenCode Remote-0.2.1-mac.zip
    sha512: fake
    size: 1234
path: OpenCode Remote-0.2.1-mac.zip
sha512: fake
releaseName: 0.2.1
releaseNotes: |-
  Spike feed: notas fake
  segunda linha
releaseDate: '2026-09-01'
`;
const yml = parseFeed(YML);
check("parseFeed: yml version", yml?.version === "0.2.1" && yml.format === "yml");
check("parseFeed: yml release notes block", yml?.notes.includes("notas fake") === true && yml.notes.includes("segunda linha") === true);
check("parseFeed: yml inline notes", parseFeed("version: 1.2.3\nreleaseNotes: nota unica\n")?.notes === "nota unica");
// Version variants for the session-dedup tests (each manual version must be
// independently openable).
const YML_030 = YML.replaceAll("0.2.1", "0.3.0");
const YML_040 = YML.replaceAll("0.2.1", "0.4.0");
const json = parseFeed(
  JSON.stringify({ url: "http://127.0.0.1/x.zip", name: "0.2.1", notes: "fake release notes", releaseDate: "2026-09-01" }),
);
check("parseFeed: Squirrel JSON", json?.version === "0.2.1" && json.notes === "fake release notes" && json.format === "json");
check("parseFeed: garbage → null", parseFeed("<html>404</html>") === null);
check("parseFeed: empty → null", parseFeed("") === null);

// --- checkForUpdatesOnBoot with injected fakes -------------------------------
function fakeFetcher(body: string | null, status = 200): typeof fetch {
  return (async () =>
    body === null ? Promise.reject(new Error("ECONNREFUSED")) : new Response(body, { status })) as unknown as typeof fetch;
}
function fakeUpdater() {
  const spy = {
    feedURLs: [] as { url: string; serverType?: "json" | "default" }[],
    checks: 0,
    listenerCount: {} as Record<string, number>,
  };
  let updateAvailableListener: () => void = () => {};
  return {
    setFeedURL(options: { url: string; serverType?: "json" | "default" }): void {
      spy.feedURLs.push(options);
    },
    checkForUpdates(): void {
      spy.checks++;
      updateAvailableListener();
    },
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      spy.listenerCount[event] = (spy.listenerCount[event] ?? 0) + 1;
      if (event === "update-available") updateAvailableListener = listener;
      return spy;
    },
    spy,
  };
}

const disabledLogs: string[] = [];
check(
  "no OCR_UPDATE_FEED → disabled, silent, updater untouched",
  (await checkForUpdatesOnBoot({
    feedUrl: null,
    currentVersion: "0.2.0",
    updater: fakeUpdater(),
    log: (l) => disabledLogs.push(l),
  })) === "disabled" && disabledLogs.length === 0,
);

const availLogs: string[] = [];
const availUpdater = fakeUpdater();
const jsonStatus = await checkForUpdatesOnBoot({
  feedUrl: "http://127.0.0.1:9/feed.json",
  currentVersion: "0.2.0",
  updater: availUpdater,
  fetchImpl: fakeFetcher(JSON.stringify({ url: "http://127.0.0.1:9/x.zip", name: "0.2.1", notes: "fake release notes" })),
  log: (l) => availLogs.push(l),
});
check("JSON feed newer → update-available", jsonStatus === "update-available");
check("update-available log carries the feed version + notes", availLogs.some((l) => l.includes("update-available: 0.2.1") && l.includes("fake release notes")));
check("Squirrel wired with serverType json", JSON.stringify(availUpdater.spy.feedURLs) === '[{"url":"http://127.0.0.1:9/feed.json","serverType":"json"}]');
check("checkForUpdates called exactly once", availUpdater.spy.checks === 1);
check("error listener attached (log-only path)", availUpdater.spy.listenerCount.error === 1);

const ymlLogs: string[] = [];
const ymlUpdater = fakeUpdater();
const ymlStatus = await checkForUpdatesOnBoot({
  feedUrl: "http://127.0.0.1:9/latest-mac.yml",
  currentVersion: "0.2.0",
  updater: ymlUpdater,
  fetchImpl: fakeFetcher(YML),
  log: (l) => ymlLogs.push(l),
});
check(
  "yml feed newer → update-available-manual (no download engine, P2-131)",
  ymlStatus === "update-available-manual" && ymlLogs.some((l) => l.includes("update-available: 0.2.1")),
);
check("yml feed: Squirrel NOT wired (spike finding)", ymlUpdater.spy.checks === 0);
check("P2-131: yml feed never calls setFeedURL", ymlUpdater.spy.feedURLs.length === 0);

// --- P2-131: manual update flow (yml feeds) -----------------------------------
check(
  "P2-131: update-available-manual has its own tray label",
  updateMenuLabel("update-available-manual") === "Update available — open release page",
);
{
  const manualUpdater = fakeUpdater();
  const openedUrls: string[] = [];
  const manualStatus = await checkForUpdatesOnBoot({
    feedUrl: "https://github.com/acme/remote/releases/latest/download/latest-mac.yml",
    currentVersion: "0.2.0",
    updater: manualUpdater,
    fetchImpl: fakeFetcher(YML),
    log: () => {},
    openReleasePage: (url) => openedUrls.push(url),
  });
  check(
    "P2-131: yml update → manual status + openReleasePage sink gets the release page",
    manualStatus === "update-available-manual" &&
      JSON.stringify(openedUrls) === JSON.stringify(["https://github.com/acme/remote/releases/latest"]),
  );
  check(
    "P2-131: manual flow leaves the updater completely untouched",
    manualUpdater.spy.feedURLs.length === 0 && manualUpdater.spy.checks === 0,
  );
  check(
    "P2-131: openReleasePage is optional — no sink, no crash",
    (await checkForUpdatesOnBoot({
      feedUrl: "http://127.0.0.1:9/latest-mac.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: fakeFetcher(YML),
      log: () => {},
    })) === "update-available-manual",
  );
  check(
    "releasePageUrl: GitHub download link → releases/latest of the same repo",
    releasePageUrl("https://github.com/foo/bar/releases/latest/download/latest.yml") ===
      "https://github.com/foo/bar/releases/latest",
  );
  check(
    "releasePageUrl: self-hosted feed → the feed's own directory (never the upstream repo)",
    releasePageUrl("https://feeds.example/staging/latest-mac.yml") === "https://feeds.example/staging/" &&
      releasePageUrl("https://fork.dev/latest.yml") === "https://fork.dev/",
  );
}
{
  // Round-2 review: the release page must open at most once per version per
  // session — boot + every tray re-check otherwise spam a browser tab.
  const dedupUpdater = fakeUpdater();
  const opened: string[] = [];
  const dedupOpts = {
    feedUrl: "http://127.0.0.1:9/latest-mac.yml",
    currentVersion: "0.2.0",
    updater: dedupUpdater,
    fetchImpl: fakeFetcher(YML_030),
    log: () => {},
    openReleasePage: (url: string) => opened.push(url),
  };
  await checkForUpdatesOnBoot(dedupOpts);
  await checkForUpdatesOnBoot(dedupOpts);
  await checkForUpdatesOnBoot(dedupOpts);
  check("P2-131 r2: repeated checks open the release page once per version", opened.length === 1);
  // A boot-style check (no sink wired) must not consume the version: the next
  // user-initiated re-check still opens the page exactly once.
  await checkForUpdatesOnBoot({ ...dedupOpts, fetchImpl: fakeFetcher(YML_040), openReleasePage: undefined });
  await checkForUpdatesOnBoot({ ...dedupOpts, fetchImpl: fakeFetcher(YML_040) });
  check(
    "P2-131 r2: boot never opens (no sink), a NEW version opens again on the next tray re-check",
    opened.length === 2 && opened[1] === "http://127.0.0.1:9/",
  );
}

// --- P2-131: the tray gate mirrors the boot check (round-2 review) ------------
check(
  "updatesEnabled: packaged darwin/win32 → true, packaged linux → false",
  updatesEnabled({}, true, "darwin") === true &&
    updatesEnabled({}, true, "win32") === true &&
    updatesEnabled({}, true, "linux") === false,
);
check(
  "updatesEnabled: explicit staged feed keeps the tray item on feed-less platforms",
  updatesEnabled({ OCR_UPDATE_FEED: "http://127.0.0.1:9/feed.json" }, false, "linux") === true,
);
check(
  "updatesEnabled: OCR_PUBLIC_UPDATE_FEED override enables a feed-less platform",
  updatesEnabled({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/latest.yml" }, true, "linux") === true,
);
check("updatesEnabled: dev unpackaged without env stays disabled", updatesEnabled({}, false) === false);

const notNewerLogs: string[] = [];
check(
  "current >= feed → update-not-available",
  (await checkForUpdatesOnBoot({
    feedUrl: "http://127.0.0.1:9/feed.json",
    currentVersion: "0.2.1",
    updater: fakeUpdater(),
    fetchImpl: fakeFetcher(YML),
    log: (l) => notNewerLogs.push(l),
  })) === "update-not-available" && notNewerLogs.length === 1,
);

const deadLogs: string[] = [];
const deadUpdater = fakeUpdater();
check(
  "unreachable feed → feed-unreachable (no throw, updater untouched)",
  (await checkForUpdatesOnBoot({
    feedUrl: "http://127.0.0.1:1/feed.json",
    currentVersion: "0.2.0",
    updater: deadUpdater,
    fetchImpl: fakeFetcher(null),
    log: (l) => deadLogs.push(l),
  })) === "feed-unreachable" && deadUpdater.spy.checks === 0 && deadLogs.length === 1 && deadLogs[0].includes("unreachable"),
);

const serverDownLogs: string[] = [];
check(
  "HTTP 500 → feed-unreachable",
  (await checkForUpdatesOnBoot({
    feedUrl: "http://127.0.0.1:9/feed.json",
    currentVersion: "0.2.0",
    updater: fakeUpdater(),
    fetchImpl: fakeFetcher("boom", 500),
    log: (l) => serverDownLogs.push(l),
  })) === "feed-unreachable",
);
check(
  "garbage body → unrecognized-feed",
  (await checkForUpdatesOnBoot({
    feedUrl: "http://127.0.0.1:9/feed.json",
    currentVersion: "0.2.0",
    updater: fakeUpdater(),
    fetchImpl: fakeFetcher("<html>nope</html>"),
    log: () => {},
  })) === "unrecognized-feed",
);

// --- P1-050: listener-once + consent flow (round-1 review regression) --------
import {
  attachUpdateListeners,
  releasePageUrl,
  resolvedFeedUrl,
  shouldOfferInstall,
  updateMenuLabel,
  updatesEnabled,
  versionFromDownloadedArgs,
  type UpdateDialogSinks,
  type WinInstallerRequest,
} from "../apps/desktop/src/update.ts";

/**
 * Fake with real EventEmitter counting: models the Electron autoUpdater
 * singleton (a second check MUST NOT re-attach — that was the regression).
 */
function fakeEmitter() {
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const api = {
    installs: 0,
    feedURLs: [] as string[],
    setFeedURL(o: { url: string }): void {
      api.feedURLs.push(o.url);
    },
    checkForUpdates(): void {
      (listeners["update-available"] ?? []).forEach((f) => f());
    },
    on(event: string, l: (...a: unknown[]) => void): unknown {
      (listeners[event] ??= []).push(l);
      return api;
    },
    listenerCount(event: string): number {
      return (listeners[event] ?? []).length;
    },
    emit(event: string, ...args: unknown[]): void {
      for (const l of [...(listeners[event] ?? [])]) l(...args);
    },
    quitAndInstall(): void {
      api.installs++;
    },
  };
  return api;
}

const repeatUpdater = fakeEmitter();
const repeatOpts = {
  feedUrl: "http://127.0.0.1:9/feed.json",
  currentVersion: "0.2.0",
  updater: repeatUpdater as never,
  fetchImpl: fakeFetcher(JSON.stringify({ url: "http://x/y.zip", name: "0.4.0", notes: "" })),
  log: () => {},
};
await checkForUpdatesOnBoot(repeatOpts);
await checkForUpdatesOnBoot(repeatOpts);
await checkForUpdatesOnBoot(repeatOpts);
check(
  "P1-050: 3 checks on the SAME updater attach each listener exactly once",
  repeatUpdater.listenerCount("error") === 1 &&
    repeatUpdater.listenerCount("update-available") === 1 &&
    repeatUpdater.listenerCount("update-downloaded") === 1,
);
check(
  "P1-050: 3 checks still call Squirrel checkForUpdates every time (download re-armed)",
  repeatUpdater.feedURLs.length === 3,
);

check("versionFromDownloadedArgs: releaseName string", versionFromDownloadedArgs([null, "notes", "0.2.1"]) === "0.2.1");
check("versionFromDownloadedArgs: v-prefix", versionFromDownloadedArgs(["v0.3.0"]) === "v0.3.0");
check("versionFromDownloadedArgs: info object", versionFromDownloadedArgs([{ version: "0.4.0" }]) === "0.4.0");
check("versionFromDownloadedArgs: prose is not a version", versionFromDownloadedArgs(["release notes text"]) === null);
check("versionFromDownloadedArgs: empty → null", versionFromDownloadedArgs([]) === null);

check(
  "shouldOfferInstall: fresh version offered",
  shouldOfferInstall({ offering: null, declined: new Set(), version: null }, "0.3.0") === true,
);
check(
  "shouldOfferInstall: same-version dialog already open → false",
  shouldOfferInstall({ offering: "0.3.0", declined: new Set(), version: null }, "0.3.0") === false,
);
check(
  "shouldOfferInstall: declined this session → false",
  shouldOfferInstall({ offering: null, declined: new Set(["0.3.0"]), version: null }, "0.3.0") === false,
);

// Consent end-to-end through the module: downloaded event → dialog once per
// version, "later" defers re-offers, "install" applies via quitAndInstall.
const dialogLog: string[] = [];
const consentUpdater = fakeEmitter();
let dialogAnswer: "install" | "later" = "later";
const dialogSinks: UpdateDialogSinks = {
  askInstall: (version) => {
    dialogLog.push(version);
    return Promise.resolve(dialogAnswer);
  },
};
attachUpdateListeners(consentUpdater, { log: () => {}, dialog: dialogSinks });
consentUpdater.emit("update-downloaded", null, "release notes", "0.3.0");
await new Promise((r) => setTimeout(r, 5));
consentUpdater.emit("update-downloaded", null, "release notes", "0.3.0");
await new Promise((r) => setTimeout(r, 5));
check(
  "P1-050: declined version is offered exactly once, stale repeats never re-prompt",
  dialogLog.length === 1 && dialogLog[0] === "0.3.0" && consentUpdater.installs === 0,
);
dialogAnswer = "install";
consentUpdater.emit("update-downloaded", null, "release notes", "0.4.0");
await new Promise((r) => setTimeout(r, 5));
check(
  "P1-050: accepting a NEW version applies it via quitAndInstall",
  dialogLog.length === 2 && dialogLog[1] === "0.4.0" && consentUpdater.installs === 1,
);

check(
  "resolvedFeedUrl: explicit env wins over packaged default",
  resolvedFeedUrl({ OCR_UPDATE_FEED: "http://x/feed.json" }, true) === "http://x/feed.json",
);
check(
  "resolvedFeedUrl: packaged default = daemon loopback updates folder",
  resolvedFeedUrl({}, true) === "http://127.0.0.1:8792/__ocr/updates/feed.json",
);
check(
  "resolvedFeedUrl: packaged default honors the metrics port override",
  resolvedFeedUrl({ OCR_DAEMON_METRICS_PORT: "9321" }, true) === "http://127.0.0.1:9321/__ocr/updates/feed.json",
);
check("resolvedFeedUrl: dev unpackaged stays disabled", resolvedFeedUrl({}, false) === null);

// --- P2-098: public fallback feed for third-party installs --------------------
// P2-191: the darwin feed is per-architecture (arm64/x64), other arches keep
// the legacy update-mac.json alias.
check(
  "publicFeedUrl: packaged default on darwin follows the architecture (P2-191)",
  publicFeedUrl({}, true, "darwin", "arm64") === "https://github.com/caiovicentino/opencode-remote/releases/latest/download/update-mac-arm64.json" &&
    publicFeedUrl({}, true, "darwin", "x64") === "https://github.com/caiovicentino/opencode-remote/releases/latest/download/update-mac-x64.json",
);
check(
  "publicFeedUrl: OCR_PUBLIC_UPDATE_FEED overrides (forks/staging)",
  publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/latest-mac.yml" }, true) === "https://fork.dev/latest-mac.yml",
);
check("publicFeedUrl: dev unpackaged has no public feed", publicFeedUrl({}, false) === null);

// --- P2-131: platform-aware public feed ---------------------------------------
check(
  "publicFeedUrl: win32 → electron-builder latest.yml",
  publicFeedUrl({}, true, "win32") === "https://github.com/caiovicentino/opencode-remote/releases/latest/download/latest.yml",
);
check(
  "publicFeedUrl: platforms without a feed (linux, freebsd) → null",
  publicFeedUrl({}, true, "linux") === null && publicFeedUrl({}, true, "freebsd") === null,
);
check(
  "publicFeedUrl: OCR_PUBLIC_UPDATE_FEED is an absolute override — ignores the platform",
  publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/latest.yml" }, true, "linux") === "https://fork.dev/latest.yml" &&
    publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/latest.yml" }, true, "win32") === "https://fork.dev/latest.yml",
);
check(
  "publicFeedUrl: default platform param follows process.platform",
  publicFeedUrl({}, true) === publicFeedUrl({}, true, process.platform),
);
{
  // A platform with no feed has the whole feature off: disabled BEFORE any
  // network request — not even the staged Squirrel.Mac loopback default.
  const requestedUrls: string[] = [];
  const mustNotFetch = ((input: RequestInfo | URL) => {
    requestedUrls.push(String(input));
    return Promise.reject(new Error("ECONNREFUSED"));
  }) as unknown as typeof fetch;
  check(
    "P2-131: platform without feed → disabled, zero network requests (packaged linux)",
    (await checkForUpdatesOnBoot({
      packaged: true,
      platform: "linux",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: mustNotFetch,
      log: () => {},
    })) === "disabled" && requestedUrls.length === 0,
  );
  check(
    "P2-131: platform without feed → disabled, zero network requests (packaged freebsd)",
    (await checkForUpdatesOnBoot({
      packaged: true,
      platform: "freebsd",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: mustNotFetch,
      log: () => {},
    })) === "disabled" && requestedUrls.length === 0,
  );
  // The gate only short-circuits platform-less platforms: an explicit staged
  // feed is operator intent and keeps failing loudly (P2-098 round 4).
  const savedFeed = process.env.OCR_UPDATE_FEED;
  process.env.OCR_UPDATE_FEED = "http://127.0.0.1:1/staged.json";
  requestedUrls.length = 0;
  check(
    "P2-131: explicit OCR_UPDATE_FEED keeps the check alive on feed-less platforms (fails loudly, no public fetch)",
    (await checkForUpdatesOnBoot({
      packaged: true,
      platform: "linux",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: mustNotFetch,
      log: () => {},
    })) === "feed-unreachable" && JSON.stringify(requestedUrls) === JSON.stringify(["http://127.0.0.1:1/staged.json"]),
  );
  if (savedFeed !== undefined) process.env.OCR_UPDATE_FEED = savedFeed;
  else delete process.env.OCR_UPDATE_FEED;
}

// --- P2-146: Squirrel.Mac JSON feed published from the release ----------------
{
  // YML (the fixture above) is a valid latest-mac.yml: version 0.2.1, zip
  // "OpenCode Remote-0.2.1-mac.zip" (with a space in the name), notes, date.
  const distFiles = ["OpenCode Remote-0.2.1-mac.zip", "OpenCode Remote-0.2.1.dmg", "latest-mac.yml"];
  const good = buildSquirrelFeed("v0.2.1", YML, distFiles, "caiovicentino/opencode-remote");
  check("P2-146: valid dist → feed without problems", good.problems.length === 0 && good.feed !== null);
  check(
    "P2-146: feed url = release download of the zip, file name percent-encoded",
    good.feed.url ===
      "https://github.com/caiovicentino/opencode-remote/releases/download/v0.2.1/OpenCode%20Remote-0.2.1-mac.zip",
  );
  check("P2-146: feed name = yml version (Squirrel reads the version from `name`)", good.feed.name === "0.2.1");
  check("P2-146: feed notes = yml releaseNotes", good.feed.notes.includes("notas fake"));
  check("P2-146: pub_date = yml releaseDate as ISO", good.feed.pub_date === new Date("2026-09-01").toISOString());
  check(
    "P2-146: darwin resolves the JSON format with zero yml in the path",
    parseFeed(JSON.stringify(good.feed))?.format === "json" && parseFeed(JSON.stringify(good.feed))?.version === "0.2.1",
  );

  const spaced = buildSquirrelFeed(
    "v1.0.0",
    YML.replaceAll("0.2.1", "1.0.0").replaceAll("OpenCode Remote-1.0.0-mac.zip", "My App 1.0-arm64-mac.zip"),
    ["My App 1.0-arm64-mac.zip", "latest-mac.yml"],
    "acme/remote",
  );
  check(
    "P2-146: artifact name with spaces is percent-encoded in the download url",
    spaced.feed.url === "https://github.com/acme/remote/releases/download/v1.0.0/My%20App%201.0-arm64-mac.zip",
  );

  const noZip = buildSquirrelFeed("v0.2.1", YML, ["OpenCode Remote-0.2.1.dmg", "latest-mac.yml"], "acme/remote");
  check(
    "P2-146: missing zip → problem (Squirrel installs only from a zip), no feed",
    noZip.feed === null && noZip.problems.length === 1 && noZip.problems[0].includes("*.zip"),
  );

  const diverged = buildSquirrelFeed("v0.3.0", YML, distFiles, "acme/remote");
  check(
    "P2-146: yml version diverging from the tag → problem, no feed",
    diverged.feed === null &&
      diverged.problems.length === 1 &&
      diverged.problems[0].includes("0.2.1") &&
      diverged.problems[0].includes("v0.3.0"),
  );

  const unreadable = buildSquirrelFeed("v0.2.1", "<html>404</html>", distFiles, "acme/remote");
  check(
    "P2-146: unreadable yml (no `version:` line) → problem",
    unreadable.feed === null && unreadable.problems.some((p) => p.includes("unreadable")),
  );
  const absent = buildSquirrelFeed("v0.2.1", null, distFiles, "acme/remote");
  check(
    "P2-146: absent latest-mac.yml → problem",
    absent.feed === null && absent.problems.some((p) => p.includes("latest-mac.yml")),
  );

  // The feed is useless without an artifact Squirrel can apply — assert the
  // REAL packaging config carries the zip target, not a test fixture.
  const builderYml = readFileSync(join(repoRoot, "apps", "desktop", "electron-builder.yml"), "utf8");
  const macBlock = builderYml.slice(builderYml.indexOf("\nmac:"), builderYml.indexOf("\ndmg:"));
  check(
    "P2-146: real electron-builder.yml mac targets = dmg + dir + zip",
    macBlock.includes("- target: dmg") && macBlock.includes("- target: dir") && macBlock.includes("- target: zip"),
  );

  // CLI mode (what the release workflow runs): writes dist/update-mac.json on
  // success; exit 1 listing ALL problems at once on a broken dist — same UX
  // as dist:smoke. --dist keeps the run hermetic (no apps/desktop/dist needed).
  // P2-191: the dist fixture carries one zip per architecture and the CLI
  // writes update-mac-arm64.json + update-mac-x64.json, with the legacy
  // update-mac.json a byte-identical alias of the arm64 document.
  const cliRoot = mkdtempSync(join(tmpdir(), "ocr-update-feed-"));
  try {
    writeFileSync(join(cliRoot, "OpenCode Remote-0.2.1-arm64.zip"), "zip");
    writeFileSync(join(cliRoot, "OpenCode Remote-0.2.1-x64.zip"), "zip");
    writeFileSync(join(cliRoot, "latest-mac.yml"), YML);
    const cli = spawnSync(
      process.execPath,
      [join(repoRoot, "apps", "desktop", "scripts", "update-feed.mjs"), "--dist", cliRoot, "--tag", "v0.2.1"],
      { encoding: "utf8" },
    );
    check(
      "P2-146/P2-191: CLI exits 0 and writes update-mac-arm64/x64.json + the update-mac.json alias",
      cli.status === 0 &&
        existsSync(join(cliRoot, "update-mac-arm64.json")) &&
        existsSync(join(cliRoot, "update-mac-x64.json")) &&
        existsSync(join(cliRoot, "update-mac.json")),
    );
    const written = JSON.parse(readFileSync(join(cliRoot, "update-mac.json"), "utf8"));
    check(
      "P2-146: CLI-written feed carries url/name/notes/pub_date",
      typeof written.url === "string" && written.name === "0.2.1" && typeof written.pub_date === "string",
    );
    check(
      "P2-191: the alias file is byte-identical to the arm64 document, x64 points at its own zip",
      readFileSync(join(cliRoot, "update-mac.json"), "utf8") === readFileSync(join(cliRoot, "update-mac-arm64.json"), "utf8") &&
        JSON.parse(readFileSync(join(cliRoot, "update-mac-x64.json"), "utf8")).url.endsWith(
          encodeURIComponent("OpenCode Remote-0.2.1-x64.zip"),
        ),
    );

    rmSync(join(cliRoot, "update-mac.json"));
    rmSync(join(cliRoot, "update-mac-arm64.json"));
    rmSync(join(cliRoot, "update-mac-x64.json"));
    writeFileSync(join(cliRoot, "latest-mac.yml"), YML_030); // version 0.3.0 ≠ tag v0.2.1
    rmSync(join(cliRoot, "OpenCode Remote-0.2.1-arm64.zip"));
    rmSync(join(cliRoot, "OpenCode Remote-0.2.1-x64.zip"));
    const bad = spawnSync(
      process.execPath,
      [join(repoRoot, "apps", "desktop", "scripts", "update-feed.mjs"), "--dist", cliRoot, "--tag", "v0.2.1"],
      { encoding: "utf8" },
    );
    check(
      "P2-146: CLI exit 1 prints every problem at once and writes nothing",
      bad.status === 1 &&
        bad.stderr.includes("0.3.0") &&
        bad.stderr.includes("*.zip") &&
        bad.stderr.includes("problem(s)") &&
        !existsSync(join(cliRoot, "update-mac.json")) &&
        !existsSync(join(cliRoot, "update-mac-arm64.json")),
    );
  } finally {
    rmSync(cliRoot, { recursive: true, force: true });
  }

  // Boot check over the public darwin feed: a JSON body is handed to
  // Squirrel.Mac (serverType json) — never the manual yml flow.
  const darwinUpdater = fakeUpdater();
  check(
    "P2-146: packaged darwin + JSON public feed → update-available with Squirrel wired",
    (await checkForUpdatesOnBoot({
      packaged: true,
      platform: "darwin",
      currentVersion: "0.2.0",
      updater: darwinUpdater,
      fetchImpl: fakeFetcher(JSON.stringify(good.feed)),
      log: () => {},
    })) === "update-available" && darwinUpdater.spy.feedURLs[0]?.serverType === "json",
  );
}

{
  const savedFeed = process.env.OCR_UPDATE_FEED;
  // Round 4: the packaged loopback default is the only feed with a public
  // fallback — delete the env override so resolvedFeedUrl() takes that path.
  delete process.env.OCR_UPDATE_FEED;
  const savedMetrics = process.env.OCR_METRICS_PORT;
  delete process.env.OCR_METRICS_PORT;
  delete process.env.OCR_DAEMON_METRICS_PORT;
  const staged = resolvedFeedUrl({}, true);
  const fetchedUrls: string[] = [];
  const sequenceFetcher = ((input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url === staged || url.endsWith("staged.json")) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve(new Response(YML, { status: 200 }));
  }) as unknown as typeof fetch;
  const fallbackLogs: string[] = [];
  check(
    "P2-098: staged loopback down → public latest-mac.yml fallback answers (packaged default)",
    // The public fallback is a yml feed: since P2-131 that is a manual update.
    (await checkForUpdatesOnBoot({
      packaged: true,
      publicFeed: "http://127.0.0.1:9/latest-mac.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: sequenceFetcher,
      log: (l) => fallbackLogs.push(l),
    })) === "update-available-manual" && fallbackLogs.some((l) => l.includes("staged feed unreachable")),
  );
  check(
    "P2-098: fallback fetch order = staged first, public second (one retry)",
    JSON.stringify(fetchedUrls) === JSON.stringify([staged, "http://127.0.0.1:9/latest-mac.yml"]),
  );
  fetchedUrls.length = 0;
  check(
    "P2-098: staged AND public down → feed-unreachable (fail-open)",
    (await checkForUpdatesOnBoot({
      packaged: true,
      publicFeed: "http://127.0.0.1:1/public.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: fakeFetcher(null),
      log: () => {},
    })) === "feed-unreachable",
  );
  check(
    "P2-098: staged feed up → fallback never consulted",
    (await checkForUpdatesOnBoot({
      packaged: true,
      publicFeed: "http://127.0.0.1:1/public.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: fakeFetcher(JSON.stringify({ url: "http://x/y.zip", name: "0.4.0", notes: "" })),
      log: () => {},
    })) === "update-available",
  );
  fetchedUrls.length = 0;
  // Round 4: an OCR_UPDATE_FEED-configured feed is explicit operator intent —
  // when it is down the check fails loudly instead of silently requesting
  // github.com from a dev/staging machine.
  process.env.OCR_UPDATE_FEED = "http://127.0.0.1:1/staged.json";
  fetchedUrls.length = 0;
  check(
    "P2-098 round 4: OCR_UPDATE_FEED feed down → feed-unreachable, no public fallback fetch",
    (await checkForUpdatesOnBoot({
      packaged: true,
      publicFeed: "http://127.0.0.1:9/latest-mac.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: sequenceFetcher,
      log: () => {},
    })) === "feed-unreachable" && JSON.stringify(fetchedUrls) === JSON.stringify(["http://127.0.0.1:1/staged.json"]),
  );
  delete process.env.OCR_UPDATE_FEED;
  if (savedFeed !== undefined) process.env.OCR_UPDATE_FEED = savedFeed;
  if (savedMetrics !== undefined) process.env.OCR_METRICS_PORT = savedMetrics;
  check(
    "P2-098: injected feedUrl is authoritative — no public fallback fetch",
    (await checkForUpdatesOnBoot({
      feedUrl: "http://127.0.0.1:1/feed.json",
      packaged: true,
      publicFeed: "http://127.0.0.1:9/latest-mac.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: fakeFetcher(null),
      log: () => {},
    })) === "feed-unreachable",
  );
}


// --- P2-233: parseWindowsFeed (Windows latest.yml → version/file/digest) ------
{
  const WIN_YML = `version: 0.2.1
path: OpenCode-Remote-Setup-0.2.1.exe
sha512: qz9KkfakeBase64DigestAA==
releaseName: 0.2.1
releaseDate: '2026-09-01'
files:
  - url: OpenCode-Remote-Setup-0.2.1.exe
    sha512: qz9KkfakeBase64DigestAA==
    size: 1234
`;
  const feed = parseWindowsFeed(WIN_YML);
  check("parseWindowsFeed: valid feed → version, installer file, digest", feed?.version === "0.2.1" && feed?.file === "OpenCode-Remote-Setup-0.2.1.exe" && feed?.digest === "qz9KkfakeBase64DigestAA==");
  check("parseWindowsFeed: top-level path/sha512 win over the indented files block", feed?.file === "OpenCode-Remote-Setup-0.2.1.exe");
  check("parseWindowsFeed: empty body → null", parseWindowsFeed("") === null && parseWindowsFeed("   \n  ") === null);
  check("parseWindowsFeed: HTML error page → null", parseWindowsFeed("<html><body>404 Not Found</body></html>") === null);
  check("parseWindowsFeed: missing file name → null", parseWindowsFeed("version: 0.2.1\nsha512: abc==\n") === null);
  check("parseWindowsFeed: missing digest → null", parseWindowsFeed("version: 0.2.1\npath: Setup.exe\n") === null);
  check("parseWindowsFeed: non dotted-numeric version → null", parseWindowsFeed("version: v0.2.1\npath: Setup.exe\nsha512: abc==\n") === null);
  check("parseWindowsFeed: prerelease version → null", parseWindowsFeed("version: 0.2.1-beta.1\npath: Setup.exe\nsha512: abc==\n") === null);
  check("parseWindowsFeed: prose version → null", parseWindowsFeed("version: banana\npath: Setup.exe\nsha512: abc==\n") === null);
  const spaced = parseWindowsFeed("version: 0.2.1 \r\npath: OpenCode-Remote-Setup-0.2.1.exe\t \r\nsha512:   qz9KkfakeBase64DigestAA==  \r\n");
  check("parseWindowsFeed: whitespace around values tolerated (also CRLF)", spaced?.version === "0.2.1" && spaced?.file === "OpenCode-Remote-Setup-0.2.1.exe" && spaced?.digest === "qz9KkfakeBase64DigestAA==");
  check("installerNameIsSafe: plain setup name accepted", installerNameIsSafe("OpenCode-Remote-Setup-0.2.1.exe") === true);
  check("installerNameIsSafe: separators/dotdot/colon/oversize refused", !installerNameIsSafe("") && !installerNameIsSafe("a/b.exe") && !installerNameIsSafe("a\\b.exe") && !installerNameIsSafe("a..b.exe") && !installerNameIsSafe("C:setup.exe") && !installerNameIsSafe("a".repeat(MAX_INSTALLER_NAME + 1)));
}

// --- P2-233: assetUrlFrom (installer resolved NEXT TO the feed, fail-closed) --
check(
  "assetUrlFrom: simple name resolves in the feed's own directory",
  assetUrlFrom("https://github.com/foo/bar/releases/latest/download/latest.yml", "App-Setup-0.2.1.exe") ===
    "https://github.com/foo/bar/releases/latest/download/App-Setup-0.2.1.exe",
);
check(
  "assetUrlFrom: spaces percent-encoded",
  assetUrlFrom("https://feeds.example/rel/", "My App Setup.exe") === "https://feeds.example/rel/My%20App%20Setup.exe",
);
check("assetUrlFrom: empty name refused", assetUrlFrom("https://x/latest.yml", "") === null && assetUrlFrom("https://x/latest.yml", "   ") === null);
check("assetUrlFrom: slash refused", assetUrlFrom("https://x/latest.yml", "dir/setup.exe") === null);
check("assetUrlFrom: backslash refused", assetUrlFrom("https://x/latest.yml", "dir\\setup.exe") === null);
check("assetUrlFrom: dot-dot refused", assetUrlFrom("https://x/latest.yml", "..%2Fsetup.exe") === null && assetUrlFrom("https://x/latest.yml", "..") === null);
check("assetUrlFrom: embedded scheme refused", assetUrlFrom("https://x/latest.yml", "https://evil/setup.exe") === null);
check("assetUrlFrom: colon refused", assetUrlFrom("https://x/latest.yml", "C:setup.exe") === null);
check("assetUrlFrom: over the documented size ceiling refused", assetUrlFrom("https://x/latest.yml", `${"a".repeat(MAX_INSTALLER_NAME + 1)}.exe`) === null);
check("assetUrlFrom: invalid feed URL refused", assetUrlFrom("not a url at all", "Setup.exe") === null);
check("assetUrlFrom: non-http(s) feed URL refused", assetUrlFrom("ftp://x/latest.yml", "Setup.exe") === null);

// --- P2-233: integrityVerdict (fail-closed digest compare, static pt-BR) ------
{
  const noPathNoUrl = (message: string) => !/[A-Za-z]:[\\/]/.test(message) && !message.includes("://") && !message.includes("www.");
  const accepted = integrityVerdict("AbCdEf123456==", "AbCdEf123456==");
  check("integrityVerdict: equal digest accepted", accepted.ok === true && accepted.message.length > 0);
  check(
    "integrityVerdict: case-only difference accepted",
    integrityVerdict("AbCdEf123456==", "aBcDeF123456==").ok === true,
  );
  const refused = integrityVerdict("AbCdEf123456==", "TotallyDifferent==");
  check("integrityVerdict: different digest refused", refused.ok === false && refused.message.length > 0);
  check(
    "integrityVerdict: missing expected/measured digest refused",
    integrityVerdict(null, "abc").ok === false && integrityVerdict("abc", "").ok === false && integrityVerdict(null, null).ok === false,
  );
  const messages = [accepted.message, refused.message, integrityVerdict(null, null).message];
  check(
    "integrityVerdict: every phrase is static pt-BR with no absolute path and no URL scheme",
    messages.every((m) => noPathNoUrl(m) && !/[\n\r]/.test(m) && m.length < 200),
  );
}

// --- P2-233: download decision (RULE ORDER: harness first, always) -------------
check(
  "winDownloadDecision: harness session never downloads, even with a newer version",
  winDownloadDecision({ harnessSession: true, packaged: true, platform: "win32", explicitAction: true }).action === "skip" &&
    winDownloadDecision({ harnessSession: true, packaged: true, platform: "win32", explicitAction: true }).reason === "harness-session",
);
check(
  "winDownloadDecision: unpackaged app never downloads",
  winDownloadDecision({ harnessSession: false, packaged: false, platform: "win32", explicitAction: true }).action === "skip",
);
check(
  "winDownloadDecision: macOS never downloads through this path",
  winDownloadDecision({ harnessSession: false, packaged: true, platform: "darwin", explicitAction: true }).action === "skip",
);
check(
  "winDownloadDecision: packaged Windows + explicit action downloads",
  winDownloadDecision({ harnessSession: false, packaged: true, platform: "win32", explicitAction: true }).action === "download",
);
check(
  "winDownloadDecision: packaged Windows without an explicit action never downloads (boot/timer/recheck)",
  winDownloadDecision({ harnessSession: false, packaged: true, platform: "win32", explicitAction: false }).action === "skip",
);

// --- P2-233: the win32 explicit-action path through checkForUpdatesOnBoot -----
{
  const WIN_YML = `version: 0.9.0
path: OpenCode-Remote-Setup-0.9.0.exe
sha512: qz9KkfakeBase64DigestAA==
releaseName: 0.9.0
`;
  const winOpts = {
    feedUrl: "https://github.com/foo/bar/releases/latest/download/latest.yml",
    currentVersion: "0.2.0",
    updater: fakeUpdater(),
    fetchImpl: fakeFetcher(WIN_YML),
    log: () => {},
  };
  const requests: WinInstallerRequest[] = [];
  const okStatus = await checkForUpdatesOnBoot({
    ...winOpts,
    platform: "win32",
    winInstallerDownload: async (info) => {
      requests.push(info);
      return true;
    },
  });
  check(
    "P2-233: win32 + sink + parsed feed → installer request next to the feed and update-installer-ready",
    okStatus === "update-installer-ready" &&
      JSON.stringify(requests) ===
        JSON.stringify([
          {
            version: "0.9.0",
            file: "OpenCode-Remote-Setup-0.9.0.exe",
            url: "https://github.com/foo/bar/releases/latest/download/OpenCode-Remote-Setup-0.9.0.exe",
            expectedDigest: "qz9KkfakeBase64DigestAA==",
          },
        ]),
  );
  const openedUrls: string[] = [];
  const fallbackStatus = await checkForUpdatesOnBoot({
    ...winOpts,
    platform: "win32",
    openReleasePage: (url) => openedUrls.push(url),
    winInstallerDownload: async () => false,
  });
  check(
    "P2-233: sink declines → manual release-page fallback intact (same openReleasePage sink)",
    fallbackStatus === "update-available-manual" &&
      JSON.stringify(openedUrls) === JSON.stringify(["https://github.com/foo/bar/releases/latest"]),
  );
  const unparseableStatus = await checkForUpdatesOnBoot({
    ...winOpts,
    fetchImpl: fakeFetcher("<html>502 Bad Gateway</html>"),
    platform: "win32",
    openReleasePage: (url) => openedUrls.push(url),
    winInstallerDownload: async () => true,
  });
  check(
    "P2-233: unparseable Windows feed body → sink never fires (unrecognized-feed)",
    unparseableStatus === "unrecognized-feed",
  );
  let macSinkCalls = 0;
  const macStatus = await checkForUpdatesOnBoot({
    ...winOpts,
    platform: "darwin",
    winInstallerDownload: async (info) => {
      macSinkCalls++;
      return Boolean(info);
    },
  });
  check(
    "P2-233: macOS tray re-check keeps the P2-131 behavior byte-for-byte (sink never invoked)",
    macStatus === "update-available-manual" && macSinkCalls === 0,
  );
}

// --- P2-233: source-level contract (installer never executed, rule order, no timers)
{
  const mainSrc = readFileSync(join(repoRoot, "apps", "desktop", "src", "main.ts"), "utf8");
  const updateSrc = readFileSync(join(repoRoot, "apps", "desktop", "src", "update.ts"), "utf8");
  const winSrc = readFileSync(join(repoRoot, "apps", "desktop", "src", "winupdate.ts"), "utf8");
  // Module purity: the decision layer never gains I/O, network or timers.
  check(
    "P2-233: winupdate.ts stays pure (no electron, no node:fs, no fetch, no child_process, no timers)",
    !winSrc.includes("from \"electron\"") &&
      !winSrc.includes("node:fs") &&
      !winSrc.includes("fetch(") &&
      !winSrc.includes("child_process") &&
      !winSrc.includes("setTimeout") &&
      !winSrc.includes("setInterval"),
  );
  // Rule-order contract inside the pure decision: harness-session is the FIRST
  // consulted rule, before packaged, platform and explicit-action.
  const decStart = winSrc.indexOf("export function winDownloadDecision");
  const decSrc = winSrc.slice(decStart, winSrc.indexOf("}", winSrc.indexOf("explicitAction", decStart)) + 1);
  check(
    "P2-233: harness-session rule is the first consulted in winDownloadDecision",
    decSrc.indexOf("input.harnessSession") >= 0 &&
      decSrc.indexOf("input.harnessSession") < decSrc.indexOf("input.packaged") &&
      decSrc.indexOf("input.packaged") < decSrc.indexOf("input.platform") &&
      decSrc.indexOf("input.platform") < decSrc.indexOf("input.explicitAction"),
  );
  // No execution surface anywhere near the Windows download: the handler never
  // spawns/execs/opens the installer — it only reveals it via showItemInFolder.
  const handlerStart = mainSrc.indexOf("async function downloadWinInstaller");
  const handlerSrc = mainSrc.slice(handlerStart, mainSrc.indexOf("function scheduleNextUpdateCheck", handlerStart));
  check(
    "P2-233: main.ts handler consults the decision before any fetch, never executes the installer",
    handlerSrc.length > 0 &&
      handlerSrc.indexOf("winDownloadDecision(") >= 0 &&
      handlerSrc.indexOf("winDownloadDecision(") < handlerSrc.indexOf("fetch(") &&
      !handlerSrc.includes("spawn(") &&
      !handlerSrc.includes("execFile(") &&
      !handlerSrc.includes("openPath(") &&
      !handlerSrc.includes("quitAndInstall"),
  );
  check(
    "P2-233: handler reveals the installer with showItemInFolder (never openPath/openExternal on it)",
    handlerSrc.includes("showItemInFolder(") && !handlerSrc.includes("openPath(") && !handlerSrc.includes("openExternal("),
  );
  check(
    "P2-233: no child_process anywhere in main.ts/update.ts, no exec of the downloaded file",
    !mainSrc.includes("child_process") && !updateSrc.includes("child_process") && !updateSrc.includes("spawn("),
  );
  // Action-driven only: no new periodic timer anywhere in the update path
  // (main.ts's two pre-existing setInterval calls are out of scope here —
  // hang-watch and the pairing poll — and P2-155's recheck timer is untouched).
  check(
    "P2-233: no new periodic timers in update.ts, winupdate.ts or the download handler",
    !updateSrc.includes("setInterval(") &&
      !updateSrc.includes("setTimeout(") &&
      !winSrc.includes("setTimeout") &&
      !winSrc.includes("setInterval") &&
      !handlerSrc.includes("setTimeout(") &&
      !handlerSrc.includes("setInterval("),
  );
  // The win32 gate precedes the sink invocation in update.ts: macOS behavior
  // is byte-for-byte inert.
  check(
    "P2-233: update.ts gates the Windows sink behind platform === win32",
    updateSrc.indexOf("platform === \"win32\"") >= 0 &&
      updateSrc.indexOf("platform === \"win32\"") < updateSrc.indexOf("winInstallerDownload({"),
  );
  check(
    "P2-233: update-installer-ready has its own tray/menu label",
    updateMenuLabel("update-installer-ready") === "Update downloaded — installer ready",
  );
}

// --- e2e: compiled update.js inside the real Electron ------------------------
// P2-131: the e2e layer spawns real Electron and needs dist-electron — it is
// skipped in unit-only mode so the fast root test:unit battery stays Electron-
// free (P2-107: the file itself must still be wired into test:unit).
async function runElectronE2E(): Promise<void> {
  const req = createRequire(join(repoRoot, "package.json"));
  const electronBin = req("electron") as unknown as string;
  check("electron binary resolved", typeof electronBin === "string" && existsSync(electronBin));
  const compiled = join(repoRoot, "apps", "desktop", "dist-electron", "update.js");
  if (!existsSync(compiled)) {
    spawnSync("npm", ["run", "build", "--workspace", "@ocr/desktop"], { cwd: repoRoot, stdio: "inherit" });
  }
  check("desktop shell built (dist-electron/update.js)", existsSync(compiled));

  // Staged feed dir: latest-mac.yml (version 0.2.1 + fake release notes) plus the
  // same release as Squirrel.Mac JSON — both static, served on loopback.
  const feedServer = createServer((req, res) => {
    if (req.url === "/latest-mac.yml") {
      res.writeHead(200, { "content-type": "text/yaml" });
      res.end(YML);
    } else if (req.url === "/feed.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          url: `http://127.0.0.1:${(feedServer.address() as { port: number }).port}/OpenCode Remote-0.2.1-mac.zip`,
          name: "0.2.1",
          notes: "fake release notes",
          releaseDate: "2026-09-01",
        }),
      );
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => feedServer.listen(0, "127.0.0.1", r));
  const feedPort = (feedServer.address() as { port: number }).port;
  process.on("exit", () => {
    feedServer.closeAllConnections();
    feedServer.close();
  });

  const DRIVER = join(repoRoot, "scripts", "desktop-update-driver.cjs");
  const MARKER = "OCR_UPDATE_SMOKE_RESULT ";
  // Async spawn (not spawnSync): the feed server lives in this process, and a
  // sync wait would block the event loop so the server could never answer
  // Electron's fetch (the request would only die on our 10s feed timeout).
  async function runDriver(feedUrl: string | null): Promise<{ status: number; stdout: string }> {
    const env = { ...process.env };
    delete env.OCR_UPDATE_FEED;
    if (feedUrl) env.OCR_UPDATE_FEED = feedUrl;
    env.OCR_UPDATE_MODULE = compiled;
    const child = spawn(electronBin, [DRIVER], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stdout += String(chunk);
    });
    const killed = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const status: number = await new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve(code ?? (signal ? -1 : -1)));
    });
    clearTimeout(killed);
    return { status, stdout };
  }
  function resultOf(stdout: string): { status?: string } {
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
    return line ? (JSON.parse(line.slice(MARKER.length)) as { status?: string }) : {};
  }

  const jsonRun = await runDriver(`http://127.0.0.1:${feedPort}/feed.json`);
  check("e2e JSON feed: driver exits cleanly", jsonRun.status === 0);
  check("e2e JSON feed: status update-available", resultOf(jsonRun.stdout).status === "update-available");
  check(
    "e2e JSON feed: app logs update-available (decision + real autoUpdater event)",
    jsonRun.stdout.includes("update-available: 0.2.1") && jsonRun.stdout.includes("update-available (autoUpdater event)"),
  );

  const ymlRun = await runDriver(`http://127.0.0.1:${feedPort}/latest-mac.yml`);
  check("e2e yml feed: driver exits cleanly", ymlRun.status === 0);
  check(
    "e2e yml feed: manual status from latest-mac.yml (0.2.1, fake notes, P2-131)",
    resultOf(ymlRun.stdout).status === "update-available-manual" && ymlRun.stdout.includes("update-available: 0.2.1"),
  );

  const deadRun = await runDriver("http://127.0.0.1:1/feed.json");
  check("e2e dead feed: driver exits cleanly (no crash)", deadRun.status === 0);
  check(
    "e2e dead feed: feed-unreachable, no update-available",
    resultOf(deadRun.stdout).status === "feed-unreachable" && !deadRun.stdout.includes("update-available"),
  );

  const unsetRun = await runDriver(null);
  check("e2e unset env: driver exits cleanly", unsetRun.status === 0);
  check(
    "e2e unset env: disabled and silent (no fetch, no update-available)",
    resultOf(unsetRun.stdout).status === "disabled" && !unsetRun.stdout.includes("update-available"),
  );

  feedServer.close();
}

if (UNIT_ONLY) {
  console.log("unit-only: Electron e2e layer skipped (--unit-only / OCR_UPDATE_UNIT_ONLY)");
} else {
  await runElectronE2E();
}
console.log(failures === 0 ? "\ndesktop update feed tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
