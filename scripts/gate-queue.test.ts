/**
 * P3-360: the first-boot offline queue. On the degraded journey (daemon down,
 * clean boot) the calm card now carries a real composer; whatever is saved
 * becomes the first message of the first conversation once the daemon
 * answers. Pins the contract of the pure queue lib (sanitize/read/write/clear
 * against a fake store — fail-safe on poisoned storage), the i18n keys in
 * every supported locale (result ≠ raw key, the P3-329 lesson), and the
 * source wiring: DegradedView renders the queue composer and App consumes it
 * on "paired" through the home composer's send-on-open flow.
 * Run: npx tsx scripts/gate-queue.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATE_QUEUE_KEY,
  GATE_QUEUE_MAX,
  clearGateQueue,
  readGateQueue,
  sanitizeQueue,
  writeGateQueue,
} from "../apps/web/src/lib/gatequeue";
import { translate } from "../apps/web/src/lib/i18n";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

// --- fake store (same surface as localStorage, no DOM) ------------------------
function fakeStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

// --- sanitize: trim, NUL-free, cap, non-string → "" ----------------------------
check("sanitize: trims whitespace", sanitizeQueue("  olá \n") === "olá");
check("sanitize: drops NULs", sanitizeQueue("a\u0000b") === "ab");
check("sanitize: non-string → empty", sanitizeQueue(null) === "" && sanitizeQueue(42) === "");
check(
  `sanitize: caps at GATE_QUEUE_MAX (${GATE_QUEUE_MAX})`,
  sanitizeQueue("x".repeat(GATE_QUEUE_MAX + 99)).length === GATE_QUEUE_MAX,
);

// --- read/write/clear round-trip ------------------------------------------------
const store = fakeStore();
check("read: empty store → empty", readGateQueue(store) === "");
writeGateQueue("  primeira mensagem  ", store);
check("write: persists trimmed text under the namespaced key", store.map.get(GATE_QUEUE_KEY) === "primeira mensagem");
check("read: round-trips what write stored", readGateQueue(store) === "primeira mensagem");
writeGateQueue("", store);
check("write: empty text clears the key", store.map.get(GATE_QUEUE_KEY) === undefined);
clearGateQueue(store);
check("clear: removing twice stays quiet", store.map.get(GATE_QUEUE_KEY) === undefined);

// --- fail-safe: a poisoned localStorage never takes the card down ---------------
const poison = fakeStore();
Object.defineProperty(poison, "getItem", {
  value: () => {
    throw new Error("SecurityError");
  },
});
check("read: throwing store → empty (fail-safe)", readGateQueue(poison) === "");
const readOnly = fakeStore({ [GATE_QUEUE_KEY]: "keep" });
Object.defineProperty(readOnly, "setItem", {
  value: () => {
    throw new Error("QuotaExceededError");
  },
});
writeGateQueue("novo", readOnly);
check("write: throwing store keeps the previous text", readGateQueue(readOnly) === "keep");

// --- i18n: every rendered key resolves in every locale (P3-329 lesson) ----------
for (const lang of ["en", "pt"] as const) {
  for (
    const key of [
      "degradedQueueTitle",
      "degradedQueueHint",
      "degradedQueuePlaceholder",
      "degradedQueueSave",
      "degradedQueueSaved",
    ] as const
  ) {
    const rendered = translate(lang, key);
    check(`${lang}.${key} resolves (≠ raw key)`, rendered !== key && rendered.trim() !== "", JSON.stringify(rendered));
  }
}

// --- source wiring: card renders the composer, App consumes the queue -----------
const view = src("apps/web/src/components/DegradedView.tsx");
check("DegradedView seeds the composer from the persisted queue", view.includes("readGateQueue"));
check("DegradedView persists through writeGateQueue (localStorage)", view.includes("writeGateQueue(queueText, localStorage)"));
check("DegradedView confirms the save with a status line", view.includes(`"degradedQueueSaved"`));
check(
  "composer grammar matches the home: Enter submits, Shift+Enter is a newline",
  view.includes(`e.key === "Enter" && !e.shiftKey`),
);

const app = src("apps/web/src/App.tsx");
check("App consumes the queue when the shell pairs", app.includes("readGateQueue(localStorage)"));
check("App rides the send-on-open flow (markSendOnOpen + prefill)", app.includes("markSendOnOpen(queued)") && app.includes("createSession(queued)"));
check("App clears the queue only after creation succeeds", /if \(!err\) clearGateQueue/.test(app));

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\ngate-queue checks passed");
