/**
 * EVIDENCE pre-check (forensic 2026-09-24, recommendation 4): the STATIC half
 * of the judge's P2-009 evidence step — block present, required commands
 * cited, both UI screenshots cited as readable, correctly sized, fresh PNGs —
 * run by the pipeline right after a builder round, BEFORE the gate. A round
 * that forgot its screenshots (or the whole block) goes back to the same
 * builder session in the same round instead of spending the round — or, on
 * the last round, the attempt — at the gate's evidence step.
 *
 * The judge stays the authority. This mirror of ~/.opencode-remote/judge
 * src/gate.ts (parseEvidenceBlock + the static checks of verifyEvidence, judge
 * pin 957106c) only decides whether to ask for a complete block first: a
 * wrong "no gap" means the gate rejects exactly as before, a wrong gap costs
 * one short bounce turn. Command re-execution (the divergence check) stays in
 * the judge. Pure over an injected file reader so the battery pins every rule.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { couplingBlock } from "./coupling";

/** Same literals as pipeline.ts EVIDENCE_MARKER / TASK_DONE_MARKER (and the
 * judge's) — duplicated because pipeline.ts imports this module (a cycle
 * would evaluate the template below before the constants exist); parity is
 * pinned by the battery. */
export const EVIDENCE_MARKER = "EVIDENCE:";
export const TASK_DONE_MARKER = "PILOT:TASK-DONE";

/** judge EVIDENCE_COMMANDS — the only `$ ` lines the gate parses. */
export const EVIDENCE_COMMANDS: readonly string[] = [
  "npm run typecheck --silent",
  "npm run test:unit --silent",
  "npm run build --silent",
];

/** judge EVIDENCE_REQUIRED — every task proves typecheck + unit. */
export const EVIDENCE_REQUIRED: readonly string[] = ["npm run typecheck --silent", "npm run test:unit --silent"];

/** The two screenshot keys a UI round must cite. */
export const EVIDENCE_SHOT_KEYS = ["shot-1440x900", "shot-390"] as const;

/** Bounces per builder round — one short turn, never a loop. */
export const EVIDENCE_BOUNCE_MAX = 1;

/** Wall-clock cap of the bounce turn (build + two shots + the cited reruns). */
export const EVIDENCE_BOUNCE_TIMEOUT_MIN = 20;

/** Commands whose green re-run prints output — a stray line in their pasted
 * section is compared against it (typecheck --silent prints nothing when
 * green, so the judge skips its containment check). */
const VERBOSE_COMMANDS: readonly string[] = ["npm run test:unit --silent", "npm run build --silent"];

export interface EvidenceShotBlock {
  commands: string[];
  shots: Record<string, string>;
  /** Lines inside the block that mention a shot key but are not the bare
   * `shot-<key>: <path>` shape the gate reads (bullets, backticks, bold…). */
  nearMissShots: string[];
  /** Code-fence lines pasted inside a verbose command's output section — the
   * judge compares them against the re-run and rejects the merge. */
  fencedCommands: string[];
}

/**
 * Mirror of the judge's parseEvidenceBlock: the LAST line that is exactly
 * `EVIDENCE:` opens the block, the first PILOT:TASK-DONE after it closes it,
 * a body over 600 lines is refused (null), only allowlisted `$ ` lines open a
 * command, and `shot-<label>: <path>` lines (path without spaces) cite shots.
 */
export function parseEvidenceShots(output: string): EvidenceShotBlock | null {
  const lines = output.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trim() === EVIDENCE_MARKER) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.trim() === TASK_DONE_MARKER) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  if (body.length > 600) return null;
  const block: EvidenceShotBlock = { commands: [], shots: {}, nearMissShots: [], fencedCommands: [] };
  let current: string | null = null;
  for (const line of body) {
    const t = line.trim();
    if (t.startsWith("$ ")) {
      const cmd = t.slice(2).trim();
      // judge: a non-allowlisted `$ ` line is dropped and does NOT end the
      // current command's pasted output
      if (EVIDENCE_COMMANDS.includes(cmd)) {
        block.commands.push(cmd);
        current = cmd;
      }
      continue;
    }
    const shot = t.match(/^(shot-[0-9a-z]+):\s*(\S+)\s*$/i);
    if (shot) {
      block.shots[shot[1]!.toLowerCase()] = shot[2]!;
      continue;
    }
    if (/shot-(?:1440x900|390)\b/i.test(t)) block.nearMissShots.push(t);
    if (t.startsWith("```") && current && VERBOSE_COMMANDS.includes(current) && !block.fencedCommands.includes(current)) {
      block.fencedCommands.push(current);
    }
  }
  return block;
}

