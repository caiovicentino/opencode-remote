/**
 * eval-16: release & distribution — the first tag must end in a complete,
 * verified DRAFT, and a third party must have install paths that work.
 *   1. electron-builder resolves the GitHub repository from apps/desktop, so
 *      `npm run dist` writes latest-mac.yml / latest.yml (the update-feed
 *      step and the Windows upload need them);
 *   2. release notes stay under GitHub's 125,000-character body ceiling;
 *   3. rollout.mjs (the release brake) speaks gh's real argv contract;
 *   4. release.yml: one run per ref, capped notes, idempotent draft,
 *      --publish never, a real ad-hoc signature, opt-in publication, and no
 *      pipeline push to main; the upload globs attach a complete, consistent
 *      set (both Squirrel.Mac zips included) and release-verify/release-feeds
 *      can see the draft (contents: write);
 *   5. an ad-hoc/unsigned macOS build takes the manual update flow instead of
 *      a Squirrel.Mac download bound to fail;
 *   6. `opencode-remote setup` refuses a relay the phone cannot reach, builds
 *      the web app, and prints a QR with the relay it was given;
 *   7. the Homebrew formula builds the web app and the workflow's pin really
 *      rewrites url/version/sha256 of the real file.
 * Hermetic: temp dirs only, a fake `gh` on PATH, no network, no ports.
 * Run: npx tsx scripts/release-distribution.test.ts
 */
// testhome FIRST (fix-round): throwaway HOME for the whole suite plus the
// launchctl/pkill PATH shims — section 6 spawns the real cli.mjs setup and a
// refusal regression must never reach the host's launchd domain.
import "./testhome";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkForUpdatesOnBoot, type UpdaterLike, type UpdateStatus } from "../apps/desktop/src/update";
import { bundlePathFromExec, macSigningFromCodesign, squirrelCanApply } from "../apps/desktop/src/macsigning";
import { CODESIGN_ARGS, CODESIGN_BIN, runningMacSigning } from "../apps/desktop/src/macsigningprobe";
import { ghDownloadArgs, ROLLOUT_FEED_ASSETS } from "../apps/desktop/scripts/rollout.mjs";
import { relayUrlFromArgv, relayUrlProblem, WEB_DIST_INDEX } from "../cli-setup.mjs";
import { capReleaseNotes, omissionLine, RELEASE_BODY_MAX_CHARS, RELEASE_NOTES_BUDGET_CHARS } from "./release-body";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.error("  ", detail);
  }
}

const repoRoot = join(import.meta.dirname, "..");
const tsxEntry = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const requireFromRepo = createRequire(join(repoRoot, "package.json"));
const releaseYml = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

/** The text without its YAML comment lines — the assertions below are about
 * what runs, and the comments deliberately quote the commands they replaced. */
