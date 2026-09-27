/**
 * eval-03 (forensic 2026-09-24, rec 1): classify an agent process that died
 * on a MODEL-PROVIDER outage — at the producer site, from the process's own
 * terminal error line, never from free text (P1-094: a reviewer finding or a
 * builder paste citing "Cannot connect to API" stays merit).
 *
 * The gap: the runner's preflight (waitForApi) probes `opencode serve`, which
 * stays healthy while the provider behind it is unreachable. The builder then
 * dies with the CLI's own `Error: Cannot connect to API: Unable to connect…`,
 * the round is retried at once (dying again), and the final round is
 * reported as "builder did not finish" — a merit failure that burns an
 * attempt. Real corpus (pilot.log, 2026-08-31 → 2026-09-23): 8 attempts
 * burned this way (P1-014 ×2, P1-056, P2-148, P2-337/338/339 within 25s of
 * each other, P3-457 — whose 4th and last attempt died so and was blocked).
 * Meanwhile dozens of builder logs carry the same words mid-run (a stream
 * error the SDK retried) and finished with PILOT:TASK-DONE — a substring
 * classifier would call every one of them an outage.
 *
 * Pure: no node builtins, no I/O. The pipeline aborts the cycle with the
 * structured infra kind "api-down"; index.ts holds new picks with the
 * backoff below instead of feeding the per-task streak breaker (a systemic
 * outage must never block tasks one by one).
 */

// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** opencode's structured log lines (`--print-logs`): `timestamp=… level=… …`. */
const OPENCODE_LOG_LINE = /^timestamp=\S+ level=[A-Z]+\b/;
/** Only the end of the output can hold the terminal line. */
const TAIL_SCAN_CHARS = 16_384;

/**
 * The opencode CLI's terminal error: the LAST line of the output that is not
 * blank and not an opencode structured log line, when (ANSI-stripped) it
 * starts with `Error: `. Anything the model printed afterwards — or a normal
 * final answer — means the process did not die on that error ⇒ null.
 */
export function cliTerminalError(output: unknown): string | null {
  if (typeof output !== "string" || !output) return null;
  const lines = output.slice(-TAIL_SCAN_CHARS).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.replace(ANSI, "").trim();
    if (!l || OPENCODE_LOG_LINE.test(l)) continue;
    return /^Error: \S/.test(l) ? l.slice("Error: ".length).slice(0, 300) : null;
  }
  return null;
}

/** Connectivity/availability failures of the provider API as the AI SDK and
 * Bun's fetch word them. Rate limiting belongs here too: the right answer is
 * the same backoff, never a burned attempt. */
export const PROVIDER_OUTAGE_SIGNATURES: readonly RegExp[] = [
  /^Cannot connect to API\b/i, // AI_APICallError (real corpus: "…: Unable to connect…", "…: The socket connection was closed unexpectedly…")
  /\bUnable to connect\b/i,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)\b/,
  /\bfetch failed\b/i,
  /\bsocket hang up\b/i,
  /\b(?:Service Unavailable|Bad Gateway|Gateway Timeout)\b/i,
  /\boverloaded(?:_error)?\b/i,
  /\b(?:Too Many Requests|rate[ _-]?limit(?:ed)?)\b/i,
];

/**
 * The provider-outage verdict for one agent run: the CLI's terminal error
 * when it matches a provider signature, else null. Callers only ask for runs
 * that did NOT complete (no PILOT:TASK-DONE / no verdict marker).
 */
export function providerOutage(output: unknown): string | null {
  const err = cliTerminalError(output);
  if (!err) return null;
  return PROVIDER_OUTAGE_SIGNATURES.some((re) => re.test(err)) ? err : null;
}

// ── global pick hold while the provider is down ─────────────────────────────

/** First hold after an outage, doubling per new outage, capped. */
export const PROVIDER_HOLD_BASE_MS = 2 * 60_000;
export const PROVIDER_HOLD_MAX_MS = 30 * 60_000;

export interface ProviderHold {
  /** consecutive outage holds (1 = first) */
  count: number;
  /** epoch ms until which no new pipeline is picked */
  until: number;
}

/**
 * Fold one provider-outage outcome into the hold. While a hold is running,
 * further outage reports (slots that were already mid-round when the
 * provider died — three of them within 25s on 2026-09-23) do NOT escalate:
 * only an outage observed after the previous hold expired doubles the wait.
 * A hold that expired longer ago than the cap is history — back to the base.
 */
export function noteProviderOutage(prev: ProviderHold | null, now: number): ProviderHold {
  if (prev && now < prev.until) return prev;
  const fresh = !prev || now - prev.until > PROVIDER_HOLD_MAX_MS;
  const count = fresh ? 1 : prev.count + 1;
  const ms = Math.min(PROVIDER_HOLD_BASE_MS * 2 ** (count - 1), PROVIDER_HOLD_MAX_MS);
  return { count, until: now + ms };
}

/** Milliseconds of hold left (0 = picks allowed). */
export function providerHoldRemaining(h: ProviderHold | null, now: number): number {
  return h ? Math.max(0, h.until - now) : 0;
}
