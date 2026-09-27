/**
 * eval-11: the REAL shell's main-window load-failure journey (P2-247) — the
 * retry budget must run out and the give-up page must render.
 *
 * Boots the built shell (apps/desktop/dist-electron) hermetically — temp
 * userData, run-unique OCR_DESKTOP_SESSION (hidden window), OCR_KEEPER_PID
 * leash, no daemon sidecar — with OCR_WEB_URL pointing at a file:// page that
 * does not exist, so every main-frame load fails exactly like a corrupted
 * install. Before eval-11, Chromium's error page fired did-finish-load right
 * after each did-fail-load, main.ts refilled the budget there, and the shell
 * reloaded the error page every 1.5s forever (measured: 7 retries in 9s, no
 * give-up). Now: exactly LOAD_FAIL_MAX_ATTEMPTS retries, one give-up line,
 * and the window ends on the static give-up page.
 *
 * Needs a display-capable Electron (macOS/Windows dev machine or runner).
 * Run: npx tsx scripts/desktop-loadfail.test.ts
 */
import "./testhome";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOAD_FAIL_MAX_ATTEMPTS, LOAD_FAIL_RETRY_DELAY_MS, LOAD_FAIL_USER_MESSAGE } from "../apps/desktop/src/loadfail";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const req = createRequire(join(repoRoot, "package.json"));
const electronBin = req("electron") as unknown as string;
const { _electron } = req("playwright-core") as typeof import("playwright-core");
const mainJs = join(repoRoot, "apps", "desktop", "dist-electron", "main.js");
if (!existsSync(mainJs)) {
  spawnSync("npm", ["run", "build", "--workspace", "@ocr/desktop"], { cwd: repoRoot, stdio: "inherit" });
}
check("desktop shell built (dist-electron/main.js)", existsSync(mainJs));

const userData = mkdtempSync(join(tmpdir(), "ocr-loadfail-"));
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  OCR_USER_DATA_DIR: userData,
  OCR_DESKTOP_SESSION: `loadfail-${process.pid}-${Date.now()}`,
  OCR_KEEPER_PID: String(process.pid),
  OCR_DAEMON_STATE_FILE: join(userData, "daemon-state.json"),
  OCR_DAEMON_ENTRY: join(userData, "no-daemon-entry.js"),
  OCR_DAEMON_FORCE_DOWN: "1",
  OCR_WEB_URL: `file://${join(userData, "missing", "index.html")}`,
};

// Budget: every attempt waits LOAD_FAIL_RETRY_DELAY_MS, plus boot and slack.
const settleMs = (LOAD_FAIL_MAX_ATTEMPTS + 3) * LOAD_FAIL_RETRY_DELAY_MS + 3_000;
const app = await _electron.launch({ executablePath: electronBin, args: [join(repoRoot, "apps", "desktop")], env, timeout: 60_000 });
try {
  await app.firstWindow({ timeout: 60_000 });
  await new Promise((r) => setTimeout(r, settleMs));
  const lines = readFileSync(join(userData, "logs", "desktop.log"), "utf8").split("\n");
  const retries = lines.filter((l) => l.includes("load watch: falha ao carregar a janela principal — tentando de novo")).length;
  const giveups = lines.filter((l) => l.includes("load watch:") && l.includes("recarregamentos automáticos esgotados")).length;
  check(`exactly ${LOAD_FAIL_MAX_ATTEMPTS} automatic retries (saw ${retries})`, retries === LOAD_FAIL_MAX_ATTEMPTS);
  check(`exactly one give-up line (saw ${giveups})`, giveups === 1);
  const finalUrl = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.getURL() ?? "");
  check("the window ends on the give-up page (data:)", finalUrl.startsWith("data:"));
  const text = await (await app.firstWindow()).evaluate(() => document.body?.innerText ?? "");
  check("the give-up page shows the static user message", text.includes(LOAD_FAIL_USER_MESSAGE.slice(0, 40)));
  if (!text.includes(LOAD_FAIL_USER_MESSAGE.slice(0, 40))) console.log(`  page text: ${JSON.stringify(text.slice(0, 80))}`);
} finally {
  const pid = app.process().pid;
  await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 12_000))]);
  try {
    if (pid) process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(userData, { recursive: true, force: true });
}

console.log(failures === 0 ? "\ndesktop loadfail: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