function codeOnly(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** One job block of release.yml (from its key to the next top-level job). */
function jobBlock(name: string): string {
  const start = releaseYml.indexOf(`\n  ${name}:\n`);
  if (start === -1) return "";
  const rest = releaseYml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

// --- 1. electron-builder writes the update metadata ---------------------------
{
  // electron-builder only writes latest-mac.yml / latest.yml when its
  // repository info resolves to GitHub. It looks at the app package.json's
  // `repository` and at <projectDir>/.git/config — and projectDir is
  // apps/desktop, which has no .git. A full `npm run dist` on 2026-09-12
  // produced both DMGs and both zips and NO latest-mac.yml.
  type RepoInfo = { type?: string; user?: string; project?: string } | null;
  const { getRepositoryInfo } = requireFromRepo("app-builder-lib/out/util/repositoryInfo") as {
    getRepositoryInfo: (projectDir: string, metadata: unknown, devMetadata: unknown) => Promise<RepoInfo>;
  };
  const desktopDir = join(repoRoot, "apps", "desktop");
  const pkg = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8")) as Record<string, unknown>;
  const info = await getRepositoryInfo(desktopDir, pkg, pkg);
  check(
    "eval-16: electron-builder resolves apps/desktop to the GitHub repo (update metadata gets written)",
    info?.type === "github" && info.user === "caiovicentino" && info.project === "opencode-remote",
    JSON.stringify(info),
  );
  const { repository: _dropped, ...withoutRepository } = pkg;
  const control = await getRepositoryInfo(desktopDir, withoutRepository, withoutRepository);
  check(
    "eval-16: control — without the repository field apps/desktop resolves to nothing (the pre-fix state)",
    control === null,
    JSON.stringify(control),
  );
}

// --- 2. release notes under GitHub's ceiling ----------------------------------
{
  const small = "## What's Changed\n* one by @a in https://x/pull/1\n\n**Full Changelog**: https://x/commits/v1\n";
  const unchanged = capReleaseNotes(small);
  check("eval-16: notes under the budget come back byte for byte", unchanged.body === small && !unchanged.capped && unchanged.omitted === 0);

  // The shape GitHub generates: header, one bullet per merged PR (oldest
  // first), New Contributors, Full Changelog — sized like the measured v0.2.0
  // body (1,386 lines, 203,972 chars).
  const bullets = Array.from(
    { length: 1380 },
    (_, i) => `* pilot(P3-${String(i).padStart(3, "0")}): a merged change with a long enough title to matter by @caiovicentino in https://github.com/caiovicentino/opencode-remote/pull/${i + 2}`,
  );
  const changelog = "**Full Changelog**: https://github.com/caiovicentino/opencode-remote/commits/v0.2.0";
  const big = [
    "## What's Changed",
    ...bullets,
    "",
    "## New Contributors",
    "* @caiovicentino made their first contribution in https://github.com/caiovicentino/opencode-remote/pull/2",
    "",
    changelog,
  ].join("\n");
  check("eval-16: fixture is above the GitHub ceiling, like the real first release", big.length > RELEASE_BODY_MAX_CHARS, String(big.length));
  const capped = capReleaseNotes(big);
  const lines = capped.body.split("\n");
  const kept = lines.filter((l) => l.startsWith("* pilot("));
  check("eval-16: capped notes fit the budget", capped.capped && capped.body.length <= RELEASE_NOTES_BUDGET_CHARS, String(capped.body.length));
  check("eval-16: capped notes keep the header first", lines[0] === "## What's Changed");
  check(
    "eval-16: capped notes keep the NEWEST entries (the tail of the list) and state the omitted count",
    kept.length > 0 &&
      kept[kept.length - 1] === bullets[bullets.length - 1] &&
      kept[0] === bullets[bullets.length - kept.length] &&
      capped.omitted === bullets.length - kept.length &&
      lines[1] === omissionLine(capped.omitted),
    `kept=${kept.length} omitted=${capped.omitted}`,
  );
  check("eval-16: capped notes keep the Full Changelog link last", lines.filter((l) => l.length > 0).at(-1) === changelog);
  const noBullets = capReleaseNotes(`${"x".repeat(80)}\n`.repeat(3000), 1000);
  check("eval-16: a body with no bullet list still ends under the budget", noBullets.body.length <= 1000 && noBullets.capped);

  // release-notes.ts refuses (exit 1, reason named) a body the guide would
  // push over the ceiling — the PATCH would otherwise die with an opaque 422.
  const dir = mkdtempSync(join(tmpdir(), "release-dist-notes-"));
  const assets = join(dir, "assets.txt");
  const body = join(dir, "body.md");
  writeFileSync(
    assets,
    ["OpenCode-Remote-0.3.0-arm64.dmg", "OpenCode-Remote-0.3.0-x64.dmg", "OpenCode-Remote-Setup-0.3.0.exe", "checksums.txt"].join("\n"),
  );
  const runNotes = () =>
    spawnSync(process.execPath, [tsxEntry, join(repoRoot, "scripts", "release-notes.ts"), "v0.3.0", assets, body], {
      cwd: repoRoot,
      encoding: "utf8",
    });
  writeFileSync(body, "x".repeat(RELEASE_BODY_MAX_CHARS - 100));
  const over = runNotes();
  check(
    "eval-16: release-notes.ts fails closed when guide + body exceed the ceiling (body untouched)",
    over.status === 1 && `${over.stderr}`.includes("ceiling") && readFileSync(body, "utf8").length === RELEASE_BODY_MAX_CHARS - 100,
    `${over.status} ${over.stderr}`,
  );
  writeFileSync(body, small);
  const fine = runNotes();
  check("eval-16: release-notes.ts still applies the guide to a normal body", fine.status === 0 && readFileSync(body, "utf8").includes(small), `${fine.status} ${fine.stderr}`);
  rmSync(dir, { recursive: true, force: true });
}

// --- 3. rollout.mjs over a gh that enforces the real argv contract ------------
{
  // gh 2.86 (measured): `gh release download v9.9.9 update-mac.json latest.yml`
  // → "accepts at most 1 arg(s), received 3", exit 1. Asset names ride
  // --pattern. This fake enforces exactly that contract.
  const fakeBin = mkdtempSync(join(tmpdir(), "release-dist-gh-"));
  const releaseDir = mkdtempSync(join(tmpdir(), "release-dist-release-"));
  const logPath = join(fakeBin, "gh.log");
  writeFileSync(
    join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      'import { appendFileSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";',
      'import { basename, join } from "node:path";',
      "const argv = process.argv.slice(2);",
      'appendFileSync(process.env.OCR_FAKE_GH_LOG, JSON.stringify(argv) + "\\n");',
      "const rel = process.env.OCR_FAKE_RELEASE_DIR;",
      'if (argv[0] === "release" && argv[1] === "download") {',
      '  const positional = []; const patterns = []; let dir = ".";',
      "  for (let i = 2; i < argv.length; i++) {",
      "    const a = argv[i];",
      '    if (a === "--pattern" || a === "-p") { patterns.push(argv[++i]); continue; }',
      '    if (a === "--dir" || a === "-D") { dir = argv[++i]; continue; }',
      '    if (a.startsWith("-")) { console.error("unknown flag: " + a); process.exit(1); }',
      "    positional.push(a);",
      "  }",
      '  if (positional.length > 1) { console.error("accepts at most 1 arg(s), received " + positional.length); process.exit(1); }',
      "  mkdirSync(dir, { recursive: true });",
      "  let n = 0;",
      "  for (const name of readdirSync(rel)) if (patterns.includes(name)) { copyFileSync(join(rel, name), join(dir, name)); n++; }",
      '  if (n === 0) { console.error("no assets match the file pattern"); process.exit(1); }',
      "  process.exit(0);",
      "}",
      'if (argv[0] === "release" && argv[1] === "upload") {',
      '  for (const f of argv.slice(3).filter((a) => !a.startsWith("-"))) copyFileSync(f, join(rel, basename(f)));',
      "  process.exit(0);",
      "}",
      'console.error("fake gh: unsupported " + argv.join(" ")); process.exit(1);',
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "gh"), 0o755);
  const armFeed = `${JSON.stringify({ url: "https://github.com/o/r/releases/download/v0.3.0/OpenCode-Remote-0.3.0-arm64.zip", name: "0.3.0", notes: "", pub_date: "2026-09-27T00:00:00.000Z" }, null, 2)}\n`;
  const x64Feed = `${JSON.stringify({ url: "https://github.com/o/r/releases/download/v0.3.0/OpenCode-Remote-0.3.0-x64.zip", name: "0.3.0", notes: "", pub_date: "2026-09-27T00:00:00.000Z" }, null, 2)}\n`;
  const yml = "version: 0.3.0\nfiles:\n  - url: OpenCode-Remote-Setup-0.3.0.exe\n    sha512: YWJj\n    size: 3\npath: OpenCode-Remote-Setup-0.3.0.exe\nsha512: YWJj\nreleaseDate: '2026-09-27T00:00:00.000Z'\n";
  writeFileSync(join(releaseDir, "update-mac.json"), armFeed);
  writeFileSync(join(releaseDir, "update-mac-arm64.json"), armFeed);
  writeFileSync(join(releaseDir, "update-mac-x64.json"), x64Feed);
  writeFileSync(join(releaseDir, "latest.yml"), yml);
  writeFileSync(join(releaseDir, "OpenCode-Remote-0.3.0-arm64.zip"), "zip-bytes");
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, OCR_FAKE_GH_LOG: logPath, OCR_FAKE_RELEASE_DIR: releaseDir };

  const args = ghDownloadArgs("v0.3.0", "/tmp/x");
  const positional = args.slice(2).filter((a, i, all) => !a.startsWith("-") && !["--pattern", "--dir"].includes(all[i - 1] ?? ""));
  check(
    "eval-16: rollout download argv carries ONE positional (the tag) and every feed behind --pattern",
    JSON.stringify(positional) === JSON.stringify(["v0.3.0"]) &&
      ROLLOUT_FEED_ASSETS.every((name) => args[args.indexOf(name) - 1] === "--pattern"),
    JSON.stringify(args),
  );
  const oldShape = spawnSync("gh", ["release", "download", "v0.3.0", ...ROLLOUT_FEED_ASSETS, "--dir", join(fakeBin, "old")], { env, encoding: "utf8" });
  check(
    "eval-16: the fake gh rejects the P3-460 argv shape exactly like gh 2.86 does",
    oldShape.status === 1 && oldShape.stderr.includes("accepts at most 1 arg(s), received 5"),
    `${oldShape.status} ${oldShape.stderr}`,
  );
  const cli = join(repoRoot, "apps", "desktop", "scripts", "rollout.mjs");
  const run40 = spawnSync(process.execPath, [cli, "v0.3.0", "40"], { env, encoding: "utf8" });
  check(
    "eval-16: rollout.mjs v0.3.0 40 succeeds against the real gh contract",
    run40.status === 0 && run40.stdout.includes("rollout: OK v0.3.0 — 40"),
    `${run40.status} ${run40.stdout}${run40.stderr}`,
  );
  check(
    "eval-16: the four feeds on the release now carry 40, the alias stays identical, the zip is untouched",
    (JSON.parse(readFileSync(join(releaseDir, "update-mac-arm64.json"), "utf8")) as { rolloutPercent?: number }).rolloutPercent === 40 &&
      (JSON.parse(readFileSync(join(releaseDir, "update-mac-x64.json"), "utf8")) as { rolloutPercent?: number }).rolloutPercent === 40 &&
      readFileSync(join(releaseDir, "update-mac.json"), "utf8") === readFileSync(join(releaseDir, "update-mac-arm64.json"), "utf8") &&
      /^stagingPercentage: 40$/m.test(readFileSync(join(releaseDir, "latest.yml"), "utf8")) &&
      readFileSync(join(releaseDir, "OpenCode-Remote-0.3.0-arm64.zip"), "utf8") === "zip-bytes",
  );
  const run0 = spawnSync(process.execPath, [cli, "v0.3.0", "0"], { env, encoding: "utf8" });
  check(
    "eval-16: the documented suspension (0) works end to end",
    run0.status === 0 && /^stagingPercentage: 0$/m.test(readFileSync(join(releaseDir, "latest.yml"), "utf8")),
    `${run0.status} ${run0.stderr}`,
  );
  rmSync(fakeBin, { recursive: true, force: true });
  rmSync(releaseDir, { recursive: true, force: true });
}

