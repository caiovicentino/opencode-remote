// P2-244: pure GPU-crash policy for the desktop shell. A machine with a broken
// video driver used to open the app on a black window (or full of rendering
// artifacts), get the exact same thing after every reopen and repeat that path
// forever without a single log line — the definitive outcome P2-223 closed for
// a dead renderer, still open for the GPU process. This module owns the
// NUMBERS and the DECISIONS: the counting window, the drop ceiling, the
// tolerance rules for the state read back from disk and the verdict for each
// GPU child-process crash.
//
// Same module hygiene as hangwatch.ts / zoomlevel.ts: NO electron, no node:fs,
// no fetch, no I/O, no timers of any kind — main.ts resolves the session flag,
// the persisted state and the real crash events, applies the verdicts and
// persists through src/gpustore.ts, and scripts/unit.test.ts exercises every
// rule in plain Node.
//
// THE NUMBERS, and why:
// - The counting window is ONE HOUR (GPU_CRASH_WINDOW_MS). A machine with a
//   defective driver crashes its GPU process seconds after every boot, and
//   the lay user reopens the app minutes later — the window must be long
//   enough to bridge those restarts, or the count would reset on every reopen
//   and the disable would never fire. One hour is also short enough that
//   unrelated, once-a-day crashes never pile up into a disable.
// - The drop ceiling is THREE (GPU_CRASH_CEILING), the same family as the
//   P3-011 renderer reload budget: one crash is an accident, two are a
//   pattern, three within the window are a broken machine — the point where
//   software rendering (acceleration off) is strictly better than a black
//   window.
//
// RULE ORDER CONTRACTS (the gate depends on them):
// - gpuVerdict: a child process that is not the GPU one ALWAYS ignores without
//   accumulating anything (renderer crashes already have their own P3-011
//   budget); an expired window zeroes the count BEFORE any comparison; a count
//   below the ceiling only logs; a count at or above the ceiling orders the
//   acceleration off on the next start.
// - accelerationPlan: the harness-session rule comes FIRST and must stay
//   first — before any saved-state, packaged or platform consideration, the
//   P2-221/P2-235/P2-238 lesson. With the test-session variable set the
//   acceleration is ALWAYS on and nothing is written to disk: acceleration
//   inherited from another execution would change the framing of every
//   evidence screenshot and break the npm run test:desktop-flow battery. The
//   second rule is that absent, unreadable or out-of-range state turns into
//   "on" — and so does a state whose window expired: the machine may have
//   been fixed, so the policy heals itself instead of disabling hardware
//   acceleration forever off three old crashes.

/** Counting window for GPU-process crashes, in ms (one hour). See the header
 * for why it must bridge app restarts yet stay short enough to forget. */
export const GPU_CRASH_WINDOW_MS = 3_600_000;

/** GPU-process crashes inside the window that turn the acceleration off on the
 * next start. Same family as the P3-011 reload budget (3). */
export const GPU_CRASH_CEILING = 3;

/** Electron's child-process-gone `type` for the GPU process. Compared
 * case-insensitively; any other type never accumulates anything. */
export const GPU_PROCESS_TYPE = "gpu";

/** Shape of the persisted crash count. `count` is the number of GPU crashes
 * inside the current window; `windowStart` is the epoch ms the window began. */
export interface GpuCrashState {
  count: number;
  windowStart: number;
}

/** The zeroed state every read failure degrades to: no crashes counted, no
 * window in progress (windowStart 0 is always an expired window, so the first
 * real crash starts a fresh one). */
export const GPU_STATE_ZEROED: GpuCrashState = { count: 0, windowStart: 0 };

/**
 * Tolerant reader for the value loaded from disk: whatever comes in, a valid
 * state comes out — a non-object, a missing field, a wrong type, a
 * non-finite or negative number, or a window that starts in the future (a
 * clock that ran ahead when the state was written) all become the zeroed
 * state. Never throws, never returns a negative count.
 */
export function sanitizeGpuState(raw: unknown, nowMs: number): GpuCrashState {
  if (typeof raw !== "object" || raw === null) return { ...GPU_STATE_ZEROED };
  const { count, windowStart } = raw as { count?: unknown; windowStart?: unknown };
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return { ...GPU_STATE_ZEROED };
  if (typeof windowStart !== "number" || !Number.isFinite(windowStart) || windowStart < 0) {
    return { ...GPU_STATE_ZEROED };
  }
  if (windowStart > nowMs) return { ...GPU_STATE_ZEROED };
  return { count, windowStart };
}

/** The three possible answers to one GPU child-process crash. */
export type GpuCrashPlan = "ignore" | "log" | "disable";

