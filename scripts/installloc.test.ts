/**
 * P2-299: Windows install-location table tests (apps/desktop/src/installloc.ts)
 * — the portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real
 * installloc.ts/main.ts sources for the purity and wiring assertions, via a
 * URL relative to this file (Windows-safe).
 * Run: npx tsx scripts/installloc.test.ts
 */
import { readFileSync } from "node:fs";
import { installMessage, installVerdict } from "../apps/desktop/src/installloc";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// --- the full Windows table, rules in the documented order -----------------------
{
  const v = (path: string | null) => installVerdict("win32", path as string, null, true);

  // ok: the recognized install destinations stay quiet
  check(
    "table: path under the system program folder → ok",
    v("C:\\Program Files\\OpenCode Remote\\OpenCode Remote.exe").state === "ok",
  );
  check(
    "table: path under the x86 system program folder → ok",
    v("C:\\Program Files (x86)\\OpenCode Remote\\OpenCode Remote.exe").state === "ok",
  );
  check(
    "table: path under the per-user program area → ok",
    v("C:\\Users\\u\\AppData\\Local\\Programs\\opencode-remote\\OpenCode Remote.exe").state === "ok",
  );
  // unc-share: two leading backslashes win over everything else
  check(
    "table: path starting with two backslashes → unc-share",
    v("\\\\servidor\\compartilhamento\\OpenCode Remote.exe").state === "unc-share",
  );
  // zip-temp: the user temp directory (where Explorer unpacks a zip's exe)
  check(
    "table: path under the user temp directory → zip-temp",
    v("C:\\Users\\u\\AppData\\Local\\Temp\\Portable\\OpenCode Remote.exe").state === "zip-temp",
  );
  // downloads: the reused existing state
  check(
    "table: path under the Downloads folder → downloads",
    v("C:\\Users\\u\\Downloads\\OpenCode Remote.exe").state === "downloads",
  );
  // Windows paths are case-insensitive; the table follows
  check(
    "table: the Windows table is case-insensitive",
    v("C:\\USERS\\U\\APPDATA\\LOCAL\\TEMP\\x\\App.exe").state === "zip-temp" &&
      v("c:\\users\\u\\downloads\\app.exe").state === "downloads",
  );
  // missing or non-textual entry → unknown
  check("table: absent path entry → unknown", v(null).state === "unknown");
  check("table: non-textual path entry → unknown", v(42 as unknown as string).state === "unknown");
  check("table: empty path entry → unknown", v("").state === "unknown");
  // rule order: the network share beats Downloads (gravest case first) and
  // the temp folder beats Downloads
  check(
    "order: a UNC share inside a Downloads folder stays unc-share",
    v("\\\\servidor\\compartilhamento\\Downloads\\App.exe").state === "unc-share",
  );
  check(
    "order: a temp extraction of a Downloads-like path stays zip-temp",
    v("C:\\Users\\u\\AppData\\Local\\Temp\\Downloads\\App.exe").state === "zip-temp",
  );
  // dev builds never warn, on any platform
  check(
    "order: a dev build is always ok, even from a temp extraction",
    installVerdict("win32", "C:\\Users\\u\\AppData\\Local\\Temp\\App.exe", null, false).state === "ok",
  );
  // platforms outside the documented pair stay ok exactly as before
  check(
    "order: platforms outside the documented pair stay ok exactly as before",
    installVerdict("linux", "/opt/App/App", null, true).state === "ok" &&
      installVerdict("freebsd", "\\\\share\\App.exe", null, true).state === "ok",
  );
}

