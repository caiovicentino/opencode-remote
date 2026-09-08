/**
 * P3-333: QR wait-state verdict — the pure decision core of the step-3
 * pairing ceremony (apps/web/src/lib/qrWait.ts). A slow or failed QR
 * generation must resolve to an inline error with a retry, never to an
 * eternal "Generating QR…" line.
 * Run: npx tsx scripts/qr-wait.test.ts
 */
import { QR_WAIT_TIMEOUT_MS, qrWaitVerdict } from "../apps/web/src/lib/qrWait";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

// a minted QR is always ready, whatever the clock says
check("truthy data URL is ready", qrWaitVerdict({ qrDataUrl: "data:image/png;base64,AA", elapsedMs: 0 }) === "ready");
check("truthy data URL stays ready after the timeout", qrWaitVerdict({ qrDataUrl: "data:image/png;base64,AA", elapsedMs: QR_WAIT_TIMEOUT_MS * 10 }) === "ready");

// wait state: no QR yet, inside the window
check("no QR at t=0 is waiting", qrWaitVerdict({ qrDataUrl: null, elapsedMs: 0 }) === "waiting");
check("no QR just before the timeout is waiting", qrWaitVerdict({ qrDataUrl: null, elapsedMs: QR_WAIT_TIMEOUT_MS - 1 }) === "waiting");
check("empty-string QR is not treated as ready", qrWaitVerdict({ qrDataUrl: "", elapsedMs: 100 }) === "waiting");
check("undefined QR (legacy payload) is waiting", qrWaitVerdict({ qrDataUrl: undefined, elapsedMs: 100 }) === "waiting");

// timeout: the wait resolves to the retryable error, never to a frozen skeleton
check("no QR at the timeout is error", qrWaitVerdict({ qrDataUrl: null, elapsedMs: QR_WAIT_TIMEOUT_MS }) === "error");
check("no QR far past the timeout is error", qrWaitVerdict({ qrDataUrl: null, elapsedMs: QR_WAIT_TIMEOUT_MS * 3 }) === "error");

// negative elapsed (clock skew) fails toward waiting, not error
check("negative elapsed is waiting", qrWaitVerdict({ qrDataUrl: null, elapsedMs: -5 }) === "waiting");

// the timeout stays generous-but-bounded: the QR is a local render, seconds
// not minutes — keeps the first-boot journey recoverable
check("timeout is between 5s and 60s", QR_WAIT_TIMEOUT_MS >= 5_000 && QR_WAIT_TIMEOUT_MS <= 60_000);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("QR WAIT TESTS PASSED");
