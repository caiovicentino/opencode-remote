/**
 * eval-15 (red team): supply-chain gate hardening in scripts/lockintegrity.ts.
 *   - rule 4b: a registry origin must be the entry's OWN canonical tarball —
 *     a lockfile edit that points a trusted name at another package's
 *     tarball (with that tarball's valid sha512) used to approve;
 *   - isInternalOrigin: a parent segment anywhere is not provably internal;
 *   - the real package-lock.json still approves (zero false positives).
 * Run: npx tsx scripts/supplychain.test.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isInternalOrigin, lockEntryPackageName, lockIntegrityVerdict, tarballMatchesPackage, type LockEntry } from "./lockintegrity";
import { normalizeLockEntries } from "./check-lock-integrity";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const REGISTRIES = ["https://registry.npmjs.org/"];
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const SHA512 = "sha512-qqJ8zSCnXblcrXFTiwdt7RrZZXeiGQgT9M4WJfYuQP7YCVcsQpePE3LzIJLFa4M8=";
const entry = (path: string, resolved: string, extra: Partial<LockEntry> = {}): LockEntry => ({
  path,
  resolved,
  integrity: SHA512,
  internal: false,
  ...extra,
});

// --- rule 4b: lockfile injection ---------------------------------------------------
{
  const own = entry("node_modules/lodash", "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz", { version: "4.17.21" });
  const swapped = entry("node_modules/lodash", "https://registry.npmjs.org/evil-helper/-/evil-helper-1.0.0.tgz", { version: "4.17.21" });
  check("4b: the package's own tarball approves", lockIntegrityVerdict([own], REGISTRIES, [], NOW).outcome === "approve");
  const v = lockIntegrityVerdict([swapped], REGISTRIES, [], NOW);
  check(
    "4b: another package's tarball under a trusted name rejects (lockfile injection)",
    v.outcome === "reject" && v.lines.length === 1 && v.lines[0]!.includes("not the tarball of lodash@4.17.21"),
    JSON.stringify(v),
  );
  const exempted = lockIntegrityVerdict([swapped], REGISTRIES, [{ id: "node_modules/lodash", reason: "x", expiresAt: "2099-01-01T00:00:00.000Z" }], NOW);
  check("4b: a still-valid exemption cannot save an injected origin", exempted.outcome === "reject");
  const downgrade = entry("node_modules/lodash", "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz", { version: "4.17.21" });
  check("4b: an older tarball behind the pinned version rejects", lockIntegrityVerdict([downgrade], REGISTRIES, [], NOW).outcome === "reject");
  const lookalike = entry("node_modules/lodash", "https://registry.npmjs.org/lodash/-/lodash.merge-4.6.2.tgz", { version: "4.6.2" });
  check("4b: a same-prefix lookalike basename rejects", lockIntegrityVerdict([lookalike], REGISTRIES, [], NOW).outcome === "reject");
  const nested = entry("node_modules/foo/node_modules/@scope/pkg", "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz", { version: "2.0.0" });
  check("4b: nested scoped entry resolves its name from the last node_modules segment", lockIntegrityVerdict([nested], REGISTRIES, [], NOW).outcome === "approve" && lockEntryPackageName(nested) === "@scope/pkg");
  const encoded = entry("node_modules/@esbuild/darwin-arm64", "https://registry.npmjs.org/@esbuild%2fdarwin-arm64/-/darwin-arm64-0.25.12.tgz", { version: "0.25.12" });
  check("4b: a %2f-encoded scope slash is the same tarball", tarballMatchesPackage(encoded, REGISTRIES));
  const alias = entry("node_modules/string-width-cjs", "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz", { name: "string-width", version: "4.2.3" });
  check("4b: an npm alias (lockfile name field) approves on the aliased package", lockIntegrityVerdict([alias], REGISTRIES, [], NOW).outcome === "approve");
  const noVersion = entry("node_modules/left-pad", "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz");
  check("4b: without a declared version only the name is compared", lockIntegrityVerdict([noVersion], REGISTRIES, [], NOW).outcome === "approve");
  check("4b: a malformed percent-escape fails closed", !tarballMatchesPackage(entry("node_modules/x", "https://registry.npmjs.org/x/-/x-%E0.tgz", { version: "1.0.0" }), REGISTRIES));
  check("4b: origins outside the registries stay rule 4's business", tarballMatchesPackage(entry("node_modules/x", "https://evil.example/x.tgz"), REGISTRIES));
}

// --- isInternalOrigin: parent segments ---------------------------------------------------
{
  check("internal: plain workspace links stay internal", isInternalOrigin("apps/web") && isInternalOrigin("./packages/protocol"));
  check("internal: a parent segment anywhere is not provably internal", !isInternalOrigin("apps/../../outside") && !isInternalOrigin("apps\\..\\..\\outside") && !isInternalOrigin("apps/web/.."));
  check("internal: dots inside a segment name are fine", isInternalOrigin("apps/..hidden/x") && isInternalOrigin("apps/web.v2"));
  const escaped = normalizeLockEntries({ packages: { "node_modules/@ocr/web": { resolved: "apps/../../tmp/x", link: true } } });
  check("internal: an escaping link crosses the registry checks and rejects", !escaped[0]!.internal && lockIntegrityVerdict(escaped, REGISTRIES, [], NOW).outcome === "reject");
}

// --- the real lockfile --------------------------------------------------------------------
{
  const root = fileURLToPath(new URL("..", import.meta.url));
  const entries = normalizeLockEntries(JSON.parse(readFileSync(`${root}/package-lock.json`, "utf8")));
  const thirdParty = entries.filter((e) => !e.internal);
  check("real lockfile: normalizer carries versions for rule 4b", thirdParty.length > 100 && thirdParty.every((e) => typeof e.version === "string"));
  const verdict = lockIntegrityVerdict(entries, REGISTRIES, [], Date.now());
  check("real lockfile: still approves under rule 4b (no false positive)", verdict.outcome === "approve", verdict.lines.slice(0, 5).join("\n"));
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nall supply-chain checks passed");
