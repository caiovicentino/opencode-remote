/**
 * P2-336: red-team findings used to reach BACKLOG.md as raw multiline text —
 * addTask interpolated the summary directly, so only the first line became
 * the spec while the rest spilled into ## Ready as loose paragraphs (the
 * finding's own content was effectively lost), and the line carried no area
 * tag so the scheduler could never place it. This module is the ONLY path an
 * agent finding's text takes into a task line: pure, deterministic — the same
 * input always yields the same output — and deliberately free of node:fs,
 * network and process imports so the battery can pin every rule.
 */

/** Documented ceiling for the flattened spec text (same cut the old flow used). */
export const FINDING_SPEC_MAX = 600;

/** Title ceiling — keeps the task line scannable in the backlog (parity with
 * the explorer/fable parsers, which cap titles at 120 chars). */
export const FINDING_TITLE_MAX = 120;

/** Stable reserve sentence when nothing useful survives normalization: a
 * malformed finding must never become an empty spec line. Deliberately free
 * of the validator's banned characters, so the fallback line itself is a
 * valid task line. */
export const FINDING_SPEC_FALLBACK =
  "Security finding reported by the nightly red team (details were lost in normalization).";

/** Stable reserve area (documented): the product premise centers on the
 * desktop shell, so a finding that names no known surface defaults there —
 * an untagged line is useless (the task-line validator refuses it). */
export const FINDING_AREA_FALLBACK = "desktop";

/** One keyword row of the area table. */
export interface FindingAreaRule {
  area: string;
  keywords: readonly string[];
}

/**
 * Keyword table for findingArea. Precedence is ROW ORDER: the first row with
 * any keyword hit wins a multi-area tie, so constitution-critical surfaces
 * (relay E2E crypto, daemon auth) rank before app-shell, UI and pipeline.
 * Matching is word-bounded and case-insensitive — "web" never matches inside
 * another token like "webhook".
 */
export const FINDING_AREA_TABLE: readonly FindingAreaRule[] = [
  {
    area: "relay",
    keywords: [
      "relay", "frame", "replay", "handshake", "downgrade", "websocket", "e2e",
      "crypto", "encrypt", "encrypted", "encryption", "decrypt", "seal", "nonce", "aad",
    ],
  },
  {
    area: "daemon",
    keywords: [
      "daemon", "permission", "traversal", "path traversal", "allowlist", "allow-list",
      "unix socket", "socket", "port", "handoff", "sandbox", "artifact", "artifacts",
      "path", "filesystem", "upload",
    ],
  },
  {
    area: "desktop",
    keywords: [
      "desktop", "electron", "window", "main process", "ipc", "keeper", "tray",
      "updater", "single instance", "appimage", "dmg",
    ],
  },
  {
    area: "ui",
    keywords: [
      "ui", "pwa", "web", "chat", "markdown", "xss", "dom", "composer", "message",
      "notification", "spoof", "browser", "frontend", "css", "html", "iframe", "webview",
    ],
  },
  {
    area: "infra",
    keywords: [
      "pipeline", "deploy", "gate", "backlog", "build", "invariant", "script",
      "npm", "dependency", "supply", "workspace", "slot", "scheduler", "workflow",
    ],
  },
];

/** Word-bounded, case-insensitive test for one keyword inside the text. */
function hasKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

/** Flatten one finding text to a single clean line WITHOUT any fallback. */
function normalizeOneLine(raw: string): string {
  return raw
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, " ")
    .replace(/[;`&|<>$]/g, " ")
    .replace(/\b(?:curl|wget)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Flatten the whole finding into ONE line: newline and control characters
 * become spaces, the metacharacters (and command verbs) the task-line
 * validator rejects are removed, repeated whitespace collapses, the text is
 * cut at the documented ceiling, and a stable reserve sentence is returned
 * when nothing useful remains.
 */
export function normalizeFindingSpec(raw: string): string {
  const one = normalizeOneLine(raw).slice(0, FINDING_SPEC_MAX);
  return one.length > 0 ? one : FINDING_SPEC_FALLBACK;
}

/**
 * Short title for the finding: taken from the `Title:` field when present
 * (markdown bold decorations tolerated), normalized with the same rules as
 * the spec and capped at FINDING_TITLE_MAX; otherwise the dated fallback the
 * flow always used. Never empty.
 */
export function findingTitle(raw: string, today: string): string {
  for (const line of raw.split("\n")) {
    const bare = line.replace(/\*\*/g, "").trim();
    const m = /^[^\p{L}\d]*title\s*:\s*(.+)$/iu.exec(bare);
    const candidate = m?.[1] ? normalizeOneLine(m[1]).slice(0, FINDING_TITLE_MAX) : "";
    if (candidate) return candidate;
  }
  return `Redteam finding ${today}`;
}

/**
 * Pick EXACTLY ONE known area for the finding: the first table row with a
 * keyword hit (precedence = row order), else the stable reserve area.
 */
export function findingArea(raw: string): string {
  for (const rule of FINDING_AREA_TABLE) {
    if (rule.keywords.some((k) => hasKeyword(raw, k))) return rule.area;
  }
  return FINDING_AREA_FALLBACK;
}

/** The three task-line parts composed from one raw agent finding. */
export interface FindingLineParts {
  title: string;
  spec: string;
  area: string;
}

/**
 * Compose title, spec and area from one raw finding text — the single path
 * the redteam flow in index.ts uses; nothing else interpolates agent text
 * into the backlog line.
 */
export function redteamFinding(raw: string, today: string): FindingLineParts {
  return {
    title: findingTitle(raw, today),
    spec: normalizeFindingSpec(raw),
    area: findingArea(raw),
  };
}
