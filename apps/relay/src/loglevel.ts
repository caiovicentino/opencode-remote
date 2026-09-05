/**
 * Relay log level (P2-177): which JSONL entries the relay actually writes.
 *
 * Pure decision module — imports nothing (no node/fs, node/http, ws) so the
 * wiring in index.ts stays thin and the decisions stay unit-testable — same
 * pattern as limits.ts, knobs.ts and metricsbind.ts and the `problems`
 * format they established (P2-132/P2-141).
 *
 * Fail-closed in the P2-114 spirit: an unknown or non-string RELAY_LOG_LEVEL
 * value never falls back silently to the default — it is reported as a
 * problem so the boot refuses to start (exit 1, no listener) instead of
 * serving with an unvalidated knob. Only an absent or blank variable keeps
 * the documented default, so an empty env reproduces the pre-P2-177
 * behavior exactly.
 *
 * The relay stays blind here too: only the severity gate is resolved — no
 * plaintext, no key material, no room ids ever flow through this module.
 */

/**
 * Severity order, least verbose first: each level up from `error` adds
 * lines an operator would see; `debug` is the only level that emits the
 * per-frame `frame in` line.
 */
export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Historical default: everything except the per-frame debug line. */
export const LOG_LEVEL_DEFAULT: LogLevel = "info";

export interface ResolvedLogLevel {
  /** The level the relay logs at (the default when a problem exists). */
  level: LogLevel;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve RELAY_LOG_LEVEL from the env.
 *
 * An absent or blank variable keeps the default `info` with zero problems —
 * the only case that does. A present value must be one of the four levels,
 * case-insensitive; anything else (unknown word, non-string) is a problem
 * and the boot refuses to start.
 */
export function resolveLogLevel(env: Record<string, unknown>): ResolvedLogLevel {
  const problems: string[] = [];
  const raw = env.RELAY_LOG_LEVEL;
  if (raw === undefined) return { level: LOG_LEVEL_DEFAULT, problems };
  if (typeof raw !== "string") {
    problems.push(
      `RELAY_LOG_LEVEL=${JSON.stringify(raw)} is not a string: ` +
        "refusing to start with an unvalidated log level (fail-closed)",
    );
    return { level: LOG_LEVEL_DEFAULT, problems };
  }
  if (raw.trim() === "") return { level: LOG_LEVEL_DEFAULT, problems };
  const candidate = raw.trim().toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(candidate)) {
    problems.push(
      `RELAY_LOG_LEVEL=${JSON.stringify(raw)} is not one of ${LOG_LEVELS.join("|")}: ` +
        "refusing to start with an unvalidated log level (fail-closed)",
    );
    return { level: LOG_LEVEL_DEFAULT, problems };
  }
  return { level: candidate as LogLevel, problems };
}

/**
 * Whether a log entry at `entry` severity is written when the relay logs at
 * `configured` severity: every entry at least as severe as the configured
 * level passes, everything more verbose is dropped.
 */
export function shouldLog(configured: LogLevel, entry: LogLevel): boolean {
  return LOG_LEVELS.indexOf(entry) <= LOG_LEVELS.indexOf(configured);
}
