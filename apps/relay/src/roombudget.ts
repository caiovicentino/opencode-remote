/**
 * Per-room accumulated-volume budget (P2-243).
 *
 * The bug this bounds: every traffic control the relay had was instantaneous
 * — the per-frame byte cap (limits.ts), the per-connection frame-rate bucket
 * (ratelimit.ts) and the per-socket outgoing-queue cap (backpressure.ts).
 * A room whose peers stayed comfortably inside all three could still move
 * bytes forever, so the hosted multi-tenant relay's traffic bill
 * (docs/VISION.md stage 4) had no ceiling at all, and not a single log line
 * said which room grew: the only outcome was the operator discovering it on
 * the invoice. This module is the missing accumulated dimension: a volume
 * ceiling per room per window, with one warn line before the cut.
 *
 * Why the default window is 3600000 ms (one hour): hosted traffic is
 * reasoned about (and billed) in hourly scales, and the window is tumbling
 * per room — the first forwarded frame after a reset starts the next one —
 * so an hour bounds what a runaway room can cost per billing slice while
 * never interrupting a legitimate conversation mid-window. A ceiling of
 * 86400000 ms (one day) is accepted: a window longer than that stops being
 * an operations-relevant feedback loop and only serves misconfiguration.
 *
 * Why the default cap is 1073741824 bytes (1 GiB) per room per window — the
 * heaviest legitimate room-hour of this product, generously counted:
 *
 *     chat:        5000 envelope frames x ~4 KiB          ≈   20 MiB
 *     voice:       3600 s x 16 KiB/s                      ≈   56 MiB
 *     files:       100 transfers  x 1 MiB (the frame cap) ≈  100 MiB
 *     screenshots: 100 captures   x 1 MiB (the frame cap) ≈  100 MiB
 *     -------------------------------------------------      ----------
 *     heaviest legitimate room-hour                      ≈  276 MiB
 *
 * 1 GiB is ~3.8x that headroom — a real room never reaches the warn line,
 * let alone the terminate one. A ceiling of 17179869184 bytes (16 GiB) is
 * accepted: beyond that a per-room hourly cap no longer protects the hosted
 * link and only serves misconfiguration (extra zeros, pasted disk sizes).
 *
 * Why the documented disable value is -1: an operator running a private,
 * allowlisted relay may want the budget off entirely. Zero and generic
 * negatives stay refused (a zero-byte cap would close every room), so an
 * explicit -1 on RELAY_ROOM_BUDGET_BYTES is the only value that means "off"
 * — opt-in, never the default, because a hosted multi-tenant relay needs
 * this bound on by default.
 *
 * Fail-closed in the P2-114 spirit: a present-but-non-numeric, zero,
 * negative (other than the documented -1), fractional or above-ceiling value
 * is a problem. Any problem means the relay must not open its listener:
 * index.ts logs every reason once at boot and exits 1 instead of silently
 * falling back to the default. Every rule is checked independently and each
 * one appends its own problem, so a single value that violates several rules
 * reports every reason at once instead of short-circuiting on the first.
 * An absent or blank variable keeps the documented default, so an empty env
 * reproduces the pre-P2-243 behavior as closely as the new knob allows.
 *
 * The verdict rules, in the exact order they are applied: a disabled cap
 * always follows; an expired window zeroes the accumulated bytes before any
 * comparison; a missing, non-finite or negative frame size follows without
 * accumulating anything — closing a room on a dubious count is worse than
 * letting a frame pass, the same prudence the backpressure verdict applies
 * to a socket without accounting; only an accumulated total strictly above
 * the cap terminates (a total exactly at the cap is still serviceable, and
 * that boundary is explicit in the test battery); crossing half of the cap
 * warns, at most once per window.
 *
 * THE RELAY STAYS BLIND: only the byte count of a forwarded frame flows
 * through this module — no payload content, no envelope field, no sender or
 * receiver identity is ever inspected, decrypted or stored. The close/warn
 * reasons are fixed short strings with no file path, no URL, no network
 * address and no secret; at most a room-id PREFIX (8 chars, the same
 * convention as every other relay rejection line) is attached by index.ts.
 *
 * Pure decision module — imports nothing (no node/net, node/fs, node/http
 * nor ws) so the wiring in index.ts stays thin and the decisions stay
 * unit-testable — same pattern as backpressure.ts and capacity.ts, including
 * the `problems` format they established (P2-132/P2-141).
 */

/** Env variable for the per-room budget window in milliseconds. */
export const ROOM_BUDGET_WINDOW_MS_ENV = "RELAY_ROOM_BUDGET_WINDOW_MS";

