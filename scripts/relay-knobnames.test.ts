/**
 * P2-263: unknown RELAY_ environment keys are advised at boot instead of
 * being ignored in silence. Covers the pure advisor in apps/relay/src/
 * knobnames.ts (registry completeness, bounded-distance suggestion, sorted
 * deterministic output) and locks the registry against the operator docs
 * docs/RELAY-HOSTING.md in BOTH directions: every knob the relay reads must
 * be documented, and every RELAY_ variable documented in the environment
 * section must be one the relay actually reads — a swapped letter in a
 * deployment can then never drift the code and the docs apart unnoticed.
 * Run: npx tsx scripts/relay-knobnames.test.ts
 */
import { readFileSync } from "node:fs";
import {
  editDistance,
  RELAY_KNOB_NAMES,
  SUGGEST_DISTANCE_MAX,
  unknownRelayKeys,
} from "../apps/relay/src/knobnames";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

// --- 1. registry: sorted, prefix-clean, complete against itself --------------
const sorted = [...RELAY_KNOB_NAMES].sort();
check("registry: stored sorted", sorted.join(",") === RELAY_KNOB_NAMES.join(","));
check("registry: every name carries the RELAY_ prefix", RELAY_KNOB_NAMES.every((n) => n.startsWith("RELAY_")));
check("registry: no duplicates", new Set(RELAY_KNOB_NAMES).size === RELAY_KNOB_NAMES.length);

// --- 2. known environment: no false positives --------------------------------
check("advisor: full registry env yields no unknowns", unknownRelayKeys(RELAY_KNOB_NAMES).length === 0);
check(
  "advisor: non-RELAY_ keys (platform-injected) are ignored",
  unknownRelayKeys(["PORT", "DYNO", "RAILWAY_REPLOYMENT", "npm_config_yes"]).length === 0,
);
check("advisor: empty env yields no unknowns", unknownRelayKeys([]).length === 0);

// --- 3. the task's exact scenario: one swapped letter ------------------------
const typo = unknownRelayKeys(["RELAY_MAX_PER_ROM"]);
check("advisor: swapped-letter key is reported", typo.length === 1 && typo[0].key === "RELAY_MAX_PER_ROM");
check(
  "advisor: swapped-letter key suggests RELAY_MAX_PER_ROOM",
  typo.length === 1 && typo[0].suggestion === "RELAY_MAX_PER_ROOM",
);

// --- 4. suggestion quality ----------------------------------------------------
check(
  "advisor: extra-letter key suggests the trimmed name",
  unknownRelayKeys(["RELAY_WEB_BURSTY"])[0]?.suggestion === "RELAY_WEB_BURST",
);
check(
  "advisor: distance-2 key still suggests (RELAY_MAX_PER_I -> RELAY_MAX_PER_IP)",
  unknownRelayKeys(["RELAY_MAX_PER_I"])[0]?.suggestion === "RELAY_MAX_PER_IP",
);
check(
  "advisor: distance-2 boundary holds (RELAY_MAX_PER is 3 away from RELAY_MAX_PER_IP)",
  unknownRelayKeys(["RELAY_MAX_PER"])[0]?.suggestion === undefined,
);
check("advisor: distance-3 key gets no suggestion", unknownRelayKeys(["RELAY_P"])[0]?.suggestion === undefined);
check("advisor: nonsense key gets no suggestion", unknownRelayKeys(["RELAY_ZZZZZZ"])[0]?.suggestion === undefined);
check(
  "advisor: bare RELAY_ prefix is unknown without suggestion",
  unknownRelayKeys(["RELAY_"]).length === 1 &&
    unknownRelayKeys(["RELAY_"])[0].key === "RELAY_" &&
    unknownRelayKeys(["RELAY_"])[0].suggestion === undefined,
);

// --- 5. deterministic, sorted, deduplicated, non-mutating --------------------
const mixed = ["RELAY_WEB_BURSTY", "RELAY_MAX_PER_ROM", "RELAY_ZZZ", "RELAY_MAX_PER_ROM", "RELAY_PORT"];
const snapshot = [...mixed];
const first = unknownRelayKeys(mixed);
check("advisor: input is not mutated", mixed.join(",") === snapshot.join(","));
check("advisor: duplicate keys collapse to one entry", first.filter((e) => e.key === "RELAY_MAX_PER_ROM").length === 1);
check(
  "advisor: output is sorted by key",
  first.map((e) => e.key).join(",") === "RELAY_MAX_PER_ROM,RELAY_WEB_BURSTY,RELAY_ZZZ",
);
check("advisor: repeated calls are deterministic", JSON.stringify(first) === JSON.stringify(unknownRelayKeys(mixed)));
check(
  "advisor: every suggestion is within the documented distance bound",
  first.every((e) => e.suggestion === undefined || editDistance(e.key, e.suggestion) <= SUGGEST_DISTANCE_MAX),
);

// --- 6. drift-lock: registry vs docs/RELAY-HOSTING.md (both directions) ------
const doc = readFileSync(new URL("../docs/RELAY-HOSTING.md", import.meta.url), "utf8");
const sectionStart = doc.indexOf("## Environment variables");
check("docs: the environment variables section exists", sectionStart !== -1);
const nextHeading = doc.indexOf("\n## ", sectionStart + 1);
check("docs: the environment variables section terminates", nextHeading !== -1);
const section = doc.slice(sectionStart, nextHeading < 0 ? doc.length : nextHeading);
// (?<![A-Z_]) keeps suffix matches like PUBLISH_RELAY_IMAGE out of the set.
const documented = new Set(section.match(/(?<![A-Z_])RELAY_[A-Z]+(?:_[A-Z]+)*/g) ?? []);
check(
  "docs: the section enumerates exactly one entry per registry name",
  documented.size === RELAY_KNOB_NAMES.length,
);
const undocumented = RELAY_KNOB_NAMES.filter((n) => !documented.has(n));
check(
  `docs: every knob the relay reads is documented (missing: ${undocumented.join(", ") || "none"})`,
  undocumented.length === 0,
);
const unread = [...documented].filter((n) => !RELAY_KNOB_NAMES.includes(n));
check(
  `docs: every documented variable is read by the relay (unread: ${unread.join(", ") || "none"})`,
  unread.length === 0,
);

if (failures) process.exit(1);
console.log("relay-knobnames: ALL OK");
process.exit(0);
