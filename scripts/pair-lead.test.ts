/**
 * P3-415 (eval-09): one accent-filled action per pairing-ceremony render.
 * The fleet ping-ponged this screen: P3-415 demoted the desktop paste submit
 * to a recessed --bg chip so the host card would lead (it read as a disabled
 * ghost), P3-433 reverted to the accent fill everywhere (the host card went
 * back to a plain row under a green submit, and the agent-down ceremony grew
 * two green CTAs — the full-width submit out-shouting the reconnect its own
 * copy names first). lib/pairlead.ceremonyLead now decides the ONE lead per
 * render (PRODUCT.md: accent = the screen's highest action) and PairingView
 * paints from it: the lead wears the accent, the desktop submit off-lead is a
 * solid secondary (surface, firm border, full-contrast semibold label).
 * The live paint (computed styles) is pinned by the P3-415 beats in
 * scripts/desktop-flow.test.ts; this file pins the verdict and the wiring.
 * Run: npx tsx scripts/pair-lead.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ceremonyLead, type CeremonyShape } from "../apps/web/src/lib/pairlead";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// --- the verdict, per real render shape --------------------------------------
const shapes: Array<[string, CeremonyShape, string]> = [
  // first boot, manual escape with the local agent down (P3-427/P3-443)
  ["desktop agent-down ceremony with the restart bridge", { preferPaste: true, hostEntry: false, reconnect: true }, "reconnect"],
  // add machine (paired shell, live daemon): host entry on screen (P3-334)
  ["desktop add-machine ceremony (host entry on screen)", { preferPaste: true, hostEntry: true, reconnect: false }, "host"],
  // agent down but the verdict card yielded to the App-level error block, or
  // no restart bridge: the paste form is the sole path (P3-433's case)
  ["desktop ceremony where the paste form is the sole path", { preferPaste: true, hostEntry: false, reconnect: false }, "paste"],
  // the phone leads with the scanner (P2-117), untouched
  ["phone ceremony (scan-first)", { preferPaste: false, hostEntry: false, reconnect: false }, "scan"],
  // never rendered together today (the agent-down state hides the host
  // entry) — the order keeps the verdict total: the fix for the cause wins
  ["totality: reconnect and host at once", { preferPaste: true, hostEntry: true, reconnect: true }, "reconnect"],
];
for (const [name, shape, want] of shapes) {
  const got = ceremonyLead(shape);
  check(`ceremonyLead: ${name} → ${want}`, got === want, `got ${got}`);
}

// --- PairingView paints from the verdict it renders from ----------------------
const web = join(import.meta.dirname, "..", "apps", "web", "src");
const view = readFileSync(join(web, "components", "PairingView.tsx"), "utf8");
check(
  "PairingView: the verdict reads the same booleans that gate the renders",
  view.includes("const hostEntry = !!onPairRemote && !agentDown;") &&
    view.includes('const agentDownCard = !!agentDown && phase !== "error";') &&
    view.includes("const lead = ceremonyLead({ preferPaste: !!preferPaste, hostEntry, reconnect: agentDownCard && !!reconnect });") &&
    view.includes("const hostSection = hostEntry && (") &&
    view.includes("{agentDownCard && ("),
);
check(
  "PairingView: the desktop submit wears `primary` only as the lead, `secondary` otherwise",
  view.includes('const submitClass = !preferPaste ? "pair-submit" : lead === "paste" ? "pair-submit primary" : "pair-submit secondary";') &&
    view.includes("className={submitClass}") &&
    !view.includes('className={preferPaste ? "pair-submit primary" : "pair-submit"}'),
);
check(
  "PairingView: the lead host section carries the accent mark (phone tile, aria-hidden)",
  view.includes('className={lead === "host" ? "pair-section pair-section-lead" : "pair-section"}') &&
    /<button className="pair-remote-entry"[^>]*>\s*<span className="pair-remote-icon" aria-hidden="true">\s*<IconPhone \/>/.test(view),
);
check(
  "PairingView: the agent-down reconnect keeps the shared accent primary (P3-443/P3-450)",
  view.includes('<ReconnectButton className="primary pair-agent-down-reconnect" reconnect={reconnect} />'),
);
check(
  "PairingView: the scanner wears the accent only as the lead (the phone's scan-first, P2-117)",
  view.includes('className={lead === "scan" ? "primary pair-scan-entry" : "pair-scan-entry"}') &&
    !view.includes('className={preferPaste ? "pair-scan-entry" : "primary pair-scan-entry"}'),
);
// Every accent owner in the view is gated by the lead verdict (or is the
// agent-down reconnect, which only renders when it IS the lead on the
// desktop): no other element may carry the shared `primary` class.
const primaryClassUses = (view.match(/"[^"\n]*\bprimary\b[^"\n]*"/g) ?? []).sort();
check(
  "PairingView: `primary` appears only on the lead-gated submit/scan and the agent-down reconnect",
  JSON.stringify(primaryClassUses) ===
    JSON.stringify(['"pair-submit primary"', '"primary pair-agent-down-reconnect"', '"primary pair-scan-entry"']),
  JSON.stringify(primaryClassUses),
);

// --- CSS: the secondary reads enabled, the accent lives on the lead only ------
const css = readFileSync(join(web, "index.css"), "utf8");
const rule = (sel: string): string => {
  const at = css.indexOf(`\n${sel} {`);
  if (at === -1) return "";
  return css.slice(at, css.indexOf("}", at) + 1);
};
const secondary = rule(".pair-submit.secondary");
check(
  "CSS: .pair-submit.secondary is the solid secondary (surface, firm border, full-contrast semibold)",
  /background:\s*var\(--surface\)/.test(secondary) &&
    /border:\s*1px solid var\(--border-strong\)/.test(secondary) &&
    /color:\s*var\(--text\)/.test(secondary) &&
    /font-weight:\s*600/.test(secondary),
  secondary,
);
check(
  "CSS: the secondary is never the P3-433 ghost (no recessed --bg, no opacity, no accent)",
  !!secondary && !/var\(--bg\)/.test(secondary) && !/opacity/.test(secondary) && !/var\(--accent\)/.test(secondary),
);
check("CSS: the secondary has a hover fill (reads as a live control)", /background:\s*var\(--gray-hover\)/.test(rule(".pair-submit.secondary:hover")));
check("CSS: no one-off override of the shared primary (P3-433 invariant)", !/\.pair-submit\.primary\s*\{/.test(css));
const tileBase = rule(".pair-remote-icon");
const tileLead = rule(".pair-section-lead .pair-remote-icon");
check(
  "CSS: the phone tile wears the accent only inside the lead section",
  !!tileBase && !/var\(--accent\)/.test(tileBase) && /background:\s*var\(--accent\)/.test(tileLead) && /color:\s*var\(--on-accent\)/.test(tileLead),
);
// The compound selector matters: the base .pair-section card rule is declared
// later in the sheet with the same single-class weight and would win.
check("CSS: the lead section takes an accent edge (compound selector outranks .pair-section)", /border-color:\s*color-mix\(in srgb, var\(--accent\)/.test(rule(".pair-section.pair-section-lead")));
// Settings' host entry keeps its quiet row — the lead chrome is ceremony-only.
const settings = readFileSync(join(web, "components", "SettingsView.tsx"), "utf8");
check("scope: Settings renders none of the ceremony lead chrome", !settings.includes("pair-section-lead") && !settings.includes("pair-remote-icon"));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall pair-lead checks passed");
