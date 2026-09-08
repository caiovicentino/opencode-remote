#!/usr/bin/env node
/**
 * P2-216: the release page a stage-5 user opens must answer "which file is
 * mine" — but the auto-generated body (draft created by the release job with
 * `--generate-notes`) is a wall of pilot commit titles. This module writes the
 * download guide into the release body before it goes public:
 *
 *   - downloadGuide(tag, assets) → the guide text in Portuguese plus every
 *     problem at once (same all-at-once string[] format as
 *     scripts/release-assets.ts): one line per audience (Mac com Apple
 *     Silicon, Mac com Intel, Windows) carrying the EXACT file name taken
 *     from the published asset list — never an invented name — plus the
 *     first-open warning (signing not configured yet) and the checksums.txt
 *     how-to. One problem per audience whose installer is absent, one for a
 *     missing checksums.txt, one for an empty asset list and one for an
 *     invalid tag — no short-circuit, the operator sees everything at once.
 *   - applyGuide(body, guide)   → the body with the guide between the
 *     documented markers (GUIDE_START/GUIDE_END) replaced when the block
 *     already exists, or inserted ABOVE the body when it does not — every
 *     byte outside the block is preserved, so re-running the step is
 *     idempotent and never duplicates the guide nor eats the generated notes.
 *
 * CLI (same fail-closed pattern as release-assets, release-publish and
 * release-checksums): reads the tag, the asset-name list and the current body
 * from paths passed as arguments, prints one line per problem, exits 1 when
 * ANY problem exists and only then rewrites the body file with the guide
 * applied. No new dependencies, no network.
 *
 * Run: gh release view "$GITHUB_REF_NAME" --json assets --jq '.assets[].name' > guide-assets.txt
 *      gh release view "$GITHUB_REF_NAME" --json body --jq '.body' > guide-body.md
 *      npx tsx scripts/release-notes.ts "$GITHUB_REF_NAME" guide-assets.txt guide-body.md
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { assetMatches, bareVersion, tagProblems, type AssetMatch } from "./release-assets";
import { MANIFEST_NAME } from "./release-checksums";

/** Documented delimiters of the guide block inside the release body. */
export const GUIDE_START = "<!-- download-guide:start -->";
export const GUIDE_END = "<!-- download-guide:end -->";

/** One audience line of the guide: who it is for and which file satisfies it. */
interface GuideSlot {
  /** Audience name, in Portuguese, printed verbatim in the guide line. */
  audience: string;
  /** Instruction for the audience once the file is identified. */
  hint: string;
  /** Matching rule (release-assets.ts shapes) for this audience's installer. */
  match: AssetMatch;
  /** Human description of the expected file, for the missing-asset problem. */
  expected: string;
}

/** The three audiences a download page must serve, with version-boundary
 * matching identical in discipline to scripts/release-assets.ts (by import,
 * never a copy). An unknown tag yields rules that match nothing — every
 * audience is then reported missing, all problems at once. */
export function guideSlots(tag: string): GuideSlot[] {
  const version = bareVersion(tag);
  return [
    {
      audience: "Mac com Apple Silicon",
      hint: "baixe o instalador, abra o DMG e arraste o app para Aplicativos",
      match: { kind: "extension+version+arch", ext: ".dmg", version, arch: "arm64" },
      expected: `a .dmg carrying ${version} and arm64`,
    },
    {
      audience: "Mac com Intel",
      hint: "baixe o instalador, abra o DMG e arraste o app para Aplicativos",
      match: { kind: "extension+version+arch", ext: ".dmg", version, arch: "x64" },
      expected: `a .dmg carrying ${version} and x64`,
    },
    {
      audience: "Windows",
      hint: "baixe o instalador e execute-o",
      match: { kind: "extension+version", ext: ".exe", version },
      expected: `a Windows NSIS setup .exe carrying ${version}`,
    },
  ];
}

/** First-open warning: the release may ship unsigned (no secrets configured). */
const FIRST_OPEN_LINE =
  '> **Primeira abertura no macOS:** enquanto a assinatura de desenvolvedor não estiver configurada, o macOS pode avisar que o app é de um "desenvolvedor não identificado". Clique com o botão direito no app e escolha **Abrir** — só na primeira vez.';

