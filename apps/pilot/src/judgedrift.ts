/**
 * Judge freshness — the pinned judge's vendored protocol vs the deploy target.
 *
 * The live invariants that close every deploy run the PINNED judge
 * (~/.opencode-remote/judge, P1-056) against the services the deploy just
 * restarted, speaking the protocol through the judge's own vendored copy
 * (src/protocol.ts — the judge never imports the code it audits). When
 * packages/protocol moves and the copy does not, the live check fails for a
 * reason no merge can fix: on 2026-09-10 RT-390 put the hello timestamp inside
 * the sealed token, the judge pinned on 09-05 kept sealing {clientPub} only,
 * the daemon refused it ("no-timestamp") and every deploy for 12 days rolled
 * back and QUARANTINED a good sha (17 rollbacks on 09-22 alone).
 *
 * This module compares the two files by what they EXECUTE: TypeScript types
 * are erased by the compiler, then the emitted JavaScript is reduced to its
 * leaf-token stream, so comments, whitespace, quote style, trailing commas and
 * type-only edits (the judge's ASCII-only comment copy, a widened `caps` type)
 * never count, while any change to executable code does. Pure over its inputs
 * except for the injectable readers; nothing here writes anywhere.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as TsApi from "typescript";

/** Operator-owned pin of the live judge (same file judge.ts resolveJudge reads). */
export const DEFAULT_JUDGE_PIN_FILE = join(homedir(), ".opencode-remote", "judge.json");
/** The vendored copy inside the judge checkout. */
export const JUDGE_PROTOCOL_REL = join("src", "protocol.ts");
/** The file it mirrors, as a git path inside the production repo. */
export const TARGET_PROTOCOL_PATH = "packages/protocol/src/crypto.ts";

const SHA_OK = /^[0-9a-f]{7,40}$/;

type Ts = typeof TsApi;
let tsCache: Ts | null | undefined;

/** The compiler, loaded lazily (never on the pilot's hot path); null when absent. */
export function loadTypescript(): Ts | null {
  if (tsCache !== undefined) return tsCache;
  try {
    tsCache = createRequire(import.meta.url)("typescript") as Ts;
  } catch {
    tsCache = null;
  }
  return tsCache;
}

/**
 * Leaf-token stream of what a TypeScript module executes. Literals are
 * normalized to their cooked value (quote style never counts); a comma right
 * before a closing bracket is dropped (trailing-comma formatting). Null when
 * the compiler is unavailable.
 */
export function runtimeTokens(src: string, ts: Ts | null = loadTypescript()): string[] | null {
  if (!ts) return null;
  const js = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      removeComments: true,
      isolatedModules: true,
    },
    reportDiagnostics: false,
    fileName: "mirror.ts",
  }).outputText;
  const sf = ts.createSourceFile("mirror.js", js, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (node: TsApi.Node): void => {
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      // a quoted property key that is a valid identifier is the same key
      // unquoted ({ "clientPub": x } ≡ { clientPub: x })
      const parent = node.parent;
      const isKey = ts.isStringLiteral(node) && parent !== undefined && (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
      if (isKey && /^[A-Za-z_$][\w$]*$/.test((node as TsApi.StringLiteral).text)) out.push((node as TsApi.StringLiteral).text);
      else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(`str:${JSON.stringify(node.text)}`);
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(`tpl:${JSON.stringify(node.text)}`);
      else out.push(node.getText(sf));
      return;
    }
    for (const k of kids) visit(k);
  };
  visit(sf);
  return out.filter((t, i) => !(t === "," && [")", "]", "}"].includes(out[i + 1] ?? "")));
}

export type ProtocolDriftState = "match" | "drift" | "no-target" | "no-mirror" | "unknown";

export interface ProtocolDrift {
  state: ProtocolDriftState;
  detail: string;
  /** For "drift": the first differing window, judge side vs target side. */
  diff?: { judge: string; target: string };
}

