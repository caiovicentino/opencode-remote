/**
 * Static-route request budget (P2-195): per-identity token buckets for the
 * optional web route (P2-188), so a single client cannot loop GETs against
 * the bundle and starve the same process that routes everyone's E2E frames.
 *
 * Pure decision module — no node/http, node/fs nor ws imports (the only
 * cross-import is the pure clientIp() from ipcap.ts) so the wiring in
 * index.ts stays thin and the decisions stay unit-testable — same pattern as
 * limits.ts, knobs.ts, loglevel.ts and webheaders.ts, including the
 * `problems` format they established (P2-132/P2-141).
 *
 * Fail-closed in the P2-114 spirit: a present-but-non-numeric, negative,
 * zero, fractional or above-ceiling value for either variable is a problem.
 * Any problem means the relay must not open its listener: index.ts logs
 * every reason once at boot and exits 1 instead of serving the static route
 * with an unvalidated budget. An absent or blank variable is the only case
 * that keeps the documented default, so an empty env reproduces the
 * documented behavior exactly.
 *
 * The relay stays blind here too: only envelope-metadata counters flow
 * through this module — the bucket key is the derived P2-174 ipTag, never
 * the raw address, and no plaintext, key material or room id is ever seen.
 */
import { clientIp } from "./ipcap.js";

/** Env variable for the sustained static-route request rate, per identity. */
export const WEB_RATE_PER_MIN_ENV = "RELAY_WEB_RATE_PER_MIN";
/** Env variable for the token-bucket burst of the static route, per identity. */
export const WEB_BURST_ENV = "RELAY_WEB_BURST";

/** Defaults sized for a cold PWA load (~a dozen requests) plus refreshes. */
export const WEB_RATE_PER_MIN_DEFAULT = 120;
export const WEB_BURST_DEFAULT = 60;

/**
 * Documented ceilings. They do not make a knob harmless — they only catch
 * values that are obviously misconfigurations (extra zeros, pasted byte
 * counts) before the relay serves the static route with them.
 */
export const WEB_RATE_PER_MIN_CEILING = 10_000;
export const WEB_BURST_CEILING = 10_000;

/**
 * Hard cap on live bucket entries. Each entry is a handful of numbers keyed
 * by a 12-hex tag; the cap exists so the map itself can never become the
 * memory leak a public route invites. When the cap is reached the entry seen
 * longest ago is discarded (least-recently-seen, see WebBudgets.take).
 */
export const WEB_BUDGET_MAX_ENTRIES = 4096;

/**
 * Inactivity window applied by the liveness sweep in index.ts: an identity
 * that has not sent a single static-route request for this long loses its
 * bucket. The entry cap above is the hard bound; this is hygiene so a
 * long-lived process returns the memory of long-gone clients.
 */
export const WEB_BUDGET_IDLE_MS = 15 * 60_000;

