/**
 * P3-452: pane chrome speaks ONE icon language. The rail draws its icons
 * from icons.tsx (P2-055, lucide-style SVG), but pane headers still rendered
 * bare text glyphs — "←", "↻", "⤢", "→", "≡" — so the same journey showed
 * both dialects side by side (explorer shot journey-artifact-pane-20260922),
 * which reads as unfinished. Header actions (back, refresh, maximize/restore,
 * go, toggle-text) now reuse the shared SVG set; this pin keeps the glyph
 * dialect from creeping back into the pane files, comments excluded (the
 * arrow characters are legitimate prose inside review notes).
 * P3-437: the last glyph controls joined the set — FileCard's fullscreen
 * viewer header ("← Chat") and copy-path action ("⧉"), the dismiss ✕/× in
 * FilesView/SettingsView/ScreenFlash/ChatView — so those glyphs join the
 * pin alongside the pane files.
 * Run: npx tsx scripts/pane-icons.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const web = join(import.meta.dirname, "..", "apps", "web", "src");

// every pane whose header renders chrome buttons — the surfaces the rail
// sits beside (P3-384's pane-title census, plus the artifact viewer header
// and P3-437's file-card viewer header)
const panes = [
  "ArtifactsView.tsx",
  "BrowserView.tsx",
  "MissionControlView.tsx",
  "FilesView.tsx",
  "SettingsView.tsx",
  "SendToAgentView.tsx",
  "QrScanner.tsx",
  "ArtifactViewer.tsx",
  "FileCard.tsx",
];

const glyphs = ["←", "↻", "⤢", "⤡", "→", "≡", "✕", "×", "⧉"];
for (const pane of panes) {
  const lines = readFileSync(join(web, "components", pane), "utf8").split("\n");
  const offenders = lines
    .map((l, i) => ({ l: l.trim(), n: i + 1 }))
    .filter(
      ({ l }) =>
        glyphs.some((g) => l.includes(g)) &&
        !l.startsWith("//") &&
        !l.startsWith("*") &&
        !l.startsWith("/*"),
    )
    .map(({ l, n }) => `${pane}:${n} ${l.slice(0, 80)}`);
  check(`${pane}: pane chrome uses the SVG icon set (no bare glyphs)`, offenders.length === 0, offenders.join("\n   "));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pane-icons checks passed");