/** Env variable for the per-room accumulated-bytes cap within the window. */
export const ROOM_BUDGET_BYTES_ENV = "RELAY_ROOM_BUDGET_BYTES";

/** Default window: one hour. See the module header for the reasoning. */
export const ROOM_BUDGET_WINDOW_MS_DEFAULT = 3_600_000;

/** Documented window ceiling: one day. See the module header. */
export const ROOM_BUDGET_WINDOW_MS_CEILING = 86_400_000;

/** Default per-room cap: 1 GiB per window. See the module header for the math. */
export const ROOM_BUDGET_BYTES_DEFAULT = 1_073_741_824;

/** Documented bytes ceiling: 16 GiB. See the module header. */
export const ROOM_BUDGET_BYTES_CEILING = 17_179_869_184;

/** The only value that disables the budget entirely. See the module header. */
export const ROOM_BUDGET_BYTES_DISABLED = -1;

/** Close code for a room terminated over its volume budget (policy 1013). */
export const ROOM_BUDGET_CLOSE_CODE = 1013;

/**
 * Fixed close reason, also the terminate-line reason: short, Portuguese, and
 * free of file paths, URLs, network addresses, room identifiers and secrets —
 * same privacy shape as the P2-217/P2-227/P2-230 reasons.
 */
export const ROOM_BUDGET_CLOSE_REASON = "sala encerrada: volume acima do teto da janela";

/**
 * Fixed warn-line reason for the one-per-window heads-up. Same shape as the
 * close reason above.
 */
export const ROOM_BUDGET_WARN_REASON = "volume de sala proximo do teto da janela";

/** Resolved limits the verdict consumes. */
export interface RoomBudgetLimits {
  /** Tumbling window length in ms. */
  windowMs: number;
  /** Per-room accumulated-bytes ceiling within the window, or
   *  ROOM_BUDGET_BYTES_DISABLED when the budget is off. */
  capBytes: number;
}

