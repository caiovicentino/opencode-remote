/**
 * eval-09: the pairing scanner acquires the camera ONCE per mount.
 * QrScanner's capture effect used to depend on the onScan prop, and the
 * parent's handler changes identity on every App render (PairingView's
 * handleScan closes over App's inline onPair) — so every pairing-state push
 * tore the camera down and re-acquired a NEW MediaStream: a flickering
 * preview, a dead feed flipped from "unavailable" back to "preview", and the
 * desktop-flow scan-live flake (stream id dba9a43c → 771f2f2c mid-preview in
 * eval-12's diagnosis log). The fix mirrors CameraSheet: callbacks behind
 * refs, the capture effect keyed only on what really changes the capture.
 * The live proof is the scan-live beat of scripts/desktop-flow.test.ts (the
 * stream id must survive the parent re-renders of the 390px resize); this
 * file pins the wiring.
 * Run: npx tsx scripts/qr-camera.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const components = join(import.meta.dirname, "..", "apps", "web", "src", "components");
const scanner = readFileSync(join(components, "QrScanner.tsx"), "utf8");

check(
  "QrScanner keeps the scan callback behind a ref refreshed on render",
  scanner.includes("const onScanRef = useRef(onScan);") && scanner.includes("onScanRef.current = onScan;"),
);
check(
  "the decoded code is delivered through the ref, never the captured prop",
  scanner.includes("onScanRef.current(code.data);") && !/[^.]onScan\(code\.data\)/.test(scanner),
);

// The capture effect is the one that calls getUserMedia; its closing
// dependency list is the first 2-space-indented `}, [...]);` after the call.
const gumAt = scanner.indexOf("navigator.mediaDevices.getUserMedia(");
const effectAt = scanner.lastIndexOf("useEffect(() => {", gumAt);
const deps = gumAt === -1 ? null : scanner.slice(gumAt).match(/\n {2}\}, \[([^\]]*)\]\);/);
check(
  "the capture effect mounts once (empty dependency list)",
  gumAt !== -1 && effectAt !== -1 && !!deps && (deps[1] ?? "x").trim() === "",
  deps ? `deps: [${deps[1]}]` : "capture effect not found",
);
check(
  "no QrScanner effect is keyed on a callback prop",
  !/\}, \[[^\]]*\bon(Scan|Cancel|Paste)\b[^\]]*\]\);/.test(scanner) && !/\}, \[[^\]]*\bgetCamAccess\b[^\]]*\]\);/.test(scanner),
);

// Same idiom as the camera-ask sheet, whose capture effect restarts only on a
// real camera switch — the two camera state machines stay in step.
const sheet = readFileSync(join(components, "CameraSheet.tsx"), "utf8");
check("CameraSheet's capture effect stays keyed only on the facing mode", /\n {2}\}, \[facing\]\);/.test(sheet));

// The live beat exists: the stream id is read at preview and compared after
// the parent re-renders (390px resize + pairing-state pushes).
const flow = readFileSync(join(import.meta.dirname, "desktop-flow.test.ts"), "utf8");
check(
  "desktop-flow pins the stream id across parent re-renders in the scan-live beat",
  flow.includes("scan-live: the camera stream survives parent re-renders (one getUserMedia per mount)"),
);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall qr-camera checks passed");
