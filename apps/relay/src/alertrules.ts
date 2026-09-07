/**
 * Alert rules for the hosted relay (P2-320) — pure observation module.
 *
 * The /metrics surface publishes fifteen-plus series (connections, frames,
 * bytes, room refusals, slow consumers, capacity, room budget, certificate
 * validity — plus the P2-313 process gauges), yet nothing in the repository
 * said which number is worth waking the operator for: docs/VISION.md stage 4
 * left the operator inventing thresholds from scratch for a service they did
 * not write. This module is the closed, documented starting set — each rule
 * names the series it observes, the PromQL expression, the duration window
 * the condition must hold, a closed-set severity and a short Portuguese
 * symptom sentence, and the serializer renders the whole set as a
 * Prometheus rule-group file committed at deploy/relay/alerts.yml.
 *
 * THE RULES ARE NOT POLICY (boundary): nothing in the relay reads them —
 * no limit, no admission, no refusal and no socket close changes because of
 * them. They are a starting point for the operator's own alerting stack,
 * generated deterministically and pinned by tests:
 *
 *   - alertRules()          → the closed set of rules, in a fixed order;
 *                             two calls return deep-equal sets.
 *   - serializeAlertRules() → the exact Prometheus rule-group YAML text,
 *                             ordered, no serialization library; refuses
 *                             (throws) input the verifier rejects, so a
 *                             broken rule set is never published.
 *   - alertRuleProblems()   → everything wrong with a rule list, one
 *                             problem per cause, rules applied in a fixed
 *                             order with no short-circuit, same plain
 *                             string[] form as the P2-245 manifest
 *                             verifier (scripts/wingetmanifest.ts).
 *
 * Verifier rules, IN THIS ORDER (the order is load-bearing and covered by
 * tests):
 *
 *   1. Per rule, in list order, three causes each:
 *        a. the rule carries no symptom phrase (missing, non-string, blank);
 *        b. the severity is outside the closed ALERT_SEVERITIES set
 *           (missing, non-string or an unknown word);
 *        c. the duration window is missing (absent, non-string or empty).
 *   2. Then, in list order, one cause across rules: a rule observes a
 *      series another earlier rule already observes (repeated series). A
 *      rule without a string series never repeats anything and is skipped
 *      by this cause.
 *
 * The result is deterministic: the same input produces the same problems,
 * the same order and the same serialized bytes on every call.
 *
 * THE OPERATOR STAYS UNLOCATED (boundary): no rule name, expression,
 * severity, window or symptom sentence ever carries an address, a port, a
 * room id or any other identifiable material — the symptom sentences talk
 * about the relay's own health only.
 *
 * Pure module — imports nothing at all (no node:fs, node:process, no
 * network, no timers, no I/O), same hygiene as certmetrics.ts and
 * procmetrics.ts, so the unit battery can load it without booting anything.
 * The caller (or the repository, via the committed alerts.yml) owns what to
 * do with the text.
 */

/** The closed severity set — a rule outside it is refused, never published. */
export const ALERT_SEVERITIES = ["critical", "warning"] as const;

export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** One alert rule: a stable name over one published series. */
export interface RelayAlertRule {
  /** Stable Prometheus alert name — never renamed, only added to. */
  readonly alert: string;
  /** The single /metrics series the rule observes (emitted by index.ts). */
  readonly series: string;
  /** The PromQL expression, in terms of `series` alone. */
  readonly expr: string;
  /** Duration window the condition must hold (Prometheus `for`). */
  readonly for: string;
  /** Closed-set severity. */
  readonly severity: AlertSeverity;
  /** Short Portuguese symptom sentence — no address, port or room id. */
  readonly symptom: string;
}

/**
 * The closed set of relay alert rules, in publishing order. The order is
 * load-bearing: it is the order the serialized file carries and the order
 * tests pin. Adding a rule means editing here (and the docs) first.
 */
export function alertRules(): RelayAlertRule[] {
  return [
    {
      alert: "RelayCapacityRefused",
      series: "relay_capacity_refused_total",
      expr: "increase(relay_capacity_refused_total[10m]) > 0",
      for: "5m",
      severity: "critical",
      symptom: "O relay está recusando conexões novas por capacidade: quem tenta entrar recebe ocupado.",
    },
    {
      alert: "RelayCrashLoop",
      series: "relay_uptime_seconds",
      expr: "relay_uptime_seconds < 60",
      for: "10m",
      severity: "critical",
      symptom: "O processo está reiniciando em laço: o tempo de atividade volta a zero a cada raspagem.",
    },
    {
      alert: "RelayCertExpiryState",
      series: "relay_cert_expiry_state",
      expr: "relay_cert_expiry_state > 0",
      for: "30m",
      severity: "critical",
      symptom: "O certificado TLS saiu do estado saudável: a renovação está atrasando.",
    },
    {
      alert: "RelayCertExpirySeconds",
      series: "relay_cert_expiry_seconds",
      expr: "relay_cert_expiry_seconds < 259200",
      for: "1h",
      severity: "warning",
      symptom: "O certificado TLS entrou nos três dias finais antes de vencer.",
    },
    {
      alert: "RelaySchedulingDelay",
      series: "relay_scheduling_delay_ms",
      expr: "relay_scheduling_delay_ms > 1000",
      for: "5m",
      severity: "warning",
      symptom: "O loop de eventos está atrasando: as conversas começam a sentir lag antes de cair.",
    },
    {
      alert: "RelayMemoryBytes",
      series: "relay_resident_bytes",
      expr: "relay_resident_bytes > 1073741824",
      for: "15m",
      severity: "warning",
      symptom: "A memória do processo está alta: antecipa pressão antes de o sistema derrubar o relay.",
    },
    {
      alert: "RelaySlowConsumers",
      series: "relay_slow_consumers_total",
      expr: "increase(relay_slow_consumers_total[15m]) > 0",
      for: "5m",
      severity: "warning",
      symptom: "Clientes que pararam de ler estão sendo fechados para conter a memória.",
    },
    {
      alert: "RelayRoomsRejected",
      series: "relay_rooms_rejected",
      expr: "increase(relay_rooms_rejected[15m]) > 0",
      for: "10m",
      severity: "warning",
      symptom: "Recusas de sala acumulando: costuma ser identificador inválido ou teto por conexão.",
    },
    {
      alert: "RelayRoomBudgetTerminated",
      series: "relay_room_budget_terminated",
      expr: "increase(relay_room_budget_terminated[1h]) > 0",
      for: "5m",
      severity: "warning",
      symptom: "Uma sala passou o orçamento de volume da janela e foi encerrada.",
    },
  ];
}