export interface RoomBudgetConfig extends RoomBudgetLimits {
  /** Non-empty means the boot must NOT open the listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve the per-room budget from the process env.
 *
 * An absent or blank variable keeps its documented default — an empty env
 * reproduces the pre-P2-243 behavior as closely as the new knob allows (the
 * budget is new, so "as closely as it allows" means: the defaults above are
 * the only values ever served without an explicit override). The documented
 * disable value (-1) is accepted verbatim for the bytes knob, checked before
 * the negative rule. Every rule is checked independently and each one
 * appends its own problem, so a single value that violates several rules
 * reports every reason at once instead of short-circuiting on the first. A
 * problematic value resolves to its default, which is never served: the boot
 * refuses to start on any problem.
 */
export function parseRoomBudget(env: Record<string, string | undefined>): RoomBudgetConfig {
  const problems: string[] = [];
  const windowMs = resolveRoomBudgetNumber(
    env[ROOM_BUDGET_WINDOW_MS_ENV],
    ROOM_BUDGET_WINDOW_MS_DEFAULT,
    ROOM_BUDGET_WINDOW_MS_CEILING,
    "a window this long stops being an operations-relevant feedback loop",
    false,
    problems,
  );
  const capBytes = resolveRoomBudgetNumber(
    env[ROOM_BUDGET_BYTES_ENV],
    ROOM_BUDGET_BYTES_DEFAULT,
    ROOM_BUDGET_BYTES_CEILING,
    "a per-room hourly cap this large only serves link abuse",
    true,
    problems,
  );
  return { windowMs, capBytes, problems };
}

/**
 * Resolve one budget number: unset/blank keeps the default; non-numeric,
 * zero, negative (other than the documented disable value when `disable`
 * applies), fractional and above-ceiling values each append their own
 * problem — no short-circuit — and the default is returned, which the boot
 * never serves because any problem refuses it.
 */
function resolveRoomBudgetNumber(
  raw: string | undefined,
  dflt: number,
  ceiling: number,
  ceilingWhy: string,
  disableAllowed: boolean,
  problems: string[],
): number {
  const name = disableAllowed ? ROOM_BUDGET_BYTES_ENV : ROOM_BUDGET_WINDOW_MS_ENV;
  if (raw === undefined || raw.trim() === "") return dflt;
  // one variable's problems must never spill into the other's resolution
  const before = problems.length;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not a numeric value: ` +
        "refusing to start with an unvalidated budget (fail-closed)",
    );
    return dflt;
  }
  if (disableAllowed && v === ROOM_BUDGET_BYTES_DISABLED) return v;
  if (v === 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is not accepted: zero would ` +
        (disableAllowed
          ? `close every room outright — use the documented disable value ${ROOM_BUDGET_BYTES_DISABLED} to turn the budget off (fail-closed)`
          : "reset the accumulated volume on every frame (fail-closed)"),
    );
  }
  if (v < 0) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a positive number: ` +
        (disableAllowed
          ? `the only accepted non-positive is the documented disable value ${ROOM_BUDGET_BYTES_DISABLED} (fail-closed)`
          : "a negative window is meaningless (fail-closed)"),
    );
  }
  if (!Number.isInteger(v)) {
    problems.push(
      `${name}=${JSON.stringify(raw)} must be a whole number: ` +
        "a fractional budget cannot be applied (fail-closed)",
    );
  }
  if (v > ceiling) {
    problems.push(
      `${name}=${JSON.stringify(raw)} is above the ${ceiling} ceiling: ` +
        `${ceilingWhy} (fail-closed)`,
    );
  }
  return problems.length > before ? dflt : v;
}

/** Accumulated state of one room's budget within its current window. */
export interface RoomBudgetState {
  /** ms timestamp the current window started at. */
  windowStart: number;
  /** Accumulated forwarded-frame bytes within the current window (never negative). */
  bytes: number;
  /** Whether the one-per-window warn line already fired for this window. */
  warned: boolean;
}

export type RoomBudgetVerdict =
  | { action: "follow" }
  | { action: "warn"; reason: string }
  | { action: "terminate"; reason: string };

const FOLLOW: RoomBudgetVerdict = { action: "follow" };
const WARN: RoomBudgetVerdict = { action: "warn", reason: ROOM_BUDGET_WARN_REASON };
const TERMINATE: RoomBudgetVerdict = { action: "terminate", reason: ROOM_BUDGET_CLOSE_REASON };

/** A fresh state starting its window at `nowMs`. */
export function initialRoomBudgetState(nowMs: number): RoomBudgetState {
  return { windowStart: nowMs, bytes: 0, warned: false };
}

/**
 * Decide what the next forwarded frame costs the room's budget.
 *
 * Pure: the input state is never mutated — the new state is returned
 * alongside exactly one of three plans (follow / warn once per window /
 * terminate the room). Rules, in the documented order:
 *
 * 1. a disabled cap always follows, accumulating nothing;
 * 2. an expired window zeroes the accumulated bytes before any comparison;
 * 3. a missing, non-finite or negative frame size follows without
 *    accumulating — a dubious count must never close a room (the same
 *    fail-open prudence the P2-217 backpressure verdict applies to a socket
 *    without accounting);
 * 4. only an accumulated total strictly above the cap terminates — exactly
 *    at the cap the room stays serviceable.
 *
 * `frameBytes` is the serialized frame's byte count and nothing else: no
 * payload content, envelope field or identity is ever inspected.
 */
export function budgetVerdict(
  state: RoomBudgetState | undefined,
  nowMs: number,
  frameBytes: unknown,
  limits: RoomBudgetLimits,
): { state: RoomBudgetState; plan: RoomBudgetVerdict } {
  // 1. disabled: always follow, no accounting, no plan but follow.
  if (limits.capBytes === ROOM_BUDGET_BYTES_DISABLED) {
    return { state: state ?? initialRoomBudgetState(nowMs), plan: FOLLOW };
  }
  // 2. expired window: zero the accumulated BEFORE any comparison.
  const base =
    state === undefined || nowMs - state.windowStart >= limits.windowMs
      ? initialRoomBudgetState(nowMs)
      : state;
  // 3. dubious frame size: follow without accumulating anything — closing a
  //    room on a count the relay cannot trust is worse than letting the
  //    frame pass (documented in the module header).
  if (typeof frameBytes !== "number" || !Number.isFinite(frameBytes) || frameBytes < 0) {
    return { state: { ...base }, plan: FOLLOW };
  }
  const bytes = base.bytes + frameBytes;
  const next: RoomBudgetState = {
    windowStart: base.windowStart,
    bytes,
    warned: base.warned,
  };
  // 4. only strictly above the cap terminates (exactly at the cap holds).
  if (bytes > limits.capBytes) return { state: next, plan: TERMINATE };
  // half the cap, integer-safe: warn once per window while there is still
  // time for the operator to react before the terminate line.
  if (!base.warned && bytes * 2 >= limits.capBytes) {
    return { state: { ...next, warned: true }, plan: WARN };
  }
  return { state: next, plan: FOLLOW };
}
