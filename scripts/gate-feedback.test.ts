/**
 * Gate feedback quality (eval-04 — forensic 2026-09-24 recs 3, 4, 5, 8):
 * every failed round must tell the builder exactly what broke.
 *
 *  1. gatetail.ts — the gate's finding / carryover / headline are cut by
 *     relevance (failing checks + beat, first error, summary, then the last
 *     lines), not by the last N bytes of stdout+stderr.
 *  2. evidencecheck.ts — the static half of the judge's evidence step runs
 *     before the gate; a gap bounces back to the same builder session once.
 *  3. pipeline.ts — the task diff is taken against origin/<base>, never the
 *     slot's stale local `main` (the P3-401/P3-459/P2-357 false "UI task
 *     without shot-1440x900" rejections; reproduced below with real git).
 *  4. Prompts — the fixed UI-EVIDENCE lines + format rules, and the coupled-
 *     assertions rule in the planner and builder prompts (stable prefixes).
 *  5. desktop-flow.test.ts — the beat-timing / FAILED CHECKS report it prints
 *     is exactly what gatetail.ts parses (source-shape parity).
 * Run: npx tsx scripts/gate-feedback.test.ts
 */
import "./testhome"; // throwaway HOME before any pilot module loads (testhome.ts)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GATE_CARRY_TAIL_BYTES,
  GATE_FINDING_TAIL_BYTES,
  GATE_HEADLINE_BYTES,
  gateTailDigest,
  gateTailHeadline,
  isNoiseLine,
} from "../apps/pilot/src/gatetail";
import {
  bounceEvidence,
  defaultEvidenceIo,
  EVIDENCE_BOUNCE_MAX,
  EVIDENCE_MARKER as CHECK_EVIDENCE_MARKER,
  evidenceBouncePrompt,
  evidenceGaps,
  parseEvidenceShots,
  pngDims,
  TASK_DONE_MARKER as CHECK_TASK_DONE_MARKER,
  UI_EVIDENCE_TEMPLATE,
  type EvidenceIo,
} from "../apps/pilot/src/evidencecheck";
import {
  builderPrompt,
  CONTEXT_HYGIENE_RULE,
  COUPLING_RULE_BUILDER,
  COUPLING_RULE_PLANNER,
  DOCS_RULE_BUILDER,
  EVIDENCE_FORMAT_RULES,
  EVIDENCE_MARKER,
  gateFindingBlock,
  gateWarnings,
  needsUiEvidence,
  plannerPrompt,
  TASK_DONE_MARKER,
  taskDiffRange,
  touchedUiFromDiff,
  UI_SHOT_LINES,
} from "../apps/pilot/src/pipeline";
import type { Task } from "../apps/pilot/src/backlog";
import {
  COUPLING_GATE_STEPS,
  COUPLING_MAX_HINTS,
  couplingBlock,
  couplingHints,
  couplingLiterals,
  parseUnifiedDiff,
  workspaceCouplingIo,
  type CouplingIo,
} from "../apps/pilot/src/coupling";
import { formatFailureLesson } from "../apps/pilot/src/failureLessons";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- fixtures: gate outputs shaped like the real ones -------------------------
// The judge returns `${stdout}${stderr}` of the failing step (separate
// buffers). Line shapes below are the real ones from the P3-457 / P3-371 /
// P3-354 carryovers (~/.opencode-remote/pilot/gate-fail/, 2026-09-08..23):
// OK lines, `--- beat (Ns elapsed)` banners, the duration/FAILURES footer on
// stdout; "   condition never held…" details, fake-daemon JSON events, keeper
// boot lines and Node's MaxListeners warning on stderr.
const JSON_EVENT = '{"ts":"2026-09-09T10:41:22.084Z","event":"session.historyPage","data":{"sessionId":"ses-draft-a","limit":50,"before":null,"bytes":551}}';
const MAXLISTENERS = [
  "(node:29507) MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 exit listeners added to [process]. MaxListeners is 10. Use emitter.setMaxListeners() to increase limit",
  "(Use `node --trace-warnings ...` to show where the warning was created)",
];

function desktopFlowOutput(withReport: boolean): string {
  const out: string[] = ["OK   web UI built (apps/web/dist/index.html)", "OK   open (hermetic launch)"];
  out.push("--- P2-148: welcome walk (keeper boot) (12.4s elapsed)");
  for (let i = 0; i < 60; i++) out.push(`OK   P2-148: welcome step ${i} renders`);
  out.push("--- P2-090: artifact auto-open on idle (176.2s elapsed)");
  for (let i = 0; i < 4; i++) out.push(`OK   P2-090: idle round-trip ${i}`);
  out.push("FAIL P2-090: artifact pane auto-opened on idle");
  for (let i = 0; i < 400; i++) out.push(`OK   P3-407: saved-file check ${i}`);
  out.push("FAIL P3-407: success toast is the terminal state");
  for (let i = 0; i < 80; i++) out.push(`OK   P2-338: incompatible relay check ${i}`);
  out.push("OK   no daemon sidecar spawned (hermetic)");
  if (withReport) {
    out.push(
      "",
      "desktop flow beat timing: 206.2s of the 420s budget (49%), 41 beats; slowest 10:",
      "    61.3s  P1-089 (14 check(s))",
      "    40.2s  P2-148 (61 check(s))",
      "last check: no daemon sidecar spawned (hermetic) (beat P2-338)",
      "FAILED CHECKS (2) — the check, the beat it ran in, when, and its detail:",
      "FAIL P2-090: artifact pane auto-opened on idle",
      '     beat P2-090 · phase "P2-090: artifact auto-open on idle" · at 188.9s',
      '     condition never held (12 probes), last value: "preview"',
      "FAIL P3-407: success toast is the terminal state",
      '     beat P3-407 · phase "P3-407: diagnostics save-to-file (hatch) writes the redacted bundle" · at 201.0s',
      '     condition never held (12 probes), last value: ""',
      "",
    );
  }
  out.push("", "desktop flow duration: 206.2s (budget 420s)", "FAILURES: 2");
  const err: string[] = [];
  for (let i = 0; i < 150; i++) err.push(JSON_EVENT);
  err.push('   condition never held (12 probes), last value: "preview"', '   condition never held (12 probes), last value: ""', ...MAXLISTENERS);
  return `${out.join("\n")}\n${err.join("\n")}\n`;
}

