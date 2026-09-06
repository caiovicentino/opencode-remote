/**
 * Canonical registry of the RELAY_ environment variables the relay reads,
 * plus the unknown-key boot advisor (P2-263).
 *
 * The bug this closes: every resolver module (limits.ts, knobs.ts,
 * capacity.ts, roombudget.ts, joindeadline.ts, webbudget.ts, metricsbind.ts,
 * tlsconfig.ts, webroot.ts, webheaders.ts, backpressure.ts, loglevel.ts)
 * reads only the names it knows, so one swapped letter in the deployment
 * environment — RELAY_MAX_PER_ROM for RELAY_MAX_PER_ROOM — was ignored in
 * silence: the operator believed the chosen limit was live while the
 * `relay listening` line showed the default with not a single word of
 * difference. This module is the missing mirror: the full list of names the
 * relay reads, and a pure advisor that, given the environment's keys, returns
 * every RELAY_-prefixed key no resolver would ever look at — each with the
 * closest documented name when one sits within an edit distance of 2 (a
 * swapped, missing, extra or repeated letter), and without any suggestion
 * when nothing does.
 *
 * Purity: no node imports at all — same pattern as the other decision
 * modules, so unit tests (and the docs drift-lock test) never boot a relay.
 *
 * Determinism: the registry is stored sorted and the advisor's output is
 * sorted by key name; distance ties resolve to the alphabetically first
 * known name, so the same environment always produces the same lines.
 *
 * The relay stays blind here too: the advisor consumes key NAMES only —
 * never values. One of the real variables carries the metrics bearer token
 * and others carry certificate paths, so the log lines index.ts emits from
 * this advice cite the unknown name and the suggestion and never any value.
 */

/**
 * Every RELAY_ variable the relay process reads, sorted lexically. The
 * operator-facing mirror of this list is docs/RELAY-HOSTING.md, and the unit
 * battery locks the two together in both directions — adding a knob without
 * documenting it (or documenting one without reading it) now fails the tests
 * instead of drifting apart silently.
 */
export const RELAY_KNOB_NAMES: readonly string[] = [
  "RELAY_BUFFER_CAP_BYTES",
  "RELAY_DRAIN_GRACE_MS",
  "RELAY_JOIN_DEADLINE_MS",
  "RELAY_LOG_LEVEL",
  "RELAY_MAX_FRAME_BYTES",
  "RELAY_MAX_PER_IP",
  "RELAY_MAX_PER_ROOM",
  "RELAY_MAX_SOCKETS",
  "RELAY_MAX_SOCKETS_GLOBAL",
  "RELAY_METRICS_BIND",
  "RELAY_METRICS_PORT",
  "RELAY_METRICS_TOKEN",
  "RELAY_PING_INTERVAL_S",
  "RELAY_PORT",
  "RELAY_RATE_BURST",
  "RELAY_RATE_PER_MIN",
  "RELAY_ROOM_BUDGET_BYTES",
  "RELAY_ROOM_BUDGET_WINDOW_MS",
  "RELAY_TLS_CERT",
  "RELAY_TLS_KEY",
  "RELAY_TRUST_PROXY_HOPS",
  "RELAY_WEB_BURST",
  "RELAY_WEB_CSP",
  "RELAY_WEB_DIR",
  "RELAY_WEB_RATE_PER_MIN",
];

/** Prefix every relay knob shares; the advisor ignores any other key. */
const RELAY_PREFIX = "RELAY_";

/**
 * Largest edit distance that still earns a suggestion: 2 catches the
 * swapped/missing/extra/doubled-letter class a typo produces while never
 * mistaking a genuinely unrelated (e.g. hosting-platform-injected) RELAY_
 * key for a near miss.
 */
export const SUGGEST_DISTANCE_MAX = 2;

/** One unknown RELAY_ key, with the nearest documented name when close enough. */
export interface UnknownRelayKey {
  /** The exact environment key the relay would ignore. */
  key: string;
  /** Closest known knob name when its edit distance is <= 2; absent otherwise. */
  suggestion?: string;
}

/**
 * Advise on the environment's RELAY_ keys.
 *
 * Receives the environment's keys (values are never needed and are never
 * requested) and returns every key that starts with the RELAY_ prefix but is
 * not part of the registry — sorted by key, one entry per distinct key, each
 * carrying the closest known name within SUGGEST_DISTANCE_MAX when one
 * exists. Pure: the input is never mutated and the same input always yields
 * the same output.
 */
export function unknownRelayKeys(envKeys: readonly string[]): UnknownRelayKey[] {
  const known = new Set(RELAY_KNOB_NAMES);
  const seen = new Set<string>();
  const out: UnknownRelayKey[] = [];
  for (const key of envKeys) {
    if (!key.startsWith(RELAY_PREFIX) || known.has(key) || seen.has(key)) continue;
    seen.add(key);
    const suggestion = closestKnown(key);
    out.push(suggestion === undefined ? { key } : { key, suggestion });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Closest registry name within SUGGEST_DISTANCE_MAX, or undefined when
 * nothing is that close. The registry is sorted, and the scan keeps only a
 * strictly better distance, so ties deterministically resolve to the
 * alphabetically first candidate.
 */
function closestKnown(key: string): string | undefined {
  let best: string | undefined;
  let bestDistance = SUGGEST_DISTANCE_MAX + 1;
  for (const name of RELAY_KNOB_NAMES) {
    const distance = editDistance(key, name);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = name;
    }
  }
  return bestDistance <= SUGGEST_DISTANCE_MAX ? best : undefined;
}

/**
 * Levenshtein distance (insertions, deletions, substitutions — all cost 1),
 * computed with the classic two-row DP over code units. The keys and names
 * compared here are ASCII, so no locale or normalization concerns apply.
 * Exported for the unit battery to verify the suggestion bound honestly.
 */
export function editDistance(a: string, b: string): number {
  const cols = b.length + 1;
  let prev = new Array<number>(cols).fill(0);
  for (let j = 0; j < cols; j++) prev[j] = j;
  let curr = new Array<number>(cols).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j < cols; j++) {
      const substitute =
        (prev[j - 1] ?? 0) + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1);
      const insert = (curr[j - 1] ?? 0) + 1;
      const remove = (prev[j] ?? 0) + 1;
      curr[j] = Math.min(substitute, insert, remove);
    }
    [prev, curr] = [curr, prev];
  }
  // The last row is fully written and cols >= 1, so the cell always exists;
  // the fallback only satisfies noUncheckedIndexedAccess and never fires.
  return prev[cols - 1] ?? 0;
}
