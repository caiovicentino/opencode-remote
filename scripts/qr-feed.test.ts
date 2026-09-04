/**
 * P2-117: QR scanner empty-feed verdict — the pure decision core of the
 * camera state machine (apps/web/src/lib/qrFeed.ts). A capture device with
 * no input ("NO SIGNAL" class of devices) must resolve to the unavailable
 * state, never to a dead black box that leaks the device's own OSD.
 * Run: npx tsx scripts/qr-feed.test.ts
 */
import { FEED_GRACE_MS, feedVerdict } from "../apps/web/src/lib/qrFeed";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

check("live feed (frames flowing) is preview", feedVerdict({ frames: 12, videoWidth: 640, trackEnded: false, elapsedMs: FEED_GRACE_MS * 10 }) === "preview");
check("first frame before the grace ends looking", feedVerdict({ frames: 1, videoWidth: 640, trackEnded: false, elapsedMs: 50 }) === "preview");

// grace window: no verdict before it — slow USB cameras take 1-2s for frame 1
check("no frames during the grace stays undecided (preview)", feedVerdict({ frames: 0, videoWidth: 0, trackEnded: false, elapsedMs: FEED_GRACE_MS - 1 }) === "preview");
check("no frames past the grace is empty", feedVerdict({ frames: 0, videoWidth: 0, trackEnded: false, elapsedMs: FEED_GRACE_MS }) === "empty");
check("no frames past the grace (far past) is empty", feedVerdict({ frames: 0, videoWidth: 640, trackEnded: false, elapsedMs: FEED_GRACE_MS * 3 }) === "empty");

// capture device with no input: decoder never locks a size
check("zero videoWidth past the grace is empty even with rVFC noise", feedVerdict({ frames: 3, videoWidth: 0, trackEnded: false, elapsedMs: FEED_GRACE_MS }) === "empty");

// feed lost mid-preview: unplugged camera, capture card losing signal
check("ended track is empty immediately", feedVerdict({ frames: 300, videoWidth: 640, trackEnded: true, elapsedMs: 100 }) === "empty");

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("QR FEED TESTS PASSED");
