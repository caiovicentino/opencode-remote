/**
 * eval-11: owner consent before an opencode-remote://pair link reaches the
 * renderer (apps/desktop/src/deeplinkconsent.ts + the main.ts wiring).
 *
 * Red-team finding routed by eval-15: main.ts forwarded every well-formed pair
 * link straight to the renderer, whose "only while unpaired" guard reads the
 * persisted pairing — local mode persists none — so one click on a web page's
 * link re-paired a running desktop to the attacker's daemon and relay. The
 * shell now names the machine and relay host and waits for an explicit
 * "Pair" (Cancel is the default). Pure checks + the real main.ts wiring.
 *
 * Run: npx tsx scripts/deeplinkconsent.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEEP_LINK_BUTTON_INDEX,
  DEEP_LINK_CONSENT_REASONS,
  DEEP_LINK_FACT_MAX,
  deepLinkConsentPlan,
  deepLinkFacts,
  deepLinkPrompt,
} from "../apps/desktop/src/deeplinkconsent";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const KEY = "QkVJTkctU0VDUkVULUtFWS1NQVRFUklBTA%3D%3D";
const evil =
  "opencode-remote://pair?v=2&relay=wss%3A%2F%2Fevil.example%3A443%2Fws&room=R00M&k=" +
  KEY +
  "&vapid=VAPID&name=Mac%20do%20Caio";

// --- 1. the facts the owner sees ------------------------------------------------
{
  const f = deepLinkFacts(evil);
  check("facts: the machine name is decoded like parsePairingUri", f.machine === "Mac do Caio");
  check("facts: the relay is reduced to its host (and port)", f.relayHost === "evil.example");
  check("facts: no key material ever enters the facts", !JSON.stringify(f).includes("QkVJTkc") && !JSON.stringify(f).includes("R00M"));
  const spoof = deepLinkFacts("opencode-remote://pair?v=2&relay=wss%3A%2F%2Fr.example%3A8788&name=Mac%E2%80%AE%0Adoc");
  check("facts: control characters and bidi overrides are stripped", spoof.machine === "Macdoc" && spoof.relayHost === "r.example:8788");
  const long = deepLinkFacts(`opencode-remote://pair?v=2&name=${"a".repeat(300)}`);
  check("facts: an oversize name is capped", long.machine.length === DEEP_LINK_FACT_MAX && long.machine.endsWith("…"));
  const broken = deepLinkFacts("opencode-remote://pair?v=2&name=%E0%A4%A&relay=not-a-url");
  check("facts: malformed escapes and relay degrade to empty, never throw", broken.machine === "" && broken.relayHost === "");
  check("facts: a link without query yields empty facts", JSON.stringify(deepLinkFacts("opencode-remote://pair")) === JSON.stringify({ machine: "", relayHost: "" }));
}

// --- 2. the plan (rule order) ----------------------------------------------------
{
  check("plan: a real session always asks", deepLinkConsentPlan({ harnessSession: false, hatchAnswer: "pair" }).action === "ask");
  const hatchPair = deepLinkConsentPlan({ harnessSession: true, hatchAnswer: "pair" });
  check("plan: harness + hatch pair → accept", hatchPair.action === "accept" && "reason" in hatchPair && hatchPair.reason === DEEP_LINK_CONSENT_REASONS.hatchPair);
  const hatchCancel = deepLinkConsentPlan({ harnessSession: true, hatchAnswer: "cancel" });
  check("plan: harness + hatch cancel → refuse", hatchCancel.action === "refuse" && "reason" in hatchCancel && hatchCancel.reason === DEEP_LINK_CONSENT_REASONS.hatchCancel);
  const harness = deepLinkConsentPlan({ harnessSession: true, hatchAnswer: undefined });
  check("plan: harness without hatch → refuse (a gate run is never paired by a link it did not ask for)", harness.action === "refuse");
  check("plan: an unknown hatch value is not consent", deepLinkConsentPlan({ harnessSession: true, hatchAnswer: "yes" }).action === "refuse");
  check("plan: reasons are static (no URI, host or machine)", Object.values(DEEP_LINK_CONSENT_REASONS).every((r) => !/:\/\/|\.example|Caio/.test(r)));
}

// --- 3. the dialog vocabulary ------------------------------------------------------
{
  const f = deepLinkFacts(evil);
  const pt = deepLinkPrompt(f, "pt");
  const en = deepLinkPrompt(f, "en");
  check("prompt: pt names the machine and the relay host", pt.message.includes("Mac do Caio") && pt.detail.includes("evil.example"));
  check("prompt: en names the machine and the relay host", en.message.includes("Mac do Caio") && en.detail.includes("evil.example"));
  check("prompt: pt/en buttons", pt.confirm === "Parear" && pt.cancel === "Cancelar" && en.confirm === "Pair" && en.cancel === "Cancel");
  check("prompt: the dialog never carries key material", !JSON.stringify([pt, en]).includes("QkVJTkc"));
  const unnamed = deepLinkPrompt({ machine: "", relayHost: "" }, "pt");
  check("prompt: empty facts still read as a sentence", unnamed.message.includes("sem nome") && unnamed.detail.includes("desconhecido"));
  check("prompt: Cancel is a distinct button index", DEEP_LINK_BUTTON_INDEX.cancel !== DEEP_LINK_BUTTON_INDEX.confirm);
}

// --- 4. the real main.ts wiring ------------------------------------------------------
{
  const main = readFileSync(join(import.meta.dirname, "..", "apps", "desktop", "src", "main.ts"), "utf8");
  const handle = main.slice(main.indexOf("function handleDeepLink("), main.indexOf("function forwardDeepLink("));
  check("wiring: handleDeepLink itself never pushes to a window or fills the late-pull cache", !handle.includes('send("ocr:deep-link"') && !handle.includes("lastDeepLink = uri"));
  check(
    "wiring: before ready the link waits; after ready it asks for consent",
    /if \(!app\.isReady\(\)\) \{\s*\n\s*pendingDeepLink = uri;\s*\n\s*return;\s*\n\s*\}\s*\n\s*void consentDeepLink\(uri\);/.test(handle),
  );
  check("wiring: exactly one push of ocr:deep-link exists (forwardDeepLink)", (main.match(/send\("ocr:deep-link"/g) ?? []).length === 1);
  const consent = main.slice(main.indexOf("async function consentDeepLink("), main.indexOf("// --- first-run pairing watcher"));
  const forwards = consent.match(/forwardDeepLink\(uri\)/g) ?? [];
  check("wiring: consent forwards in exactly two places — the plan's accept and the owner's confirm", forwards.length === 2);
  check(
    "wiring: the owner's confirm is the only interactive path to forward",
    /if \(response === DEEP_LINK_BUTTON_INDEX\.confirm\) \{[\s\S]{0,160}?forwardDeepLink\(uri\);/.test(consent),
  );
  check(
    "wiring: Cancel is both the default and the Escape answer",
    consent.includes("defaultId: DEEP_LINK_BUTTON_INDEX.cancel,") && consent.includes("cancelId: DEEP_LINK_BUTTON_INDEX.cancel,"),
  );
  check("wiring: the harness rule is consulted before any dialog", consent.indexOf("deepLinkConsentPlan(") < consent.indexOf("dialog.showMessageBox"));
  const flushAt = main.indexOf("if (pendingDeepLink !== null) {");
  check(
    "wiring: onReady flushes a pending link right after the first window exists",
    flushAt > main.indexOf('createWindow({ bootHidden: launchVerdict.action === "tray" });') && flushAt < main.indexOf("startPairingWatcher();\n  // P2-209"),
  );
  check("wiring: a pending invite still counts as a cold deep link for the login-launch plan", main.includes("coldDeepLink: pendingDeepLink !== null || lastDeepLink !== null,"));
  const logs = consent.match(/^\s*log\([^\n]*$/gm) ?? [];
  check("wiring: consent log lines never interpolate the URI", logs.length >= 3 && logs.every((l) => !/\$\{uri|\$\{raw|\+\s*uri/.test(l)));
}

console.log(failures === 0 ? "\ndeeplinkconsent: all green" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
