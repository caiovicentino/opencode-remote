#!/usr/bin/env node
// opencode-remote document → PDF conversion (local, no cloud).
//   node tools/doc2pdf.mjs <file> [<file>...]  -> converts each doc to PDF next
//   to the input and prints one `[file: <abs path>]` line per output (the app
//   renders that as a download card).
// Prefers LibreOffice (`soffice --headless --convert-to pdf`) for full fidelity;
// on macOS falls back to the native textutil+cupsfilter pipeline (textutil
// normalizes doc/docx/rtf/html to plain text, cupsfilter prints it to PDF).
// P2-231: the known install locations, the preference order and the extensions
// each converter covers are the single source of truth in
// apps/daemon/src/doccap.ts — consumed below instead of a local list, so the
// Windows default LibreOffice path works too and failures come out as the
// module's short pt-BR verdict phrase (never an English terminal dead end).
// The original input file is never modified.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  SOFFICE_EXTS as ALLOWED_EXTS,
  NATIVE_EXTS,
  SOFFICE_PATHS,
  TEXTUTIL_PATHS,
  CUPSFILTER_PATHS,
  docConvertProbe,
  docConvertVerdict,
} from "../apps/daemon/src/doccap.ts";

// the allowlist IS the full-fidelity converter's coverage (single source of truth)
export { ALLOWED_EXTS };

/** Lowercased extension of `file` ("" when none; dotfiles are not extensions). */
export function extOf(file) {
  const base = basename(String(file)).toLowerCase();
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1);
}

/** Allowlist check: { ok, ext } for an input path. */
export function validateExt(file, allowlist = ALLOWED_EXTS) {
  const ext = extOf(file);
  return { ok: ext !== "" && allowlist.includes(ext), ext };
}

/**
 * Pure: choose which converter to use on this platform. `candidates` is the
 * discovery list pre-filtered for the target extension (see discoverConverters).
 * soffice wins wherever it appears because it keeps formatting; the native
 * textutil+cupsfilter pipeline is darwin-only. Returns the chosen candidate or
 * null when nothing applies (the CLI must then fail gracefully).
 */
export function pickConverter(platform, candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  const soffice = list.find((c) => c?.kind === "soffice" && !!c.bin);
  if (soffice) return soffice;
  if (platform === "darwin") {
    const native = list.find((c) => c?.kind === "native");
    if (native) return native;
  }
  return null;
}

function findBin(name, extraPaths) {
  for (const p of extraPaths) if (existsSync(p)) return p;
  const w = spawnSync("which", [name], { encoding: "utf8" });
  return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : null;
}

function discoverConverters() {
  // P2-231: candidate locations come from apps/daemon/src/doccap.ts, keyed by
  // platform (macOS app bundle path, Windows default install path, PATH lookup
  // still covers everything else).
  const known = (list) => list[process.platform] ?? [];
  const out = [];
  const soffice = findBin("soffice", known(SOFFICE_PATHS));
  if (soffice) out.push({ kind: "soffice", bin: soffice, exts: [...ALLOWED_EXTS] });
  const textutil = findBin("textutil", known(TEXTUTIL_PATHS));
  const cupsfilter = findBin("cupsfilter", known(CUPSFILTER_PATHS));
  if (textutil && cupsfilter) {
    out.push({ kind: "native", textutil, cupsfilter, exts: [...NATIVE_EXTS] });
  }
  return out;
}

/** P2-231: raw probe of what discovery actually found, for the verdict phrase. */
function probeOf(converters) {
  const probe = { soffice: false, textutil: false, cupsfilter: false };
  for (const c of converters) {
    if (c?.kind === "soffice") probe.soffice = true;
    if (c?.kind === "native") {
      probe.textutil = true;
      probe.cupsfilter = true;
    }
  }
  return probe;
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "buffer", timeout: 60_000, ...opts });
  if (r.error) throw new Error(`${basename(bin)} could not run: ${r.error.message}`);
  if (r.status !== 0) {
    const tail = (r.stderr?.toString("utf8") || r.stdout?.toString("utf8") || "").slice(-400).trim();
    throw new Error(`${basename(bin)} failed (exit ${r.status})${tail ? `: ${tail}` : ""}`);
  }
  return r;
}

function isPdf(buf) {
  return buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF";
}

function convertWithSoffice(conv, input) {
  run(conv.bin, ["--headless", "--convert-to", "pdf", "--outdir", dirname(input), input]);
  const out = join(dirname(input), basename(input).replace(/\.[^.]+$/i, "") + ".pdf");
  if (!existsSync(out) || !isPdf(readFileSync(out))) {
    throw new Error("soffice reported success but no valid PDF was produced");
  }
  return out;
}

function convertNative(conv, input, ext) {
  const dir = dirname(input);
  const base = basename(input).replace(/\.[^.]+$/i, "");
  let src = input;
  let tmp = null;
  if (ext !== "csv") {
    // cupsfilter only prints text/images/PDFs — normalize doc/docx/rtf/html first
    tmp = join(dir, `${base}.doc2pdf-${process.pid}.txt`);
    run(conv.textutil, ["-convert", "txt", input, "-output", tmp]);
    src = tmp;
  }
  let pdf;
  try {
    pdf = run(conv.cupsfilter, [src], { maxBuffer: 64 * 1024 * 1024 }).stdout;
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
  if (!isPdf(pdf)) throw new Error("cupsfilter did not produce a valid PDF");
  const out = join(dir, `${base}.pdf`);
  writeFileSync(out, pdf);
  return out;
}

function convert(file, converters) {
  const input = String(file);
  if (!existsSync(input)) throw new Error("file not found");
  const { ok, ext } = validateExt(input);
  if (!ok) {
    throw new Error(
      ext ? `extension ".${ext}" is not allowed (allowlist: ${ALLOWED_EXTS.join(" ")})`
          : `missing file extension (allowlist: ${ALLOWED_EXTS.join(" ")})`,
    );
  }
  const conv = pickConverter(process.platform, converters.filter((c) => c.exts.includes(ext)));
  if (!conv) {
    // P2-231: the failure is the verdict's short pt-BR phrase (what to install)
    // instead of an English terminal dead end — the original file stays intact.
    throw new Error(docConvertVerdict(process.platform, probeOf(converters)).message);
  }
  return conv.kind === "soffice" ? convertWithSoffice(conv, input) : convertNative(conv, input, ext);
}

function main(argv) {
  const files = argv.filter((a) => a && a !== " ").map((f) => resolve(f));
  if (!files.length) {
    console.error(`usage: doc2pdf.mjs <file> [<file>...]\n  converts docs to PDF; allowed: ${ALLOWED_EXTS.join(" ")}`);
    return 1;
  }
  const converters = discoverConverters();
  let failures = 0;
  for (const f of files) {
    try {
      console.log(`[file: ${convert(f, converters)}]`);
    } catch (e) {
      failures++;
      console.error(`doc2pdf: ${f}: ${e.message}`);
    }
  }
  return failures ? 1 : 0;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = main(process.argv.slice(2));
