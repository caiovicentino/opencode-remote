/**
 * P2-309: pure verdict for the macOS disk-image smoke. Deliberately NO I/O
 * here (same rule as packaged-boot-verdict.mjs, installer-smoke-verdict.mjs
 * and the P2-194/P2-251 helper modules): scripts/unit.test.ts imports this
 * file directly and must never mount an image, boot a process or touch the
 * filesystem — every fact is injected by the caller.
 *
 * The smoke is a strictly sequential pipeline (attach → layout → Applications
 * link → boot → detach): when a stage fails the driver skips the stages after
 * it (only the detach still runs — always), so the verdict is first-match-wins,
 * ordered from "the image never even mounted" to "cosmetic cleanup":
 *
 *   attach-failed              hdiutil attach exited non-zero, died by signal
 *                              or the volume never appeared at the mount point
 *   layout-missing             the mounted volume is incomplete (not exactly
 *                              one .app bundle, executable, resources/daemon or
 *                              resources/web-dist inside it)
 *   applications-link-missing  the volume root has no Applications symlink or
 *                              it points somewhere else — the drag-and-drop
 *                              install the P2-211 copy tells laypeople to use
 *   boot-failed                the app FROM INSIDE the mounted volume failed
 *                              the hermetic boot — including a missing
 *                              Playwright driver, which fails closed (never a
 *                              vacuous pass)
 *   detach-failed              the always-detach step failed (or was never
 *                              attempted) with everything else green — the
 *                              image would stay mounted on the runner
 *
 * The boot stage reuses bootVerdict (packaged-boot-verdict.mjs) so the app
 * inside the DMG is held to EXACTLY the same bar as the unpacked bundle: load
 * finished, #root mounted, canary seen, console clean. Messages are short
 * pt-BR lines for the release-job log: no paths, no URL schemes, no secrets
 * (the P2-201 hygiene bar).
 */
import { bootVerdict } from "./packaged-boot-verdict.mjs";

const MESSAGES = {
  ok: "imagem montou, conteúdo íntegro, o app de dentro do volume abriu e a imagem desmontou",
  "attach-failed": "a imagem não montou via hdiutil attach",
  "layout-missing": "o conteúdo montado está incompleto",
  "applications-link-missing": "o atalho para a pasta Aplicativos não está no volume",
  "boot-failed": "o app de dentro do volume não passou no boot hermético",
  "detach-failed": "a imagem não desmontou ao final do smoke",
};

/** Fixed pt-BR labels for the mounted-layout requirements (slash-free — the
 * P2-201 message-hygiene bar treats any separator as a machine path). */
const LAYOUT_LABELS = {
  singleAppBundle: "exatamente um pacote de aplicativo no volume",
  executable: "executável do app",
  daemonEntry: "daemon empacotado em resources",
  webDist: "interface web empacotada em resources",
};

function verdict(reason, detail) {
  const message = detail ? `${MESSAGES[reason]} — ${detail}` : MESSAGES[reason];
  return { ok: false, reason, message };
}

function describeExit(code, signal) {
  return signal !== null && signal !== undefined ? `sinal ${signal}` : `código ${code}`;
}

/**
 * Decide the disk-image smoke verdict from plain facts:
 *
 *   attach            { exitCode, signal, mounted } for hdiutil attach
 *   layout            { singleAppBundle, executable, daemonEntry, webDist }
 *                     booleans for the mounted volume content
 *   applicationsLink  { present, targetOk } for the volume-root symlink
 *   boot              { driverAvailable, loadFinished, rootEmpty, canarySeen,
 *                       consoleErrors } — the packaged-boot facts for the
 *                     executable INSIDE the mounted bundle (executableFound
 *                     is implied: the driver only boots a resolved binary)
 *   detach            { attempted, exitCode, signal } for the always-detach
 *
 * Returns { ok: true, reason: null, message } or { ok: false, reason, message }.
 */
export function dmgVerdict(facts) {
  const attach = facts?.attach ?? {};
  const layout = facts?.layout ?? {};
  const applicationsLink = facts?.applicationsLink ?? {};
  const boot = facts?.boot ?? {};
  const detach = facts?.detach ?? {};

  // Rule 1: the image itself failed to mount — nothing after it can be trusted.
  if (attach.signal !== null && attach.signal !== undefined) return verdict("attach-failed", `sinal ${attach.signal}`);
  if (attach.exitCode !== null && attach.exitCode !== undefined && attach.exitCode !== 0) {
    return verdict("attach-failed", `código ${attach.exitCode}`);
  }
  if (attach.mounted !== true) return verdict("attach-failed", "volume não apareceu no ponto de montagem");

  // Rule 2: the mounted tree is incomplete — name every missing piece.
  const missing = Object.entries(LAYOUT_LABELS)
    .filter(([key]) => layout[key] !== true)
    .map(([, label]) => label);
  if (missing.length > 0) return verdict("layout-missing", `ausente: ${missing.join(", ")}`);

  // Rule 3: the Applications shortcut the P2-211 copy tells laypeople to drag
  // to — present, and pointing at the real Applications folder.
  if (applicationsLink.present !== true) return verdict("applications-link-missing", "atalho ausente na raiz do volume");
  if (applicationsLink.targetOk !== true) return verdict("applications-link-missing", "atalho aponta para alvo errado");

  // Rule 4: the executable INSIDE the mounted bundle failed the hermetic
  // boot. A missing driver (driverAvailable !== true) is the fail-closed
  // case: the app was NOT boot-tested, so the smoke must never pass vacuously.
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

  // Rule 5: everything green, but the image would stay mounted on the
  // runner — the always-detach contract failed (or was never run).
  if (detach.attempted !== true) return verdict("detach-failed", "desmontagem não executada");
  if (detach.signal !== null && detach.signal !== undefined) {
    return verdict("detach-failed", `sinal ${detach.signal}`);
  }
  if (detach.exitCode !== null && detach.exitCode !== undefined && detach.exitCode !== 0) {
    return verdict("detach-failed", `código ${detach.exitCode}`);
  }

  return { ok: true, reason: null, message: MESSAGES.ok };
}
