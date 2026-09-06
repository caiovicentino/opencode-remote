// P2-266: when a published update reaches the installed phone app. The
// browser only revalidates the worker script on navigation, and an installed
// PWA stays open for weeks — so without an explicit plan the new publication
// waits behind a tab that never closes (sw-policy.js takeoverPlan) and the
// user keeps running the old shell with nothing telling them a version is
// ready. This module is the decision, the wiring lives in main.tsx.
//
// PURE on purpose (same hygiene as recency.ts / degraded.ts / viewState.ts):
// no DOM access, no storage, no network, no clock — the caller supplies every
// instant and every flag, so scripts/unit.test.ts can pin the full table.
//
// RULE ORDER CONTRACT (the header is the contract — tests pin it):
//   1. no registration → idle: without a worker there is no interlocutor;
//   2. streaming answer or unsent draft → idle, NEVER offer and NEVER reload:
//      swapping the app under someone mid-sentence loses their work, so this
//      rule outranks the waiting worker itself (tests prove both cases where
//      user work and a waiting worker are true at the same time);
//   3. waiting worker → offer, beating any recheck: verifying again with the
//      new version already in hand only spends the phone's network;
//   4. demo hatch → offer (evidence only, see demoForced — ignored outside a
//      harness session);
//   5. non-finite instants → refused (idle), never guessed;
//   6. last check newer than the minimum interval → idle: checking again
//      now cannot find anything the browser itself did not already check;
//   7. a future last-check instant is treated as "just checked now" (age
//      clamped to zero, never negative) → idle for this cycle;
//   8. otherwise → check now.
// Same input, same verdict — always.

export type SwUpdatePlanName = "idle" | "check" | "offer";

/** The one page-to-worker message the worker honors (P2-266). The worker's
 * message listener calls skipWaiting exclusively for this value, and only the
 * banner's explicit action ever posts it. */
export const SW_SWAP_MESSAGE = "ocr-sw-swap";

/** Minimum age of the last verification before another one is worth it.
 * The caller passes it into swUpdatePlan so the threshold stays documented
 * data, not hidden behavior. */
export const SW_UPDATE_MIN_INTERVAL_MS = 30 * 60_000;

/** Documented value of the evidence search parameter (?swupdate=demo). */
export const SW_DEMO_PARAM = "swupdate";
export const SW_DEMO_VALUE = "demo";

export interface SwUpdateInput {
  /** A service worker registration exists (supported, allowed, no file:). */
  registered: boolean;
  /** An updated worker is waiting to take over (the new version is ready). */
  waitingWorker: boolean;
  /** Instant of the last verification (ms epoch; boot counts as one). */
  lastCheckAt: number;
  /** Current instant (ms epoch), supplied by the caller — never read here. */
  now: number;
  /** An agent answer is streaming into the chat right now. */
  streaming: boolean;
  /** The composer holds an unsent draft. */
  draftUnsent: boolean;
  /** Minimum interval between verifications (ms). Falls back to the
   * documented constant when absent or unusable. */
  minIntervalMs?: number;
  /** Evidence hatch: caller-resolved demoForced() verdict. */
  demo?: boolean;
}

export interface SwUpdateVerdict {
  plan: SwUpdatePlanName;
  /** Machine reason for the verdict — one of the rule names above. */
  reason:
    | "no-registration"
    | "user-work"
    | "waiting-worker"
    | "demo"
    | "bad-instants"
    | "too-recent"
    | "check-due";
}

/** The decision table, in exactly the header's rule order. */
export function swUpdatePlan(input: SwUpdateInput): SwUpdateVerdict {
  if (input.registered !== true) return { plan: "idle", reason: "no-registration" };
  if (input.streaming === true || input.draftUnsent === true) {
    return { plan: "idle", reason: "user-work" };
  }
  if (input.waitingWorker === true) return { plan: "offer", reason: "waiting-worker" };
  if (input.demo === true) return { plan: "offer", reason: "demo" };
  if (!Number.isFinite(input.now) || !Number.isFinite(input.lastCheckAt)) {
    return { plan: "idle", reason: "bad-instants" };
  }
  const min =
    typeof input.minIntervalMs === "number" &&
    Number.isFinite(input.minIntervalMs) &&
    input.minIntervalMs >= 0
      ? input.minIntervalMs
      : SW_UPDATE_MIN_INTERVAL_MS;
  // A future last-check instant reads as "just checked now": age is clamped
  // to zero, never negative (clock skew must not trigger a burst of checks).
  const age = Math.max(0, input.now - input.lastCheckAt);
  if (age < min) return { plan: "idle", reason: "too-recent" };
  return { plan: "check", reason: "check-due" };
}

/** Resolve the evidence search parameter against the environment: the demo
 * force only counts inside the desktop shell during a harness session
 * (window.ocrDesktop present AND an automation-driven page), and is ignored
 * on every normal boot — phone, browser tab and packaged shell alike. Pure:
 * the caller reads location.search and the environment flags. */
export function demoForced(
  search: string,
  env: { desktopShell: boolean; harnessSession: boolean },
): boolean {
  if (env.desktopShell !== true || env.harnessSession !== true) return false;
  try {
    const params = new URLSearchParams(typeof search === "string" ? search : "");
    return params.get(SW_DEMO_PARAM) === SW_DEMO_VALUE;
  } catch {
    return false;
  }
}
