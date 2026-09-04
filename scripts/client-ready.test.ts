/**
 * Client-ready tests (P1-050): crash reporting, diagnostics bundle and the
 * daemon's staged updates folder resolver. Pure logic under plain tsx — the
 * electron/IPC layers are exercised by the desktop-* test files.
 *
 * Run: npx tsx scripts/client-ready.test.ts
 */
import { join, sep } from "node:path";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

import {
  CRASH_LOG_MAX_FILES,
  clientLogsDir,
  crashFileName,
  formatCrashReport,
  writeCrashReport,
  type CrashLogFs,
} from "../apps/desktop/src/crash-log";

// --- clientLogsDir ------------------------------------------------------------
check("clientLogsDir: under ~/.opencode-remote/pilot/client-logs", clientLogsDir("/home/u") === join("/home/u", ".opencode-remote", "pilot", "client-logs"));

// --- crashFileName / formatCrashReport ---------------------------------------
const now = new Date(2026, 8, 2, 9, 34, 12, 345); // local 2026-09-02 09:34:12.345
check(
  "crashFileName: sortable local timestamp + safe kind",
  crashFileName("renderer gone", now) === "crash-2026-09-02T09-34-12-345-renderer-gone.txt",
);
check(
  "formatCrashReport: kind + version + detail (ISO stamp, TZ-independent)",
  formatCrashReport("uncaught", "boom stack", "0.2.0", now).includes("kind: uncaught\napp: OpenCode Remote 0.2.0\nat: ") &&
    formatCrashReport("uncaught", "boom stack", "0.2.0", now).endsWith("\n\nboom stack\n"),
);

// --- writeCrashReport: write + retention --------------------------------------
function fakeCrashFs(existing: string[] = []) {
  const files = new Set(existing);
  const fs = {
    existsSync: (f: string) => (files.has(f) ? true : false),
    mkdirSync: (d: string) => void files.add(d + "/"),
    readdirSync: (d: string) => [...files].filter((f) => f.startsWith(d + "/")).map((f) => f.slice((d + "/").length)),
    unlinkSync: (f: string) => void files.delete(f),
    appendFileSync: (f: string, data: string) => void files.add(f),
    list: files,
  } as unknown as CrashLogFs & { list: Set<string> };
  return fs;
}
const cfs = fakeCrashFs();
const dir = join("/tmp", "client-logs-test");
const paths: string[] = [];
for (let i = 0; i < CRASH_LOG_MAX_FILES + 5; i++) {
  const p = writeCrashReport(dir, "uncaught", `detail ${i}`, "0.2.0", cfs, new Date(Date.now() + i * 1000));
  if (p) paths.push(p);
}
check(
  `writeCrashReport: retention keeps the newest ${CRASH_LOG_MAX_FILES} files`,
  paths.length === CRASH_LOG_MAX_FILES + 5 && cfs.readdirSync(dir).filter((f) => f.startsWith("crash-")).length === CRASH_LOG_MAX_FILES,
);
check(
  "writeCrashReport: exactly the newest files survive (oldest pruned)",
  cfs
    .readdirSync(dir)
    .filter((f) => f.startsWith("crash-"))
    .sort()
    .join("|") === paths.slice(5).map((p) => p.split("/").pop()).sort().join("|"),
);
check(
  "writeCrashReport: detail carries the reason",
  (() => {
    const p = writeCrashReport(dir, "renderer", "reason=crashed exitCode=133", "0.2.0", cfs, now);
    return p !== null;
  })(),
);

// --- buildDiagnosticReport -----------------------------------------------------
import { buildDiagnosticReport, DIAG_LOG_TAIL } from "../apps/desktop/src/diagnostics";

