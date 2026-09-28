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
 * outage must never block tasks one by one) — with the per-task cap below:
 * free retries are not a license, and a task whose output reliably "ends" on
 * an outage-shaped line is not an outage, it is the task.
 */

// eslint-disable-next-line no-control-regex -- stripping terminal escapes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** opencode's structured log lines (`--print-logs`): `timestamp=… level=… …`. */
const OPENCODE_LOG_LINE = /^timestamp=\S+ level=[A-Z]+\b/;
/** Only the end of the output can hold the terminal line. */
const TAIL_SCAN_CHARS = 16_384;

/**
 * The opencode CLI's own terminal-error frame: bold red `Error: ` (real
 * corpus: P3-457's builder-P3-457.log, the fixture below, and every recorded
 * provider-outage death). A plain `Error: ` line from a TOOL's stdout or the
 * MODEL's own prose can be identical after ANSI stripping — the fixround
 * probe "builder timeout whose last line is bash printing `Error: connect
 * ECONNREFUSED 127.0.0.1:43123`" is exactly that. Only a raw line that
 * carries this frame can carry a process death; anything else (including a
 * forged `Error: Cannot connect to API: …`) is text, not a verdict.
 */
export const CLI_ERROR_FRAME = "\u001b[91m\u001b[1mError: \u001b[0m";
/** The structured process-exit log line the CLI prints IMMEDIATELY before the
 * frame when --print-logs is on (real corpus, P3-457:
 * `level=ERROR run=… message=process … error="Cannot connect to API: …"`). */
const PROCESS_EXIT_LOG_LINE = /^timestamp=\S+ level=ERROR\b[^\n]*\bmessage=process\b[^\n]*\berror=/;

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
 * eval fixround: `connect ECONNREFUSED 127.0.0.1:43123` is a LOCAL service
 * (opencode serve, a gate port, a test server) — never the model provider,
 * whose path always names a non-loopback host. Loopback-targeted connect
 * failures are blanked before the signatures run, so a tool line that only
 * mentions a dead loopback port cannot arm a global outage hold. (Only the
 * loopback ranges are blanked: `ECONNREFUSED 10.0.0.1:443` stays an outage.)
 */
const LOOPBACK_CONNECT = /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)\s+(?:(?:127|0)\.(?:\d{1,3}\.){2}\d{1,3}|localhost|::1|\[[0-9a-fA-F:]+\])(?::\d+)?\b/gi;

/** Options for the outage detector: with `printLogs` (the builder always
 * runs --print-logs) the structured process-exit ERROR line must sit right
 * before the frame — an extra proof the death is the CLI's own, not text the
 * agent printed. Reviewer runs have no --print-logs; the frame is their
 * only structural proof. */
export interface OutageProbe {
  printLogs?: boolean;
}

/**
 * The provider-outage verdict for one agent run: the CLI's terminal error
 * (its own ANSI frame — see CLI_ERROR_FRAME) when it matches a provider
 * signature, else null. Callers only ask for runs that did NOT complete (no
 * PILOT:TASK-DONE / no verdict marker).
 */
export function providerOutage(output: unknown, opts: OutageProbe = {}): string | null {
  if (typeof output !== "string" || !output) return null;
  const lines = output.slice(-TAIL_SCAN_CHARS).split(/\r?\n/);
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.replace(ANSI, "").trim();
    if (!l || OPENCODE_LOG_LINE.test(l)) continue;
    idx = i;
    break;
  }
  if (idx < 0) return null;
  const raw = lines[idx]!;
  // the CLI's own frame, not a tool/model "Error: " line
  if (!raw.startsWith(CLI_ERROR_FRAME)) return null;
  if (opts.printLogs) {
    let before = idx - 1;
    while (before >= 0 && !lines[before]!.trim()) before--;
    if (before < 0 || !PROCESS_EXIT_LOG_LINE.test(lines[before]!)) return null;
  }
  const err = raw.replace(ANSI, "").trim().slice("Error: ".length).slice(0, 300);
  const candidate = err.replace(LOOPBACK_CONNECT, " ");
  return PROVIDER_OUTAGE_SIGNATURES.some((re) => re.test(candidate)) ? err : null;
}

