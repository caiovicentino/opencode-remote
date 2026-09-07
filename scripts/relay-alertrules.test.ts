/**
 * P2-320: relay alert rules — the closed rule set, its deterministic
 * Prometheus serialization and the verifier's cause table. Covers each
 * verifier cause with valid, absent, degenerate and duplicate input, the
 * no-short-circuit fixed problem order, determinism across calls, the
 * byte-for-byte pin of deploy/relay/alerts.yml to the serializer, the
 * fail-closed check that every rule observes a series the real
 * apps/relay/src/index.ts actually emits, the symptom-phrase boundary and
 * the purity of the module itself.
 * Run: npx tsx scripts/relay-alertrules.test.ts
 */
import { readFileSync } from "node:fs";
import {
  ALERT_SEVERITIES,
  alertRuleProblems,
  alertRules,
  serializeAlertRules,
} from "../apps/relay/src/alertrules";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail !== undefined) console.log(`     ${String(detail)}`);
  }
}

// --- fixtures -----------------------------------------------------------------
const BASE = {
  alert: "TestAlert",
  series: "relay_frames_routed",
  expr: "relay_frames_routed > 0",
  for: "5m",
  severity: "warning",
  symptom: "Frase de sintoma curta.",
};
function rule(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ...BASE, ...overrides };
}
function without(field: keyof typeof BASE): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...BASE };
  delete copy[field];
  return copy;
}
const causeOf = (problems: readonly string[]) => problems.join(" | ");

// --- 1. the closed set is valid and clean ------------------------------------
const closed = alertRules();
check(
  "closed set: every rule passes the verifier with zero problems",
  alertRuleProblems(closed).length === 0,
  causeOf(alertRuleProblems(closed)),
);
check(
  "closed set: severity vocabulary is exactly critical|warning",
  JSON.stringify([...ALERT_SEVERITIES]) === JSON.stringify(["critical", "warning"]),
);
check(
  "closed set: every rule severity comes from the closed vocabulary",
  closed.every((r) => (ALERT_SEVERITIES as readonly string[]).includes(r.severity)),
);
check(
  "closed set: every expr is written in terms of the series it observes",
  closed.every((r) => r.expr.includes(r.series)),
);

// --- 2. cause: rule without symptom phrase ------------------------------------
const phraseProblems = (entry: unknown) =>
  alertRuleProblems([entry]).filter((p) => p.includes("symptom phrase"));
check("phrase: absent field is a problem", phraseProblems(without("symptom")).length === 1);
check(
  "phrase: degenerate inputs (empty, blank, non-string) are one problem each",
  phraseProblems(rule({ symptom: "" })).length === 1 &&
    phraseProblems(rule({ symptom: "   " })).length === 1 &&
    phraseProblems(rule({ symptom: 42 })).length === 1,
);
check(
  "phrase: a non-object rule degrades to the phrase cause",
  phraseProblems(null).length === 1 && phraseProblems("banana").length === 1,
);

// --- 3. cause: severity outside the closed set --------------------------------
const severityProblems = (entry: unknown) =>
  alertRuleProblems([entry]).filter((p) => p.includes("severity outside the closed set"));
check("severity: absent field is a problem", severityProblems(without("severity")).length === 1);
check(
  "severity: degenerate inputs (unknown word, wrong case, number) are one problem each",
  severityProblems(rule({ severity: "page" })).length === 1 &&
    severityProblems(rule({ severity: "CRITICAL" })).length === 1 &&
    severityProblems(rule({ severity: 7 })).length === 1,
);

// --- 4. cause: missing duration window ----------------------------------------
const windowProblems = (entry: unknown) =>
  alertRuleProblems([entry]).filter((p) => p.includes("no duration window"));
check("window: absent field is a problem", windowProblems(without("for")).length === 1);
check(
  "window: degenerate inputs (empty, blank, non-string) are one problem each",
  windowProblems(rule({ for: "" })).length === 1 &&
    windowProblems(rule({ for: "   " })).length === 1 &&
    windowProblems(rule({ for: 0 })).length === 1,
);

// --- 5. cause: repeated series between rules ----------------------------------
const dupProblems = (list: readonly unknown[]) =>
  alertRuleProblems(list).filter((p) => p.includes("already observes"));
check("duplicate: two rules on one series is one problem", dupProblems([rule(), rule({ alert: "B" })]).length === 1);
check(
  "duplicate: three rules on one series is two problems, in list order",
  dupProblems([rule(), rule({ alert: "B" }), rule({ alert: "C" })]).length === 2,
);
check(
  "duplicate: distinct series stay clean",
  dupProblems([rule(), rule({ alert: "B", series: "relay_bytes_routed" })]).length === 0,
);
check(
  "duplicate: absent or degenerate series never repeats anything",
  dupProblems([rule(), without("series")]).length === 0 &&
    dupProblems([rule(), rule({ series: 42 })]).length === 0,
);

// --- 6. fixed order, one problem per cause, no short-circuit ------------------
const kind = (p: string) =>
  p.includes("symptom phrase") ? 1 : p.includes("severity outside") ? 2 : p.includes("duration window") ? 3 : 4;
