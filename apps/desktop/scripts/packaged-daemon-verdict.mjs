/**
 * P2-251: pure verdict for the packaged-daemon smoke. Deliberately NO I/O
 * here (same rule as packaged-boot-verdict.mjs): scripts/unit.test.ts imports
 * this file directly and must never boot a process, open a socket or touch
 * the filesystem — every fact is injected by the caller.
 *
 * Unlike the boot verdict (first match wins), this table has NO
 * short-circuit: every failing rule contributes its own problem and the full
 * list is returned at once, because the release job prints them all in a
 * single run. The rules, in this fixed order:
 *
 *   daemon-exited         the child process died before the health route
 *                         answered — the bounded stderr tail is cited
 *   module-resolution     the stderr tail carries a module resolution
 *                         failure — named on purpose, because that is
 *                         exactly the packaging regression (a resource left
 *                         out of the bundle, an unresolvable dynamic call, a
 *                         native module) this smoke exists to catch
 *   health-unreachable   /api/health never answered within the deadline
 *   health-status         /api/health answered outside the success range
 *
 * Approved is ONLY the case where health answered 2xx while the child was
 * still alive. Messages are short pt-BR lines for the release-job log: no
 * environment content, no token, no pairing credential (the stderr tail is
 * bounded and flattened to one line by citeTail).
 */

/** A module resolution failure in the child's stderr — the packaging
 * regression this smoke exists to catch, so it gets its own named problem. */
export const MODULE_RESOLUTION_RE = /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/;

const MESSAGES = {
  ok: "daemon empacotado subiu com o Electron do próprio pacote e respondeu /api/health com sucesso",
  "daemon-exited": "o daemon empacotado saiu antes de responder com vida",
  "module-resolution": "falha de resolução de módulo no daemon empacotado — recurso ficou fora do bundle",
  "health-unreachable": "o /api/health do daemon empacotado não respondeu dentro do prazo",
  "health-status": "o /api/health do daemon empacotado respondeu fora da faixa de sucesso",
};

/** Bound + flatten the stderr tail for the problem line: last 240 chars,
 * all whitespace collapsed — enough to diagnose, never a full log dump. */
function citeTail(tail) {
  const flat = tail.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `…${flat.slice(-240)}` : flat;
}

function formatSeconds(ms) {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Decide the daemon smoke verdict from plain facts:
 *
 *   exitCode        child exit code, null while alive
 *   signal          child termination signal, null when none
 *   elapsedMs       wall time the smoke waited before giving up
 *   healthAnswered  true when the authenticated /api/health got an HTTP answer
 *   healthStatus    that answer's status code, null when never answered
 *   stderrTail      bounded tail of the child's stderr ("" when clean)
 *
 * Returns { ok, reason, message, problems } — problems lists every failing
 * rule in the fixed order above; ok is true exactly when it is empty.
 */
export function daemonVerdict(facts) {
  const exitCode = facts?.exitCode ?? null;
  const signal = facts?.signal ?? null;
  const elapsedMs = Number.isFinite(facts?.elapsedMs) ? facts.elapsedMs : 0;
  const tail = typeof facts?.stderrTail === "string" ? facts.stderrTail : "";
  const healthAnswered = facts?.healthAnswered === true;
  const healthStatus = typeof facts?.healthStatus === "number" ? facts.healthStatus : null;

  const problems = [];

  // Rule 1: a child that died never proves the sidecar boots — cite the tail.
  if (exitCode !== null || signal !== null) {
    const how = signal !== null ? `sinal ${signal}` : `código ${exitCode}`;
    const cited = citeTail(tail);
    problems.push({
      reason: "daemon-exited",
      message: `${MESSAGES["daemon-exited"]} (${how}) — cauda: ${cited || "vazia"}`,
    });
  }
  // Rule 2: the named module-resolution problem — independent of rule 1 so a
  // dead child whose tail names the missing module reports both at once.
  if (MODULE_RESOLUTION_RE.test(tail)) {
    problems.push({ reason: "module-resolution", message: MESSAGES["module-resolution"] });
  }
  // Rule 3: health never answered inside the deadline.
  if (!healthAnswered) {
    problems.push({
      reason: "health-unreachable",
      message: `${MESSAGES["health-unreachable"]} (${formatSeconds(elapsedMs)} de espera)`,
    });
  }
  // Rule 4: health answered, but outside the 2xx success range.
  if (healthAnswered && !(healthStatus !== null && healthStatus >= 200 && healthStatus < 300)) {
    problems.push({
      reason: "health-status",
      message: `${MESSAGES["health-status"]} (status ${healthStatus ?? "desconhecido"})`,
    });
  }

  if (problems.length === 0) {
    return { ok: true, reason: null, message: MESSAGES.ok, problems };
  }
  return { ok: false, reason: problems[0].reason, message: problems[0].message, problems };
}
