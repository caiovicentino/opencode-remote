/**
 * P2-284: browse-capability readiness tests (apps/daemon/src/browsecap.ts) —
 * the portable twin of the unit.test.ts block. Pure node: no Electron, no
 * sockets, no chmod, no spawn; the only fs use is reading the real
 * browsecap.ts/browse.ts/index.ts sources for the hygiene and wiring
 * assertions, via a URL relative to this file (Windows-safe).
 * Run: npx tsx scripts/browsecap.test.ts
 */
import { readFileSync } from "node:fs";
import { browseReadiness } from "../apps/daemon/src/browsecap";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const json = (v: unknown) => JSON.stringify(v);
const fullProbe = { disabled: false, libraryResolved: true, executableFound: true, launchError: null };

// --- the verdict table, in the documented rule order --------------------------------
{
  check(
    "rule 1: absent input is unknown, never ready",
    browseReadiness(null).state === "unknown" &&
      browseReadiness(undefined).state === "unknown" &&
      browseReadiness(null).message.length > 0,
  );
  check(
    "rule 1: non-object input (string, number, array) is unknown",
    browseReadiness("corrupt").state === "unknown" &&
      browseReadiness(42).state === "unknown" &&
      browseReadiness([]).state === "unknown",
  );
  check(
    "rule 1: a single non-boolean mark poisons the whole verdict into unknown",
    browseReadiness({ ...fullProbe, libraryResolved: "yes" }).state === "unknown" &&
      browseReadiness({ ...fullProbe, disabled: 1 }).state === "unknown" &&
      browseReadiness({ ...fullProbe, executableFound: null }).state === "unknown" &&
      browseReadiness({ ...fullProbe, libraryResolved: "yes" }).state !== "ready",
  );
  const disabledVerdict = browseReadiness({
    disabled: true,
    libraryResolved: false,
    executableFound: false,
    launchError: null,
  });
  check(
    "rule 2: disabled wins over an unresolved library and never suggests installing",
    disabledVerdict.state === "disabled" && !/instal/i.test(disabledVerdict.message),
  );
  check(
    "rule 3: unresolved library is no-browser before any look at the executable",
    browseReadiness({ disabled: false, libraryResolved: false, executableFound: true, launchError: null }).state ===
      "no-browser" &&
      browseReadiness({ disabled: false, libraryResolved: false, executableFound: false, launchError: null })
        .state === "no-browser",
  );
  check(
    "rule 4: missing executable is no-browser",
    browseReadiness({ disabled: false, libraryResolved: true, executableFound: false, launchError: null }).state ===
      "no-browser",
  );
  check(
    "rule 5: a launch error with the library resolved is no-browser",
    browseReadiness({
      disabled: false,
      libraryResolved: true,
      executableFound: true,
      launchError: "Executable doesn't exist",
    }).state === "no-browser",
  );
  check("rule 6: everything present is ready", browseReadiness(fullProbe).state === "ready");

  // determinism — the same input yields the identical verdict on every call
  check(
    "same input, identical verdict twice in a row",
    json(browseReadiness(fullProbe)) === json(browseReadiness(fullProbe)) &&
      json(browseReadiness(null)) === json(browseReadiness(null)) &&
      json(browseReadiness({ ...fullProbe, disabled: true })) ===
        json(browseReadiness({ ...fullProbe, disabled: true })),
  );
}

// --- phrase hygiene -------------------------------------------------------------------
{
  const nastyTail = "/Volumes/Secret Disk/chromium-1.2.3 died at https://10.0.0.1:9999 with OCR_TAIL=value";
  const allVerdicts = [
    browseReadiness(fullProbe),
    browseReadiness({ ...fullProbe, libraryResolved: false }),
    browseReadiness({ ...fullProbe, executableFound: false }),
    browseReadiness({ ...fullProbe, launchError: nastyTail }),
    browseReadiness({ disabled: true, libraryResolved: false, executableFound: false, launchError: null }),
    browseReadiness(null),
  ];
  check(
    "no phrase carries a path, port, address, env var or the raw error tail",
    allVerdicts.every(
      (v) =>
        v.message.trim().length > 0 &&
        !/[\\/]/.test(v.message) &&
        !/https?:/i.test(v.message) &&
        !v.message.includes("=") &&
        !/[0-9]/.test(v.message) &&
        !v.message.includes("OCR_") &&
        !v.message.includes(nastyTail),
    ),
  );
}

// --- the real sources: module purity + wiring ------------------------------------------
{
  const browsecapSrc = readFileSync(new URL("../apps/daemon/src/browsecap.ts", import.meta.url), "utf8");
  check(
    "browsecap.ts imports no node:fs, node:child_process, node:http, playwright-core or fetch",
    !/^import[^\n]*(node:fs|node:child_process|node:http|playwright-core|fetch)/m.test(browsecapSrc) &&
      !browsecapSrc.includes("fetch(") &&
      !browsecapSrc.includes("await import("),
  );
  check(
    "the module header documents the rule order and the phrase boundary",
    browsecapSrc.includes("in THIS order") &&
      browsecapSrc.includes("absolute path") &&
      browsecapSrc.includes("raw error tail"),
  );
  const browseSrc = readFileSync(new URL("../apps/daemon/src/browse.ts", import.meta.url), "utf8");
  check(
    "the English install-command phrase is no longer thrown at the client",
    !browseSrc.includes("npx playwright install chromium") &&
      !browseSrc.includes("playwright chromium not available") &&
      browseSrc.includes("browseReadiness(") &&
      browseSrc.includes("browsePhrase"),
  );
  const probeFn = browseSrc.slice(browseSrc.indexOf("export async function probeBrowse"));
  check(
    "the probe path never throws — a failing library probe degrades to honest marks",
    browseSrc.includes("export async function probeBrowse") &&
      probeFn.includes("catch {") &&
      probeFn.includes("libraryResolved = false"),
  );
  const indexSrc = readFileSync(new URL("../apps/daemon/src/index.ts", import.meta.url), "utf8");
  check(
    "wiring: /api/health gains the three additive browse fields",
    indexSrc.includes("browseState: browseCap.state") &&
      indexSrc.includes("browseMessage: browseCap.message") &&
      indexSrc.includes("browseCheckedAt: readinessCheckedAt(readinessState.browse.probedAt)"),
  );
  check(
    "wiring: no periodic timer in the browse lines",
    indexSrc.split("\n").every((l) => !(l.includes("setInterval") && /browse/i.test(l))),
  );
}

console.log(failures === 0 ? "\nbrowsecap tests: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
