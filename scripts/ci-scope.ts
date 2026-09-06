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
 * Pure by design: the exported functions take an in-memory list and the CLI
 * mode below only reads argv + $GITHUB_OUTPUT — no git, no network, no
 * third-party GitHub action. P2-222 adds the sister classifier
 * `touchesRelayImage` (same contract, relay image surface) so a broken
 * deploy/relay/Dockerfile fails the PR instead of the release-day job.
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

/** Directory prefixes whose change can alter the relay image. */
const RELAY_DIRS = ["apps/relay/"];

/** Exact entries (dirs listed bare, plus the image-surface files) that count. */
const RELAY_EXACT_ENTRIES = [
  "apps/relay",
  "deploy/relay/Dockerfile",
  ".dockerignore",
  "package-lock.json",
];

/**
 * P2-222: true when any changed path sits inside the relay image surface:
 * apps/relay (the source the image compiles), deploy/relay/Dockerfile
 * itself, the root .dockerignore (docker build-context exclusions) or the
 * root package-lock.json (dependency drift changes what the image installs).
 * Normalization is identical to touchesDesktop's, so a diff produced on any
 * OS classifies the same. Sister of touchesDesktop: same shape, different
 * surface — this one gates the PR-scoped relay-image CI job instead of the
 * tag-only release job.
 */
export function touchesRelayImage(changed: readonly string[]): boolean {
  return changed.some((raw) => {
    const path = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (path === "") return false;
    if (RELAY_EXACT_ENTRIES.includes(path)) return true;
    return RELAY_DIRS.some((dir) => path.startsWith(dir));
  });
}

function cli(argv: readonly string[]): void {
  const desktop = touchesDesktop(argv);
  const relayImage = touchesRelayImage(argv);
  // P2-222: two scope indicators now flow out of the same classification —
  // the desktop line stays byte for byte what it always was, the relay-image
  // line gates the new PR relay-image job beside it.
  const lines = [
    `desktop=${desktop ? "true" : "false"}`,
    `relay-image=${relayImage ? "true" : "false"}`,
  ];
  for (const line of lines) console.log(`ci-scope: ${line}`);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return; // local run: the printed line is the whole interface
  for (const line of lines) appendFileSync(output, `${line}\n`);
}

// CLI guard: run the GITHUB_OUTPUT mode only when executed directly.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) cli(process.argv.slice(2));