// --- 3b. P3-457 end to end: a gradual rollout survives the release's own checks
{
  // update-feed.mjs writes the percentage (P3-458), the release-feeds job's
  // verifiers (feed-consistency.ts, feedhash.ts) must accept the additive
  // fields, and rollout.mjs (section 3) moves it afterwards — together the
  // "fraction of the machines" and "suspend without deleting assets" of P3-457.
  const dir = mkdtempSync(join(tmpdir(), "release-dist-p3457-"));
  const mac = join(dir, "mac");
  const win = join(dir, "win");
  mkdirSync(mac);
  mkdirSync(win);
  writeFileSync(join(mac, "OpenCode-Remote-0.3.0-arm64.zip"), "zip-arm");
  writeFileSync(join(mac, "OpenCode-Remote-0.3.0-x64.zip"), "zip-x64");
  writeFileSync(
    join(mac, "latest-mac.yml"),
    "version: 0.3.0\nfiles:\n  - url: OpenCode-Remote-0.3.0-x64.zip\n    sha512: abc\n    size: 7\npath: OpenCode-Remote-0.3.0-x64.zip\nsha512: abc\nreleaseDate: '2026-09-27T12:00:00.000Z'\n",
  );
  const exe = "OpenCode-Remote-Setup-0.3.0.exe";
  writeFileSync(join(win, exe), "exe-bytes");
  const { createHash } = await import("node:crypto");
  const exeSha = createHash("sha512").update(readFileSync(join(win, exe))).digest("base64");
  writeFileSync(
    join(win, "latest.yml"),
    `version: 0.3.0\nfiles:\n  - url: ${exe}\n    sha512: ${exeSha}\n    size: 9\npath: ${exe}\nsha512: ${exeSha}\nreleaseDate: '2026-09-27T12:00:00.000Z'\n`,
  );
  const feedScript = join(repoRoot, "apps", "desktop", "scripts", "update-feed.mjs");
  const env = { ...process.env, ROLLOUT_PERCENT: "20", GITHUB_REF_NAME: "v0.3.0" };
  const macRun = spawnSync(process.execPath, [feedScript, "--dist", mac], { encoding: "utf8", env });
  const winRun = spawnSync(process.execPath, [feedScript, "--staging-yml", "--dist", win], { encoding: "utf8", env });
  const arm = existsSync(join(mac, "update-mac-arm64.json")) ? readFileSync(join(mac, "update-mac-arm64.json"), "utf8") : "";
  check(
    "P3-457: ROLLOUT_PERCENT=20 lands in the mac JSON feeds and in latest.yml",
    macRun.status === 0 && winRun.status === 0 && /"rolloutPercent": 20/.test(arm) && /^stagingPercentage: 20$/m.test(readFileSync(join(win, "latest.yml"), "utf8")),
    `${macRun.stderr}${winRun.stderr}`,
  );
  const assets = [
    "OpenCode-Remote-0.3.0-arm64.dmg",
    "OpenCode-Remote-0.3.0-x64.dmg",
    "OpenCode-Remote-0.3.0-arm64.zip",
    "OpenCode-Remote-0.3.0-x64.zip",
    exe,
    "latest-mac.yml",
    "latest.yml",
    "update-mac.json",
    "update-mac-arm64.json",
    "update-mac-x64.json",
  ].join("\n");
  const consistency = spawnSync(
    process.execPath,
    [tsxEntry, join(repoRoot, "scripts", "feed-consistency.ts"), "v0.3.0", join(mac, "update-mac.json"), join(win, "latest.yml"), join(mac, "update-mac-arm64.json"), join(mac, "update-mac-x64.json")],
    { cwd: repoRoot, encoding: "utf8", input: assets },
  );
  check(
    "P3-457: the release-feeds consistency check accepts the additive rollout fields",
    consistency.status === 0 && consistency.stdout.includes("feed-consistency: OK v0.3.0"),
    `${consistency.status} ${consistency.stdout}${consistency.stderr}`,
  );
  const hashInput = JSON.stringify({
    feeds: [{ label: "latest.yml", yml: readFileSync(join(win, "latest.yml"), "utf8") }],
    measured: [{ fileName: exe, sha512: exeSha, size: 9 }],
  });
  const hash = spawnSync(process.execPath, [tsxEntry, join(repoRoot, "scripts", "feedhash.ts")], { cwd: repoRoot, encoding: "utf8", input: hashInput });
  check(
    "P3-457: the release-feeds digest check accepts a latest.yml carrying stagingPercentage",
    hash.status === 0 && hash.stdout.includes("feedhash: OK"),
    `${hash.status} ${hash.stdout}${hash.stderr}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

// --- 4. release.yml wiring -----------------------------------------------------
{
  check(
    "eval-16: one release run per ref, queued (never cancelled)",
    /^concurrency:\n {2}group: release-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false$/m.test(releaseYml),
  );
  const release = codeOnly(jobBlock("release"));
  const notesAt = release.indexOf("releases/generate-notes");
  const capAt = release.indexOf("scripts/release-body.ts");
  const createAt = release.indexOf("gh release create");
  check(
    "eval-16: the release job generates the notes through the API and caps them BEFORE creating the draft",
    notesAt > -1 && capAt > notesAt && createAt > capAt,
    `notes=${notesAt} cap=${capAt} create=${createAt}`,
  );
  const createLine = release.split("\n").find((l) => l.includes("gh release create")) ?? "";
  check(
    "eval-16: the draft is created from the capped file, never from server-side --generate-notes",
    createLine.includes("--draft") && createLine.includes("--notes-file release-notes.md") && !codeOnly(releaseYml).includes("--generate-notes"),
    createLine,
  );
  check(
    "eval-16: the create step reuses an existing draft, refuses a published release and fails closed on anything else",
    release.includes('if [ "$STATE" = "true" ]') &&
      release.includes("already published") &&
      release.includes('grep -q "release not found"') &&
      release.includes("could not tell whether release"),
  );
  const distLines = releaseYml.split("\n").filter((l) => l.includes("npm run dist --workspace @ocr/desktop"));
  check(
    "eval-16: every packaging command in release.yml passes --publish never (the workflow owns uploads)",
    distLines.length === 3 && distLines.every((l) => l.includes("--publish never")),
    distLines.join("\n"),
  );
  const dmg = codeOnly(jobBlock("desktop-dmg"));
  const devIdAt = dmg.indexOf('elif [ "${{ steps.signing.outputs.mode }}" = "developer-id" ]');
  const adhocAt = dmg.indexOf('SIGN="-c.mac.identity=-"');
  const noNotarize = [...dmg.matchAll(/NOTARIZE="-c\.mac\.notarize=false"/g)].map((m) => m.index ?? -1);
  check(
    "eval-16: the no-Developer-ID branch signs ad-hoc for real; notarize=no is explicit in both non-notarizing branches",
    devIdAt > -1 &&
      adhocAt > devIdAt &&
      noNotarize.length === 2 &&
      (noNotarize[0] ?? -1) > devIdAt &&
      (noNotarize[0] ?? -1) < adhocAt &&
      (noNotarize[1] ?? -1) > adhocAt &&
      dmg.includes("npm run dist --workspace @ocr/desktop -- --publish never $SIGN $NOTARIZE"),
    JSON.stringify({ devIdAt, adhocAt, noNotarize }),
  );
  const publish = jobBlock("release-publish");
  const verdictAt = publish.indexOf("scripts/release-publish.ts");
  const gateAt = publish.indexOf('if [ "${AUTO_PUBLISH:-}" = "true" ]; then');
  const editAt = publish.indexOf('gh release edit "$GITHUB_REF_NAME" --draft=false');
  check(
    "eval-16: going public is opt-in — the edit runs only under RELEASE_AUTO_PUBLISH=true, after the verdict",
    publish.includes("AUTO_PUBLISH: ${{ vars.RELEASE_AUTO_PUBLISH }}") && verdictAt > -1 && gateAt > verdictAt && editAt > gateAt,
    `verdict=${verdictAt} gate=${gateAt} edit=${editAt}`,
  );
  check("eval-16: the default path writes the publish command to the job summary", publish.includes('>> "$GITHUB_STEP_SUMMARY"'));
  check("eval-16: no step of release.yml pushes to any branch", !/\bgit push\b/.test(codeOnly(releaseYml)));
  // eval-15 note: npm ci / npx run third-party lifecycle scripts in jobs that
  // hold contents: write — the token must not sit in .git/config. No job uses
  // git credentials (gh gets GH_TOKEN through env), so every checkout drops them.
  const checkouts = releaseYml.split("\n").flatMap((line, i, all) =>
    line.includes("uses: actions/checkout@") ? [all.slice(i + 1, i + 6).join("\n")] : [],
  );
  check(
    "eval-16: every release.yml checkout sets persist-credentials: false, and no step runs an authenticated git command",
    checkouts.length === 7 &&
      checkouts.every((next) => /^\s+persist-credentials: false$/m.test(next)) &&
      !/\bgit (push|fetch|pull|remote|config)\b/.test(codeOnly(releaseYml)),
    `checkouts=${checkouts.length}`,
  );
  // eval-16 (fix-round): the release is ALWAYS a draft when release-verify and
  // release-feeds run (P2-179), and GitHub only lists drafts to push access —
  // for the GITHUB_TOKEN that means contents: write. With contents: read both
  // jobs fail on "release not found" and release-publish (needs both) never
  // runs, so the draft is never verified.
  const scopes = JSON.parse(readFileSync(join(repoRoot, "scripts", "workflow-scopes.json"), "utf8")) as {
    jobs?: Record<string, readonly string[]>;
  };
  /** The scope line a job's own `permissions:` block declares (comments ignored). */
  const scopeOf = (job: string): string | null => {
    const block = jobBlock(job);
    const group = /\n {4}permissions:\n((?: {6}[^\n]*\n)+)/.exec(block)?.[1];
    if (!group) return null;
    return / {6}([a-z-]+: (?:read|write|none))\n/.exec(group)?.[1] ?? null;
  };
  check(
    "eval-16: release-verify and release-feeds declare contents: write in release.yml, name the draft-visibility reason, and the scopes allowlist agrees",
    scopeOf("release-verify") === "contents: write" &&
      scopeOf("release-feeds") === "contents: write" &&
      jobBlock("release-verify").includes("draft") &&
      jobBlock("release-feeds").includes("draft") &&
      scopes.jobs?.["release.yml/release-verify"]?.includes("contents:write") === true &&
      scopes.jobs?.["release.yml/release-feeds"]?.includes("contents:write") === true,
    `verify=${scopeOf("release-verify")} feeds=${scopeOf("release-feeds")}`,
  );
  check(
    "eval-16: the pinned formula is attached as a release asset",
    publish.includes("gh release upload \"$GITHUB_REF_NAME\" formula-pin/opencode-remote.rb --clobber"),
  );
  // Structural parse (js-yaml is in the tree through electron-builder).
  try {
    const yaml = requireFromRepo("js-yaml") as { load: (s: string) => unknown };
    const doc = yaml.load(releaseYml) as { concurrency?: { group?: string }; jobs?: Record<string, { steps?: { name?: string }[] }> };
    const names = (doc.jobs?.release?.steps ?? []).map((s) => s.name ?? "");
    check(
      "eval-16: parsed release job step order — preflight, tarball, notes, draft",
      doc.concurrency?.group === "release-${{ github.ref }}" &&
        names.indexOf("Generate the release notes (capped below GitHub's body limit)") > names.indexOf("Build source tarball (node_modules excluded)") &&
        names.indexOf("Create GitHub release (draft)") > names.indexOf("Generate the release notes (capped below GitHub's body limit)"),
      JSON.stringify(names),
    );
  } catch (err) {
    check("eval-16: release.yml parses as YAML", false, (err as Error).message);
  }
}

// --- 4b. the upload globs attach a complete, consistent set --------------------
{
  // eval-16 (fix-round): the rehearsal ran release-assets.ts over the DIST
  // listing, not over what the upload steps actually attach — so a missing
  // glob (the Squirrel.Mac zips the update-mac*.json feeds point at) stayed
  // invisible and the "complete, verified draft" promise was never real.
  // This section derives the attached set from the REAL globs of the upload
  // steps over a realistic dist listing (the measured rehearsal shape:
  // zips, blockmaps, builder-debug.yml, win-unpacked), then runs BOTH
  // release verifiers on exactly that set.
  const tag = "v0.2.0";

  /** Every path token the `gh release upload` statements of a job hand over,
   * multi-line continuations included (flags and "$GITHUB_REF_NAME" skipped). */
  const uploadTokens = (job: string): string[] => {
    const lines = job.split("\n");
    const tokens: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/gh release upload/.test(lines[i] ?? "")) continue;
      let statement = (lines[i] ?? "").replace(/^\s*gh release upload/, "");
      while (statement.trimEnd().endsWith("\\")) {
        statement = `${statement.trimEnd().slice(0, -1)} ${lines[i + 1] ?? ""}`;
        i++;
      }
      for (const raw of statement.split(/\s+/)) {
        const token = raw.trim().replace(/\\$/, "");
        if (!token || token.startsWith("-") || token.includes("GITHUB_REF_NAME")) continue;
        tokens.push(token);
      }
    }
    return tokens;
  };

  /** `*` within one path segment; everything else literal. */
  const globToRegExp = (pattern: string): RegExp =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

  const dist = mkdtempSync(join(tmpdir(), "release-dist-upload-"));
  // The rehearsal-mac listing (reports/16-release-distribution/rehearsal-mac/
  // asset-names.txt) plus the Windows half electron-builder writes. Files the
  // globs must NOT match stay in the listing on purpose.
  for (const name of [
    "builder-debug.yml",
    "latest-mac.yml",
    "OpenCode-Remote-0.2.0-arm64.dmg",
    "OpenCode-Remote-0.2.0-arm64.dmg.blockmap",
    "OpenCode-Remote-0.2.0-arm64.zip",
    "OpenCode-Remote-0.2.0-arm64.zip.blockmap",
    "OpenCode-Remote-0.2.0-x64.dmg",
    "OpenCode-Remote-0.2.0-x64.dmg.blockmap",
    "OpenCode-Remote-0.2.0-x64.zip",
    "OpenCode-Remote-0.2.0-x64.zip.blockmap",
    "OpenCode-Remote-Setup-0.2.0.exe",
    "OpenCode-Remote-Setup-0.2.0.exe.blockmap",
    "opencode-remote-v0.2.0.tar.gz",
  ]) writeFileSync(join(dist, name), "bytes");
  const exeSha = `${(await import("node:crypto")).createHash("sha512").update("exe-bytes").digest("base64")}`;
  writeFileSync(
    join(dist, "latest-mac.yml"),
    `version: 0.2.0\nfiles:\n  - url: OpenCode-Remote-0.2.0-arm64.zip\n    sha512: YWJj\n    size: 5\npath: OpenCode-Remote-0.2.0-arm64.zip\nsha512: YWJj\nreleaseDate: '2026-09-27T00:00:00.000Z'\n`,
  );
  writeFileSync(
    join(dist, "latest.yml"),
    `version: 0.2.0\nfiles:\n  - url: OpenCode-Remote-Setup-0.2.0.exe\n    sha512: ${exeSha}\n    size: 9\npath: OpenCode-Remote-Setup-0.2.0.exe\nsha512: ${exeSha}\nreleaseDate: '2026-09-27T00:00:00.000Z'\n`,
  );
  // The feeds are built exactly like CI: update-feed.mjs from the zips + the
  // yml (empty ROLLOUT_PERCENT = no rollout field, the plain tag push).
  const feedRun = spawnSync(process.execPath, [join(repoRoot, "apps", "desktop", "scripts", "update-feed.mjs"), "--dist", dist], {
    encoding: "utf8",
    env: { ...process.env, ROLLOUT_PERCENT: "", GITHUB_REF_NAME: tag },
  });
  check(
    "eval-16: the feed build over the rehearsal-shaped dist succeeds (zips present, yml matches the tag)",
    feedRun.status === 0,
    `${feedRun.status} ${feedRun.stderr}`,
  );

  const listing = readdirSync(dist);
  const tokens = [...uploadTokens(codeOnly(jobBlock("desktop-dmg"))), ...uploadTokens(codeOnly(jobBlock("desktop-win"))), ...uploadTokens(codeOnly(jobBlock("release")))];
  const attached = [...new Set(tokens.flatMap((token) => {
    const base = token.startsWith("apps/desktop/dist/") ? token.slice("apps/desktop/dist/".length) : token;
    return listing.filter((name) => globToRegExp(base).test(name));
  }))].sort();
  check(
    "eval-16: the desktop-dmg upload carries the dist/*.zip glob (the Squirrel.Mac payloads the feeds point at)",
    tokens.some((t) => t === "apps/desktop/dist/*.zip"),
    JSON.stringify(tokens),
  );
  check(
    "eval-16: the attached set carries both Squirrel.Mac zips, the tarball and every feed/metadata file",
    attached.includes("OpenCode-Remote-0.2.0-arm64.zip") &&
      attached.includes("OpenCode-Remote-0.2.0-x64.zip") &&
      attached.includes("opencode-remote-v0.2.0.tar.gz") &&
      attached.includes("update-mac-arm64.json") &&
      attached.includes("update-mac-x64.json") &&
      attached.includes("update-mac.json") &&
      attached.includes("latest-mac.yml") &&
      attached.includes("latest.yml"),
    JSON.stringify(attached),
  );
  const assets = spawnSync(
    process.execPath,
    [tsxEntry, join(repoRoot, "scripts", "release-assets.ts"), tag, ...attached],
    { cwd: repoRoot, encoding: "utf8" },
  );
  check(
    "eval-16: release-assets passes over EXACTLY what the upload globs attach (the rehearsal over the dist listing hid the missing zips)",
    assets.status === 0 && assets.stdout.includes("release-assets: OK v0.2.0"),
    `${assets.status} ${assets.stdout}${assets.stderr}`,
  );
  const consistency = spawnSync(
    process.execPath,
    [tsxEntry, join(repoRoot, "scripts", "feed-consistency.ts"), tag, join(dist, "update-mac.json"), join(dist, "latest.yml"), join(dist, "update-mac-arm64.json"), join(dist, "update-mac-x64.json")],
    { cwd: repoRoot, encoding: "utf8", input: `${attached.join("\n")}\n` },
  );
  check(
    "eval-16: feed-consistency passes over EXACTLY what the upload globs attach (every feed url resolves to a published zip)",
    consistency.status === 0 && consistency.stdout.includes("feed-consistency: OK v0.2.0"),
    `${consistency.status} ${consistency.stdout}${consistency.stderr}`,
  );
  rmSync(dist, { recursive: true, force: true });
}

// --- 5. ad-hoc macOS builds take the manual update flow ------------------------
{
  // Real `codesign -dv --verbose=2` outputs (identity names made generic).
  const linkerAdhoc = "Executable=/x/OpenCode Remote.app/Contents/MacOS/OpenCode Remote\nIdentifier=com.culturabuilder.opencode-remote\nFormat=app bundle with Mach-O thin (arm64)\nCodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded\nSignature=adhoc\nInfo.plist entries=33\nTeamIdentifier=not set\n";
  const builderAdhoc = "CodeDirectory v=20500 size=451 flags=0x10002(adhoc,runtime) hashes=3+7 location=embedded\nSignature=adhoc\nTeamIdentifier=not set\n";
  const developerId = "CodeDirectory v=20500 size=462 flags=0x10000(runtime) hashes=3+7 location=embedded\nSignature size=8978\nAuthority=Developer ID Application: Example Corp (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=ABCDE12345\n";
  const appleDev = "Signature size=4400\nAuthority=Apple Development: dev@example.com (XYZ9876543)\nAuthority=Apple Worldwide Developer Relations Certification Authority\nTeamIdentifier=XYZ9876543\n";
  const unsigned = "/x/OpenCode Remote.app: code object is not signed at all\n";
  check(
    "eval-16: codesign verdicts — linker ad-hoc, builder ad-hoc, Developer ID, other certificate, unsigned, unknown",
    macSigningFromCodesign(linkerAdhoc) === "adhoc" &&
      macSigningFromCodesign(builderAdhoc) === "adhoc" &&
      macSigningFromCodesign(developerId) === "developer-id" &&
      macSigningFromCodesign(appleDev) === "certificate" &&
      macSigningFromCodesign(unsigned) === "unsigned" &&
      macSigningFromCodesign("") === "unknown" &&
      macSigningFromCodesign(undefined) === "unknown" &&
      macSigningFromCodesign("codesign: some new wording") === "unknown",
  );
  check(
    "eval-16: Squirrel can apply updates except to ad-hoc/unsigned bundles (unknown fails open)",
    !squirrelCanApply("adhoc") && !squirrelCanApply("unsigned") && squirrelCanApply("developer-id") && squirrelCanApply("certificate") && squirrelCanApply("unknown"),
  );
  check(
    "eval-16: the bundle path is derived from the main executable",
    bundlePathFromExec("/Applications/OpenCode Remote.app/Contents/MacOS/OpenCode Remote") === "/Applications/OpenCode Remote.app" &&
      bundlePathFromExec("/usr/local/bin/node") === "/usr/local/bin/node",
  );

  const feed = JSON.stringify({ url: "https://github.com/caiovicentino/opencode-remote/releases/download/v0.3.0/OpenCode-Remote-0.3.0-arm64.zip", name: "0.3.0", notes: "" });
  const feedUrl = "https://github.com/caiovicentino/opencode-remote/releases/latest/download/update-mac-arm64.json";
  const fetchImpl = (async () => new Response(feed, { status: 200 })) as unknown as typeof fetch;
  const run = async (signing: "adhoc" | "unsigned" | "developer-id" | "unknown", platform: NodeJS.Platform = "darwin") => {
    const calls: string[] = [];
    const opened: string[] = [];
    let probed = 0;
    const updater: UpdaterLike = {
      setFeedURL: () => void calls.push("setFeedURL"),
      checkForUpdates: () => void calls.push("checkForUpdates"),
      on: () => undefined,
      listenerCount: () => 0,
    };
    const status: UpdateStatus = await checkForUpdatesOnBoot({
      feedUrl,
      packaged: true,
      platform,
      currentVersion: "0.2.0",
      updater,
      fetchImpl,
      log: () => undefined,
      macSigning: () => {
        probed++;
        return signing;
      },
      openReleasePage: (url) => void opened.push(url),
    });
    return { status, calls, opened, probed };
  };
  const adhoc = await run("adhoc");
  check(
    "eval-16: an ad-hoc build is offered the release page — Squirrel is never armed",
    adhoc.status === "update-available-manual" &&
      adhoc.calls.length === 0 &&
      JSON.stringify(adhoc.opened) === JSON.stringify(["https://github.com/caiovicentino/opencode-remote/releases/latest"]),
    JSON.stringify(adhoc),
  );
  const unsignedRun = await run("unsigned");
  check("eval-16: an unsigned build takes the same manual flow", unsignedRun.status === "update-available-manual" && unsignedRun.calls.length === 0);
  const devId = await run("developer-id");
  check(
    "eval-16: a Developer ID build keeps the Squirrel background download",
    devId.status === "update-available" && devId.calls.join(",") === "setFeedURL,checkForUpdates",
    JSON.stringify(devId),
  );
  const unknown = await run("unknown");
  check("eval-16: an unknown signature fails open to Squirrel (today's behavior)", unknown.status === "update-available" && unknown.calls.length === 2);
  const win = await run("adhoc", "win32");
  check("eval-16: the signature probe is never consulted off macOS", win.probed === 0, JSON.stringify(win));

  // The probe is the update path's only process execution and lives outside
  // update.ts (P2-233 keeps update.ts/main.ts free of child_process): one
  // fixed binary, display-only flags, and a target derived from
  // process.execPath alone — it cannot be pointed at a downloaded file.
  const probeSrc = codeOnly(readFileSync(join(repoRoot, "apps", "desktop", "src", "macsigningprobe.ts"), "utf8"));
  const updateSrc = readFileSync(join(repoRoot, "apps", "desktop", "src", "update.ts"), "utf8");
  check(
    "eval-16: the signature probe runs only /usr/bin/codesign -dv --verbose=2 on the running bundle",
    CODESIGN_BIN === "/usr/bin/codesign" &&
      JSON.stringify(CODESIGN_ARGS) === JSON.stringify(["-dv", "--verbose=2"]) &&
      (probeSrc.match(/execFile\(/g) ?? []).length === 1 &&
      probeSrc.includes("[...CODESIGN_ARGS, bundlePathFromExec(process.execPath)]") &&
      !/\b(spawn|spawnSync|execSync|execFileSync|exec)\(/.test(probeSrc) &&
      runningMacSigning.length === 0,
  );
  check("eval-16: update.ts stays free of child_process (P2-233)", !updateSrc.includes("child_process") && updateSrc.includes('from "./macsigningprobe"'));
  check("eval-16: outside a packaged Electron app the probe answers unknown without running anything", (await runningMacSigning()) === "unknown");
}

// --- 6. opencode-remote setup --------------------------------------------------
{
  check(
    "eval-16: --relay keeps everything after the first '=' (and --relay <url> works)",
    relayUrlFromArgv(["--relay=wss://h.ts.net:8788/?a=b"]) === "wss://h.ts.net:8788/?a=b" &&
      relayUrlFromArgv(["--relay", "ws://10.0.0.2:8788"]) === "ws://10.0.0.2:8788" &&
      relayUrlFromArgv(["--other"]) === null,
  );
  const refused = ["", "   ", "not a url", "http://10.0.0.2:8788", "ws://127.0.0.1:8787", "ws://localhost:8787", "wss://[::1]:8788", "ws://0.0.0.0:8788", "ws://127.9.9.9:1", "ws://[::ffff:127.0.0.1]:8788"];
  const accepted = ["wss://my-mac.tailnet.ts.net:8788", "ws://192.168.1.20:8788", "wss://relay.example.com"];
  check(
    "eval-16: relay URLs a phone cannot dial are refused; reachable ones pass",
    refused.every((u) => relayUrlProblem(u) !== null) && accepted.every((u) => relayUrlProblem(u) === null),
    JSON.stringify(refused.map((u) => [u, relayUrlProblem(u)])),
  );
  const cli = readFileSync(join(repoRoot, "cli.mjs"), "utf8");
  const setupSrc = cli.slice(cli.indexOf("async function setup()"), cli.indexOf("async function update("));
  const problemAt = setupSrc.indexOf("relayUrlProblem(relayUrl)");
  const doctorAt = setupSrc.indexOf("await doctor()");
  const webAt = setupSrc.indexOf("npm run build --workspace @ocr/web");
  const installAt = setupSrc.indexOf("deploy\", \"install.sh\"");
  const guardAt = setupSrc.indexOf("process.env.OCR_SETUP_NO_INSTALL");
  check(
    "eval-16: setup refuses the relay before any probe, builds the web app before the services, prints the QR with its own relay, and carries the OCR_SETUP_NO_INSTALL guard BEFORE install.sh",
    problemAt > -1 && doctorAt > problemAt && webAt > doctorAt && guardAt > -1 && guardAt < installAt && installAt > webAt && setupSrc.includes("await qr(relayUrl)"),
    `problem=${problemAt} doctor=${doctorAt} web=${webAt} guard=${guardAt} install=${installAt}`,
  );
  check("eval-16: doctor reports a missing web build", cli.includes("existsSync(join(ROOT, WEB_DIST_INDEX))") && WEB_DIST_INDEX === join("apps", "web", "dist", "index.html"));
  // Live and hermetic: the refusal happens before doctor(), so no port is
  // probed — and (eval-16 fix-round) every command the fall-through past a
  // refusal regression would need (npm, bash, lsof) is shimmed to fail closed
  // and LOG its call, plus cli.mjs carries the OCR_SETUP_NO_INSTALL guard
  // before install.sh. Under a regressed refusal the run stops loudly at the
  // guard or at a shim — it can never reach the real launchd domain
  // (deploy/install.sh bootouts com.ocr.* and kills the :5173 listener).
  const setupBin = mkdtempSync(join(tmpdir(), "release-dist-setup-bin-"));
  const shimLog = join(setupBin, "calls.log");
  const shimCall = (tool: string) =>
    `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "${shimLog}"\necho "release-distribution: refusing '${tool} $*' under test" >&2\nexit 1\n`;
  for (const tool of ["npm", "bash", "lsof"]) {
    writeFileSync(join(setupBin, tool), shimCall(tool), { mode: 0o755 });
  }
  const home = mkdtempSync(join(tmpdir(), "release-dist-home-"));
  const live = spawnSync(process.execPath, [join(repoRoot, "cli.mjs"), "setup", "--relay=ws://127.0.0.1:8787"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, RELAY_URL: "", OCR_SETUP_NO_INSTALL: "1", PATH: `${setupBin}:${process.env.PATH ?? ""}` },
  });
  check(
    "eval-16: `setup --relay=ws://127.0.0.1:8787` exits 1 naming the loopback, before checking prerequisites",
    live.status === 1 && live.stdout.includes("loopback") && !live.stdout.includes("checking prerequisites"),
    `${live.status} ${live.stdout}${live.stderr}`,
  );
  check(
    "eval-16: the live setup reached no dangerous tool — the npm/bash/lsof shims logged zero calls and testhome shields launchctl/pkill",
    (existsSync(shimLog) ? readFileSync(shimLog, "utf8").trim() === "" : true) && guardAt > -1,
    existsSync(shimLog) ? readFileSync(shimLog, "utf8") : "(no shim was called)",
  );
  rmSync(home, { recursive: true, force: true });
  rmSync(setupBin, { recursive: true, force: true });
}

