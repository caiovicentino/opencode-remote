/**
 * Unit tests for the daemon prompt-idempotency cache (apps/daemon/src/idempotency.ts).
 * Run: npx tsx scripts/idempotency.test.ts
 */
import { IdempotencyCache } from "../apps/daemon/src/idempotency";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

check("fresh key not seen", !new IdempotencyCache().seen("a"));
check("remembered key is seen", new IdempotencyCache().seen("a") === false && (() => {
  const c = new IdempotencyCache();
  c.remember("a");
  return c.seen("a");
})());

// TTL expiry: inject an old timestamp by reaching into the map (same-package semantics)
{
  const c = new IdempotencyCache(1000);
  c.remember("old");
  (c as unknown as { entries: Map<string, number> }).entries.set("old", Date.now() - 2000);
  check("expired key is not seen", !c.seen("old"));
}

// LRU cap: oldest entries evicted beyond cap
{
  const c = new IdempotencyCache(60_000, 3);
  for (const k of ["a", "b", "c", "d"]) c.remember(k);
  check("cap evicts oldest", !c.seen("a") && c.seen("d") && c.seen("c") && c.seen("b"));
}

// re-remember refreshes recency
{
  const c = new IdempotencyCache(60_000, 2);
  c.remember("a");
  c.remember("b");
  c.remember("a"); // refresh a → b becomes oldest
  c.remember("c");
  check("re-remember refreshes recency", c.seen("a") && !c.seen("b") && c.seen("c"));
}

if (failures) process.exit(1);
console.log("idempotency: all checks passed");