export interface GpuVerdict {
  plan: GpuCrashPlan;
  /** The state to persist after this crash (the caller decides whether the
   * session may write to disk at all). */
  state: GpuCrashState;
  /** Short pt-BR line for the log — static, path-free, scheme-free. */
  reason: string;
}

const REASON_IGNORE = "queda de processo que não é de vídeo — ignorada sem acumular";
const REASON_LOG = "queda do processo de vídeo registrada — a aceleração será desligada se voltar a cair";
const REASON_DISABLE = "quedas repetidas do processo de vídeo — aceleração de vídeo desligada no próximo início";

/** True for the child-process types the policy counts (Electron's GPU type,
 * case-insensitive, so a future spelling never silently escapes the rule). */
export function isGpuProcess(childType: string): boolean {
  return childType.trim().toLowerCase() === GPU_PROCESS_TYPE;
}

/**
 * Pure decision for one child-process crash. Rules apply in this exact order:
 *
 *  1. a process that is not the GPU one always ignores and accumulates
 *     nothing — renderer crashes have their own P3-011 budget in crash.ts;
 *  2. an expired window zeroes the count before any comparison — crashes
 *     older than the window are not evidence anymore;
 *  3. a count below the ceiling only logs;
 *  4. a count at or above the ceiling orders the acceleration off on the
 *     next start.
 *
 * The returned count is never negative and the same input always yields the
 * same output.
 */
export function gpuVerdict(state: GpuCrashState, nowMs: number, childType: string): GpuVerdict {
  if (!isGpuProcess(childType)) {
    return { plan: "ignore", state: { count: Math.max(0, state.count), windowStart: state.windowStart }, reason: REASON_IGNORE };
  }
  const expired = nowMs - state.windowStart >= GPU_CRASH_WINDOW_MS;
  const base: GpuCrashState = expired
    ? { count: 0, windowStart: nowMs }
    : { count: Math.max(0, state.count), windowStart: state.windowStart };
  const count = base.count + 1;
  if (count >= GPU_CRASH_CEILING) {
    return { plan: "disable", state: { count, windowStart: base.windowStart }, reason: REASON_DISABLE };
  }
  return { plan: "log", state: { count, windowStart: base.windowStart }, reason: REASON_LOG };
}

/** The two answers for the session's hardware acceleration. */
export type AccelerationAction = "enable" | "disable";

export interface AccelerationPlan {
  action: AccelerationAction;
  /** False only for a harness session: nothing gpu-related may reach disk. */
  persist: boolean;
  /** Short pt-BR line for the log — static, path-free, scheme-free. */
  reason: string;
}

const ACCEL_HARNESS = "sessão de teste do harness — aceleração sempre ligada e nada é gravado";
const ACCEL_FRESH = "nenhuma queda recente de vídeo — aceleração de vídeo ligada";
const ACCEL_BELOW = "quedas de vídeo abaixo do teto — aceleração de vídeo segue ligada";
const ACCEL_DISABLE = "quedas de vídeo no teto — aceleração de vídeo desligada nesta sessão";

/** Body of the one-per-start tray tip shown when the plan disables the
 * acceleration. Static pt-BR, path-free, scheme-free (the P2-140 bar). */
export const NOTIFY_GPU_DISABLED_BODY =
  "Aceleração de vídeo desligada após quedas repetidas. O app segue funcionando em modo compatível.";

/**
 * Decide this session's hardware acceleration. Rules apply in this exact
 * order:
 *
 *  1. a test-harness session always enables and persists nothing — see the
 *     RULE ORDER CONTRACT in the header;
 *  2. absent, unreadable, out-of-range (the caller passes the sanitized
 *     zeroed state for those) or simply zero counts enable — no evidence, no
 *     disable;
 *  3. a count whose window expired enables too — the machine may have been
 *     fixed while the app was closed, so the policy heals itself;
 *  4. a count at or above the ceiling within the window disables the
 *     acceleration for this session (Electron only honors the call before
 *     the app is ready).
 */
export function accelerationPlan(input: { harnessSession: boolean; state: GpuCrashState; nowMs: number }): AccelerationPlan {
  if (input.harnessSession) {
    return { action: "enable", persist: false, reason: ACCEL_HARNESS };
  }
  const count = Math.max(0, input.state.count);
  const expired = input.nowMs - input.state.windowStart >= GPU_CRASH_WINDOW_MS;
  if (count <= 0 || expired) {
    return { action: "enable", persist: true, reason: ACCEL_FRESH };
  }
  if (count >= GPU_CRASH_CEILING) {
    return { action: "disable", persist: true, reason: ACCEL_DISABLE };
  }
  return { action: "enable", persist: true, reason: ACCEL_BELOW };
}
