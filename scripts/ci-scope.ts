/**
 * P2-147: PR scope classifier for the desktop packaging job.
 *
 * The release workflow only discovers a broken electron-builder config or a
 * missing extraResources entry in the desktop-dmg job — after the release is
 * already created (the exact version-dr-adjacent risk P2-130 mitigated on the
 * version side). `touchesDesktop` classifies a changed-path list (the output
 * of `git diff --name-only`) so CI can package the mac shell on every PR that
 * touches the desktop surface instead.
 *
 * Pure by design: the exported function takes an in-memory list and the CLI
 * mode below only reads argv + $GITHUB_OUTPUT — no git, no network, no
 * third-party GitHub action.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Directory prefixes whose change can alter the packaged bundle. */
const DESKTOP_DIRS = ["apps/desktop/", "apps/web/"];

/** Exact entries (dirs listed bare, plus the root lockfile) that count. */
const EXACT_ENTRIES = ["apps/desktop", "apps/web", "package-lock.json"];

/**
 * True when any changed path sits inside the desktop packaging surface:
 * apps/desktop (shell + electron-builder.yml), apps/web (the UI shipped as
 * web-dist) or the root package-lock.json (dependency drift affects the
 * bundle). Paths are normalized (backslashes/./ prefix) so a diff produced
 * on any OS classifies the same.
 */
export function touchesDesktop(changed: readonly string[]): boolean {
  return changed.some((raw) => {
    const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (path === "") return false;
    if (EXACT_ENTRIES.includes(path)) return true;
    return DESKTOP_DIRS.some((dir) => path.startsWith(dir));
  });
}

function cli(argv: readonly string[]): void {
  const desktop = touchesDesktop(argv);
  const line = `desktop=${desktop ? "true" : "false"}`;
  console.log(`ci-scope: ${line}`);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return; // local run: the printed line is the whole interface
  appendFileSync(output, `${line}\n`);
}

// CLI guard: run the GITHUB_OUTPUT mode only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