/** How to verify a download against the checksum manifest. */
function checksumLine(): string {
  return (
    `**Conferindo o download:** o release publica \`${MANIFEST_NAME}\` com o hash SHA-256 de cada arquivo; ` +
    `confira com \`shasum -a 256 -c ${MANIFEST_NAME}\` (macOS), \`sha256sum -c ${MANIFEST_NAME}\` (Linux) ` +
    `ou \`Get-FileHash <arquivo> -Algorithm SHA256\` (Windows PowerShell). ` +
    "Hash divergente: não abra o arquivo — baixe de novo."
  );
}

/**
 * The download guide for `tag` against the published `assets` list, plus every
 * problem at once. The guide never names a file that is not in the list: an
 * audience whose installer is absent becomes a problem, not an invented name.
 */
export function downloadGuide(
  tag: string,
  assets: readonly string[],
): { guide: string; problems: string[] } {
  const problems: string[] = [...tagProblems(tag)];
  if (assets.length === 0) {
    problems.push("asset list is empty — the guide cannot name any download");
  }
  const lines: string[] = ["## Qual arquivo baixar", ""];
  for (const slot of guideSlots(tag)) {
    const found = assets.find((name) => assetMatches({ label: slot.audience, match: slot.match }, name));
    if (found === undefined) {
      problems.push(
        `missing: download for ${slot.audience} — expected ${slot.expected}, none found in the asset list`,
      );
      continue;
    }
    lines.push(`- **${slot.audience}:** ${slot.hint} — \`${found}\`.`);
  }
  const hasManifest = assets.includes(MANIFEST_NAME);
  if (!hasManifest) {
    problems.push(
      `missing: ${MANIFEST_NAME} — the guide's integrity-check line points at a file that is not attached`,
    );
  }
  lines.push("");
  lines.push(FIRST_OPEN_LINE);
  if (hasManifest) {
    lines.push("");
    lines.push(checksumLine());
  }
  return { guide: lines.join("\n"), problems };
}

/**
 * Body with the guide applied: the block between the documented markers is
 * replaced in place when it already exists; otherwise the block is inserted
 * ABOVE the body. Everything outside the block is preserved byte-by-byte, so
 * applying the same guide twice yields the same text (idempotent) and the
 * auto-generated notes are never deleted.
 */
export function applyGuide(body: string, guide: string): string {
  const block = `${GUIDE_START}\n${guide}\n${GUIDE_END}`;
  const start = body.indexOf(GUIDE_START);
  const end = start === -1 ? -1 : body.indexOf(GUIDE_END, start);
  if (start !== -1 && end !== -1) {
    return body.slice(0, start) + block + body.slice(end + GUIDE_END.length);
  }
  if (body.length === 0) return block + "\n";
  return block + "\n\n" + body;
}

function cli(argv: readonly string[]): void {
  const tag = argv[0] ?? "";
  const assetsPath = argv[1] ?? "";
  const bodyPath = argv[2] ?? "";
  if (tag === "" || assetsPath === "" || bodyPath === "") {
    console.error(
      "release-notes: usage: tsx scripts/release-notes.ts <tag> <assets.txt> <body.md>\n" +
        "  (assets.txt: one published asset name per line, from\n" +
        "   `gh release view --json assets --jq '.assets[].name'`;\n" +
        "   body.md: the current release body, rewritten in place on success)",
    );
    process.exitCode = 1;
    return;
  }
  let assetsRaw: string;
  let body: string;
  try {
    assetsRaw = readFileSync(assetsPath, "utf8");
  } catch (err) {
    console.error(`release-notes: cannot read the asset list — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  try {
    body = readFileSync(bodyPath, "utf8");
  } catch (err) {
    console.error(`release-notes: cannot read the release body — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  // Line-based, like release-assets.ts: GitHub asset names contain spaces
  // ("OpenCode Remote Setup 0.2.0.exe"), whitespace-splitting would shred them.
  const assets = assetsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const { guide, problems } = downloadGuide(tag, assets);
  if (problems.length > 0) {
    console.error(`release-notes: FAIL ${tag}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`release-notes: ${problems.length} problem(s) found — the release stays a draft`);
    process.exitCode = 1;
    return;
  }
  try {
    writeFileSync(bodyPath, applyGuide(body, guide), "utf8");
  } catch (err) {
    console.error(`release-notes: cannot write the release body — ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`release-notes: OK ${tag} — download guide applied to ${bodyPath}`);
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