const report = buildDiagnosticReport({
  appVersion: "0.2.0",
  electronVersion: "44.1.1",
  platform: "darwin arm64",
  locale: "pt-BR",
  packaged: true,
  userData: "/users/u/Library/Application Support/OpenCode Remote",
  daemon: { healthy: false, down: false, reconnecting: true, attempts: 3, port: 8792, portReason: null },
  logTail: ["[1] line", "[2] line"],
  crashFiles: ["crash-2026-09-02T09-34-12-345-renderer.txt"],
  updateStatus: "update-available",
});
check("diagnostics: app + electron version present", report.includes("app: 0.2.0 (electron 44.1.1)"));
check("diagnostics: reconnecting attempt surfaced", report.includes("reconnecting (attempt 3)"));
check("diagnostics: crash file names present", report.includes("crash-2026-09-02T09-34-12-345-renderer.txt"));
check("diagnostics: update status present", report.includes("last update check: update-available"));
check("diagnostics: log tail embedded", report.includes("[1] line") && report.includes("[2] line"));
check("diagnostics: DIAG_LOG_TAIL is bounded (support-friendly)", DIAG_LOG_TAIL === 40);
check(
  "diagnostics: healthy daemon wording",
  buildDiagnosticReport({
    appVersion: "0.2.0",
    electronVersion: "44.1.1",
    platform: "darwin arm64",
    locale: "en",
    packaged: false,
    userData: "/u",
    daemon: { healthy: true, down: false, reconnecting: false, attempts: 0, port: 8792, portReason: null },
    logTail: [],
    crashFiles: [],
    updateStatus: null,
  }).includes("daemon: healthy"),
);

// --- P2-143: resolved daemon port + reason surfaced in the bundle --------------
const daemonLine = (daemon: { port: number; portReason: string | null }): string =>
  buildDiagnosticReport({
    appVersion: "0.2.0",
    electronVersion: "44.1.1",
    platform: "darwin arm64",
    locale: "en",
    packaged: false,
    userData: "/u",
    daemon: { healthy: true, down: false, reconnecting: false, attempts: 0, ...daemon },
    logTail: [],
    crashFiles: [],
    updateStatus: null,
  })
    .split("\n")
    .find((l) => l.startsWith("daemon:")) ?? "";
check("diagnostics: fallback port + reason surfaced (P2-143)", (() => {
  const line = daemonLine({ port: 8793, portReason: "fallback" });
  return line.includes("8793") && line.includes("fallback") && line.endsWith("porta 8793 (fallback)");
})());
check("diagnostics: null portReason omits the reason (no junk in the bundle)", (() => {
  const line = daemonLine({ port: 8792, portReason: null });
  return line.includes("8792") && !line.includes("(null)") && !line.includes("undefined");
})());

// --- daemon updates resolver (apps/daemon/src/updates.ts) ----------------------
import { resolveUpdatePath, UPDATE_CONTENT_TYPES, updatesDir } from "../apps/daemon/src/updates";

const base = join(sep, "home", "u", ".opencode-remote", "updates");
check("resolveUpdatePath: root feed.json", resolveUpdatePath(base, "/feed.json") === join(base, "feed.json"));
check(
  "resolveUpdatePath: versioned artifact",
  resolveUpdatePath(base, "/0.2.1/OpenCode Remote-0.2.1-mac.zip") === join(base, "0.2.1", "OpenCode Remote-0.2.1-mac.zip"),
);
check("resolveUpdatePath: encoded space decodes", resolveUpdatePath(base, "/0.2.1/OpenCode%20Remote-0.2.1-mac.zip") !== null);
check("resolveUpdatePath: empty → null", resolveUpdatePath(base, "/") === null);
check("resolveUpdatePath: traversal .. → null", resolveUpdatePath(base, "/0.2.1/..%2f..%2fdaemon.json") === null);
check("resolveUpdatePath: dot segment → null", resolveUpdatePath(base, "/../daemon.json") === null);
check("resolveUpdatePath: dotfile → null", resolveUpdatePath(base, "/.env") === null);
check("resolveUpdatePath: unknown extension → null", resolveUpdatePath(base, "/0.2.1/payload.sh") === null);
check("resolveUpdatePath: malformed escape → null", resolveUpdatePath(base, "/%ZZ") === null);
check("resolveUpdatePath: yml allowed", resolveUpdatePath(base, "/0.2.1/latest-mac.yml") !== null);
check("content types: zip + json + yml mapped", UPDATE_CONTENT_TYPES[".zip"] === "application/zip" && UPDATE_CONTENT_TYPES[".json"].includes("application/json") && UPDATE_CONTENT_TYPES[".yml"].includes("text/yaml"));
check("updatesDir: ~/.opencode-remote/updates", updatesDir("/home/u") === join("/home/u", ".opencode-remote", "updates"));

console.log(failures === 0 ? "\nclient-ready tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
