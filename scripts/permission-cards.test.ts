/**
 * Unit tests for the P1-082 permission card lifecycle: dedupe by
 * permissionID, reconcile against the daemon's pending list, AutoMode
 * suppression and the friendly 404 mapping.
 * Run: npx tsx scripts/permission-cards.test.ts
 */
import {
  collectPermissionAsks,
  isPermissionResolvedElsewhere,
  reconcilePermissionCards,
} from "../apps/web/src/lib/permissionCards";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

function askEvent(id: string, permissionID: string, props: Record<string, unknown> = {}) {
  return {
    id,
    type: "permission.updated",
    properties: { sessionID: "s1", permissionID, type: "bash", ...props },
  };
}

function autoEvent(id: string, permissionID: string) {
  return {
    id,
    type: "ocr.permission.auto",
    properties: { sessionID: "s1", permissionID, action: "bash" },
  };
}

// --- collectPermissionAsks: dedupe --------------------------------------------
const tenDupes = Array.from({ length: 10 }, (_, i) => askEvent(`e${i}`, "perm-1"));
check(
  "dedupe: 10 events with the same permissionID → 1 ask",
  collectPermissionAsks(tenDupes, "s1").length === 1,
);
check(
  "dedupe: last occurrence wins (label updated)",
  collectPermissionAsks([askEvent("e0", "p", { type: "a" }), askEvent("e1", "p", { type: "b" })], "s1")[0]
    ?.label === "b",
);
check(
  "normalize: legacy `id` field dedupes like permissionID",
  collectPermissionAsks(
    [askEvent("e0", "p"), { id: "e1", type: "permission.updated", properties: { sessionID: "s1", id: "p" } }],
    "s1",
  ).length === 1,
);
check(
  "filter: events from other sessions are ignored",
  collectPermissionAsks([askEvent("e0", "p", { sessionID: "s2" })], "s1").length === 0,
);
check(
  "filter: non-permission events are ignored",
  collectPermissionAsks(
    [{ id: "e0", type: "message.updated", properties: { sessionID: "s1", id: "p" } }],
    "s1",
  ).length === 0,
);
check(
  "origin: auto event marks the ask auto (real-time flip)",
  collectPermissionAsks([askEvent("e0", "p"), autoEvent("e1", "p")], "s1")[0]?.auto === true,
);
check(
  "origin: plain ask is not auto",
  collectPermissionAsks([askEvent("e0", "p")], "s1")[0]?.auto === false,
);

// --- reconcilePermissionCards: lifecycle ---------------------------------------
const ask = { permissionID: "p1", label: "bash" };
const collected = collectPermissionAsks([askEvent("e0", "p1")], "s1");

const live = reconcilePermissionCards(collected, [ask], new Set(), false);
check("reconcile: pending + not responded + manual → actionable", live.actionable.length === 1);
check("reconcile: no resolved line while still pending", live.resolved.length === 0);

const offList = reconcilePermissionCards(collected, [], new Set(), false);
check("reconcile: gone from server pending → resolved, never actionable", offList.actionable.length === 0 && offList.resolved.length === 1);
check("reconcile: human-resolved origin is 'other'", offList.resolved[0]?.origin === "other");

const answered = reconcilePermissionCards(collected, [ask], new Set(["p1"]), false);
check(
  "reconcile: locally answered + still listed → no ghost card, no premature line",
  answered.actionable.length === 0 && answered.resolved.length === 0,
);

const autoMode = reconcilePermissionCards(collected, [ask], new Set(), true);
check("reconcile: autoMode=true → 0 actionable even with pending asks", autoMode.actionable.length === 0);
check("reconcile: autoMode pending ask is not claimed as resolved", autoMode.resolved.length === 0);

const autoCollected = collectPermissionAsks([askEvent("e0", "p1"), autoEvent("e1", "p1")], "s1");
const autoResolved = reconcilePermissionCards(autoCollected, [], new Set(), false);
check("reconcile: auto-approved origin is 'auto'", autoResolved.resolved[0]?.origin === "auto");

const persistedOnly = reconcilePermissionCards([], [{ permissionID: "p9", label: "edit" }], new Set(), false);
check(
  "reconcile: server pending seeds actionable without events (pre-mount asks)",
  persistedOnly.actionable.length === 1 && persistedOnly.actionable[0]?.permissionID === "p9",
);

const mixed = reconcilePermissionCards(
  collectPermissionAsks([askEvent("e0", "a"), askEvent("e1", "b"), autoEvent("e2", "c")], "s1"),
  [{ permissionID: "b", label: "bash" }],
  new Set(["a"]),
  false,
);
check(
  "reconcile: mixed board (a responded, b pending, c auto) splits correctly",
  mixed.actionable.length === 1 &&
    mixed.actionable[0]?.permissionID === "b" &&
    mixed.resolved.length === 2 &&
    mixed.resolved.find((r) => r.permissionID === "a")?.origin === "other" &&
    mixed.resolved.find((r) => r.permissionID === "c")?.origin === "auto",
);

// --- 404 mapping ----------------------------------------------------------------
check("404: mapped to already-resolved", isPermissionResolvedElsewhere(404) === true);
check("404: other statuses keep the raw error path", !isPermissionResolvedElsewhere(500) && !isPermissionResolvedElsewhere(403));

console.log(failures === 0 ? "ALL OK" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