/** PNG IHDR dimensions from the first 24 bytes, or null (judge pngSize). */
export function pngDims(buf: Uint8Array | null): { w: number; h: number } | null {
  if (!buf || buf.length < 24) return null;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!magic.every((b, i) => buf[i] === b)) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const w = view.getUint32(16);
  const h = view.getUint32(20);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** judge evidenceShotDimsOk: 1x and 2x (Retina) captures. */
export function evidenceShotDimsOk(key: string, size: { w: number; h: number }): boolean {
  if (key === "shot-1440x900") return (size.w === 1440 && size.h === 900) || (size.w === 2880 && size.h === 1800);
  if (key === "shot-390") return size.w === 390 || size.w === 780;
  return false;
}

export interface EvidenceIo {
  /** First bytes of the file (24 are enough), or null when unreadable. */
  readHead: (path: string) => Uint8Array | null;
  /** mtime in ms, or null when the file cannot be stat'ed. */
  mtimeMs: (path: string) => number | null;
  home: string;
}

/**
 * The gaps the judge's evidence step would reject on, in the judge's order
 * (block, required commands, then each shot: cited, readable PNG, size,
 * freshness). Empty array = the static half passes. `requireShots` must be
 * the gate's own predicate (needsUiEvidence over the task area and the
 * branch's name-only diff).
 */
export function evidenceGaps(output: string, requireShots: boolean, minShotMtimeMs: number, io: EvidenceIo): string[] {
  const block = parseEvidenceShots(output);
  if (!block) {
    return [
      `no EVIDENCE block — the gate reads the LAST line that is exactly \`${EVIDENCE_MARKER}\` (alone on its line, no markdown, no code fence) and everything after it up to ${TASK_DONE_MARKER}`,
    ];
  }
  const gaps: string[] = [];
  for (const req of EVIDENCE_REQUIRED) {
    if (!block.commands.includes(req)) gaps.push(`the EVIDENCE block does not cite \`$ ${req}\` with its real output`);
  }
  for (const cmd of block.fencedCommands) {
    gaps.push(`a code-fence line sits inside the pasted output of \`$ ${cmd}\` — the gate compares it against the real re-run and rejects the merge; paste plain lines only`);
  }
  if (!requireShots) return gaps;
  for (const key of EVIDENCE_SHOT_KEYS) {
    const p = block.shots[key];
    if (!p) {
      const near = block.nearMissShots.find((l) => l.toLowerCase().includes(key));
      gaps.push(
        near
          ? `\`${key}\` is cited as "${near.slice(0, 120)}" — the gate only reads a bare \`${key}: <absolute path>\` line (no bullet, no backticks, no spaces in the path)`
          : `no \`${key}: <path>\` line — this round's diff touches apps/web/ or apps/desktop/ (or the task is ui/desktop), so the gate requires it`,
      );
      continue;
    }
    // isAbsolute, not startsWith("/"): a Windows checkout cites C:\… paths
    if (!isAbsolute(p) && !p.startsWith("~")) {
      gaps.push(`\`${key}\` path "${p}" is relative — the gate needs an absolute (or ~/) path`);
      continue;
    }
    const abs = p.startsWith("~") ? join(io.home, p.slice(1)) : p;
    const size = pngDims(io.readHead(abs));
    if (!size) {
      gaps.push(`\`${key}\`: ${p} is not a readable PNG (missing file or not a PNG)`);
      continue;
    }
    if (!evidenceShotDimsOk(key, size)) {
      gaps.push(`\`${key}\`: ${p} is ${size.w}x${size.h} — expected ${key === "shot-390" ? "width 390 (or 780)" : "1440x900 (or 2880x1800)"}`);
      continue;
    }
    if (minShotMtimeMs > 0 && (io.mtimeMs(abs) ?? 0) < minShotMtimeMs) {
      gaps.push(`\`${key}\`: ${p} predates this pipeline run (stale) — take it again now`);
    }
  }
  return gaps;
}

/** The fixed UI evidence template (placeholders only — stable prompt prefix). */
export const UI_EVIDENCE_TEMPLATE = `EVIDENCE:
$ npm run typecheck --silent
<final lines of the real output, verbatim>
$ npm run test:unit --silent
<final lines of the real output, verbatim>
shot-1440x900: ~/.opencode-remote/pilot/shots/builder/<TASK-ID>-r<ROUND>-1440.png
shot-390: ~/.opencode-remote/pilot/shots/builder/<TASK-ID>-r<ROUND>-390.png
${TASK_DONE_MARKER}`;

/**
 * The same-round bounce prompt: names every evidence gap and every dangling
 * coupled assertion (coupling.ts), asks for those items ONLY (no new work)
 * and restates the exact block shape. Sent on the builder's own session, so
 * its context (and prompt cache) carries over.
 */
