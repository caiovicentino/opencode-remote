// P2-231: document→PDF conversion capability. Pure module — no node:fs,
// node:child_process, node:path/os or fetch imports on purpose, because
// index.ts runs main() on import and unit tests must never boot a daemon
// (same pattern as voicecap.ts / opencodebin.ts).
//
// Why this exists: a stage-3 user (docs/VISION.md) sends a .docx from the
// phone exactly as the README promises and used to learn the machine cannot
// convert it only as a raw English terminal error asking for a LibreOffice
// install — mid-conversation, after the wait. On Windows there was no path
// at all: the only known-locations list was macOS-only, and the native
// textutil+cupsfilter fallback exists only on macOS. This module is the
// single source of truth (lesson P2-065) for the converter candidates, their
// per-platform known install locations, the documented preference order and
// the extensions each converter covers. tools/doc2pdf.mjs consumes these
// lists instead of keeping its own, and the daemon probes the candidates
// ONCE at the existing boot-readiness hook so the health payload announces
// the capability BEFORE the user ever sends a document.
//
// Choice rationale:
// - soffice (LibreOffice headless) is the only full-fidelity converter: it
//   keeps formatting of every extension the upload allowlist accepts
//   (docx/doc/rtf/html/csv/xlsx/pptx) and exists on macOS, Windows and
//   Linux — so it always wins wherever it is found.
// - the native textutil+cupsfilter pipeline is macOS-only by definition
//   (both binaries ship with macOS and have no Windows/Linux builds); it
//   normalizes doc/docx/rtf/html to text and prints csv straight through,
//   losing formatting — so it is a partial, darwin-only fallback.

export type DocConvertState = "complete" | "partial" | "unavailable";

export interface DocConvertVerdict {
  state: DocConvertState;
  /** Extensions effectively covered — documented order, no repetitions. */
  exts: string[];
  /** Short actionable pt-BR sentence — never a path, URL scheme or secret. */
  message: string;
}

/** Raw probe result for each converter candidate (true = found on disk). */
export interface DocConvertProbe {
  soffice: boolean;
  textutil: boolean;
  cupsfilter: boolean;
}

/** Every extension the full-fidelity converter covers (the upload allowlist). */
export const SOFFICE_EXTS: string[] = ["docx", "doc", "rtf", "html", "csv", "xlsx", "pptx"];

/** Extensions the native macOS pipeline covers (formatting is not preserved). */
export const NATIVE_EXTS: string[] = ["doc", "docx", "rtf", "html", "csv"];

/**
 * Known install locations per Node platform, in preference order. Linux has
 * no standard location worth naming — there the PATH lookup in
 * tools/doc2pdf.mjs remains the discovery mechanism.
 */
export const SOFFICE_PATHS: Record<string, string[]> = {
  darwin: ["/Applications/LibreOffice.app/Contents/MacOS/soffice"],
  win32: [
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
  ],
  linux: [],
};

/** Native pipeline candidates — macOS-only, so other platforms stay empty. */
export const TEXTUTIL_PATHS: Record<string, string[]> = {
  darwin: ["/usr/bin/textutil"],
  win32: [],
  linux: [],
};

export const CUPSFILTER_PATHS: Record<string, string[]> = {
  darwin: ["/usr/sbin/cupsfilter", "/usr/bin/cupsfilter"],
  win32: [],
  linux: [],
};

/** Documented preference order: full fidelity first, native fallback second. */
export const CONVERTER_PREFERENCE: string[] = ["soffice", "native"];

const COMPLETE_MESSAGE = "Conversão de documentos em PDF pronta neste computador.";
const PARTIAL_MESSAGE =
  "A conversão de documentos neste computador cobre apenas alguns formatos — instale o LibreOffice para converter qualquer documento em PDF.";
const UNAVAILABLE_MESSAGE =
  "Este computador ainda não converte documentos em PDF — peça a quem gerencia a máquina para instalar o LibreOffice.";

/**
 * Build the raw probe from an injected existence check, so the caller (index.ts
 * at boot, tools/doc2pdf.mjs at conversion time) keeps all real I/O on its side.
 */
export function docConvertProbe(platform: string, exists: (path: string) => boolean): DocConvertProbe {
  const paths = (list: Record<string, string[]>) => list[platform] ?? [];
  return {
    soffice: paths(SOFFICE_PATHS).some((p) => exists(p)),
    textutil: paths(TEXTUTIL_PATHS).some((p) => exists(p)),
    cupsfilter: paths(CUPSFILTER_PATHS).some((p) => exists(p)),
  };
}

/** Dedupe preserving the documented declaration order (already sorted lists). */
function dedupe(exts: string[]): string[] {
  return [...new Set(exts)];
}

/**
 * Resolve the document-conversion capability from the platform and the
 * already-probed candidate results. Rules, in THIS order:
 * 1. a full-fidelity converter (soffice) present wins always and covers every
 *    documented extension — on any platform;
 * 2. the native candidate is declared macOS-only: on any other platform it is
 *    IGNORED even when the probe reports it present, because that pipeline
 *    does not exist there (textutil/cupsfilter have no Windows or Linux
 *    builds) and promising it would end in the raw error this module kills;
 * 3. only the native pipeline present (macOS) is partial, with the exact
 *    extension list it covers;
 * 4. nothing usable is unavailable, with one short pt-BR sentence saying
 *    what to install — no absolute path, no URL scheme, no secret.
 */
export function docConvertVerdict(platform: string, probed: DocConvertProbe): DocConvertVerdict {
  if (probed.soffice) {
    return { state: "complete", exts: dedupe(SOFFICE_EXTS), message: COMPLETE_MESSAGE };
  }
  if (platform === "darwin" && probed.textutil && probed.cupsfilter) {
    return { state: "partial", exts: dedupe(NATIVE_EXTS), message: PARTIAL_MESSAGE };
  }
  return { state: "unavailable", exts: [], message: UNAVAILABLE_MESSAGE };
}