/**
 * eval-03 (+ eval-15 red team): a reviewer run that never FINISHED produced no
 * trustworthy verdict — even when its output carries a VERDICT marker: a
 * builder-planted file the reviewer cat'ed prints one before the timeout kill
 * or the provider outage, and the LAST-marker rule would read it as the
 * reviewer's own APPROVE. Timed out ⇒ infra "timeout"; not spawned ⇒ infra
 * "spawn"; opencode preflight or provider outage ⇒ infra "api-down". null ⇒
 * the run finished: its verdict is parsed as usual.
 */
export function reviewerInconclusive(r: {
  output: string;
  timedOut?: boolean;
  infra?: string;
}): { infra: "timeout" | "spawn" | "api-down"; why: string } | null {
  if (r.timedOut) return { infra: "timeout", why: "a reviewer timed out before finishing" };
  if (r.infra === "spawn") return { infra: "spawn", why: "a reviewer could not be spawned" };
  if (r.infra === "api-down") return { infra: "api-down", why: "opencode API unreachable (preflight)" };
  const outage = providerOutage(r.output);
  return outage ? { infra: "api-down", why: `model provider unreachable: ${outage}` } : null;
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
  /** eval fixround: epoch ms of the outage observation that armed this hold.
   * A pipeline picked BEFORE this instant had model calls that predate the
   * outage — its success (a merge included) proves nothing and must not
   * clear the hold; only a run picked after it can. */
  armedAt: number;
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
  return { count, until: now + ms, armedAt: now };
}

/** Milliseconds of hold left (0 = picks allowed). */
export function providerHoldRemaining(h: ProviderHold | null, now: number): number {
  return h ? Math.max(0, h.until - now) : 0;
}

// ── per-task api-down cap: free retries are not a license (eval fixround) ───

/**
 * Consecutive api-down cycles of ONE task that stay free (paced only by the
 * global hold). The detector is structural, but its last line can still be a
 * false positive (a tool's bash output, a model quote) — a task that dies
 * this way repeats FOREVER at zero attempt cost (836M tokens were burned by
 * exactly such a loop while the hold starved every other pick). After
 * API_DOWN_FREE_CYCLES consecutive api-down outcomes of the same task, and
 * once some OTHER pipeline was picked and completed without api-down after
 * the trail began (proof the provider answers for someone else), the api-down
 * stops being free: it feeds the normal per-task infra streak (index.ts) and
 * the task blocks with an explicit reason like any other infra starvation.
 * A REAL outage never reaches this: while the provider is down no pipeline
 * completes, so no proof-of-life exists and the hold paces every retry.
 */
export const API_DOWN_FREE_CYCLES = 3;

/** Per-task consecutive api-down trail (persisted in state.json like the
 * infra streaks; `startedAt` anchors the trail's first outage). */
export interface ApiDownStreak {
  n: number;
  startedAt: number;
}

/** Fold one api-down outcome of a task into its trail (any other outcome of
 * the same task resets it — see clearApiDownStreak callers in index.ts). */
export function noteApiDownStreak(prev: ApiDownStreak | undefined, now: number): ApiDownStreak {
  return prev && prev.n > 0 ? { n: prev.n + 1, startedAt: prev.startedAt } : { n: 1, startedAt: now };
}

/**
 * Pure cap rule: the free retries are over when the trail passed
 * API_DOWN_FREE_CYCLES AND the provider was proven up after the trail began
 * (`providerUpAt` = the pick time of the newest pipeline that completed
 * without api-down — its builder call reached the model after the trail's
 * first outage, so the "outage" cannot be systemic).
 */
export function apiDownStreakExhausted(s: ApiDownStreak | undefined, providerUpAt: number | null): boolean {
  return !!s && s.n > API_DOWN_FREE_CYCLES && providerUpAt !== null && providerUpAt > s.startedAt;
}