// --- 7. Homebrew formula -------------------------------------------------------
{
  const formula = readFileSync(join(repoRoot, "Formula", "opencode-remote.rb"), "utf8");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { license?: string };
  check("eval-16: formula license matches package.json (AGPL-3.0-only)", formula.includes(`license "${pkg.license}"`) && pkg.license === "AGPL-3.0-only");
  const ciAt = formula.indexOf('system "npm", "ci"');
  const buildAt = formula.indexOf('system "npm", "run", "build", "--workspace", "@ocr/web"');
  const pruneAt = formula.indexOf('system "npm", "prune", "--omit=dev"');
  const installAt = formula.indexOf('(libexec/"app").install Dir["*"]');
  check(
    "eval-16: the formula builds the web app with the dev toolchain, then prunes, then installs",
    ciAt > -1 && buildAt > ciAt && pruneAt > buildAt && installAt > pruneAt && !formula.includes('"ci", "--omit=dev"'),
  );
  check("eval-16: the formula documents the tap install (Homebrew refuses formula files outside a tap)", formula.includes("brew tap caiovicentino/opencode-remote https://github.com/caiovicentino/opencode-remote"));

  // Execute the workflow's own pin commands (copied out of release.yml) on a
  // copy of the real formula: url, version and sha256 must all be rewritten.
  const step = jobBlock("release-publish");
  const from = step.indexOf("URL_RE=");
  const to = step.indexOf("gh release upload \"$GITHUB_REF_NAME\" formula-pin/opencode-remote.rb");
  const script = from > -1 && to > from ? step.slice(from, to).split("\n").map((l) => l.trim()).join("\n") : "";
  const dir = mkdtempSync(join(tmpdir(), "release-dist-formula-"));
  mkdirSync(join(dir, "Formula"));
  mkdirSync(join(dir, "formula-pin"));
  copyFileSync(join(repoRoot, "Formula", "opencode-remote.rb"), join(dir, "Formula", "opencode-remote.rb"));
  const sha = "ab".repeat(32);
  const pin = spawnSync("bash", ["-euo", "pipefail", "-c", `VERSION=v9.8.7\nSHA=${sha}\n${script}`], { cwd: dir, encoding: "utf8" });
  const pinned = existsSync(join(dir, "formula-pin", "opencode-remote.rb")) ? readFileSync(join(dir, "formula-pin", "opencode-remote.rb"), "utf8") : "";
  check(
    "eval-16: the workflow's pin commands rewrite url, version and sha256 of the real formula",
    script.length > 0 &&
      pin.status === 0 &&
      pinned.includes('url "https://github.com/caiovicentino/opencode-remote/releases/download/v9.8.7/opencode-remote-v9.8.7.tar.gz"') &&
      pinned.includes('version "9.8.7"') &&
      pinned.includes(`sha256 "${sha}"`),
    `${pin.status} ${pin.stderr}`,
  );
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} release-distribution test(s) failed`);
  process.exit(1);
}
console.log("\nall release-distribution tests passed");
