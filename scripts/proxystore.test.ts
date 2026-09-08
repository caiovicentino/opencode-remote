/**
 * P2-289: machine-proxy store tests (apps/desktop/src/proxystore.ts) — the
 * portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no spawn; the only fs use is the store's own tmpdir file plus
 * reading the real main.ts / proxystore.ts sources for the wiring and
 * purity assertions, via URLs relative to this file (Windows-safe).
 * Run: npx tsx scripts/proxystore.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearProxyChoice, proxySettingFile, readProxyChoice, writeProxyChoice } from "../apps/desktop/src/proxystore";
import { dict } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "ocr-proxystore-"));
const file = proxySettingFile(dir);
const json = (v: unknown) => JSON.stringify(v);

// --- the tolerant-read table: every degraded shape is "no stored choice" ---
{
  check("read: missing file is no choice", readProxyChoice(file) === null);
  writeFileSync(file, "not json at all", "utf8");
  check("read: corrupted JSON is no choice", readProxyChoice(file) === null);
  writeFileSync(file, "[1,2,3]", "utf8");
  check("read: a non-object payload is no choice", readProxyChoice(file) === null);
  writeFileSync(file, "{}", "utf8");
  check("read: an object without the fields is no choice", readProxyChoice(file) === null);
  writeFileSync(file, JSON.stringify({ mode: "always" }), "utf8");
  check("read: a mode outside the documented table is no choice", readProxyChoice(file) === null);
  writeFileSync(file, JSON.stringify({ mode: "fixed", address: 42 }), "utf8");
  check("read: a non-textual address is no choice", readProxyChoice(file) === null);
  writeFileSync(file, JSON.stringify({ mode: "fixed", address: "   " }), "utf8");
  check("read: a blank address is no choice", readProxyChoice(file) === null);
  writeFileSync(file, JSON.stringify({ mode: "fixed", address: "proxy.corp:3128" }), "utf8");
  check("read: the fixed mode returns the stored address", json(readProxyChoice(file)) === json({ mode: "fixed", address: "proxy.corp:3128" }));
  writeFileSync(file, JSON.stringify({ mode: "system", address: "ignored.corp:1" }), "utf8");
  check("read: system mode never carries an address", json(readProxyChoice(file)) === json({ mode: "system", address: null }));
}

// --- the fail-closed write table: refused shapes never persist --------------
{
  const before = readFileSync(file, "utf8");
  const refuses = (choice: unknown) => writeProxyChoice(file, choice);
  const r1 = refuses("junk");
  check("write: a malformed payload is refused with a static reason", !r1.ok && r1.reason.length > 0 && typeof r1.reason === "string");
  const r2 = refuses({ mode: "always" });
  check("write: a mode outside the table is refused", !r2.ok && r2.reason.length > 0);
  const r3 = refuses({ mode: "fixed" });
  check("write: a fixed choice without an address is refused", !r3.ok && r3.reason.length > 0);
  const r4 = refuses({ mode: "fixed", address: 42 });
  check("write: a non-textual address is refused", !r4.ok && r4.reason.length > 0);
  const r5 = refuses({ mode: "fixed", address: "http://user:pass@proxy.corp:3128" });
  check("write: a credential-bearing address is refused with a reason and nothing written", !r5.ok && r5.reason.length > 0 && readFileSync(file, "utf8") === before);
  const r6 = refuses({ mode: "fixed", address: "ftp://proxy.corp:21" });
  check("write: a scheme outside the documented list is refused", !r6.ok && r6.reason.length > 0 && readFileSync(file, "utf8") === before);
  const r7 = refuses({ mode: "fixed", address: "nonsense with space" });
  check("write: an unparseable address is refused", !r7.ok && r7.reason.length > 0 && readFileSync(file, "utf8") === before);
}

// --- a valid choice round-trips, deterministic across reads ------------------
{
  const ok = writeProxyChoice(file, { mode: "fixed", address: "http://proxy.corp:3128" });
  check("write: a valid fixed choice persists", ok.ok);
  const first = readProxyChoice(file);
  const second = readProxyChoice(file);
  check("write: the stored choice reads back identical", json(first) === json({ mode: "fixed", address: "http://proxy.corp:3128" }));
  check("read: the same input yields the exact same result twice", json(first) === json(second));
  check("write: a valid system choice persists", writeProxyChoice(file, { mode: "system" }).ok && readProxyChoice(file)?.mode === "system");
  check("write: a valid direct choice persists", writeProxyChoice(file, { mode: "direct" }).ok && readProxyChoice(file)?.mode === "direct");
  clearProxyChoice(file);
  check("clear: after clearing, the choice is gone", readProxyChoice(file) === null);
}

// --- owner-restricted permissions, verified for real (POSIX only) -----------
{
  writeProxyChoice(file, { mode: "fixed", address: "http://proxy.corp:3128" });
  if (process.platform !== "win32") {
    check("privacy: the stored choice file is owner-only (0600)", (statSync(file).mode & 0o777) === 0o600);
  } else {
    console.log("SKIP privacy: POSIX permission bits are not a Windows contract");
  }
}

// --- the real sources: wiring and module purity ------------------------------
{
  const mainSrc = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  check(
    "wiring: main.ts feeds proxyPlan with the stored preference beside the environment",
    mainSrc.includes("const preference = storedProxyPreference();") &&
      /proxyPlan\(\{[\s\S]*?preference,/.test(mainSrc),
  );
  check("wiring: the stored preference comes from the proxystore", mainSrc.includes("readProxyChoice") && mainSrc.includes("proxySettingFile"));
  check("wiring: the verdict is still applied exactly once", mainSrc.split("applyProxyVerdict();").length - 1 === 1);
  const applyAt = mainSrc.indexOf("applyProxyVerdict();");
  const firstWindowCall = mainSrc.indexOf("createWindow();");
  check("wiring: the application still happens before the first window creation", applyAt >= 0 && firstWindowCall > applyAt);
  check("wiring: the log line names the origin", mainSrc.includes("origem ${bootProxyOrigin}"));
  check("wiring: exactly two new proxy IPC channels, in the relay-handler shape", mainSrc.includes('"app:proxySetting"') && mainSrc.includes('"app:saveProxyChoice"'));
  const storeSrc = readFileSync(new URL("../apps/desktop/src/proxystore.ts", import.meta.url), "utf8");
  check("purity: proxystore.ts imports no electron", !storeSrc.includes("electron"));
}

// --- the new Settings labels: exact en/pt key parity (P2-118/P2-275) ---------
{
  const keys = [
    "proxyTitle",
    "proxyHint",
    "proxyModeSystem",
    "proxyModeDirect",
    "proxyModeFixed",
    "proxyAddressLabel",
    "proxySave",
    "proxySaved",
    "proxyInvalid",
    "proxyNextStart",
    "proxyOriginOwner",
    "proxyOriginEnvironment",
  ];
  const en = dict.en as Record<string, string>;
  const pt = dict.pt as Record<string, string>;
  check(
    "i18n: every new proxy label exists in BOTH locales with exact key parity",
    keys.every((k) => typeof en[k] === "string" && typeof pt[k] === "string" && en[k].trim() !== "" && pt[k].trim() !== ""),
  );
}

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? "\nproxystore tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