// --- the documented static copy ---------------------------------------------------
{
  check(
    "copy: zip-temp ships exactly the documented phrase",
    installMessage("zip-temp") ===
      "o app está rodando de uma cópia temporária extraída de um arquivo compactado — feche-o, instale-o em uma pasta definitiva do computador e reabra pela cópia instalada",
  );
  check(
    "copy: unc-share ships exactly the documented phrase",
    installMessage("unc-share") ===
      "o app está rodando de um compartilhamento de rede — feche-o, instale-o no disco do computador e reabra pela cópia instalada",
  );
  check(
    "copy: the reused downloads state ships the same copy on Windows",
    installVerdict("win32", "C:\\Users\\u\\Downloads\\App.exe", null, true).message === installMessage("downloads"),
  );

  // every Windows message: static, path-free, scheme-free, port-free, secret-free
  const v = (path: string | null) => installVerdict("win32", path as string, null, true);
  const winVerdicts = [
    v("C:\\Program Files\\App\\App.exe"),
    v("C:\\Users\\u\\AppData\\Local\\Programs\\App\\App.exe"),
    v("\\\\servidor\\compartilhamento\\App.exe"),
    v("C:\\Users\\u\\AppData\\Local\\Temp\\App\\App.exe"),
    v("C:\\Users\\u\\Downloads\\App.exe"),
    v(null),
  ];
  check(
    "copy: every Windows message is non-empty, path-free, scheme-free, port-free and secret-free",
    winVerdicts.every(
      (x) =>
        x.message.length > 0 &&
        !x.message.includes("/") &&
        !x.message.includes("\\") &&
        !x.message.includes("http") &&
        !x.message.includes("://") &&
        !x.message.includes("localhost") &&
        !/\d{2,}/.test(x.message) &&
        !x.message.includes("token") &&
        !x.message.includes("senha"),
    ),
  );
}

// --- purity and the untouched macOS table ----------------------------------------
{
  // the same input yields the identical verdict on every call
  check(
    "purity: the same Windows input yields the identical verdict twice",
    (() => {
      const a = installVerdict("win32", "C:\\Users\\u\\AppData\\Local\\Temp\\App.exe", null, true);
      const b = installVerdict("win32", "C:\\Users\\u\\AppData\\Local\\Temp\\App.exe", null, true);
      return a.state === b.state && a.message === b.message;
    })(),
  );
  // the macOS table reproduces today's verdicts, verdict-by-verdict
  check(
    "macos: the macOS table is untouched (verdict-by-verdict)",
    installVerdict("darwin", "/Volumes/Setup/App.app/x", false, true).state === "dmg-volume" &&
      installVerdict("darwin", "/private/var/folders/T/AppTranslocation/g/d/App.app/x", false, true).state ===
        "translocated" &&
      installVerdict("darwin", "/Users/u/Downloads/App.app/x", false, true).state === "downloads" &&
      installVerdict("darwin", "/Applications/App.app/x", true, true).state === "ok" &&
      installVerdict("darwin", "/Applications/App.app/x", null, true).state === "unknown" &&
      installVerdict("darwin", "/Applications/App.app/x", false, true).state === "unknown" &&
      installVerdict("darwin", "/Volumes/Setup/App.app/x", false, false).state === "ok",
  );
}

// --- the real sources: module purity + shell wiring -------------------------------
{
  const locSrc = readFileSync(new URL("../apps/desktop/src/installloc.ts", import.meta.url), "utf8");
  check(
    "purity: installloc.ts stays pure — it never imports electron, node:fs or node:path",
    !/from\s+["'](electron|node:fs|node:path|node:os)["']/.test(locSrc) &&
      !/^\s*import\s+["'](electron|node:fs|node:path|node:os)/m.test(locSrc) &&
      !locSrc.includes("require("),
  );
  const mainSrc = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  check(
    "wiring: the Windows verdict rides the same single boot call, fed by the shell's own process.execPath",
    (mainSrc.match(/installVerdict\(/g) ?? []).length === 1 &&
      mainSrc.includes("installVerdict(process.platform, process.execPath, inApplicationsFolder, app.isPackaged)"),
  );
  check(
    "wiring: the boot verdict block gains no new disk access and no new timer",
    (() => {
      const bootAt = mainSrc.indexOf("bootInstallLocation = ");
      const bootEnd = mainSrc.indexOf("log(`[desktop] install location:", bootAt);
      const bootBlock = bootAt >= 0 && bootEnd > bootAt ? mainSrc.slice(bootAt, bootEnd) : "";
      return (
        bootBlock.length > 0 &&
        bootBlock.includes("process.execPath") &&
        !bootBlock.includes("readFile") &&
        !bootBlock.includes("existsSync") &&
        !bootBlock.includes("statSync") &&
        !bootBlock.includes("tmpdir") &&
        !bootBlock.includes("setInterval") &&
        !bootBlock.includes("setTimeout")
      );
    })(),
  );
  check(
    "wiring: the three existing surfaces carry the Windows verdict unfiltered (no new surface)",
    mainSrc.includes("log(`[desktop] install location: ${bootInstallLocation.state}`)") &&
      mainSrc.includes("installLocation: bootInstallLocation"),
  );
}

console.log(failures === 0 ? "\ninstallloc tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