const mixedInput = [
  rule({ alert: "Aaa", symptom: "", severity: "page", series: "relay_frames_routed" }),
  rule({ alert: "Bbb", for: "", series: "relay_bytes_routed" }),
  rule({ alert: "Ccc", series: "relay_bytes_routed", symptom: "Outra frase." }),
];
const mixed = alertRuleProblems(mixedInput);
check(
  "order: per-rule causes first (phrase, severity, window), then repeated series",
  JSON.stringify(mixed.map((p) => kind(p))) === JSON.stringify([1, 2, 3, 4]),
  causeOf(mixed),
);
const threeCauses = alertRuleProblems([{ alert: "Xxx" }]);
check(
  "order: a rule with all three per-rule causes yields exactly those, in cause order",
  JSON.stringify(threeCauses.map((p) => kind(p))) === JSON.stringify([1, 2, 3]),
  causeOf(threeCauses),
);

// --- 7. determinism: same input, two calls, identical result ------------------
const once = alertRuleProblems(closed);
const twice = alertRuleProblems(closed);
check("determinism: verifier output identical across two calls", JSON.stringify(once) === JSON.stringify(twice));
check(
  "determinism: serializer output identical across two calls",
  serializeAlertRules(closed) === serializeAlertRules(alertRules()),
);
check(
  "determinism: two alertRules() calls return deep-equal sets",
  JSON.stringify(closed) === JSON.stringify(alertRules()),
);
check(
  "determinism: mixed-cause order identical across two calls",
  JSON.stringify(mixed) === JSON.stringify(alertRuleProblems(mixedInput)),
);

// --- 8. serializer refuses rejected sets --------------------------------------
let refused = 0;
try {
  serializeAlertRules([]);
} catch {
  refused++;
}
try {
  serializeAlertRules([rule({ severity: "page" }) as never]);
} catch {
  refused++;
}
check("serializer: empty and rejected sets are refused, never published", refused === 2);
check(
  "serializer: the closed set serializes without throwing",
  serializeAlertRules(closed).startsWith("# Relay alert rules"),
);

// --- 9. byte equality with the committed deploy/relay/alerts.yml --------------
const root = new URL("..", import.meta.url);
const committedPath = new URL("deploy/relay/alerts.yml", root);
let committed = "";
try {
  committed = readFileSync(committedPath, "utf8");
} catch {
  committed = "";
}
check(
  "alerts.yml: the committed file is byte-for-byte the serializer output",
  committed !== "" && committed === serializeAlertRules(alertRules()),
);

// --- 10. fail-closed: every rule series is emitted by the real index.ts -------
const indexSrc = readFileSync(new URL("apps/relay/src/index.ts", root), "utf8");
const promStart = indexSrc.indexOf('if (req.url.includes("format=prom")) {');
const promEnd = indexSrc.indexOf('res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });');
check("emission: the prom block anchors exist in the real index.ts", promStart !== -1 && promEnd > promStart);
const metricModules =
  readFileSync(new URL("apps/relay/src/certmetrics.ts", root), "utf8") +
  readFileSync(new URL("apps/relay/src/procmetrics.ts", root), "utf8");
const emitted = new Set(
  (indexSrc.slice(promStart, promEnd) + metricModules).match(/relay_[a-z0-9_]+/g) ?? [],
);
check(
  "emission: extraction positive controls (index, cert, proc series all found)",
  emitted.has("relay_connections_total") &&
    emitted.has("relay_cert_expiry_seconds") &&
    emitted.has("relay_resident_bytes"),
  [...emitted].join(","),
);
check(
  "emission: every closed-set rule observes a series index.ts really emits, and no rule cites a nonexistent one",
  closed.every((r) => emitted.has(r.series)),
  closed.filter((r) => !emitted.has(r.series)).map((r) => r.series).join(","),
);

// --- 11. boundary: no address, port or room identifier anywhere ---------------
const texts = [...closed.map((r) => r.symptom), serializeAlertRules(closed)];
check(
  "boundary: no symptom sentence or serialized line carries an address, port or URL",
  texts.every(
    (t) =>
      !/(?:\d{1,3}\.){3}\d{1,3}/.test(t) &&
      !/:\d{2,5}\b/.test(t) &&
      !t.includes("wss://") &&
      !t.includes("ws://") &&
      !t.includes("localhost"),
  ),
);

// --- 12. the module itself stays pure -----------------------------------------
const src = readFileSync(new URL("apps/relay/src/alertrules.ts", root), "utf8");
// strip comments first: the header NAMES the banned tokens, the code must not use them
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
check(
  "purity: no node:fs, no child process, no node:process, no network, no timers",
  !code.includes("node:fs") &&
    !code.includes("node:child_process") &&
    !code.includes("node:process") &&
    !code.includes("node:http") &&
    !code.includes("fetch(") &&
    !code.includes("setTimeout") &&
    !code.includes("setInterval") &&
    !/^import /m.test(code),
);

if (failures > 0) {
  console.error(`relay-alertrules: ${failures} failure(s)`);
  process.exit(1);
}
console.log("relay-alertrules: all checks passed");
process.exit(0);
