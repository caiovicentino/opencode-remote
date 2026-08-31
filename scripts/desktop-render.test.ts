/**
 * Desktop render smoke test (P0-002): boots the real Electron shell against
 * the built web UI (file://) and validates RENDERING, not just process boot.
 *
 * Beyond booting, it waits for did-finish-load, captures renderer console
 * errors (webContents "console-message") and checks the app actually mounted
 * content into #root — so a white window (e.g. an asset 404 on file://) fails
 * the gate. ServiceWorker failures on file:// are known noise (P3-005).
 *
 * Run: npx tsx scripts/desktop-render.test.ts
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const MARKER = "OCR_RENDER_SMOKE_RESULT ";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// --- resolve the Electron binary (hoisted at the repo root) ------------------
const req = createRequire(join(repoRoot, "package.json"));
let electronBin = "";
try {
  electronBin = req("electron") as unknown as string;
} catch {
  electronBin = "";
}
check("electron binary resolved", typeof electronBin === "string" && existsSync(electronBin));
if (!electronBin || !existsSync(electronBin)) {
  // spawnSync("") throws synchronously — fail cleanly instead of crashing.
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}

// --- ensure build artifacts exist (the gate's npm run build produces both) ---
const webIndex = join(repoRoot, "apps", "web", "dist", "index.html");
if (!existsSync(webIndex)) {
  spawnSync("npm", ["run", "build", "--workspace", "@ocr/web"], { cwd: repoRoot, stdio: "inherit" });
}
check("web UI built (apps/web/dist/index.html)", existsSync(webIndex));

const preload = join(repoRoot, "apps", "desktop", "dist-electron", "preload.js");
if (!existsSync(preload)) {
  spawnSync("npm", ["run", "build", "--workspace", "@ocr/desktop"], { cwd: repoRoot, stdio: "inherit" });
}
check("desktop shell built (dist-electron/preload.js)", existsSync(preload));

// --- run the driver inside Electron ------------------------------------------
const driver = join(repoRoot, "scripts", "desktop-render-driver.cjs");
const res = spawnSync(electronBin, [driver], {
  cwd: repoRoot,
  encoding: "utf8",
  timeout: 120_000,
  env: {
    ...process.env,
    OCR_SMOKE_HTML: webIndex,
    OCR_SMOKE_PRELOAD: preload,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  },
});

// 0 = render OK, 1 = render broken (see the checks below) — anything else is
// a harness failure (crash, kill, timeout) with no verdict to trust.
check("driver ran to completion (exit 0/1)", res.status === 0 || res.status === 1);

const line = (res.stdout ?? "")
  .split("\n")
  .find((l) => l.startsWith(MARKER));
const result = line
  ? (JSON.parse(line.slice(MARKER.length)) as {
      loadOk?: boolean;
      canarySeen?: boolean;
      rootChildren?: number;
      bodyTextLength?: number;
      consoleErrors?: string[];
    })
  : null;

if (!result) {
  console.error("driver produced no result; stdout tail:", (res.stdout ?? "").slice(-400));
  if (res.stderr) console.error("stderr tail:", res.stderr.slice(-400));
  check("render smoke driver ran", false);
} else {
  check("did-finish-load fired", result.loadOk === true);
  check("console capture verified (canary seen)", result.canarySeen === true);
  check("#root mounted content (no white window)", (result.rootChildren ?? 0) > 0 && (result.bodyTextLength ?? 0) > 0);
  check("no non-noise console errors", Array.isArray(result.consoleErrors) && result.consoleErrors.length === 0);
  if (result.consoleErrors?.length) {
    for (const e of result.consoleErrors) console.error("  renderer error:", e);
  }
}

console.log(failures === 0 ? "\ndesktop render smoke: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