// ============================================================================
// 1. gatetail.ts
// ============================================================================
{
  // passthrough: judge-authored reasons stay byte-identical
  const reason = "UI task without shot-1440x900 path in the EVIDENCE block";
  check("gatetail: an output that fits the budget passes through byte-identical", gateTailDigest("evidence", reason) === reason);
  const diverge = `pasted output diverges from re-run of: npm run build --silent\nre-run tail:\n${"x".repeat(380)}`;
  check("gatetail: a short multi-line judge reason passes through byte-identical", gateTailDigest("evidence", diverge) === diverge);

  // the P3-457 shape WITHOUT desktop-flow's report (today's gate output)
  const legacy = desktopFlowOutput(false);
  const oldFinding = legacy.slice(-GATE_FINDING_TAIL_BYTES);
  const digest = gateTailDigest("desktop-flow", legacy, GATE_FINDING_TAIL_BYTES);
  check(
    "gatetail: regression — the old byte tail of this output names NO failing check",
    !/^FAIL /m.test(oldFinding) && oldFinding.includes("session.historyPage"),
    oldFinding.slice(0, 200),
  );
  check("gatetail: digest respects the finding budget", digest.length <= GATE_FINDING_TAIL_BYTES, String(digest.length));
  check(
    "gatetail: digest names BOTH failing checks",
    digest.includes("FAIL P2-090: artifact pane auto-opened on idle") && digest.includes("FAIL P3-407: success toast is the terminal state"),
    digest,
  );
  check(
    "gatetail: digest names the last beat started before the first FAIL",
    digest.includes("last beat started before the first FAIL: P2-090: artifact auto-open on idle (176.2s elapsed)"),
    digest.split("\n")[0],
  );
  check("gatetail: digest carries the first failure's detail", digest.includes('condition never held (12 probes), last value: "preview"'), digest);
  check("gatetail: digest keeps the run summary", digest.includes("FAILURES: 2") && digest.includes("desktop flow duration: 206.2s (budget 420s)"), digest);
  check("gatetail: JSON event noise never reaches the digest", !digest.includes("session.historyPage"), digest);
  check("gatetail: Node MaxListeners warnings never reach the digest", !digest.includes("MaxListenersExceededWarning"), digest);
  check("gatetail: runs of OK lines collapse to a count marker", /… \d+ earlier OK line\(s\) …/.test(digest), digest);
  check("gatetail: digest is deterministic", gateTailDigest("desktop-flow", legacy) === digest);
  const carry = gateTailDigest("desktop-flow", legacy, GATE_CARRY_TAIL_BYTES);
  check(
    "gatetail: carry budget (1200) still names the failing checks",
    carry.length <= GATE_CARRY_TAIL_BYTES && carry.includes("FAIL P2-090") && carry.includes("FAIL P3-407"),
    carry,
  );

  // desktop-flow's FAILED CHECKS report (this PR) is used verbatim, counted once
  const reported = desktopFlowOutput(true);
  const d2 = gateTailDigest("desktop-flow", reported);
  check("gatetail: the FAILED CHECKS report rides the digest with beat + detail", d2.includes('     beat P2-090 · phase "P2-090: artifact auto-open on idle" · at 188.9s'), d2);
  check("gatetail: report FAIL lines are not double-counted in the header", d2.split("\n")[0]?.includes(": 2 FAIL line(s)") === true, d2.split("\n")[0]);
  check("gatetail: header stays one capped line", (d2.split("\n")[0] ?? "").length <= 240);

  // deadline abort: the exit-hook report + the budget line on stderr sit
  // outside the FAILED CHECKS block — they must still reach the builder
  const aborted = [
    ...Array.from({ length: 300 }, (_, i) => `OK   P2-148: welcome step ${i} renders`),
    "--- P2-152: one-time close-to-tray hint (401.7s elapsed)",
    "FAIL P2-152: close the window",
    "",
    "desktop flow beat timing: 420.3s of the 420s budget (100%), 70 beats; slowest 10:",
    "   61.3s  P1-089 (38 check(s))",
    "WARN desktop-flow budget: 420.3s of 420s (100%, warn above 80%) — slowest beats: P1-089 61.3s",
    "desktop flow exceeded the budget during beat P2-152 (last check: P2-152: close the window)",
    'FAIL desktop flow stopped before its end — last check: P2-152: close the window (beat P2-152, last banner "P2-152: one-time close-to-tray hint")',
    "FAILED CHECKS (1) — the check, the beat it ran in, when, and its detail:",
    "FAIL P2-152: close the window",
    '     beat P2-152 · phase "P2-152: one-time close-to-tray hint" · at 419.9s',
    "     timeout after 15000ms",
    "",
    ...Array.from({ length: 120 }, () => JSON_EVENT),
    "FAIL desktop flow exceeded the 420000ms budget",
  ].join("\n");
  const abortDigest = gateTailDigest("desktop-flow", aborted);
  // inside the failing-checks section — not merely in the padding
  const failSec = abortDigest.slice(0, Math.max(0, abortDigest.indexOf("\nsummary:")));
  check(
    "gatetail: a deadline abort keeps the stop line and the budget line next to the report",
    failSec.includes("FAIL desktop flow stopped before its end — last check: P2-152: close the window") &&
      failSec.includes("FAIL desktop flow exceeded the 420000ms budget") &&
      abortDigest.includes("     beat P2-152 · phase") &&
      abortDigest.includes("WARN desktop-flow budget: 420.3s of 420s"),
    abortDigest,
  );
  check("gatetail: a deadline abort headline counts the stop lines too", gateTailHeadline("desktop-flow", aborted).startsWith("FAIL P2-152: close the window (+2 more) [beat P2-152 ·"), gateTailHeadline("desktop-flow", aborted));

  // unit battery: one FAIL buried under thousands of OK lines, stderr footer
  const unitOut = [
    ...Array.from({ length: 2900 }, (_, i) => `OK   pipeline: check number ${i}`),
    "FAIL P3-467: index.html carries the dark-light color-scheme meta",
    ...Array.from({ length: 2900 }, (_, i) => `OK   daemon: later check ${i}`),
  ].join("\n");
  const unitFull = `${unitOut}\nUNIT TESTS FAILED: 1\n`;
  const unitDigest = gateTailDigest("unit", unitFull);
  check("gatetail: regression — the unit battery's byte tail has no FAIL line", !unitFull.slice(-GATE_FINDING_TAIL_BYTES).includes("FAIL "));
  check(
    "gatetail: unit digest surfaces the buried FAIL line and the stderr footer",
    unitDigest.includes("FAIL P3-467: index.html carries the dark-light color-scheme meta") && unitDigest.includes("UNIT TESTS FAILED: 1"),
    unitDigest,
  );

  // tsc: no FAIL convention — the first error block leads
  const tsc = [
    ...Array.from({ length: 80 }, (_, i) => `> @ocr/web@0.2.0 typecheck noise line ${i} ${"-".repeat(20)}`),
    "apps/pilot/src/gatetail.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
    "apps/pilot/src/pipeline.ts(40,9): error TS2304: Cannot find name 'foo'.",
    ...Array.from({ length: 40 }, (_, i) => `trailing workspace line ${i} ${"-".repeat(20)}`),
  ].join("\n");
  const tscDigest = gateTailDigest("typecheck", tsc);
  const tscFirst = tscDigest.split("\n").indexOf("first error:");
  check(
    "gatetail: tsc digest leads with the first error TS line and its continuation",
    tscFirst > 0 && tscDigest.split("\n")[tscFirst + 1]?.includes("error TS2322") === true && tscDigest.includes("error TS2304"),
    tscDigest,
  );

  // noise classification
  check("gatetail: fake-daemon JSON events are noise", isNoiseLine(JSON_EVENT));
  check("gatetail: a JSON log line at level error is NOT noise", !isNoiseLine('{"ts":"x","level":"error","msg":"daemon crashed"}'));
  check("gatetail: keeper boot chatter is noise", isNoiseLine("[2026-09-09T10:40:07.529Z] app ready, userData: /var/folders/x/T/ocr-desktop-app-nuSkJ3"));
  check("gatetail: keeper errors are NOT noise", !isNoiseLine("[2026-09-02T08:06:25.358Z] socket chmod failed: Error: ENOENT"));

  // headline: the one line that reaches pilot.log, ## Blocked and the lesson
  const h1 = gateTailHeadline("desktop-flow", legacy);
  check(
    "gatetail: headline names the first failing check, the count and the beat",
    h1 === "FAIL P2-090: artifact pane auto-opened on idle (+1 more) [beat: P2-090: artifact auto-open on idle (176.2s elapsed)]",
    h1,
  );
  const h2 = gateTailHeadline("desktop-flow", reported);
  check("gatetail: headline prefers the report's beat line", h2.startsWith("FAIL P2-090: artifact pane auto-opened on idle (+1 more) [beat P2-090 ·"), h2);
  check("gatetail: evidence headline is the reason, not the re-run tail", gateTailHeadline("evidence", diverge) === "pasted output diverges from re-run of: npm run build --silent");
  check("gatetail: tsc headline is the first error", gateTailHeadline("typecheck", tsc).includes("error TS2322"));
  check("gatetail: headline is capped", gateTailHeadline("unit", `FAIL ${"x".repeat(900)}`).length <= GATE_HEADLINE_BYTES);

  // the finding block the builder receives
  check(
    "gatetail: gateFindingBlock is unchanged for a short tail",
    gateFindingBlock("evidence", reason) === `[deterministic gate failed at step "evidence" — fix this FIRST and re-run the EVIDENCE commands]\n${reason}`,
  );
  // rec. 8: green-step warnings from the judge (bridge #1398) — tolerant of a
  // bridge that predates the field, strings only, capped
  check("gatetail: gateWarnings is [] for a bridge without the field", gateWarnings({}).length === 0 && gateWarnings({ warnings: "nope" }).length === 0);
  check(
    "gatetail: gateWarnings keeps up to 3 non-empty strings of 240 chars",
    JSON.stringify(gateWarnings({ warnings: ["WARN desktop-flow budget: 352.1s of 420s (84%)", 7, "", null] })) === JSON.stringify(["WARN desktop-flow budget: 352.1s of 420s (84%)"]) &&
      gateWarnings({ warnings: Array.from({ length: 9 }, () => `WARN x budget: ${"z".repeat(400)}`) }).every((w) => w.length === 240) &&
      gateWarnings({ warnings: Array.from({ length: 9 }, () => "WARN x budget: q") }).length === 3,
  );
  const fb = gateFindingBlock("desktop-flow", legacy);
  check("gatetail: gateFindingBlock carries the digest for a long tail", fb.includes("FAIL P2-090") && fb.includes("[gate tail digest — step \"desktop-flow\""), fb.slice(0, 300));

  // hostile input (fix-round blocking 1a): the gate tail is builder-controlled
  // and the digest runs inside the pilot's event loop. `/^--- (.+?)\s*$/` and
  // capLine's `/\s+$/` backtracked quadratically on a line with a long run of
  // spaces followed by any other character — 160k spaces cost 35 s (digest)
  // plus 15.6 s (headline); every red gate stalled the pilot ~85 s. Now every
  // pattern runs on a 4 KB copy of each line and the two patterns are linear.
  const hostileLine = `--- ${" ".repeat(1_000_000)}x`;
  const hostileOut = `OK   warmup line\n${hostileLine}\nFAIL P9-000: hostile line must not stall the gate\n`;
  const hostileStart = Date.now();
  const hostileDigest = gateTailDigest("desktop-flow", hostileOut);
  const digestMs = Date.now() - hostileStart;
  check(
    "gatetail: a line with 1 MB of spaces is digested in under 100 ms (ReDoS guard)",
    digestMs < 100,
    `${digestMs}ms — digest length ${hostileDigest.length}`,
  );
  const headlineStart = Date.now();
  const hostileHeadline = gateTailHeadline("desktop-flow", hostileOut);
  const headlineMs = Date.now() - headlineStart;
  check(
    "gatetail: the same line passes through gateTailHeadline in under 100 ms",
    headlineMs < 100 && hostileHeadline.startsWith("FAIL P9-000: hostile line must not stall the gate"),
    `${headlineMs}ms; "${hostileHeadline.slice(0, 80)}"`,
  );
  check(
    "gatetail: the hostile output still digests within budget, header capped and deterministic",
    hostileDigest.length <= GATE_FINDING_TAIL_BYTES &&
      (hostileDigest.split("\n")[0] ?? "").length <= 240 &&
      gateTailDigest("desktop-flow", hostileOut) === hostileDigest,
    hostileDigest.slice(0, 120),
  );
}

