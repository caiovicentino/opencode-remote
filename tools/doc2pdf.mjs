#!/usr/bin/env node
// opencode-remote document → PDF pipeline (local, no cloud).
//   node tools/doc2pdf.mjs <file> [outdir]  -> converts an office doc to PDF,
//     prints "[file: <abs path>]" so the phone app shows a download card.
// Allowlist: docx doc rtf html csv xlsx pptx.
// Primary converter: LibreOffice `soffice --headless --convert-to pdf`.
// macOS fallback (no LibreOffice installed): textutil + cupsfilter for the
// text-ish formats (docx doc rtf html csv); xlsx/pptx need LibreOffice.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DOC_EXTS = ["docx", "doc", "rtf", "html", "csv", "xlsx", "pptx"];

// formats the macOS-native fallback can handle without LibreOffice
export const NATIVE_TEXT_EXTS = ["docx", "doc", "rtf", "html", "csv"];

const SOFFICE_APP = "/Applications/LibreOffice.app/Contents/MacOS/soffice";

/** Normalize a filename to a lowercase allowlisted extension, or null. */
export function validateExt(file) {
  const m = /\.([a-z0-9]+)$/i.exec(String(file));
  if (!m) return null;
  const ext = m[1].toLowerCase();
  return DOC_EXTS.includes(ext) ? ext : null;
}

/** First candidate that targets this platform and is actually available. */
export function pickConverter(platform, candidates) {
  for (const c of candidates) {
    if (Array.isArray(c.platforms) && c.platforms.includes(platform) && c.available) return c;
  }
  return null;
}

/** PDF magic check: real converters always emit %PDF as the first 4 bytes. */
export function hasPdfMagic(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "%PDF";
}

function onPath(bin) {
  const w = spawnSync("which", [bin], { encoding: "utf8" });
  return w.status === 0 && w.stdout.trim() ? w.stdout.trim() : null;
}

function sofficeBin() {
  if (process.env.OCR_SOFFICE) return process.env.OCR_SOFFICE;
  const pathHit = onPath("soffice");
  if (pathHit) return pathHit;
  for (const p of [SOFFICE_APP, "/usr/bin/soffice", "/usr/local/bin/soffice"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function cupsfilterBin() {
  return onPath("cupsfilter") ?? (existsSync("/usr/sbin/cupsfilter") ? "/usr/sbin/cupsfilter" : null);
}

function textutilBin() {
  return onPath("textutil") ?? (existsSync("/usr/bin/textutil") ? "/usr/bin/textutil" : null);
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 120_000, ...opts });
  if (r.error) throw new Error(`${bin} ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${bin} failed (exit ${r.status ?? "timeout"}): ${(r.stderr || r.stdout || "").slice(-400)}`);
  }
  return r;
}

function cupsToPdf(cups, src, out) {
  const r = spawnSync(cups, [src], { encoding: "buffer", timeout: 120_000 });
  if (r.status !== 0 || !r.stdout?.length) {
    throw new Error(`cupsfilter failed (exit ${r.status}): ${r.stderr?.toString().slice(-400)}`);
  }
  writeFileSync(out, r.stdout);
}

function outPdfPath(file, outDir) {
  return join(outDir, `${basename(file).replace(/\.[^.]+$/, "")}.pdf`);
}

/** Candidate list for one file, ordered: LibreOffice first, macOS-native fallback second. */
function converterCandidates(ext) {
  const cups = cupsfilterBin();
  const textutil = textutilBin();
  return [
    { id: "soffice", platforms: ["darwin", "linux"], available: !!sofficeBin() },
    {
      id: "textutil+cupsfilter",
      platforms: ["darwin"],
      // csv needs only cupsfilter (plain text); the rest go through textutil first
      available: !!cups && NATIVE_TEXT_EXTS.includes(ext) && (ext === "csv" || !!textutil),
    },
  ];
}

function convertWithSoffice(file, outDir) {
  run(sofficeBin(), ["--headless", "--convert-to", "pdf", "--outdir", outDir, file]);
  return outPdfPath(file, outDir);
}

function convertWithNative(file, outDir, ext) {
  const cups = cupsfilterBin();
  const textutil = textutilBin();
  const out = outPdfPath(file, outDir);
  if (ext === "csv") {
    // csv is plain text: cupsfilter renders it straight to PDF
    cupsToPdf(cups, file, out);
    return out;
  }
  const tmpTxt = join(outDir, `.doc2pdf-${process.pid}-${Date.now()}.txt`);
  try {
    run(textutil, ["-convert", "txt", file, "-output", tmpTxt]);
    cupsToPdf(cups, tmpTxt, out);
    return out;
  } finally {
    try {
      unlinkSync(tmpTxt);
    } catch {
      // tmp cleanup is best-effort
    }
  }
}

function main(file, outDir) {
  const ext = validateExt(file);
  if (!ext) {
    console.error(`doc2pdf: extension not allowed for "${basename(file)}".`);
    console.error(`doc2pdf: allowed: ${DOC_EXTS.join(" ")}`);
    process.exit(1);
  }
  if (!existsSync(file)) {
    console.error(`doc2pdf: file not found: ${file}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const conv = pickConverter(process.platform, converterCandidates(ext));
  if (!conv) {
    console.error("doc2pdf: no converter available on this machine.");
    console.error("doc2pdf: install LibreOffice (https://www.libreoffice.org); on macOS doc/docx/rtf/html/csv also work via textutil+cupsfilter.");
    process.exit(1);
  }

  const started = Date.now();
  const out = outPdfPath(file, outDir);
  if (existsSync(out)) {
    console.log(`doc2pdf: overwriting existing ${basename(out)}`);
  }
  let produced;
  try {
    produced = conv.id === "soffice" ? convertWithSoffice(file, outDir) : convertWithNative(file, outDir, ext);
  } catch (e) {
    console.error(`doc2pdf: conversion failed: ${e.message ?? e}`);
    process.exit(1);
  }
  if (!existsSync(produced)) {
    console.error(`doc2pdf: conversion produced no output: ${produced}`);
    process.exit(1);
  }
  if (!hasPdfMagic(readFileSync(produced))) {
    console.error(`doc2pdf: conversion produced an invalid PDF: ${produced}`);
    process.exit(1);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`doc2pdf: ${basename(file)} -> ${basename(produced)} via ${conv.id} (${secs}s)`);
  console.log(`[file: ${resolve(produced)}]`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , file, ...rest] = process.argv;
  if (!file) {
    console.error("usage: doc2pdf.mjs <file> [outdir]");
    process.exit(1);
  }
  main(resolve(file), rest[0] ? resolve(rest[0]) : dirname(resolve(file)));
}
