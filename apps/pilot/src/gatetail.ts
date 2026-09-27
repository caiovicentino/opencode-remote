/**
 * Gate tail digest (forensic 2026-09-24, recommendation 3). The judge's signed
 * verdict carries the FULL output of the failing step — stdout first, then
 * stderr (separate buffers: every console.error detail lands after the last
 * console.log line) — and the pipeline used to keep only its last N bytes.
 * For the long steps that is exactly the wrong end: the desktop-flow
 * carryovers of P3-371 / P3-354 / P3-457 held JSON event noise, OK lines and
 * bare "condition never held" details, never the name of the check that
 * failed (0 of the 9 logged desktop-flow tails named it), and the unit
 * battery buries its FAIL line under ~5800 OK lines. The P3-457 builder had
 * to re-run the whole flow itself to learn what broke.
 *
 * `gateTailDigest` keeps the byte budget but spends it by relevance: the
 * failing checks (with the beat that was running), the first error block, the
 * run's summary lines, and only then the last lines of the output. An output
 * that already fits the budget passes through byte-identical. Pure and
 * deterministic — no fs, process or network — so the battery pins every rule.
 */

/** Budget of the finding block the builder receives in the same attempt. */
export const GATE_FINDING_TAIL_BYTES = 1500;
/** Budget of the per-task carryover file (next attempt + failure lesson). */
export const GATE_CARRY_TAIL_BYTES = 1200;
/** Budget of the one-line headline (pilot.log, pipeline result detail). */
export const GATE_HEADLINE_BYTES = 300;

/** Any single line is capped so one minified stack cannot eat the budget. */
const LINE_CAP = 240;
/** Most failing-check lines listed before "(+N more)". */
const MAX_FAIL_LINES = 10;
/** Lines kept after the first error anchor (stack / tsc continuation). */
const ERROR_CONTEXT_LINES = 6;

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** The `FAIL <name>` convention every gate script shares (unit, desktop-flow,
 * desktop-render, desktop-sidecar, …) plus TAP-style shapes. */
const FAIL_LINE_RE = /^(?:FAIL\b|not ok\b|\s*✗ )/;

/** desktop-flow phase banner: `--- <beat label> (12.3s elapsed)`. */
const BEAT_BANNER_RE = /^--- (.+?)\s*$/;

/** desktop-flow's own failure report (one entry per failed check, with its
 * beat and detail) — preferred over the raw FAIL lines when present. */
const FAILED_CHECKS_RE = /^FAILED CHECKS \(\d+\)/;

/** Run-level summary lines worth keeping verbatim. */
const SUMMARY_RE = /^(?:FAILURES: \d+|UNIT TESTS FAILED\b|INVARIANTS FAILED\b|desktop flow duration:|WARN desktop-flow budget:|desktop flow exceeded\b)/;

/** Consecutive OK lines in the padding collapse to one marker from this run
 * length on — "the run went on through N more checks" costs one line. */
const OK_RUN_COLLAPSE = 4;

/** First-error anchors for outputs without FAIL lines (tsc, vite, npm, node,
 * Playwright). Case-sensitive on purpose: "renderer error surfaced" in an OK
 * line is not an error. */