export interface WebBudgetPlan {
  /** Sustained static-route requests per minute, per identity. */
  ratePerMin: number;
  /** Token-bucket burst capacity, per identity. */
  burst: number;
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve the static-route budget from the process env.
 *
 * - RELAY_WEB_RATE_PER_MIN: sustained requests/minute per identity, default
 *   120.
 * - RELAY_WEB_BURST: token-bucket burst per identity, default 60.
 *
 * An absent or blank variable keeps the default. A present value must be a
 * whole, positive number at or below the variable's ceiling — anything else
 * is a problem and the boot refuses to start.
 */
export function resolveWebBudget(env: Record<string, string | undefined>): WebBudgetPlan {
  const problems: string[] = [];
  const ratePerMin = resolveBudgetGuard(
    env[WEB_RATE_PER_MIN_ENV],
    WEB_RATE_PER_MIN_ENV,
    WEB_RATE_PER_MIN_DEFAULT,
    WEB_RATE_PER_MIN_CEILING,
    "zero would disable the web request budget outright",
    problems,
  );
  const burst = resolveBudgetGuard(
    env[WEB_BURST_ENV],
    WEB_BURST_ENV,
    WEB_BURST_DEFAULT,
    WEB_BURST_CEILING,
    "zero would disable the web burst budget outright",
    problems,
  );
  return { ratePerMin, burst, problems };
}

/**
 * Resolve one budget knob: unset/blank keeps the default; a non-numeric,
 * negative, fractional, zero or above-ceiling value is a problem (recorded
 * once per variable) and the default is returned — the boot refuses to start
 * on any problem, so the fallback value is never served.
 */
function resolveBudgetGuard(
  raw: string | undefined,
  name: string,
  dflt: number,
  ceiling: number,
  whyNotZero: string,
  problems: string[],
): number {
  if (raw === undefined || raw.trim() === "") return dflt;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated knob (fail-closed)",
    );
    return dflt;
  }
  if (v < 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a positive number: a negative knob is meaningless ` +
        "(fail-closed)",
    );
    return dflt;
  }
  if (!Number.isInteger(v)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a whole number: a fractional knob cannot be applied ` +
        "(fail-closed)",
    );
    return dflt;
  }
  if (v === 0) {
    problems.push(
      `${name}="0" is not accepted: ${whyNotZero} — ` +
        `unset the variable to keep the default ${dflt} (fail-closed)`,
    );
    return dflt;
  }
  if (v > ceiling) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is above the ${ceiling} ceiling: ` +
        "values this large only serve misconfiguration (fail-closed)",
    );
    return dflt;
  }
  return v;
}

/** The full state of one identity's bucket, owned by the WebBudgets map. */
export interface WebBudgetState {
  /** Tokens left (fractional between refills). */
  tokens: number;
  /** Instant the tokens were last computed against. */
  lastMs: number;
  /** Instant of the last request — the inactivity-prune and eviction key. */
  lastSeenMs: number;
}

/** One budget decision plus the state the caller must store for next time. */
export interface WebBudgetVerdict {
  /** False means the request is over budget and must be answered 429. */
  allow: boolean;
  /** Suggested retry-after seconds; 0 when allowed, ≥ 1 when rejected. */
  retryAfterS: number;
  state: WebBudgetState;
}

/**
 * Pure continuous-refill token bucket decision (P2-195).
 *
 * `prev` is the stored state for this identity (undefined = first request
 * ever, which starts the bucket full). `nowMs` is the current instant;
 * refill happens continuously at `ratePerMin` tokens per minute up to
 * `burst`. A previous instant in the future (clock stepped back, skewed
 * host) counts as zero elapsed time: an advanced clock must never loosen
 * the ceiling.
 *
 * On rejection the suggested retry-after is the time one refill needs to
 * grant a token, in whole seconds, minimum 1. With a non-positive rate the
 * bucket can never refill, so the wait degrades to the 1-hour documented
 * maximum — the resolver above guarantees rate ≥ 1 in the wired path.
 */
export function webBudgetDecision(
  prev: WebBudgetState | undefined,
  nowMs: number,
  ratePerMin: number,
  burst: number,
): WebBudgetVerdict {
  const elapsedMs = prev && prev.lastMs < nowMs ? nowMs - prev.lastMs : 0;
  const tokens = Math.min(burst, (prev?.tokens ?? burst) + (elapsedMs * ratePerMin) / 60_000);
  if (tokens < 1) {
    const retryAfterS =
      ratePerMin > 0 ? Math.max(1, Math.ceil(((1 - tokens) * 60_000) / ratePerMin / 1000)) : 3600;
    return {
      allow: false,
      retryAfterS,
      state: { tokens, lastMs: nowMs, lastSeenMs: nowMs },
    };
  }
  return {
    allow: true,
    retryAfterS: 0,
    state: { tokens: tokens - 1, lastMs: nowMs, lastSeenMs: nowMs },
  };
}

/**
 * Minimal structural view of an HTTP request — no node/http import needed.
 * IncomingMessage satisfies it, and so can a plain test double.
 */
export interface WebBudgetRequestLike {
  socket: { remoteAddress?: string };
  headers: { [key: string]: string | string[] | undefined };
}

/**
 * The budget key for a request: the address derived exactly like the
 * WebSocket upgrade path derives it (clientIp() honoring
 * RELAY_TRUST_PROXY_HOPS), tagged by the P2-174 ipTagger. The bucket map
 * therefore never holds a raw address — only the irreversible per-process
 * tag — and identities behind a trusted proxy chain are keyed on the same
 * entry the per-IP cap already uses.
 */
export function webBudgetIdentity(
  req: WebBudgetRequestLike,
  trustProxyHops: number,
  tag: (address: string | undefined | null) => string,
): string {
  const fwd = req.headers["x-forwarded-for"];
  const ip = clientIp(
    req.socket.remoteAddress ?? "unknown",
    typeof fwd === "string" ? fwd : undefined,
    trustProxyHops,
  );
  return tag(ip);
}

/**
 * One budget verdict per request, as the gate returns it to the handler.
 */
export interface WebBudgetTake {
  allow: boolean;
  retryAfterS: number;
}

/**
 * The live bucket map for the static route. Keys are the derived identity
 * tags; entries are pruned by inactivity from the liveness sweep (prune())
 * and the map never grows past maxEntries (the least-recently-seen entry is
 * discarded on take()). No timers, no node imports: index.ts owns the clock
 * by passing `now` on every call.
 */
export class WebBudgets {
  private readonly entries = new Map<string, WebBudgetState>();

  constructor(
    private readonly ratePerMin: number,
    private readonly burst: number,
    private readonly maxEntries: number = WEB_BUDGET_MAX_ENTRIES,
  ) {}

  /** Live bucket count (exposed for tests and the sweep's sanity). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Consume one static-route request token for `key`. Re-inserting the
   * state on every take keeps the Map's iteration order equal to
   * last-seen order, which is what makes "discard the oldest entry" below
   * a deterministic least-recently-seen eviction.
   */
  take(key: string, nowMs: number): WebBudgetTake {
    const verdict = webBudgetDecision(this.entries.get(key), nowMs, this.ratePerMin, this.burst);
    this.entries.delete(key);
    this.entries.set(key, verdict.state);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return { allow: verdict.allow, retryAfterS: verdict.retryAfterS };
  }

  /**
   * Drop entries idle beyond `maxIdleMs`; called from the liveness sweep
   * with now = Date.now(). Returns how many entries were removed.
   */
  prune(nowMs: number, maxIdleMs: number): number {
    let removed = 0;
    for (const [key, state] of this.entries) {
      if (nowMs - state.lastSeenMs > maxIdleMs) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
