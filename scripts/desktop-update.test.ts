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
 */
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
check("yml feed newer → update-available logged", ymlStatus === "update-available" && ymlLogs.some((l) => l.includes("update-available: 0.2.1")));
check("yml feed: Squirrel NOT wired (spike finding)", ymlUpdater.spy.checks === 0);

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
  resolvedFeedUrl,
  shouldOfferInstall,
  versionFromDownloadedArgs,
  type UpdateDialogSinks,
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
check(
  "publicFeedUrl: packaged default = GitHub releases latest-mac.yml",
  publicFeedUrl({}, true) === "https://github.com/caiovicentino/opencode-remote/releases/latest/download/latest-mac.yml",
);
check(
  "publicFeedUrl: OCR_PUBLIC_UPDATE_FEED overrides (forks/staging)",
  publicFeedUrl({ OCR_PUBLIC_UPDATE_FEED: "https://fork.dev/latest-mac.yml" }, true) === "https://fork.dev/latest-mac.yml",
);
check("publicFeedUrl: dev unpackaged has no public feed", publicFeedUrl({}, false) === null);

{
  const savedFeed = process.env.OCR_UPDATE_FEED;
  process.env.OCR_UPDATE_FEED = "http://127.0.0.1:1/staged.json";
  const fetchedUrls: string[] = [];
  const sequenceFetcher = ((input: RequestInfo | URL) => {
    const url = String(input);
    fetchedUrls.push(url);
    if (url.endsWith("staged.json")) return Promise.reject(new Error("ECONNREFUSED"));
    return Promise.resolve(new Response(YML, { status: 200 }));
  }) as unknown as typeof fetch;
  const fallbackLogs: string[] = [];
  check(
    "P2-098: staged feed down → public latest-mac.yml fallback answers",
    (await checkForUpdatesOnBoot({
      publicFeed: "http://127.0.0.1:9/latest-mac.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: sequenceFetcher,
      log: (l) => fallbackLogs.push(l),
    })) === "update-available" && fallbackLogs.some((l) => l.includes("staged feed unreachable")),
  );
  check(
    "P2-098: fallback fetch order = staged first, public second (one retry)",
    JSON.stringify(fetchedUrls) === JSON.stringify(["http://127.0.0.1:1/staged.json", "http://127.0.0.1:9/latest-mac.yml"]),
  );
  check(
    "P2-098: staged AND public down → feed-unreachable (fail-open)",
    (await checkForUpdatesOnBoot({
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
      publicFeed: "http://127.0.0.1:1/public.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: fakeFetcher(JSON.stringify({ url: "http://x/y.zip", name: "0.4.0", notes: "" })),
      log: () => {},
    })) === "update-available",
  );
  check(
    "P2-098: injected feedUrl is authoritative — no public fallback fetch",
    (await checkForUpdatesOnBoot({
      feedUrl: "http://127.0.0.1:1/feed.json",
      publicFeed: "http://127.0.0.1:9/latest-mac.yml",
      currentVersion: "0.2.0",
      updater: fakeUpdater(),
      fetchImpl: fakeFetcher(null),
      log: () => {},
    })) === "feed-unreachable",
  );
  if (savedFeed === undefined) delete process.env.OCR_UPDATE_FEED;
  else process.env.OCR_UPDATE_FEED = savedFeed;
}


// --- e2e: compiled update.js inside the real Electron ------------------------
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
  "e2e yml feed: app logs update-available from latest-mac.yml (0.2.1, fake notes)",
  resultOf(ymlRun.stdout).status === "update-available" && ymlRun.stdout.includes("update-available: 0.2.1"),
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
console.log(failures === 0 ? "\ndesktop update feed tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