export function evidenceBouncePrompt(taskId: string, round: number, gaps: string[], requireShots: boolean, coupling: string[] = []): string {
  const steps: string[] = [];
  if (coupling.length) steps.push("Update each listed assertion in the same branch (or restore the literal if the rename was unintended) and commit.");
  if (gaps.length && requireShots) {
    steps.push(`Take BOTH screenshots now, of this round's build (build first if needed):
   node tools/browse.mjs shot ~/.opencode-remote/pilot/shots/builder/${taskId}-r${round}-1440.png 1440 900
   node tools/browse.mjs shot ~/.opencode-remote/pilot/shots/builder/${taskId}-r${round}-390.png 390 844
   (open the page first with \`node tools/browse.mjs open <url>\`; for the desktop shell use \`node tools/desktop.mjs open\` then \`node tools/desktop.mjs shot <path> 1440 900\` / \`390 844\`)`);
  }
  steps.push(
    `Paste the real final lines of each cited command (re-run it if you changed anything or no longer have this round's real output) and end your output with the COMPLETE block — the gate reads only the LAST block in your output — exactly this shape (plain text: no code fence, no bullets, no backticks, no bold):
${requireShots ? UI_EVIDENCE_TEMPLATE.replace(/<TASK-ID>/g, taskId).replace(/<ROUND>/g, String(round)) : `EVIDENCE:
$ npm run typecheck --silent
<final lines of the real output, verbatim>
$ npm run test:unit --silent
<final lines of the real output, verbatim>
${TASK_DONE_MARKER}`}`,
  );
  const evidence = gaps.length
    ? `\nEVIDENCE — the deterministic gate would reject this round at step "evidence":\n${gaps.map((g) => `- ${g}`).join("\n")}\n`
    : "";
  const coupled = coupling.length ? `\n${couplingBlock(coupling)}\n` : "";
  return `PRE-GATE CHECK (same round ${round}, before the deterministic gate runs): fix ONLY the items below now — no new feature work, no refactors (if a cited command fails, fixing that failure IS this work: the gate re-runs every cited command).
${evidence}${coupled}
${steps.map((st, i) => `${i + 1}. ${st}`).join("\n")}

Your LAST line of output must be exactly: ${TASK_DONE_MARKER}`;
}

export interface EvidenceBounceResult {
  /** The builder output the gate must read: the round's output plus the
   * bounce turn's (the judge parses the LAST `EVIDENCE:` block, so a bounce
   * without a block leaves the original one — and its rejection — intact). */
  output: string;
  bounced: boolean;
  /** Evidence gaps found before the bounce ([] = nothing to do). */
  before: string[];
  /** Evidence gaps left after the bounce ([] = the static half passes). */
  after: string[];
  /** Dangling coupled assertions before / after the bounce. */
  couplingBefore: string[];
  couplingAfter: string[];
}

/**
 * The same-round bounce, with injected collaborators so the battery drives
 * it without an agent: `gaps` is evidenceGaps closed over the gate's own
 * predicate/freshness, `coupling` re-scans the branch diff (coupling.ts),
 * `bounce` sends a prompt to the SAME builder session. At most
 * EVIDENCE_BOUNCE_MAX turns; stops as soon as nothing is left.
 */
export async function bounceEvidence(
  taskId: string,
  round: number,
  output: string,
  requireShots: boolean,
  deps: {
    gaps: (output: string) => string[];
    coupling?: () => string[];
    bounce: (prompt: string, items: string[]) => Promise<{ output: string }>;
  },
): Promise<EvidenceBounceResult> {
  const before = deps.gaps(output);
  const couplingBefore = deps.coupling?.() ?? [];
  let current = output;
  let after = before;
  let couplingAfter = couplingBefore;
  for (let i = 0; i < EVIDENCE_BOUNCE_MAX && (after.length > 0 || couplingAfter.length > 0); i++) {
    const r = await deps.bounce(evidenceBouncePrompt(taskId, round, after, requireShots, couplingAfter), [...after, ...couplingAfter]);
    current = `${current}\n${r.output}`;
    after = deps.gaps(current);
    couplingAfter = deps.coupling?.() ?? [];
  }
  return { output: current, bounced: current !== output, before, after, couplingBefore, couplingAfter };
}

/** Production file reader: the PNG header (24 bytes) and the mtime. */
export function defaultEvidenceIo(): EvidenceIo {
  return {
    readHead: (p) => {
      try {
        const fd = openSync(p, "r");
        try {
          const buf = Buffer.alloc(24);
          const n = readSync(fd, buf, 0, 24, 0);
          return buf.subarray(0, n);
        } finally {
          closeSync(fd);
        }
      } catch {
        return null;
      }
    },
    mtimeMs: (p) => {
      try {
        return statSync(p).mtimeMs;
      } catch {
        return null;
      }
    },
    home: homedir(),
  };
}
