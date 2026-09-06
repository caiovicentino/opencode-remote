import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import SwUpdateBanner, {
  hideSwUpdateBanner,
  showSwUpdateBanner,
} from "./components/SwUpdateBanner";
import { hasDrafts } from "./lib/drafts";
import {
  SW_SWAP_MESSAGE,
  SW_UPDATE_MIN_INTERVAL_MS,
  demoForced,
  swUpdatePlan,
} from "./lib/swupdate";
import "./index.css";

// No StrictMode: its double-mount in dev races getUserMedia on iOS
// (camera stop/start aborts with AbortError).
createRoot(document.getElementById("root")!).render(
  <>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <SwUpdateBanner />
  </>,
);

// --- P2-266: service-worker update wiring ------------------------------------
// The plan lives in lib/swupdate.ts (pure, table-tested); this block only
// reads the environment and applies its verdicts. There is NO periodic timer
// and no background request: the plan is re-evaluated only when the document
// becomes visible again, and the registration is updated only when the plan
// says "check".

interface SwRuntime {
  registration: ServiceWorkerRegistration | null;
  lastCheckAt: number;
  streaming: boolean;
}

const sw: SwRuntime = { registration: null, lastCheckAt: 0, streaming: false };

// Evidence hatch (documented ?swupdate=demo): honored only inside the desktop
// shell during an automation-driven harness session (navigator.webdriver) and
// ignored on every normal boot. Resolved once — the search never changes
// without a reload.
const demo =
  typeof location !== "undefined" &&
  demoForced(location.search, {
    desktopShell:
      typeof window !== "undefined" &&
      (window as unknown as { ocrDesktop?: unknown }).ocrDesktop !== undefined,
    harnessSession:
      typeof navigator !== "undefined" && navigator.webdriver === true,
  });

document.addEventListener("ocr:streaming", (event) => {
  const detail = (event as CustomEvent<{ streaming?: boolean }>).detail;
  sw.streaming = detail?.streaming === true;
});

function swApplyPlan(): void {
  const verdict = swUpdatePlan({
    registered: sw.registration !== null,
    waitingWorker: sw.registration?.waiting != null,
    lastCheckAt: sw.lastCheckAt,
    now: Date.now(),
    streaming: sw.streaming,
    draftUnsent: hasDrafts(),
    minIntervalMs: SW_UPDATE_MIN_INTERVAL_MS,
    demo,
  });
  if (verdict.plan === "check") {
    sw.lastCheckAt = Date.now();
    void sw.registration?.update().catch(() => {
      // a failed recheck changes nothing — the next visibility tick retries
    });
    return;
  }
  if (verdict.plan === "offer") showSwUpdateBanner(swSwap);
}

function swSwap(): void {
  // The user's explicit action is the only lever: post the documented swap
  // message so the waiting worker calls skipWaiting (sw.js listener). With no
  // waiting worker (demo hatch) there is nothing to swap — the banner just
  // closes. Arming the reload here means ONLY the swap ever reloads: the
  // first worker's activation (clients.claim) also fires controllerchange and
  // must never bounce a first visit.
  const waiting = sw.registration?.waiting;
  if (waiting) {
    swSwapArmed = true;
    waiting.postMessage(SW_SWAP_MESSAGE);
  }
  hideSwUpdateBanner();
}

// Swap completion: the waiting worker takes over and this page starts being
// controlled by the new publication — reload exactly once, with an explicit
// guard against reload loops (a second takeover in the same page life is
// ignored; the new document re-arms nothing).
let swSwapArmed = false;
let swReloaded = false;
navigator.serviceWorker?.addEventListener?.("controllerchange", () => {
  if (!swSwapArmed || swReloaded) return;
  swReloaded = true;
  location.reload();
});

if (
  "serviceWorker" in navigator &&
  import.meta.env.PROD &&
  location.protocol !== "file:"
) {
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    sw.registration = registration;
    // Boot counts as a verification: the browser just revalidated /sw.js.
    sw.lastCheckAt = Date.now();
    // Cold start IS the weeks-old-publication scenario (the phone killed the
    // process and no visibility transition will ever fire): apply the plan
    // once now, then again on every visibility regain below.
    swApplyPlan();
  }).catch(() => {
    // A failed registration changes nothing and the banner never appears.
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    swApplyPlan();
  });
}
