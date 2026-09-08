/**
 * P2-242/P2-253/P2-304 — boot-, daemon- and installer-smoke parity between
 * the CI packaging jobs and the release workflow. The CI packaging jobs
 * (desktop-package, desktop-package-win) only INSPECT the packaged bundle
 * (scripts/dist-smoke.mjs); the real executions of the package — the app
 * booting (main throwing at boot, an asar missing an asset the renderer asks
 * for, a blank window) and the daemon sidecar serving on the packaged
 * runtime — used to live exclusively in .github/workflows/release.yml, so a
 * runtime or packaging regression crossed every green pull request and
 * surfaced on publication day, with the release already drafted. This module
 * is the deterministic guard: it reads workflow text through a deliberately
 * narrow reader and demands that every job that packages the app also boots
 * the real package AND runs the packaged daemon sidecar smoke
 * (P2-251/P2-253) — after packaging, with shell: bash declared
 * (P2-126/P2-164 lessons: pwsh does not expand globs) and its own timeout —
 * in BOTH workflows; that every job that SHIPS the Windows setup exe
 * (P2-304) also smoke-installs it exactly once before the upload, with the
 * same shell/timeout hygiene; and that the release job which checks feed
 * names and versions (P2-157) also confronts the sha512 digests the feeds
 * declare with the published bytes (P2-308), with the same hygiene.
 *
 * Pure by construction: no node:fs, no node:child_process, no fetch, no
 * network — the caller reads the real-world inputs (the workflow files) and
 * injects their text, so the unit battery can pin every branch with synthetic
 * fixtures and the real-repo assertion fails the gate the moment a packaging
 * job loses its boot step. The parser is intentionally narrow — it recognizes
 * the block shapes these workflows actually use (2-space job keys, 6-space
 * step items, block-scalar runs) — and never throws: malformed text yields
 * whatever partial structure is recognizable, empty text yields [].
 */

export interface WorkflowStep {
  /** Declared step name; falls back to the `uses` value, "" when neither. */
  name: string;
  /** Declared run command (block scalars joined with "\n"); "" when the step only uses an action. */
  run: string;
  /** Declared shell, null when not declared. */
  shell: string | null;
  /** Declared timeout-minutes, null when absent or not a plain number. */
  timeoutMinutes: number | null;
}

export interface WorkflowJob {
  /** Job key as declared in the workflow. */
  name: string;
  /** Declared runs-on value, "" when absent. */
  platform: string;
  /** Declared steps, in declaration order. */
  steps: WorkflowStep[];
}

const JOB_KEY = /^ {2}([A-Za-z0-9_.-]+):\s*(?:#.*)?$/;
const STEP_ITEM = /^ {6}-\s*(.*)$/;

/**
 * Narrow reader for GitHub Actions workflow text: returns the ordered list of
 * jobs under the top-level `jobs:` key, each with its name, declared
 * `runs-on` platform and declared steps (name, run command, shell,
 * timeout-minutes). Empty text — or text with no `jobs:` key — yields [];
 * malformed text never throws, it degrades to whatever partial structure is
 * recognizable.
 */
export function parseWorkflowJobs(text: string): WorkflowJob[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (start < 0) return [];
  const jobs: WorkflowJob[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const jobKey = JOB_KEY.exec(line);
    if (!jobKey) {
      if (!line.startsWith(" ")) break; // dedent to column 0 — jobs block over
      i++;
      continue;
    }
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (l.trim() === "") {
        j++;
        continue;
      }
      if (JOB_KEY.test(l) || !/^ {3,}/.test(l)) break; // next job key, or dedent below job level
      body.push(l);
      j++;
    }
    jobs.push(parseJob(jobKey[1], body));
    i = j;
  }
  return jobs;
}

