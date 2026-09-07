/**
 * P2-304: pure verdict for the Windows installer smoke. Deliberately NO I/O
 * here (same rule as packaged-boot-verdict.mjs and the P2-194/P2-251 helper
 * modules): scripts/unit.test.ts imports this file directly and must never
 * boot a process or touch the filesystem — every fact is injected by the
 * caller.
 *
 * The smoke is a strictly sequential pipeline (install → layout → boot →
 * uninstall → leftover sweep): when a stage fails the driver skips the stages
 * after it, so the verdict is first-match-wins, ordered from "the installer
 * never even ran" to "cosmetic remains":
 *
 *   install-failed      the setup exe exited non-zero, died by signal or the
 *                       chosen install directory never appeared
 *   layout-missing      the installed tree is incomplete (executable,
 *                       resources/daemon, resources/web-dist or uninstaller)
 *   boot-failed         the INSTALLED executable failed the hermetic boot —
 *                       including a missing Playwright driver, which fails
 *                       closed (never a vacuous pass)
 *   uninstall-failed    the uninstaller exited non-zero, died by signal or
 *                       was never attempted
 *   leftover-files      a clean uninstall still left the install dir on disk
 *
 * The boot stage reuses bootVerdict (packaged-boot-verdict.mjs) so the
 * installed app is held to EXACTLY the same bar as the unpacked bundle:
 * load finished, #root mounted, canary seen, console clean. Messages are
 * short pt-BR lines for the release-job log: no paths, no URL schemes, no
 * secrets (the P2-201 hygiene bar).
 */
import { bootVerdict } from "./packaged-boot-verdict.mjs";

const MESSAGES = {
  ok: "instalador instalou, o app instalado abriu e o desinstalador limpou o diretório",
  "install-failed": "o instalador não completou a instalação silenciosa",
  "layout-missing": "a árvore instalada está incompleta",
  "boot-failed": "o app instalado não passou no boot hermético",
  "uninstall-failed": "o desinstalador não completou a desinstalação silenciosa",
  "leftover-files": "restaram arquivos no diretório de instalação após desinstalar",
};

/** Fixed pt-BR labels for the four installed-layout requirements (slash-free —
 * the P2-201 message-hygiene bar treats any separator as a machine path). */
const LAYOUT_LABELS = {
  executable: "executável do app",
  daemonEntry: "daemon empacotado em resources",
  webDist: "interface web empacotada em resources",
  uninstaller: "desinstalador",
};

function verdict(reason, detail) {
  const message = detail ? `${MESSAGES[reason]} — ${detail}` : MESSAGES[reason];
  return { ok: false, reason, message };
}

function describeExit(code, signal) {
  return signal !== null && signal !== undefined ? `sinal ${signal}` : `código ${code}`;
}

/**
 * Decide the installer smoke verdict from plain facts:
 *
 *   install    { exitCode, signal, dirAppeared } for the silent setup run
 *   layout     { executable, daemonEntry, webDist, uninstaller } booleans
 *   boot       { driverAvailable, loadFinished, rootEmpty, canarySeen,
 *                consoleErrors } — the packaged-boot facts for the
 *              INSTALLED executable (executableFound is implied: the driver
 *              only boots a resolved binary)
 *   uninstall  { attempted, exitCode, signal } for the silent uninstall run
 *   dirGone    true when the install directory no longer exists afterwards
 *
 * Returns { ok: true, reason: null, message } or { ok: false, reason, message }.
 */
export function installerVerdict(facts) {
  const install = facts?.install ?? {};
  const layout = facts?.layout ?? {};
  const boot = facts?.boot ?? {};
  const uninstall = facts?.uninstall ?? {};

  // Rule 1: the installer itself failed — nothing after it can be trusted.
  if (install.signal !== null && install.signal !== undefined) return verdict("install-failed", `sinal ${install.signal}`);
  if (install.exitCode !== null && install.exitCode !== undefined && install.exitCode !== 0) {
    return verdict("install-failed", `código ${install.exitCode}`);
  }
  if (install.dirAppeared !== true) return verdict("install-failed", "diretório de instalação não apareceu");

  // Rule 2: the installed tree is incomplete — name every missing piece.
  const missing = Object.entries(LAYOUT_LABELS)
    .filter(([key]) => layout[key] !== true)
    .map(([, label]) => label);
  if (missing.length > 0) return verdict("layout-missing", `ausente: ${missing.join(", ")}`);

  // Rule 3: the installed executable failed the hermetic boot. A missing
  // driver (driverAvailable !== true) is the fail-closed case: the app was
  // NOT boot-tested, so the smoke must never pass vacuously.
  if (boot.driverAvailable !== true) return verdict("boot-failed", "driver de automação indisponível");
  const bootFacts = {
    executableFound: true,
    loadFinished: boot.loadFinished === true,
    rootEmpty: boot.rootEmpty === true,
    canarySeen: boot.canarySeen === true,
    consoleErrors: Array.isArray(boot.consoleErrors) ? boot.consoleErrors : [],
  };
  const inner = bootVerdict(bootFacts);
  if (!inner.ok) return verdict("boot-failed", inner.reason);

  // Rule 4: the uninstaller failed — or was never run (fail closed too).
  if (uninstall.attempted !== true) return verdict("uninstall-failed", "desinstalação não executada");
  if (uninstall.signal !== null && uninstall.signal !== undefined) {
    return verdict("uninstall-failed", `sinal ${uninstall.signal}`);
  }
  if (uninstall.exitCode !== null && uninstall.exitCode !== undefined && uninstall.exitCode !== 0) {
    return verdict("uninstall-failed", `código ${uninstall.exitCode}`);
  }

  // Rule 5: the uninstaller claimed success but left the directory behind.
  if (facts?.dirGone !== true) return verdict("leftover-files");

  return { ok: true, reason: null, message: MESSAGES.ok };
}