function tokenWindow(tokens: string[], at: number): string {
  const text = tokens.slice(Math.max(0, at - 6), at + 8).map((t) => t.replace(/^(str|tpl):/, "")).join(" ");
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

/**
 * Runtime comparison of the judge's vendored protocol against the target's.
 * - no target file (foreign repo, test repo) → "no-target": nothing to mirror;
 * - target present but the mirror missing → "no-mirror" (live check cannot run);
 * - compiler unavailable → "unknown" (the caller decides; deploy fails open);
 * - otherwise "match" or "drift" with the first differing window.
 */
export function compareProtocolMirror(mirrorSrc: string | null, targetSrc: string | null, ts: Ts | null = loadTypescript()): ProtocolDrift {
  if (targetSrc === null) return { state: "no-target", detail: `target has no ${TARGET_PROTOCOL_PATH} — nothing for the judge to mirror` };
  if (mirrorSrc === null) return { state: "no-mirror", detail: `judge has no ${JUDGE_PROTOCOL_REL} mirror while the target ships ${TARGET_PROTOCOL_PATH}` };
  let a: string[] | null;
  let b: string[] | null;
  try {
    a = runtimeTokens(mirrorSrc, ts);
    b = runtimeTokens(targetSrc, ts);
  } catch (err) {
    return { state: "unknown", detail: `protocol comparison crashed: ${String(err).slice(0, 120)}` };
  }
  if (!a || !b) return { state: "unknown", detail: "typescript unavailable — runtime comparison skipped" };
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return { state: "match", detail: `runtime-identical (${a.length} tokens; comments/types ignored)` };
  return {
    state: "drift",
    detail: `runtime drift at token ${i} of ${b.length}`,
    diff: { judge: tokenWindow(a, i) || "(end of file)", target: tokenWindow(b, i) || "(end of file)" },
  };
}

// ── judge checkout inspection (read-only; mirrors judge.ts resolveJudge) ────

/** Injectable read-only git runner: argv in, {ok, output} out. */
export type GitRead = (args: string[]) => { ok: boolean; output: string };

export function realGitRead(): GitRead {
  return (args) => {
    try {
      // --no-optional-locks: a status probe must never refresh (write) the index
      const output = execFileSync("git", ["--no-optional-locks", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
      return { ok: true, output };
    } catch (err) {
      const e = err as { stdout?: string | Buffer; stderr?: string | Buffer };
      return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
}

export interface JudgeInspection {
  /** True when resolveJudge() would succeed (files present, pin set, HEAD = pin, clean). */
  usable: boolean;
  pin: string | null;
  head: string | null;
  /** Human reason when unusable; a short "judge <pin> pinned + clean" otherwise. */
  detail: string;
}

/**
 * Same verdict as judge.ts resolveJudge() — cli + pubkey present, pin set,
 * HEAD starts with the pin, no tracked edits — but non-throwing and strictly
 * read-only, so the operator preflight and the doctor can report it without
 * touching the live judge.
 */
export function inspectJudge(dir: string, pinFile: string, git: GitRead = realGitRead(), exists: (p: string) => boolean = existsSync, read: (p: string) => string = (p) => readFileSync(p, "utf8")): JudgeInspection {
  if (!exists(join(dir, "src", "cli.ts"))) return { usable: false, pin: null, head: null, detail: `judge missing: ${join(dir, "src", "cli.ts")}` };
  if (!exists(join(dir, "judge.pub"))) return { usable: false, pin: null, head: null, detail: `judge pubkey missing: ${join(dir, "judge.pub")}` };
  let pin: string | null = null;
  try {
    const raw = (JSON.parse(read(pinFile)) as { pin?: unknown }).pin;
    pin = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  } catch {}
  if (!pin) return { usable: false, pin: null, head: null, detail: `judge pin missing: ${pinFile}` };
  const h = git(["-C", dir, "rev-parse", "HEAD"]);
  const head = h.ok ? h.output.trim() : null;
  if (!head) return { usable: false, pin, head: null, detail: `judge HEAD unreadable: ${h.output.trim().slice(-120)}` };
  if (!head.startsWith(pin)) return { usable: false, pin, head, detail: `judge HEAD ${head.slice(0, 8)} != pinned ${pin.slice(0, 8)}` };
  const st = git(["-C", dir, "status", "--porcelain", "--untracked-files=no"]);
  if (!st.ok) return { usable: false, pin, head, detail: `judge status unreadable: ${st.output.trim().slice(-120)}` };
  if (st.output.trim()) return { usable: false, pin, head, detail: `judge checkout is dirty (tracked edits): ${st.output.trim().split("\n").slice(0, 3).join(", ")}` };
  return { usable: true, pin, head, detail: `judge ${pin.slice(0, 8)} pinned + clean` };
}

/** Read the judge's vendored protocol (null when absent/unreadable). */
export function readJudgeMirror(dir: string): string | null {
  try {
    return readFileSync(join(dir, JUDGE_PROTOCOL_REL), "utf8");
  } catch {
    return null;
  }
}

/** `git show <rev>:packages/protocol/src/crypto.ts` in `repo` (null when absent). */
export function showTargetProtocol(repo: string, rev: string, git: GitRead = realGitRead()): string | null {
  if (!SHA_OK.test(rev) && !/^origin\/[A-Za-z0-9._/-]+$/.test(rev) && rev !== "HEAD") return null;
  const r = git(["-C", repo, "show", `${rev}:${TARGET_PROTOCOL_PATH}`]);
  return r.ok ? r.output : null;
}

/**
 * The operator-facing sentence for a drift: what breaks, why it is not the
 * merge's fault, and the exact repair. Shared by the deploy guard, the doctor
 * and the preflight so the three never disagree.
 */
export function judgeDriftDetail(pin: string | null, target: string, drift: ProtocolDrift): string {
  const who = `pinned judge ${pin ? pin.slice(0, 8) : "?"}`;
  const what =
    drift.state === "no-mirror"
      ? `${who} has no protocol mirror`
      : `${who} protocol mirror != ${TARGET_PROTOCOL_PATH} at ${target} (${drift.detail})`;
  return `judge drift: ${what} — the live invariants would fail and quarantine a good sha; sync ~/.opencode-remote/judge/${JUDGE_PROTOCOL_REL} with ${TARGET_PROTOCOL_PATH}, commit in the judge repo and re-pin judge.json`;
}