const ERROR_ANCHORS: readonly RegExp[] = [
  /\b(?:Assertion|Type|Reference|Syntax|Range|Eval|URI)?Error\b(?::|\s+\[)/,
  /\berror TS\d+:/,
  /^npm (?:ERR!|error)\b/,
  /\bERR_[A-Z_]{3,}\b/,
  /\b(?:Timeout|TimeoutError|timed out|ETIMEDOUT)\b/,
  /\bexceeded the \d+ ?ms budget\b/,
  /\bcondition never held\b/,
  /\bhas been closed\b/,
  /\berror during build\b/,
  /\bUnhandled(?:PromiseRejection| rejection)\b/,
  /^\s*✖ \d+ problems?\b/,
];

/** Lines that never help a builder: JSON event dumps (the fake daemons'
 * stderr), keeper boot chatter, Node's own warnings, blank lines. A JSON line
 * that reports an error level is kept. */
export function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (/^[{[].*[}\]],?$/.test(t)) return !/"level"\s*:\s*"(?:error|fatal)"/.test(t);
  if (/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] (?:launching electron|app ready, userData:)/.test(t)) return true;
  if (/^\(node:\d+\) (?:MaxListenersExceededWarning|ExperimentalWarning|DeprecationWarning)\b/.test(t)) return true;
  if (/^\(Use `node --trace-(?:warnings|deprecation)/.test(t)) return true;
  return false;
}

function isErrorAnchor(line: string): boolean {
  if (/^OK\b/.test(line.trim())) return false;
  return ERROR_ANCHORS.some((re) => re.test(line));
}

function capLine(line: string): string {
  const t = line.replace(/\s+$/, "");
  return t.length > LINE_CAP ? `${t.slice(0, LINE_CAP - 1)}…` : t;
}

/** Steps whose "tail" is a judge-authored reason (not a command transcript):
 * their first line IS the headline. */
const REASON_STEPS = new Set(["evidence", "context", "profile", "corpus", "tamper", "review", "unverified-blocking"]);

interface Parsed {
  lines: string[];
  /** Raw FAIL lines, outside desktop-flow's FAILED CHECKS report. */
  failIdx: number[];
  /** desktop-flow's FAILED CHECKS report (header included), or []. */
  failedChecks: string[];
  /** Error-anchor lines outside the report, in output order (capped). */
  errorIdx: number[];
  beatBeforeFirstFail: string | null;
}

function parse(output: string): Parsed {
  const lines = output.replace(ANSI_RE, "").replace(/\r\n?/g, "\n").split("\n");
  const failIdx: number[] = [];
  const failedChecks: string[] = [];
  const errorIdx: number[] = [];
  let lastBeat: string | null = null;
  let beatBeforeFirstFail: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (FAILED_CHECKS_RE.test(l) && failedChecks.length === 0) {
      // the report runs until the first blank line; its FAIL/detail lines
      // repeat stdout/stderr content, so they are not counted twice
      let j = i;
      for (; j < lines.length && (lines[j] ?? "").trim(); j++) failedChecks.push(lines[j] ?? "");
      i = j - 1;
      continue;
    }
    const banner = BEAT_BANNER_RE.exec(l);
    if (banner?.[1]) lastBeat = banner[1];
    if (FAIL_LINE_RE.test(l)) {
      if (failIdx.length === 0) beatBeforeFirstFail = lastBeat;
      failIdx.push(i);
    } else if (errorIdx.length < 50 && !isNoiseLine(l) && isErrorAnchor(l)) {
      errorIdx.push(i);
    }
  }
  return { lines, failIdx, failedChecks, errorIdx, beatBeforeFirstFail };
}

/** FAIL lines of desktop-flow's report plus the raw ones it does not repeat
 * (a deadline abort, "stopped before its end"), else just the raw ones. */
function failLines(p: Parsed): string[] {
  const raw = p.failIdx.map((i) => p.lines[i] ?? "");
  const reported = p.failedChecks.filter((l) => FAIL_LINE_RE.test(l));
  if (!reported.length) return raw;
  const inReport = new Set(reported.map((l) => l.trim()));
  return [...reported, ...raw.filter((l) => !inReport.has(l.trim()))];
}

/**
 * Relevance-first digest of a failing gate step's output, at most `budget`
 * characters. An output that fits passes through unchanged (short judge
 * reasons such as "UI task without shot-1440x900 path…" stay byte-identical).
 * Otherwise, in priority order:
 *   1. a header naming the step, the failing-check count and the last beat
 *      banner started before the first FAIL;
 *   2. desktop-flow's FAILED CHECKS report — or, for every other script, the
 *      raw FAIL lines (first MAX_FAIL_LINES);
 *   3. the first error block (anchor + ERROR_CONTEXT_LINES non-noise lines);
 *   4. the run's summary lines (FAILURES: N, durations, budget warnings);
 *   5. the last non-noise lines of the output, padding what is left.
 * Sections 2-4 are capped so the padding always keeps room.
 */
export function gateTailDigest(step: string, output: string, budget = GATE_FINDING_TAIL_BYTES): string {
  if (output.length <= budget) return output;
  const p = parse(output);
  const used = new Set<string>();
  const take = (l: string): string => {
    const c = capLine(l);
    used.add(c.trim());
    return c;
  };

  const fails = failLines(p);
  const beat = p.beatBeforeFirstFail ? `; last beat started before the first FAIL: ${p.beatBeforeFirstFail}` : "";
  const header = capLine(
    `[gate tail digest — step "${step}": ${fails.length} FAIL line(s)${beat}; full output ${p.lines.length} lines, cut by relevance]`,
  );

  const failSection: string[] = [];
  if (p.failedChecks.length) {
    for (const l of p.failedChecks) failSection.push(take(l));
    // raw FAIL lines the report does not repeat (deadline / early-exit lines)
    for (const l of fails) if (!used.has(capLine(l).trim())) failSection.push(take(l));
  } else if (fails.length) {
    for (const l of fails.slice(0, MAX_FAIL_LINES)) failSection.push(take(l));
    if (fails.length > MAX_FAIL_LINES) failSection.push(`(+${fails.length - MAX_FAIL_LINES} more FAIL line(s))`);
  }

  // the first error anchor the failing-check section does not already show
  const errorSection: string[] = [];
  const first = p.errorIdx.find((i) => !used.has(capLine(p.lines[i] ?? "").trim()));
  if (first !== undefined) {
    errorSection.push(take(p.lines[first] ?? ""));
    for (let i = first + 1, n = 0; i < p.lines.length && n < ERROR_CONTEXT_LINES; i++) {
      const l = p.lines[i] ?? "";
      if (isNoiseLine(l) || /^OK\b/.test(l.trim()) || FAILED_CHECKS_RE.test(l)) continue;
      const c = capLine(l);
      if (used.has(c.trim())) continue;
      errorSection.push(take(c));
      n++;
    }
  }

  const summarySection: string[] = [];
  for (const l of p.lines) {
    if (!SUMMARY_RE.test(l.trim())) continue;
    const c = capLine(l.trim());
    if (used.has(c)) continue;
    summarySection.push(take(c));
  }

  // The last non-noise lines not already shown (collected newest first); a
  // run of OK lines collapses to its newest line plus a count marker.
  const tailPool: string[] = [];
  let okRun: string[] = [];
  const flushOk = () => {
    if (okRun.length >= OK_RUN_COLLAPSE) tailPool.push(...okRun.slice(0, 2), `… ${okRun.length - 2} earlier OK line(s) …`);
    else tailPool.push(...okRun);
    okRun = [];
  };
  for (let i = p.lines.length - 1; i >= 0 && tailPool.length < 200; i--) {
    const l = p.lines[i] ?? "";
    if (isNoiseLine(l)) continue;
    const c = capLine(l);
    if (used.has(c.trim())) continue;
    if (/^OK\b/.test(c.trim())) {
      okRun.push(c);
      continue;
    }
    flushOk();
    tailPool.push(c);
  }
  flushOk();

  const out: string[] = [header];
  let size = header.length;
  const push = (l: string, limit: number): boolean => {
    if (size + 1 + l.length > limit) return false;
    out.push(l);
    size += 1 + l.length;
    return true;
  };
  const section = (title: string, ls: string[], share: number) => {
    if (!ls.length) return;
    const limit = Math.min(budget, size + Math.floor(budget * share));
    if (!push(title, limit)) return;
    for (const l of ls) if (!push(l, limit)) break;
  };
  section("failing checks:", failSection, 0.45);
  section("first error:", errorSection, 0.25);
  section("summary:", summarySection, 0.15);
  const tailLines: string[] = [];
  let tailSize = size + "last lines:".length + 1;
  for (const l of tailPool) {
    if (tailSize + 1 + l.length > budget) break;
    tailLines.unshift(l);
    tailSize += 1 + l.length;
  }
  if (tailLines.length) {
    push("last lines:", budget);
    for (const l of tailLines) push(l, budget);
  }
  return out.join("\n").slice(0, budget);
}

/**
 * One-line headline (<= `max` chars) for the pilot.log gate-fail line and the
 * pipeline result detail — the text that reaches the ## Blocked line, the
 * failure lesson, the supervisor notification and the daemon's forensic
 * timeline. Judge-authored reasons (evidence, context, …) keep their first
 * line; command transcripts name the first failing check (+N more) and its
 * beat, else the first error anchor, else the last meaningful line.
 */
export function gateTailHeadline(step: string, output: string, max = GATE_HEADLINE_BYTES): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const cap = (s: string) => {
    const f = flat(s);
    return f.length > max ? `${f.slice(0, max - 1)}…` : f;
  };
  const p = parse(output);
  if (REASON_STEPS.has(step)) {
    const first = p.lines.find((l) => l.trim());
    return cap(first ?? "");
  }
  const fails = failLines(p);
  if (fails.length) {
    const more = fails.length > 1 ? ` (+${fails.length - 1} more)` : "";
    const beatLine = p.failedChecks.find((l) => /^\s+beat\b/.test(l));
    const beat = beatLine ? ` [${flat(beatLine)}]` : p.beatBeforeFirstFail ? ` [beat: ${p.beatBeforeFirstFail}]` : "";
    return cap(`${flat(fails[0] ?? "")}${more}${beat}`);
  }
  const firstError = p.errorIdx[0];
  if (firstError !== undefined) return cap(p.lines[firstError] ?? "");
  for (let i = p.lines.length - 1; i >= 0; i--) {
    const l = p.lines[i] ?? "";
    if (!isNoiseLine(l)) return cap(l);
  }
  return cap(output);
}