const RULES_PREFIX = "relay-alerts: ";

/** Own-property string field read — inherited names never reach a verdict. */
function stringField(entry: unknown, field: string): string | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  if (!Object.hasOwn(entry, field)) return undefined;
  const value = (entry as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/** Short safe echo of a rule name for problem texts (no paths, no secrets). */
function safeName(entry: unknown, index: number): string {
  const raw = stringField(entry, "alert") ?? "";
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
  return cleaned.length > 0 ? ` (${cleaned})` : ` #${index + 1}`;
}

/**
 * Every problem with a rule list, all at once, in the fixed order documented
 * in the module header: per-rule causes first (list order; within a rule:
 * phrase, severity, window), then repeated series (list order). One problem
 * per cause, no short-circuit, deterministic, and no problem text carries an
 * absolute file path or a secret.
 */
export function alertRuleProblems(rules: readonly unknown[]): string[] {
  const problems: string[] = [];

  // 1a/1b/1c: per-rule causes, in list order, cause order fixed
  for (const [index, entry] of rules.entries()) {
    const name = safeName(entry, index);
    const symptom = stringField(entry, "symptom");
    if (symptom === undefined || symptom.trim() === "") {
      problems.push(
        `${RULES_PREFIX}the rule${name} carries no symptom phrase — write the short Portuguese sentence telling the operator what the firing rule anticipates`,
      );
    }
    const severity = stringField(entry, "severity");
    if (severity === undefined || !(ALERT_SEVERITIES as readonly string[]).includes(severity)) {
      problems.push(
        `${RULES_PREFIX}the rule${name} declares a severity outside the closed set — use one of ${ALERT_SEVERITIES.join(", ")}`,
      );
    }
    const duration = stringField(entry, "for");
    if (duration === undefined || duration.trim() === "") {
      problems.push(
        `${RULES_PREFIX}the rule${name} declares no duration window — set the Prometheus for duration the condition must hold`,
      );
    }
  }

  // 2: repeated series across rules, in list order; a rule without a string
  // series never repeats anything
  const seen = new Set<string>();
  for (const [index, entry] of rules.entries()) {
    const series = stringField(entry, "series");
    if (series === undefined) continue;
    if (seen.has(series)) {
      problems.push(
        `${RULES_PREFIX}the rule${safeName(entry, index)} observes series ${series} which an earlier rule already observes — one series, one rule`,
      );
      continue;
    }
    seen.add(series);
  }

  return problems;
}

/** Double-quoted YAML scalar with deterministic escaping. */
function yamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The exact Prometheus rule-group YAML for a rule set, in the set's own
 * order — deterministic, no serialization library. Refuses (throws) an
 * empty set or any set the verifier rejects, so a broken rule set is never
 * published; the committed deploy/relay/alerts.yml is this function's
 * output for alertRules(), byte for byte (pinned by a test).
 */
export function serializeAlertRules(rules: readonly RelayAlertRule[]): string {
  const problems = alertRuleProblems(rules);
  if (rules.length === 0) {
    throw new Error(`${RULES_PREFIX}refusing to serialize an empty rule set — a group with no rules is not loadable`);
  }
  if (problems.length > 0) {
    throw new Error(`${RULES_PREFIX}refusing to serialize a rejected rule set — ${problems.join(" | ")}`);
  }
  const lines: string[] = [
    "# Relay alert rules — GENERATED FILE, do not edit by hand (P2-320).",
    "# Regenerate as the byte-exact output of serializeAlertRules(alertRules())",
    "# from apps/relay/src/alertrules.ts; a unit test pins this file to it.",
    "# Load: promtool check rules deploy/relay/alerts.yml, then list the file",
    "# under rule_files in your Prometheus configuration.",
    "# See docs/RELAY-HOSTING.md — thresholds are starting points, not policy.",
    "groups:",
    "  - name: relay",
    "    rules:",
  ];
  for (const rule of rules) {
    lines.push(
      `      - alert: ${rule.alert}`,
      `        expr: ${yamlScalar(rule.expr)}`,
      `        for: ${rule.for}`,
      "        labels:",
      `          severity: ${rule.severity}`,
      "        annotations:",
      `          summary: ${yamlScalar(rule.symptom)}`,
    );
  }
  return lines.join("\n") + "\n";
}
