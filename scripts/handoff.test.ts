/**
 * RT-439: the handoff command reaches the user's shell through AppleScript's
 * `do script`, so both layers must be inert by construction. This battery
 * pins the session-id regex, the directory validator, the POSIX quoting
 * (real /bin/sh round-trips over hostile payloads with a canary file), the
 * argv-only osascript assembly and the structural shape of the handler
 * (lesson P3-447: assert on source shape so a future refactor cannot
 * quietly reintroduce the interpolated template).
 * Run: npx tsx scripts/handoff.test.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildHandoffCommand,
  buildHandoffOsascriptArgs,
  shellQuote,
  validateHandoffDirectory,
  validateHandoffSessionId,
} from "../apps/daemon/src/handoff";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- validateHandoffSessionId ------------------------------------------------

check("session id: real id accepted and returned unchanged", validateHandoffSessionId("ses_AbC123xyz") === "ses_AbC123xyz");
check("session id: 4-char minimum accepted", validateHandoffSessionId("ses_abcd") === "ses_abcd");
check("session id: 64-char maximum accepted", validateHandoffSessionId(`ses_${"a".repeat(64)}`) === `ses_${"a".repeat(64)}`);
check("session id: missing rejected", validateHandoffSessionId(undefined) === null);
check("session id: null rejected", validateHandoffSessionId(null) === null);
check("session id: non-string (number) rejected", validateHandoffSessionId(42) === null);
check("session id: empty rejected", validateHandoffSessionId("") === null);
check("session id: bare 'ses' rejected", validateHandoffSessionId("ses") === null);
check("session id: bare 'ses_' rejected", validateHandoffSessionId("ses_") === null);
check("session id: too short ('ses_abc') rejected", validateHandoffSessionId("ses_abc") === null);
check("session id: path traversal rejected", validateHandoffSessionId("ses_../x") === null);
check("session id: shell separator rejected", validateHandoffSessionId("ses_a;b") === null);
check("session id: 65 chars rejected", validateHandoffSessionId(`ses_${"a".repeat(65)}`) === null);
check("session id: space rejected", validateHandoffSessionId("ses_ab cd") === null);
check("session id: uppercase prefix rejected", validateHandoffSessionId("SES_abc") === null);

// --- validateHandoffDirectory --------------------------------------------------

const REAL_DIR = "/Users/a/My Proj (1)/it's";
check("directory: real path with space/parens/quote accepted", validateHandoffDirectory(REAL_DIR) === REAL_DIR);
check("directory: shell specials accepted (quoting is the gate)", validateHandoffDirectory("/tmp/a'b\"c$d&e|f;g(h)i`j") === "/tmp/a'b\"c$d&e|f;g(h)i`j");
check("directory: glob and tilde accepted (no expansion — quoted)", validateHandoffDirectory("/tmp/*~") === "/tmp/*~");
check("directory: accents accepted", validateHandoffDirectory("/tmp/ébè çà") === "/tmp/ébè çà");
check("directory: trailing backslash accepted (literal inside single quotes)", validateHandoffDirectory("/tmp/a\\b") === "/tmp/a\\b");
check("directory: 4096-char ceiling boundary accepted", validateHandoffDirectory(`/${"a".repeat(4095)}`) === `/${"a".repeat(4095)}`);
check("directory: relative path rejected", validateHandoffDirectory("repo-2") === null);
check("directory: empty rejected", validateHandoffDirectory("") === null);
check("directory: newline rejected (becomes Enter in Terminal)", validateHandoffDirectory("/a\nb") === null);
check("directory: carriage return rejected", validateHandoffDirectory("/a\rb") === null);
check("directory: tab rejected", validateHandoffDirectory("/a\tb") === null);
check("directory: NUL rejected", validateHandoffDirectory("/a\u0000b") === null);
check("directory: DEL rejected", validateHandoffDirectory("/a\u007fb") === null);
check("directory: 4097 chars rejected", validateHandoffDirectory(`/${"a".repeat(4096)}`) === null);
check("directory: non-string (number) rejected", validateHandoffDirectory(42) === null);
check("directory: non-string (object) rejected", validateHandoffDirectory({}) === null);
check("directory: non-string (null) rejected", validateHandoffDirectory(null) === null);
check("directory: non-string (undefined) rejected", validateHandoffDirectory(undefined) === null);

// --- real /bin/sh round-trip over hostile payloads ------------------------------

// Every payload below, if the quoting broke, would run `touch CANARY` inside
// the temp cwd. A control run first proves the canary actually detects a
// breakout (the unquoted command-substitution payload creates the file).
const HOSTILE_PAYLOADS = [
  'foo"; touch CANARY; echo "',
  "$(touch CANARY)",
  "`touch CANARY`",
  "a'b; touch CANARY; '",
  "x\\",
  "a && touch CANARY",
  "a | touch CANARY",
  "*",
  "/tmp/none; touch CANARY",
  "~/x; touch CANARY",
];

const tmp = mkdtempSync(join(tmpdir(), "ocr-handoff-rt-"));
const canary = join(tmp, "CANARY");
// The real-shell round-trips need a POSIX shell; on Windows they are skipped
// and the pure validators/builders above still run (portable-suite contract:
// no spawn of a Unix-only binary unguarded).
const hasPosixSh = process.platform !== "win32" && existsSync("/bin/sh");
try {
  if (!hasPosixSh) {
    console.log("SKIP shell round-trips (no /bin/sh on this platform)");
  } else {
    const controlOut = execFileSync("/bin/sh", ["-c", `printf %s ${HOSTILE_PAYLOADS[1]}`], {
      cwd: tmp,
      encoding: "utf8",
    });
    check(
      "control: unquoted $(…) payload breaks out and the canary detects it",
      controlOut !== HOSTILE_PAYLOADS[1] && existsSync(canary),
      `out=${JSON.stringify(controlOut)} canary=${existsSync(canary)}`,
    );
    rmSync(canary, { force: true });

    for (const p of HOSTILE_PAYLOADS) {
      let out: string | null = null;
      let threw = false;
      try {
        out = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(p)}`], { cwd: tmp, encoding: "utf8" });
      } catch {
        threw = true;
      }
      check(
        `shell round-trip keeps payload literal: ${JSON.stringify(p)}`,
        !threw && out === p,
        `out=${JSON.stringify(out)} threw=${threw}`,
      );
    }

    check("canary: no breakout ran during the quoted round-trips", !existsSync(canary));

    // End-to-end shape: the quoted `cd` must land the shell in a REAL directory
    // whose name is hostile (space, quote, dollar) — cd succeeds, nothing expands.
    const hostileDir = join(tmp, "a b'c$d");
    mkdirSync(hostileDir, { recursive: true });
    let cdOut: string | null = null;
    let cdThrew = false;
    try {
      cdOut = execFileSync("/bin/sh", ["-c", `cd ${shellQuote(hostileDir)} && printf ok`], {
        cwd: tmp,
        encoding: "utf8",
      });
    } catch {
      cdThrew = true;
    }
    check("shell round-trip: quoted cd reaches a hostile real directory", !cdThrew && cdOut === "ok", `out=${JSON.stringify(cdOut)} threw=${cdThrew}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// --- buildHandoffCommand --------------------------------------------------------

check(
  "buildHandoffCommand: quoted directory + quoted session id",
  buildHandoffCommand("/tmp/x'y", "ses_abcd") === "cd '/tmp/x'\\''y' && opencode -s 'ses_abcd'",
);
check(
  "buildHandoffCommand: hostile directory stays one literal word",
  buildHandoffCommand("/tmp/a; touch CANARY", "ses_abcd") === "cd '/tmp/a; touch CANARY' && opencode -s 'ses_abcd'",
);

// --- buildHandoffOsascriptArgs ---------------------------------------------------

const cmd = buildHandoffCommand("/tmp/x'y", "ses_abcd");
const args = buildHandoffOsascriptArgs(cmd);
check("osascript argv: the command rides as the last element", args[args.length - 1] === cmd);
check("osascript argv: odd pairs are the -e statements", args.filter((_, i) => i % 2 === 1).every((s) => typeof s === "string"));
check("osascript argv: do script reads argv, never the value", args[7] === "do script (item 1 of argv)");
const statements = args.filter((_, i) => i % 2 === 1);
check(
  "osascript argv: no -e statement embeds the command or the directory",
  statements.every((s) => !s.includes(cmd) && !s.includes("/tmp/x'y")),
);
check(
  "osascript argv: hostile directory never reaches the AppleScript source",
  (() => {
    const hostile = buildHandoffOsascriptArgs(buildHandoffCommand("$(touch CANARY)", "ses_abcd"));
    return hostile[hostile.length - 1] === "cd '$(touch CANARY)' && opencode -s 'ses_abcd'" &&
      hostile.slice(0, -1).every((s) => !s.includes("$(touch CANARY)"));
  })(),
);

// --- structural pin over the handler (lesson P3-447) -----------------------------

const src = readFileSync(join(import.meta.dirname, "..", "apps", "daemon", "src", "index.ts"), "utf8");
const start = src.indexOf('"/__ocr/handoff"');
const end = src.indexOf('"/__ocr/transcribe/chunk"', start);
check("pin: handoff block located in index.ts", start >= 0 && end > start);
const block = src.slice(start, end);
check("pin: no interpolated `do script \"cd ${` template left", !/do script "cd \$\{/.test(block));
check("pin: no quote-escaping via .replace(/\"/g left", !/\.replace\(\/"\/g/.test(block));
check("pin: handler assembles the osascript argv", /buildHandoffOsascriptArgs\(/.test(block));
check("pin: handler builds the quoted command", /buildHandoffCommand\(/.test(block));
check("pin: handler validates the session id before the fetch", /validateHandoffSessionId\(/.test(block));
check("pin: handler validates the directory after the fetch", /validateHandoffDirectory\(/.test(block));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall handoff checks passed");