// ============================================================================
// 2. evidencecheck.ts
// ============================================================================
const tmp = mkdtempSync(join(tmpdir(), "ocr-eval04-evidence-"));
try {
  check("evidence: markers mirror pipeline.ts", CHECK_EVIDENCE_MARKER === EVIDENCE_MARKER && CHECK_TASK_DONE_MARKER === TASK_DONE_MARKER);

  const png = (w: number, h: number): Buffer => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const wide = join(tmp, "P9-001-r1-1440.png");
  const phone = join(tmp, "P9-001-r1-390.png");
  const retina = join(tmp, "retina-2880.png");
  const phone2x = join(tmp, "phone-780.png");
  const wrong = join(tmp, "wrong.png");
  const stale = join(tmp, "stale.png");
  writeFileSync(wide, png(1440, 900));
  writeFileSync(phone, png(390, 844));
  writeFileSync(retina, png(2880, 1800));
  writeFileSync(phone2x, png(780, 1688));
  writeFileSync(wrong, png(1280, 720));
  writeFileSync(stale, png(1440, 900));
  const startedAtMs = Date.now() - 60_000;
  utimesSync(stale, new Date(startedAtMs - 3_600_000), new Date(startedAtMs - 3_600_000));
  const io = defaultEvidenceIo();

  const block = (shots: string[], extra = "") =>
    `work done\n${EVIDENCE_MARKER}\n$ npm run typecheck --silent\n$ npm run test:unit --silent\nUNIT TESTS PASSED${extra}\n${shots.join("\n")}\n${TASK_DONE_MARKER}\n`;

  check("evidence: pngDims reads a real IHDR through the production reader", JSON.stringify(pngDims(io.readHead(wide))) === JSON.stringify({ w: 1440, h: 900 }));
  check("evidence: pngDims refuses a non-PNG", pngDims(Buffer.from("not a png at all, definitely not")) === null && pngDims(io.readHead(join(tmp, "missing.png"))) === null);

  // judge parser parity
  const two = `${block([`shot-1440x900: ${wrong}`])}\nlater prose\n${block([`shot-1440x900: ${wide}`, `shot-390: ${phone}`])}`;
  check("evidence: the LAST EVIDENCE: block wins (judge parity)", parseEvidenceShots(two)?.shots["shot-1440x900"] === wide);
  check("evidence: no block → null", parseEvidenceShots("no marker here") === null);
  check("evidence: a decorated marker is not a block (judge parity)", parseEvidenceShots("**EVIDENCE:**\n$ npm run typecheck --silent") === null);
  check("evidence: a padded block (>600 lines) → null (judge parity)", parseEvidenceShots(`${EVIDENCE_MARKER}\n${"x\n".repeat(601)}`) === null);
  check(
    "evidence: non-allowlisted $ lines are dropped (judge parity)",
    JSON.stringify(parseEvidenceShots(`${EVIDENCE_MARKER}\n$ rm -rf /\n$ npm run typecheck --silent\n`)?.commands) === JSON.stringify(["npm run typecheck --silent"]),
  );

  // gaps
  const noBlock = evidenceGaps("I stopped: the dependency is missing.", true, startedAtMs, io);
  check("evidence: a round without a block has exactly one gap naming the exact marker", noBlock.length === 1 && noBlock[0]!.includes("exactly `EVIDENCE:`"), noBlock.join(" | "));
  const noUnit = evidenceGaps(`${EVIDENCE_MARKER}\n$ npm run typecheck --silent\n${TASK_DONE_MARKER}`, false, startedAtMs, io);
  check("evidence: a missing required command is a gap", noUnit.length === 1 && noUnit[0]!.includes("npm run test:unit --silent"), noUnit.join(" | "));
  check("evidence: a non-UI round needs no shots", evidenceGaps(block([]), false, startedAtMs, io).length === 0);
  check("evidence: a complete UI block has no gap", evidenceGaps(block([`shot-1440x900: ${wide}`, `shot-390: ${phone}`]), true, startedAtMs, io).length === 0);
  check(
    "evidence: 2x Retina captures are accepted (judge parity)",
    evidenceGaps(block([`shot-1440x900: ${retina}`, `shot-390: ${phone2x}`]), true, startedAtMs, io).length === 0,
  );
  const missing1440 = evidenceGaps(block([`shot-390: ${phone}`]), true, startedAtMs, io);
  check("evidence: the forgotten 1440 shot is a gap (P3-401/P3-459 message)", missing1440.length === 1 && missing1440[0]!.includes("shot-1440x900"), missing1440.join(" | "));
  const bullet = evidenceGaps(block([`- shot-1440x900: \`${wide}\``, `shot-390: ${phone}`]), true, startedAtMs, io);
  check("evidence: a bulleted/backticked shot line is named as a near miss", bullet.length === 1 && bullet[0]!.includes("only reads a bare"), bullet.join(" | "));
  const rel = evidenceGaps(block(["shot-1440x900: shots/a.png", `shot-390: ${phone}`]), true, startedAtMs, io);
  check("evidence: a relative shot path is a gap", rel.length === 1 && rel[0]!.includes("relative"), rel.join(" | "));
  const unreadable = evidenceGaps(block([`shot-1440x900: ${join(tmp, "nope.png")}`, `shot-390: ${phone}`]), true, startedAtMs, io);
  check("evidence: a missing PNG is a gap", unreadable.length === 1 && unreadable[0]!.includes("not a readable PNG"), unreadable.join(" | "));
  // a cited path the builder plants may be a FIFO: openSync would block until
  // a writer shows up — forever (fix-round blocking 1b). The production
  // reader must refuse non-regular files instead of opening them.
  if (process.platform === "win32") {
    check("evidence: FIFO probe skipped on this platform", true);
  } else {
    const fifoShot = join(tmp, "fifo-1440.png");
    const mkfifo = spawnSync("mkfifo", [fifoShot]);
    const reallyFifo = mkfifo.status === 0 && statSync(fifoShot).isFIFO();
    if (!reallyFifo) {
      check("evidence: FIFO probe skipped (mkfifo unavailable)", true);
    } else {
      const fifoGaps = evidenceGaps(block([`shot-1440x900: ${fifoShot}`, `shot-390: ${phone}`]), true, startedAtMs, io);
      check(
        "evidence: a FIFO cited as a shot is a 'not a readable PNG' gap, never a hang",
        fifoGaps.length === 1 && fifoGaps[0]!.includes("not a readable PNG"),
        fifoGaps.join(" | "),
      );
    }
  }
  const wrongDims = evidenceGaps(block([`shot-1440x900: ${wrong}`, `shot-390: ${wide}`]), true, startedAtMs, io);
  check("evidence: wrong dimensions are gaps for both keys", wrongDims.length === 2 && wrongDims[0]!.includes("1280x720") && wrongDims[1]!.includes("width 390"), wrongDims.join(" | "));
  const staleGap = evidenceGaps(block([`shot-1440x900: ${stale}`, `shot-390: ${phone}`]), true, startedAtMs, io);
  check("evidence: a shot older than the pipeline start is stale", staleGap.length === 1 && staleGap[0]!.includes("stale"), staleGap.join(" | "));
  const home = mkdtempSync(join(tmpdir(), "ocr-eval04-home-"));
  writeFileSync(join(home, "a.png"), png(1440, 900));
  writeFileSync(join(home, "b.png"), png(390, 844));
  const tildeIo: EvidenceIo = { ...io, home };
  check("evidence: ~/ paths resolve against home (judge parity)", evidenceGaps(block(["shot-1440x900: ~/a.png", "shot-390: ~/b.png"]), true, startedAtMs, tildeIo).length === 0);
  rmSync(home, { recursive: true, force: true });
  const fenced = evidenceGaps(block([`shot-1440x900: ${wide}`, `shot-390: ${phone}`], "\n```"), true, startedAtMs, io);
  check("evidence: a code fence inside test:unit's pasted output is a gap", fenced.length === 1 && fenced[0]!.includes("code-fence"), fenced.join(" | "));
  const fenceAfterTypecheck = `${EVIDENCE_MARKER}\n$ npm run typecheck --silent\n\`\`\`\n$ npm run test:unit --silent\nUNIT TESTS PASSED\n${TASK_DONE_MARKER}`;
  check("evidence: a fence after the silent typecheck is harmless (judge skips empty re-runs)", evidenceGaps(fenceAfterTypecheck, false, startedAtMs, io).length === 0);

  // the bounce: one turn on the builder session, output merged for the judge
  const calls: string[] = [];
  const good = block([`shot-1440x900: ${wide}`, `shot-390: ${phone}`]);
  const gapsOf = (o: string) => evidenceGaps(o, true, startedAtMs, io);
  const clean = await bounceEvidence("P9-001", 1, good, true, { gaps: gapsOf, bounce: async (p) => (calls.push(p), { output: "" }) });
  check("evidence bounce: a clean block never bounces", !clean.bounced && calls.length === 0 && clean.output === good);
  const forgot = block([`shot-390: ${phone}`]);
  const fixed = await bounceEvidence("P9-001", 1, forgot, true, {
    gaps: gapsOf,
    bounce: async (p) => {
      calls.push(p);
      return { output: `took the shot\n${good}` };
    },
  });
  check("evidence bounce: a gap bounces exactly once and the merged output passes", fixed.bounced && calls.length === 1 && fixed.after.length === 0 && fixed.before.length === 1);
  check("evidence bounce: the gate reads the bounce's block (last marker)", parseEvidenceShots(fixed.output)?.shots["shot-1440x900"] === wide && fixed.output.startsWith(forgot));
  check("evidence bounce: the prompt names the gap and the task's concrete shot paths", (calls[0] ?? "").includes("shot-1440x900") && (calls[0] ?? "").includes("P9-001-r1-1440.png") && (calls[0] ?? "").trim().endsWith(TASK_DONE_MARKER));
  calls.length = 0;
  const stubborn = await bounceEvidence("P9-001", 2, forgot, true, { gaps: gapsOf, bounce: async (p) => (calls.push(p), { output: "sorry" }) });
  check(
    `evidence bounce: never more than ${EVIDENCE_BOUNCE_MAX} turn(s); an unfixed block keeps its gap for the gate`,
    calls.length === EVIDENCE_BOUNCE_MAX && stubborn.after.length === 1 && parseEvidenceShots(stubborn.output)?.shots["shot-390"] === phone,
  );
  const nonUi = evidenceBouncePrompt("P9-002", 3, ["the EVIDENCE block does not cite `$ npm run test:unit --silent`"], false);
  check("evidence bounce: a non-UI bounce asks for no screenshots", !nonUi.includes("browse.mjs") && nonUi.includes("npm run test:unit --silent"));
  check("evidence: the UI template is exactly the judge's line shapes", parseEvidenceShots(UI_EVIDENCE_TEMPLATE)?.shots["shot-390"] === "~/.opencode-remote/pilot/shots/builder/<TASK-ID>-r<ROUND>-390.png");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ============================================================================
// 3. the task diff is taken against origin/<base> (stale local main repro)
// ============================================================================
{
  check("diff base: taskDiffRange is three-dot against the remote base", taskDiffRange("P2-357") === "origin/main...pilot/P2-357" && taskDiffRange("P9-1", "master") === "origin/master...pilot/P9-1");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "ocr-unit",
    GIT_AUTHOR_EMAIL: "ocr-unit@test.local",
    GIT_COMMITTER_NAME: "ocr-unit",
    GIT_COMMITTER_EMAIL: "ocr-unit@test.local",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"]) delete gitEnv[k];
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const root = mkdtempSync(join(tmpdir(), "ocr-eval04-diffbase-"));
  try {
    const origin = join(root, "origin.git");
    const slot = join(root, "slot");
    const peer = join(root, "peer");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, slot);
    writeFileSync(join(slot, "README.md"), "base\n");
    git(slot, "add", "README.md");
    git(slot, "commit", "-qm", "base");
    git(slot, "push", "-q", "origin", "HEAD:main");
    // another slot merges a UI change while this slot's local main sits still
    git(root, "clone", "-q", origin, peer);
    mkdirSync(join(peer, "apps", "web", "src"), { recursive: true });
    writeFileSync(join(peer, "apps", "web", "src", "PairingOverlay.tsx"), "export const x = 1;\n");
    git(peer, "add", ".");
    git(peer, "commit", "-qm", "pilot(P2-343): overlay copy");
    git(peer, "push", "-q", "origin", "HEAD:main");
    // this slot: fetch, branch from the NEW origin/main (resume rebase /
    // conflict merge), commit a test-only change — local main stays behind
    git(slot, "fetch", "-q", "origin");
    git(slot, "checkout", "-q", "-B", "pilot/P9-357", "origin/main");
    mkdirSync(join(slot, "scripts"), { recursive: true });
    writeFileSync(join(slot, "scripts", "unit.test.ts"), "// parity\n");
    git(slot, "add", ".");
    git(slot, "commit", "-qm", "pilot(P9-357): ipc parity");
    const stale = git(slot, "diff", "--name-only", "main...pilot/P9-357").trim();
    const fixedNames = git(slot, "diff", "--name-only", taskDiffRange("P9-357")).trim();
    check(
      "diff base: repro — local `main...pilot/<ID>` lists another slot's apps/web file (old behavior)",
      stale.includes("apps/web/src/PairingOverlay.tsx") && touchedUiFromDiff(stale) && needsUiEvidence("infra", touchedUiFromDiff(stale)),
      stale,
    );
    check(
      "diff base: `origin/main...pilot/<ID>` lists only the task's own file — no shots demanded from an infra task",
      fixedNames === "scripts/unit.test.ts" && !needsUiEvidence("infra", touchedUiFromDiff(fixedNames)),
      fixedNames,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const pipelineSrc = readFileSync(join(repoRoot, "apps", "pilot", "src", "pipeline.ts"), "utf8");
  check("diff base: no pipeline diff reads the local main ref any more", !/git diff (?:--name-only )?main\.\.\./.test(pipelineSrc) && !pipelineSrc.includes("diff main...pilot"));
  // byte-identical to eval-03's #1399 on these two lines (mechanical merge);
  // taskDiffRange must keep producing the very same range string
  check(
    "diff base: runPipeline's diff and name-only list read origin/<base>...pilot/<ID> (same range as taskDiffRange)",
    pipelineSrc.includes("const diff = exec(`git diff origin/${base}...pilot/${t.id}`, { cwd: ws }).output;") &&
      pipelineSrc.includes("const nameOnly = exec(`git diff --name-only origin/${base}...pilot/${t.id}`, { cwd: ws }).output;") &&
      taskDiffRange("P9-9", "trunk") === "origin/trunk...pilot/P9-9",
  );
  check(
    "pipeline: every green-step judge warning becomes an alert event + a warn log line",
    pipelineSrc.includes("for (const w of gateWarnings(gate)) {") && pipelineSrc.includes('emit("alert", { task: t.id, ok: false, detail: w });'),
  );
  check(
    "pipeline: the gate reads the (possibly bounced) builder output and cuts its tail by relevance",
    pipelineSrc.includes("judgeGate({ ws, sha: gateSha, task: t, builderOutput, startedAtMs, nameOnly })") &&
      pipelineSrc.includes("gateTailDigest(gate.step, gate.tail, GATE_CARRY_TAIL_BYTES)") &&
      pipelineSrc.includes("detail: `gatekeeper rejected at step ${gate.step}: ${headline}`") &&
      !pipelineSrc.includes("gate.tail.slice(-300)"),
  );
}

// ============================================================================
// 4. prompts: UI-EVIDENCE template, format rules, coupled assertions
// ============================================================================
{
  const mk = (id: string, area: string, priority = "P2"): Task =>
    ({ id, title: `title of ${id}`, spec: `spec of ${id}`, priority, area, done: false }) as unknown as Task;
  const ui1 = builderPrompt(mk("P9-101", "ui"), 1, "", []);
  const ui2 = builderPrompt(mk("P9-202", "desktop"), 3, "finding", ["- lesson (fonte: P0-001)"], null, null, 2, "", "master");
  const infra = builderPrompt(mk("P9-303", "infra"), 1, "", []);
  const stable = (p: string) => p.slice(0, p.indexOf("\nTASK ("));
  check("prompt: builder carries the coupled-assertions rule", ui1.includes(COUPLING_RULE_BUILDER) && infra.includes(COUPLING_RULE_BUILDER));
  check("prompt: builder carries the EVIDENCE format rules", ui1.includes(EVIDENCE_FORMAT_RULES) && infra.includes(EVIDENCE_FORMAT_RULES));
  // eval-18: AGENTS.md rides every agent turn — builders stop growing it; the
  // diagnosis advice must never tail a long run (it would hide the FAIL line)
  check(
    "prompt: builder documents in README/docs, not AGENTS.md, and gets the context-hygiene rule",
    ui1.includes(DOCS_RULE_BUILDER) && !ui1.includes("(README.md / AGENTS.md / docs/)") && DOCS_RULE_BUILDER.includes("not AGENTS.md") && ui1.includes(CONTEXT_HYGIENE_RULE),
  );
  check("prompt: the hygiene rule greps FAIL/error lines instead of tailing a long run", CONTEXT_HYGIENE_RULE.includes("grep -nE '^FAIL|[Ee]rror'") && !/\| tail -n/.test(CONTEXT_HYGIENE_RULE));
  check("prompt: a UI task gets the fixed shot lines unconditionally", ui1.includes(`<paste the real command output here>\n${UI_SHOT_LINES}\n`));
  check("prompt: a non-UI task gets them conditionally", infra.includes(`(if this round's diff touches apps/web/ or apps/desktop/, also cite:\n${UI_SHOT_LINES})`));
  check("prompt: P1-077 — the builder's stable prefix is byte-identical across tasks/rounds/bases (UI variant)", stable(ui1).length > 0 && stable(ui1) === stable(ui2));
  check(
    "prompt: the builder is told to inspect the diff against origin/<base>",
    ui2.includes("git diff origin/master...pilot/P9-202") && !ui2.includes("git diff main...") && builderPrompt(mk("P9-404", "ui"), 2, "", []).includes("git diff origin/main...pilot/P9-404"),
  );
  check("prompt: the coupled surfaces name the mirrors from the lessons", COUPLING_RULE_BUILDER.includes("scripts/desktop-flow.test.ts") && COUPLING_RULE_BUILDER.includes("PaneMap.tsx") && COUPLING_RULE_BUILDER.includes("pt-BR") && COUPLING_RULE_BUILDER.includes("docs/PRODUCT.md"));
  const p1 = plannerPrompt(mk("P9-501", "ui", "P1"), 1);
  const p2 = plannerPrompt(mk("P9-502", "daemon", "P0"), 2, ["- l (fonte: P0-002)"]);
  check("prompt: planner requires the Invalidates: list", p1.includes(COUPLING_RULE_PLANNER) && COUPLING_RULE_PLANNER.includes("Invalidates:"));
  const pStable = (p: string) => p.slice(0, p.indexOf("\nTASK ("));
  check("prompt: P1-077 — the planner's stable prefix stays byte-identical across tasks", pStable(p1).length > 0 && pStable(p1) === pStable(p2));
}

// ============================================================================
// 5. desktop-flow report ↔ gatetail parser parity (source shape)
// ============================================================================
{
  const flow = readFileSync(join(repoRoot, "scripts", "desktop-flow.test.ts"), "utf8");
  check("desktop-flow: prints the FAILED CHECKS report gatetail parses", flow.includes("console.log(`FAILED CHECKS (${failedChecks.length}) — the check, the beat it ran in, when, and its detail:`)"));
  check("desktop-flow: each reported failure carries a `     beat …` line", flow.includes("console.log(`     beat ${f.beat}"));
  check("desktop-flow: warns above 80% of the budget with the gatetail summary prefix", flow.includes("const BUDGET_WARN_RATIO = 0.8;") && flow.includes("console.log(`WARN desktop-flow budget: "));
  check("desktop-flow: the report also runs on abnormal exits (deadline, failed open) and names where it stopped", /process\.on\("exit", \(\) => \{\s*try \{\s*flowReport\(true\);/.test(flow) && flow.includes("FAIL desktop flow stopped before its end — last check: "));
  check("desktop-flow: the normal end prints the report before the duration line", flow.indexOf("flowReport();\nconst duration = Date.now() - startedAt;") > 0);
  check("desktop-flow: every check is charged to a beat", /function check\(name: string, ok: boolean, detail = ""\) \{[\s\S]{0,400}beatMs\.set\(beat, slot\);/.test(flow));
  // the report's own lines must not look like phase banners to the parser
  check("desktop-flow: report lines never start with the `--- ` banner prefix", !/console\.log\(`\\?n?--- (?:beat|FAILED|WARN|last)/.test(flow));
}

// ============================================================================
// 6. coupling.ts — dangling literal assertions (lessons P3-413/P3-435)
// ============================================================================
{
  const diffOf = (file: string, removed: string[], added: string[] = []) =>
    [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1,3 +1,3 @@", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
  const io = (product: Record<string, string>, tests: Record<string, string>): CouplingIo => ({
    productFiles: () => Object.entries(product).map(([path, text]) => ({ path, text })),
    testFiles: () => Object.entries(tests).map(([path, text]) => ({ path, text })),
  });
  // P3-435 shape: the i18n caps label renamed, desktop-flow still expects it
  const i18nDiff = diffOf(
    "apps/web/src/lib/i18n.ts",
    ['    pairHostCaps: "Pair a phone with this machine",', '    pairHostCaps: "Parear um celular com esta máquina",'],
    ['    pairHostCaps: "Let a phone control this machine",', '    pairHostCaps: "Deixar um celular controlar esta máquina",'],
  );
  const flowTest = ['const a = 1;', "  (v) => /Pair a phone with this machine|Connect to another machine/.test(v),", "  (v) => /Parear um celular com esta máquina/.test(v),"].join("\n");
  const product435 = { "apps/web/src/lib/i18n.ts": 'pairHostCaps: "Let a phone control this machine",\npairHostCaps: "Deixar um celular controlar esta máquina",' };
  const h435 = couplingHints(i18nDiff, io(product435, { "scripts/desktop-flow.test.ts": flowTest }));
  check(
    "coupling: a renamed copy string still asserted by desktop-flow is named with path:line (P3-435)",
    h435.length === 2 && h435[0]!.startsWith('scripts/desktop-flow.test.ts:2 still asserts "Pair a phone with this machine"') && h435[1]!.startsWith("scripts/desktop-flow.test.ts:3"),
    h435.join(" | "),
  );
  check(
    "coupling: a literal still present in another product file is not dangling",
    couplingHints(i18nDiff, io({ ...product435, "apps/web/src/components/Other.tsx": "<p>Pair a phone with this machine</p>\n<p>Parear um celular com esta máquina</p>" }, { "scripts/desktop-flow.test.ts": flowTest })).length === 0,
  );
  check(
    "coupling: a literal re-added by the same diff (moved) is not dangling",
    couplingHints(diffOf("apps/web/src/lib/i18n.ts", ['  a: "Pair a phone with this machine",'], ['  b: "Pair a phone with this machine",']), io({ "apps/web/src/lib/i18n.ts": "" }, { "scripts/desktop-flow.test.ts": flowTest })).length === 0,
  );
  // P3-413 shape: the unit battery pins literal JSX source
  const paneDiff = diffOf("apps/web/src/components/PairingView.tsx", ["        <PaneMap />"], ["        <PaneMap offlinePanes={offlinePanes} />"]);
  const unitPin = ['check("pairing view renders the map", pairingSrc.includes("<PaneMap />"));'].join("\n");
  const h413 = couplingHints(paneDiff, io({ "apps/web/src/components/PairingView.tsx": "<PaneMap offlinePanes={offlinePanes} />" }, { "scripts/unit.test.ts": unitPin }));
  check("coupling: a source-shape pin of a removed JSX line is named (P3-413, reverse direction)", h413.length === 1 && h413[0]!.startsWith('scripts/unit.test.ts:1 still asserts "<PaneMap />"'), h413.join(" | "));
  check(
    "coupling: removals outside the product sources never produce hints",
    couplingHints(diffOf("scripts/unit.test.ts", ['  check("x", src.includes("<PaneMap />"));']), io({}, { "scripts/unit.test.ts": unitPin })).length === 0 &&
      couplingHints(diffOf("docs/PRODUCT.md", ["Pair a phone with this machine"]), io({}, { "scripts/desktop-flow.test.ts": flowTest })).length === 0,
  );
  check("coupling: an unrelated test literal is not a hint", couplingHints(paneDiff, io({ "apps/web/src/components/PairingView.tsx": "<PaneMap offlinePanes={offlinePanes} />" }, { "scripts/unit.test.ts": 'check("other", src.includes("<SettingsView />"));' })).length === 0);
  const many = diffOf("apps/web/src/lib/i18n.ts", Array.from({ length: 20 }, (_, i) => `  k${i}: "copy number ${i} of the old wizard",`));
  const manyTests = Array.from({ length: 20 }, (_, i) => `expect("copy number ${i} of the old wizard");`).join("\n");
  check(`coupling: at most ${COUPLING_MAX_HINTS} hints per round`, couplingHints(many, io({ "apps/web/src/lib/i18n.ts": "" }, { "scripts/unit.test.ts": manyTests })).length === COUPLING_MAX_HINTS);
  check("coupling: import specifiers and paths are wiring, not copy", couplingLiterals('import { x } from "./lib/pair-gate-hint";').length === 0 && !couplingLiterals('const u = "https://example.com/pair-gate";').includes("https://example.com/pair-gate"));
  check(
    "coupling: literals = spaced copy (whole class lists included) + kebab class/selector tokens",
    JSON.stringify(couplingLiterals('<p className="pair-gate-hint muted">Pareie com sua máquina primeiro</p>').sort()) ===
      JSON.stringify(["Pareie com sua máquina primeiro", "pair-gate-hint", "pair-gate-hint muted"].sort()),
    JSON.stringify(couplingLiterals('<p className="pair-gate-hint muted">Pareie com sua máquina primeiro</p>')),
  );
  check("coupling: parseUnifiedDiff splits removed/added per file", parseUnifiedDiff(i18nDiff).get("apps/web/src/lib/i18n.ts")?.removed.length === 2);
  check("coupling: the block tells the builder how to act on each hint", couplingBlock(h435).startsWith("COUPLED ASSERTIONS") && couplingBlock(h435).includes("- scripts/desktop-flow.test.ts:2") && couplingBlock([]) === "");
  check("coupling: only the unit / e2e flow steps attach hints to a gate failure", COUPLING_GATE_STEPS.join(",") === "unit,desktop-flow,desktop-render");

  // the production reader over a workspace layout
  const ws = mkdtempSync(join(tmpdir(), "ocr-eval04-coupling-"));
  try {
    mkdirSync(join(ws, "apps", "web", "src", "components"), { recursive: true });
    mkdirSync(join(ws, "apps", "web", "src", "node_modules"), { recursive: true });
    mkdirSync(join(ws, "apps", "desktop", "src"), { recursive: true });
    mkdirSync(join(ws, "scripts"), { recursive: true });
    writeFileSync(join(ws, "apps", "web", "src", "components", "PairingView.tsx"), "<PaneMap offlinePanes={offlinePanes} />");
    writeFileSync(join(ws, "apps", "web", "src", "node_modules", "skip.ts"), "<PaneMap />");
    writeFileSync(join(ws, "apps", "desktop", "src", "main.ts"), "app.whenReady()");
    writeFileSync(join(ws, "scripts", "unit.test.ts"), unitPin);
    writeFileSync(join(ws, "scripts", "helper.ts"), 'x("<PaneMap />")');
    const wio = workspaceCouplingIo(ws);
    check(
      "coupling: the workspace reader lists product sources (node_modules skipped) and scripts/*.test.ts only",
      JSON.stringify(wio.productFiles().map((f) => f.path).sort()) === JSON.stringify(["apps/desktop/src/main.ts", "apps/web/src/components/PairingView.tsx"]) &&
        JSON.stringify(wio.testFiles().map((f) => f.path)) === JSON.stringify(["scripts/unit.test.ts"]),
    );
    check("coupling: end to end over a real workspace layout", couplingHints(paneDiff, wio).length === 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }

  // fix-round blocking 1c: the workspace walk used to accept any non-directory
  // entry — a FIFO planted in apps/web/src blocked readFileSync forever. Both
  // readers must skip non-regular files without a single open.
  if (process.platform === "win32") {
    check("coupling: FIFO probe skipped on this platform", true);
  } else {
    const wsF = mkdtempSync(join(tmpdir(), "ocr-eval04-coupling-fifo-"));
    try {
      mkdirSync(join(wsF, "apps", "web", "src"), { recursive: true });
      mkdirSync(join(wsF, "scripts"), { recursive: true });
      writeFileSync(join(wsF, "apps", "web", "src", "PairingView.tsx"), "<PaneMap offlinePanes={offlinePanes} />");
      writeFileSync(join(wsF, "scripts", "unit.test.ts"), unitPin);
      const fifoTrap = join(wsF, "apps", "web", "src", "Trap.tsx");
      const fifoTest = join(wsF, "scripts", "evil.test.ts");
      const ok1 = spawnSync("mkfifo", [fifoTrap]);
      const ok2 = spawnSync("mkfifo", [fifoTest]);
      if (ok1.status !== 0 || ok2.status !== 0 || !statSync(fifoTrap).isFIFO() || !statSync(fifoTest).isFIFO()) {
        check("coupling: FIFO probe skipped (mkfifo unavailable)", true);
      } else {
        const wfio = workspaceCouplingIo(wsF);
        check(
          "coupling: a FIFO in the product tree and one named *.test.ts are skipped, never read",
          !wfio.productFiles().some((f) => f.path.endsWith("Trap.tsx")) &&
            wfio.productFiles().some((f) => f.path.endsWith("PairingView.tsx")) &&
            !wfio.testFiles().some((f) => f.path.endsWith("evil.test.ts")) &&
            couplingHints(paneDiff, wfio).length === 1,
          JSON.stringify([wfio.productFiles().map((f) => f.path), wfio.testFiles().map((f) => f.path)]),
        );
      }
    } finally {
      rmSync(wsF, { recursive: true, force: true });
    }
  }

  // the pre-gate bounce carries coupling hints even when the evidence is clean
  const asked: string[] = [];
  let fixedTests = false;
  const res = await bounceEvidence("P9-413", 2, `${EVIDENCE_MARKER}\n$ npm run typecheck --silent\n$ npm run test:unit --silent\nUNIT TESTS PASSED\n${TASK_DONE_MARKER}`, false, {
    gaps: (o) => evidenceGaps(o, false, 0, defaultEvidenceIo()),
    coupling: () => (fixedTests ? [] : h413),
    bounce: async (prompt) => {
      asked.push(prompt);
      fixedTests = true;
      return { output: `updated the pin\n${EVIDENCE_MARKER}\n$ npm run typecheck --silent\n$ npm run test:unit --silent\nUNIT TESTS PASSED\n${TASK_DONE_MARKER}` };
    },
  });
  check(
    "coupling bounce: dangling assertions alone bounce once, with the hint in the prompt",
    res.bounced && asked.length === 1 && (asked[0] ?? "").includes("COUPLED ASSERTIONS") && (asked[0] ?? "").includes('still asserts "<PaneMap />"') && res.couplingAfter.length === 0 && res.couplingBefore.length === 1,
  );
  check("coupling bounce: a clean evidence block is not reported as an evidence gap", !(asked[0] ?? "").includes("EVIDENCE — the deterministic gate would reject"));

  const pipelineSrc = readFileSync(join(repoRoot, "apps", "pilot", "src", "pipeline.ts"), "utf8");
  check(
    "pipeline: the pre-gate bounce re-scans the branch diff for coupling and the gate finding carries the hints",
    pipelineSrc.includes("coupling: () => couplingHints(exec(`git diff ${taskDiffRange(t.id, base)}`") &&
      pipelineSrc.includes("if (COUPLING_GATE_STEPS.includes(gate.step)) {") &&
      pipelineSrc.includes("findings = `${findings}\\n${couplingBlock(hints)}`;"),
  );
}

// ============================================================================
// 7. a REAL desktop-flow gate output (fixture: hermetic run, 2 failures)
// ============================================================================
{
  // CRLF-normalized: a Windows checkout may rewrite the fixture's line endings
  const full = readFileSync(join(repoRoot, "apps", "pilot", "src", "__fixtures__", "gate-tail", "desktop-flow-2fail.txt"), "utf8").replace(/\r\n/g, "\n");
  const lines = full.split("\n");
  const a = lines.findIndex((l) => l.startsWith("desktop flow beat timing:"));
  const b = lines.findIndex((l, i) => i > a && l.startsWith("desktop flow duration:"));
  // what the gate signed before this change: the same run without the report
  const legacy = [...lines.slice(0, a - 1), ...lines.slice(b - 1)].join("\n");
  const fails = ["FAIL P2-090: session chat rendered without the pane", "FAIL P2-338: incompatible 1440x900 shot is a real PNG"];
  const named = (s: string) => fails.filter((f) => s.includes(f)).length;
  check("real output: the fixture holds the report and the legacy shape does not", a > 0 && b > a && !legacy.includes("FAILED CHECKS"));
  check("real output: regression — the old finding (last 1500 bytes) names only the late failure", named(legacy.slice(-GATE_FINDING_TAIL_BYTES)) === 1 && !legacy.slice(-GATE_FINDING_TAIL_BYTES).includes(fails[0]!));
  check("real output: regression — the old log headline (last 300 bytes) names no failing check", named(legacy.slice(-300)) === 0);
  for (const [label, out] of [["legacy output", legacy], ["output with the report", full]] as const) {
    const finding = gateTailDigest("desktop-flow", out, GATE_FINDING_TAIL_BYTES);
    const carry = gateTailDigest("desktop-flow", out, GATE_CARRY_TAIL_BYTES);
    check(
      `real output (${label}): finding and carryover name both failures, the P2-090 beat and its detail`,
      named(finding) === 2 && named(carry) === 2 && finding.includes("P2-090: artifact auto-open on idle") && carry.includes("condition never held (12 probes), last value: false"),
      carry,
    );
    check(`real output (${label}): the headline names the first failure, the count and its beat`, gateTailHeadline("desktop-flow", out).startsWith("FAIL P2-090: session chat rendered without the pane (+1 more) [beat"));
  }

  // fix-round blocking 2 (F6): the failure lesson keeps only the first 200
  // characters of the carryover (formatFailureLesson → tailSignal, 200-char
  // slice). desktop-flow's digest header used to fill the whole slice with
  // boilerplate — the lesson never named the check, so strategist and planner
  // stayed blind. The header now LEADS with the first failing check.
  const lessonCarry = gateTailDigest("desktop-flow", full, GATE_CARRY_TAIL_BYTES);
  const lessonLine = formatFailureLesson({
    kind: "failure",
    ts: "2026-09-27T12:00:00-03:00",
    task: "P9-800",
    attempts: 2,
    step: "gatekeeper",
    findings: "gatekeeper rejected at step desktop-flow",
    tail: lessonCarry,
  });
  check(
    "real output: the failure lesson (first 200 chars of the carry) names the first failing check",
    lessonLine.includes("FAIL P2-090: session chat rendered without the pane"),
    lessonLine,
  );
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ngate-feedback: all green");
