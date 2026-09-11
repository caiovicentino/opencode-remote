/**
 * Diagnostics redactor tests (P3-407): table coverage for the pure
 * diagredact.ts pass — pairing URI, home-folder prefix, Bearer credentials,
 * long token-like secrets, control characters, clean lines left intact and
 * deterministic output — plus source-reading assertions on the real
 * apps/desktop/src/main.ts proving the redactor runs BEFORE the clipboard
 * writes and BEFORE the file write on every diagnostics exit path.
 * Run: npx tsx scripts/diagredact.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactDiagnosticReport, DIAG_HOME_MARKER, DIAG_REDACTED_TOKEN } from "../apps/desktop/src/diagredact";
import { PAIRING_SCHEME, REDACTED_MARKER } from "../apps/desktop/src/sidecar-redact";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const HOME = "/Users/ana.example";
const secret = "Zx9k2Pq7Rt4wYs6uB1cN3mV5jH8gL0aQfDe2Oi4UgTn";
const pairingUri = `${PAIRING_SCHEME}pair?ecdh=6a3f&token=${secret}`;

// --- the redactor table -------------------------------------------------------
// [name, input, expected output] — assembled with push() so a typo can never
// silently drop a case.
const cases: Array<[string, string, string]> = [];
cases.push([
  "pairing URI is swapped with the sidecar marker",
  `boot banner says or paste: ${pairingUri} then silence`,
  `boot banner says or paste: ${REDACTED_MARKER} then silence`,
]);
cases.push([
  "home-folder prefix becomes the neutral marker",
  `userData: ${HOME}/Library/Application Support/OpenCode Remote/logs`,
  `userData: ${DIAG_HOME_MARKER}/Library/Application Support/OpenCode Remote/logs`,
]);
cases.push([
  "home prefix without a trailing separator is also neutralized",
  `owner home ${HOME} referenced mid-line`,
  `owner home ${DIAG_HOME_MARKER} referenced mid-line`,
]);
cases.push([
  "Bearer credential is masked, the scheme stays readable",
  `authorization: Bearer ${secret} sent at 12:00`,
  `authorization: Bearer ${DIAG_REDACTED_TOKEN} sent at 12:00`,
]);
cases.push([
  "long token-like run is masked",
  `state=ok digest ${secret} end`,
  `state=ok digest ${DIAG_REDACTED_TOKEN} end`,
]);
cases.push([
  "control characters are removed, \\n and \\t survive",
  "line one\u0001\u001F\u000B stays\nline\ttwo\u0000\u007F",
  "line one stays\nline\ttwo",
]);
cases.push([
  "clean line passes through byte-for-byte",
  "daemon: healthy — porta 8790 (preferred)",
  "daemon: healthy — porta 8790 (preferred)",
]);

for (const [name, input, expected] of cases) {
  const out = redactDiagnosticReport(input, HOME);
  check(`diagredact: ${name}`, out === expected, `got: ${JSON.stringify(out)}`);
}

// Stability: the same input always produces the same output (the support
// thread must never change between two copies of the same bundle).
{
  const report = [
    "OpenCode Remote — diagnostic report",
    `userData: ${HOME}/Library/Application Support/OpenCode Remote`,
    `or paste: ${pairingUri}`,
    `authorization: Bearer ${secret}`,
    "crash files: none",
  ].join("\n");
  const a = redactDiagnosticReport(report, HOME);
  const b = redactDiagnosticReport(report, HOME);
  check("diagredact: stable — same input, byte-identical output", a === b);
  check("diagredact: full report carries no URI, token or account prefix", !a.includes(PAIRING_SCHEME) && !a.includes(secret) && !a.includes(HOME), a);
  check("diagredact: a home argument with a trailing separator is normalized", redactDiagnosticReport(`userData: ${HOME}/x`, `${HOME}/`).includes(`${DIAG_HOME_MARKER}/x`));
}

// --- the main.ts order contract (source-reading) -------------------------------
// The redaction must happen inside buildDiagnostics — the single exit point —
// so the clipboard paths and the file write can only ever see redacted text.
{
  const mainTs = readFileSync(new URL("../apps/desktop/src/main.ts", import.meta.url), "utf8");
  const mainLines = mainTs.split("\n");
  const buildFnStart = mainLines.findIndex((l) => l.startsWith("function buildDiagnostics"));
  const buildFnEnd = mainLines.findIndex((l) => l.startsWith("installFatalErrorHandlers"));
  check("diagredact: buildDiagnostics found in main.ts", buildFnStart !== -1 && buildFnEnd > buildFnStart);
  const buildFn = mainLines.slice(buildFnStart, buildFnEnd === -1 ? mainLines.length : buildFnEnd).join("\n");
  check(
    "diagredact: buildDiagnostics returns redactDiagnosticReport(buildDiagnosticReport(…), homedir())",
    /return\s+redactDiagnosticReport\(\s*buildDiagnosticReport\(/.test(buildFn) && buildFn.includes("homedir()"),
  );

  // Every diagnostics clipboard write goes through the redacted builder —
  // the two clipboard.writeText sites must be argumented with buildDiagnostics().
  const clipboardSites = mainLines.filter((l) => l.includes("clipboard.writeText(buildDiagnostics())"));
  check("diagredact: both clipboard writes use buildDiagnostics() (Settings + Help menu paths)", clipboardSites.length === 2, `found ${clipboardSites.length}`);

  // The save action: the report variable is assigned from buildDiagnostics()
  // BEFORE any file write call inside the same function body.
  const saveStart = mainLines.findIndex((l) => l.startsWith("async function saveDiagnosticsToFile"));
  check("diagredact: saveDiagnosticsToFile found in main.ts", saveStart !== -1);
  if (saveStart !== -1) {
    // Array.findIndex has no fromIndex — slice first (the save action lives
    // between its own definition and the installFatalErrorHandlers block).
    const afterStart = mainLines.slice(saveStart);
    const saveEnd = afterStart.findIndex((l) => l.startsWith("installFatalErrorHandlers"));
    const body = afterStart.slice(0, saveEnd === -1 ? afterStart.length : saveEnd).join("\n");
    const redactAt = body.indexOf("const report = buildDiagnostics()");
    const writeAt = body.indexOf("writeDiagFileAtomic(");
    check("diagredact: save assigns the redacted report before any file write", redactAt !== -1 && writeAt !== -1 && redactAt < writeAt, body.slice(0, 200));
    check(
      "diagredact: hatch OCR_DESKTOP_DIAG_SAVE_PATH is honored only under HERMETIC_E2E",
      /HERMETIC_E2E \? process\.env\.OCR_DESKTOP_DIAG_SAVE_PATH/.test(body) && body.includes("if (HERMETIC_E2E)"),
    );
  }

  // The ipc handler exists beside app:diagnostics and the menu id is wired.
  check("diagredact: app:saveDiagnostics IPC handler registered", mainTs.includes('ipcMain.handle("app:saveDiagnostics"'));
  check("diagredact: help-save-diagnostics menu id wired to the save action", mainTs.includes('"help-save-diagnostics": () => void saveDiagnosticsToFile()'));

  // The atomic write keeps the state-file discipline: 0600 + rename.
  const writerStart = mainLines.findIndex((l) => l.startsWith("function writeDiagFileAtomic"));
  const writerBody = mainLines.slice(writerStart, writerStart + 10).join("\n");
  check("diagredact: file write is atomic with a 0600 mode", writerBody.includes("mode: 0o600") && writerBody.includes("renameSync"), writerBody);
}

if (failures > 0) {
  console.error(`diagredact.test: ${failures} failure(s)`);
  process.exit(1);
}
console.log("diagredact.test: all green");