function parseJob(name: string, body: string[]): WorkflowJob {
  let platform = "";
  const steps: WorkflowStep[] = [];
  const stepsAt = body.findIndex((line) => /^ {4}steps:\s*(?:#.*)?$/.test(line));
  if (stepsAt >= 0) {
    let i = stepsAt + 1;
    while (i < body.length) {
      const line = body[i];
      if (line.trim() === "" || /^ {6}#/.test(line)) {
        i++;
        continue;
      }
      const item = STEP_ITEM.exec(line);
      if (!item) break; // dedent below the steps list — narrow reader stops
      const itemLines: string[] = [item[1]];
      i++;
      while (i < body.length && (body[i].trim() === "" || /^ {8}/.test(body[i]))) {
        itemLines.push(body[i]);
        i++;
      }
      steps.push(parseStep(itemLines));
    }
  }
  for (const line of body) {
    const m = /^ {4}runs-on:\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (m) {
      platform = m[1].trim();
      break;
    }
  }
  return { name, platform, steps };
}

function parseStep(itemLines: string[]): WorkflowStep {
  const lines = itemLines.filter((l) => l.trim() !== "");
  let name = "";
  let run = "";
  let shell: string | null = null;
  let timeoutMinutes: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ *([A-Za-z-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    const value = (m[2] ?? "").trim();
    if (key === "name" && name === "") {
      name = value.replace(/^["']|["']$/g, "");
    } else if (key === "uses" && name === "") {
      name = value;
    } else if (key === "run") {
      if (value === "" || /^[|>][+-]?[0-9]*$/.test(value)) {
        run = blockScalar(lines, i);
      } else {
        run = value.replace(/^["']|["']$/g, "");
      }
    } else if (key === "shell") {
      shell = value === "" ? null : value.replace(/^["']|["']$/g, "");
    } else if (key === "timeout-minutes") {
      timeoutMinutes = /^\d+$/.test(value) ? Number(value) : null;
    }
  }
  return { name, run, shell, timeoutMinutes };
}

/** Collect the block-scalar body of `lines[at]` (the `run: |` line). */
function blockScalar(lines: readonly string[], at: number): string {
  const keyIndent = /^ */.exec(lines[at])?.[0].length ?? 0;
  const content: string[] = [];
  for (let j = at + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === "") {
      content.push("");
      continue;
    }
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (indent <= keyIndent) break;
    content.push(line);
  }
  while (content.length > 0 && content[content.length - 1] === "") content.pop();
  if (content.length === 0) return "";
  const minIndent = Math.min(...content.map((l) => /^ */.exec(l)?.[0].length ?? 0));
  return content.map((l) => l.slice(minIndent)).join("\n");
}

/** A step that packages the app — the electron-builder invocation (`npm run dist ...`), never `npm run dist:smoke`. */
const PACKAGING_RUN = /npm run dist(?![\w:.-])/;

/** A step that boots the real packaged bundle via the release boot script. */
const BOOT_RUN = /packaged-boot\.mjs/;

/** A step that boots the packaged daemon sidecar via the P2-251 smoke. */
const DAEMON_SMOKE_RUN = /packaged-daemon-smoke\.mjs/;

/** A step that smoke-installs the NSIS setup exe (P2-304). */
const INSTALLER_SMOKE_RUN = /installer-smoke\.mjs/;

/** A step that smoke-mounts the macOS disk image (P2-309). */
const DMG_SMOKE_RUN = /dmg-smoke\.mjs/;

/** A step that uploads the Windows setup exe to the release — the job SHIPS
 * an installer, so the installer itself must be smoke-installed first. */
const SETUP_UPLOAD_RUN = /apps\/desktop\/dist\/\*\.exe/;

/** A step that uploads the macOS disk image to the release — the job SHIPS
 * the container the user actually opens, so it must be smoke-mounted first
 * (P2-309). */
const DMG_UPLOAD_RUN = /apps\/desktop\/dist\/\*\.dmg/;

/** A step that checks feed names/versions against the published asset names (P2-157). */
const FEED_CONSISTENCY_RUN = /feed-consistency\.ts/;

/** A step that confronts the feeds' declared sha512 digests with the published bytes (P2-308). */
const FEED_HASH_RUN = /feedhash\.ts/;

/**
 * Cross-check the packaging jobs of the integration (ci) and release
 * workflows, returning one problem per cause in the established problems
 * format (a plain string[] a caller can print or count), applying the rules
 * in this order with no short-circuit so two simultaneous causes yield two
 * problems:
 * - a job that packages the app but never runs the real packaged boot;
 * - a real-boot step positioned before the packaging step it validates;
 * - a real-boot step without shell: bash declared explicitly;
 * - a real-boot step without its own timeout-minutes;
 * - a packaging job of EITHER workflow that never runs the packaged daemon
 *   sidecar smoke (P2-251 release, P2-253 ci — both packaging surfaces are
 *   held to the same bar);
 * - a daemon-smoke step positioned before the packaging step it validates;
 * - a daemon-smoke step without shell: bash declared explicitly;
 * - a daemon-smoke step without its own timeout-minutes;
 * - a job that uploads the Windows setup exe but never runs the installer
 *   smoke (P2-304);
 * - more than one installer-smoke step in the same job (P2-304);
 * - an installer-smoke step positioned before packaging or after the upload
 *   that ships the setup exe (P2-304);
 * - an installer-smoke step without shell: bash declared explicitly (P2-304);
 * - an installer-smoke step without its own timeout-minutes (P2-304);
 * - a job that uploads the macOS disk image but never runs the DMG smoke
 *   (P2-309);
 * - more than one dmg-smoke step in the same job (P2-309);
 * - a dmg-smoke step positioned before packaging or after the upload that
 *   ships the image (P2-309);
 * - a dmg-smoke step without shell: bash declared explicitly (P2-309);
 * - a dmg-smoke step without its own timeout-minutes (P2-309).
 * A job that packages nothing is never flagged. Every problem names the job
 * and says in one sentence what to do; the order is stable for the same
 * input, and no problem ever embeds a file path from the input.
 */
export function bootSmokeParity(ciJobs: readonly WorkflowJob[], releaseJobs: readonly WorkflowJob[]): string[] {
  const problems: string[] = [];
  const groups: ReadonlyArray<readonly [string, readonly WorkflowJob[]]> = [
    ["ci", ciJobs],
    ["release", releaseJobs],
  ];
  for (const [workflow, jobs] of groups) {
    for (const job of jobs) {
      const packagingAt = job.steps.findIndex((s) => PACKAGING_RUN.test(s.run));
      if (packagingAt < 0) continue; // a job that packages nothing is never flagged
      const boots = job.steps.filter((s) => BOOT_RUN.test(s.run));
      if (boots.length === 0) {
        problems.push(
          `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow packages the app but never boots the real package — add a step after packaging that runs the packaged boot (packaged-boot.mjs) against the resolved bundle`,
        );
      } else {
        for (const boot of boots) {
          if (job.steps.indexOf(boot) < packagingAt) {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow boots the package before the packaging step it validates — move the real-boot step after packaging`,
            );
          }
          if (boot.shell !== "bash") {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow boots the package without declaring shell: bash — declare shell: bash explicitly (pwsh does not expand globs)`,
            );
          }
          if (boot.timeoutMinutes === null) {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow boots the package without its own timeout-minutes — add one so a hung boot cannot hold the runner`,
            );
          }
        }
      }
      // P2-251/P2-253: BOTH workflows have to prove the packaged daemon
      // sidecar actually boots — same hygiene bar as the boot step above.
      const smokes = job.steps.filter((s) => DAEMON_SMOKE_RUN.test(s.run));
      if (smokes.length === 0) {
        problems.push(
          `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow never boots the packaged daemon sidecar — add a step after packaging that runs the daemon smoke (packaged-daemon-smoke.mjs) against the resolved bundle`,
        );
      } else {
        for (const smoke of smokes) {
          if (job.steps.indexOf(smoke) < packagingAt) {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smokes the daemon sidecar before the packaging step it validates — move the daemon smoke after packaging`,
            );
          }
          if (smoke.shell !== "bash") {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smokes the daemon sidecar without declaring shell: bash — declare shell: bash explicitly (pwsh does not expand globs)`,
            );
          }
          if (smoke.timeoutMinutes === null) {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smokes the daemon sidecar without its own timeout-minutes — add one so a hung daemon cannot hold the runner`,
            );
          }
        }
      }
      // P2-304: a job that SHIPS the Windows setup exe must prove the
      // installer actually installs, boots and uninstalls BEFORE the upload
      // — release-only by shape (the ci packaging jobs build --dir targets
      // and never produce an installer), keyed on the upload step itself so
      // no job name is hardcoded.
      const uploadAt = job.steps.findIndex((s) => SETUP_UPLOAD_RUN.test(s.run));
      if (uploadAt > -1) {
        const installerSmokes = job.steps.filter((s) => INSTALLER_SMOKE_RUN.test(s.run));
        if (installerSmokes.length === 0) {
          problems.push(
            `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow ships the Windows setup exe but never smoke-installs it — add a step before the upload that runs the installer smoke (installer-smoke.mjs) against the resolved setup exe`,
          );
        } else {
          if (installerSmokes.length > 1) {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow runs the installer smoke more than once — keep exactly one occurrence`,
            );
          }
          for (const smoke of installerSmokes) {
            if (job.steps.indexOf(smoke) < packagingAt) {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-installs the setup exe before the packaging step it validates — move the installer smoke after packaging`,
              );
            }
            if (job.steps.indexOf(smoke) > uploadAt) {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-installs the setup exe after the upload that ships it — move the installer smoke before the upload`,
              );
            }
            if (smoke.shell !== "bash") {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-installs the setup exe without declaring shell: bash — declare shell: bash explicitly (pwsh does not expand globs)`,
              );
            }
            if (smoke.timeoutMinutes === null) {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-installs the setup exe without its own timeout-minutes — add one so a hung installer cannot hold the runner`,
              );
            }
          }
        }
      }
      // P2-309: a job that SHIPS the macOS disk image must prove the
      // container the user actually opens mounts, carries the Applications
      // shortcut and boots the app from INSIDE the volume — release-only by
      // shape (only the desktop-dmg job uploads *.dmg), keyed on the upload
      // step itself so no job name is hardcoded.
      const dmgUploadAt = job.steps.findIndex((s) => DMG_UPLOAD_RUN.test(s.run));
      if (dmgUploadAt > -1) {
        const dmgSmokes = job.steps.filter((s) => DMG_SMOKE_RUN.test(s.run));
        if (dmgSmokes.length === 0) {
          problems.push(
            `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow ships the macOS disk image but never smoke-mounts it — add a step before the upload that runs the DMG smoke (dmg-smoke.mjs) against the resolved image`,
          );
        } else {
          if (dmgSmokes.length > 1) {
            problems.push(
              `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow runs the DMG smoke more than once — keep exactly one occurrence`,
            );
          }
          for (const smoke of dmgSmokes) {
            if (job.steps.indexOf(smoke) < packagingAt) {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-mounts the disk image before the packaging step it validates — move the DMG smoke after packaging`,
              );
            }
            if (job.steps.indexOf(smoke) > dmgUploadAt) {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-mounts the disk image after the upload that ships it — move the DMG smoke before the upload`,
              );
            }
            if (smoke.shell !== "bash") {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-mounts the disk image without declaring shell: bash — declare shell: bash explicitly (pwsh does not expand globs)`,
              );
            }
            if (smoke.timeoutMinutes === null) {
              problems.push(
                `boot-smoke-parity: job "${job.name}" of the ${workflow} workflow smoke-mounts the disk image without its own timeout-minutes — add one so a hung mount cannot hold the runner`,
              );
            }
          }
        }
      }
    }
  }
  return problems;
}

/**
 * P2-308 — feed-digest parity for the release workflow. A job that checks
 * feed names and versions against the published assets (the P2-157
 * feed-consistency step) must ALSO confront the sha512 digests those feeds
 * declare with the bytes actually published — the app refuses a Windows
 * installer whose digest diverges, so a hash-mismatched feed blocks the
 * whole installed base forever and must fail the release while it is still a
 * draft. One problem per cause, applying the rules in order with no
 * short-circuit:
 * - a job with the consistency step but no feedhash step;
 * - more than one feedhash step in the same job;
 * - a feedhash step positioned before the consistency step it extends;
 * - a feedhash step without shell: bash declared explicitly;
 * - a feedhash step without its own timeout-minutes.
 * A job without the consistency step is never flagged. Every problem names
 * the job and says in one sentence what to do; the order is stable for the
 * same input, and no problem ever embeds a file path from the input.
 */
export function feedHashParity(jobs: readonly WorkflowJob[]): string[] {
  const problems: string[] = [];
  for (const job of jobs) {
    const consistencyAt = job.steps.findIndex((s) => FEED_CONSISTENCY_RUN.test(s.run));
    if (consistencyAt < 0) continue; // a job that checks no feeds is never flagged
    const hashes = job.steps.filter((s) => FEED_HASH_RUN.test(s.run));
    if (hashes.length === 0) {
      problems.push(
        `feed-hash-parity: job "${job.name}" checks feed names and versions but never confronts the declared sha512 digests with the published bytes — add a step after the consistency step that runs scripts/feedhash.ts over the measured artifacts`,
      );
    } else {
      if (hashes.length > 1) {
        problems.push(
          `feed-hash-parity: job "${job.name}" runs the feed digest confrontation more than once — keep exactly one occurrence`,
        );
      }
      for (const step of hashes) {
        if (job.steps.indexOf(step) < consistencyAt) {
          problems.push(
            `feed-hash-parity: job "${job.name}" confronts the feed digests before the consistency step it extends — move the feedhash step after the feed-consistency step`,
          );
        }
        if (step.shell !== "bash") {
          problems.push(
            `feed-hash-parity: job "${job.name}" confronts the feed digests without declaring shell: bash — declare shell: bash explicitly (pwsh does not expand globs)`,
          );
        }
        if (step.timeoutMinutes === null) {
          problems.push(
            `feed-hash-parity: job "${job.name}" confronts the feed digests without its own timeout-minutes — add one so a hung download cannot hold the runner`,
          );
        }
      }
    }
  }
  return problems;
}
