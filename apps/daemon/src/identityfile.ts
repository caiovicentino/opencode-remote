// P2-234: identity-file boot verdict. Pure module — no node:fs,
// node:crypto, node:child_process or fetch imports on purpose, because
// index.ts runs main() on import and unit tests must never boot a daemon
// (same pattern as statefile.ts / doccap.ts).
//
// Why this exists: daemon.json carries the machine identity — ECDH keys,
// VAPID keys and the paired-clients list. A truncated or hand-mangled file
// (a crashed pre-P2-165 write, a full disk before P2-215 existed, a failed
// manual edit during a support session) used to kill the daemon with a raw
// SyntaxError from a bare JSON.parse: the machine simply vanished from the
// phone with no word about what happened or what survived. This module is
// the single source of truth for what the daemon does with that file at
// boot, and it always answers with a plan plus one short static pt-BR
// sentence that is safe to log.
//
// RULE-ORDER CONTRACT (the unit-test gate depends on this order): a
// filesystem READ FAILURE (permission denied, file busy, …) is evaluated
// FIRST and NEVER becomes a first run and NEVER becomes a quarantine — it
// always refuses the boot with the file untouched. Treating a transient
// read failure as a missing file would mint a brand-new identity and
// silently erase every pairing the owner ever made; refusing keeps the
// bytes exactly where they are until a human looks at them. Only after
// that comes the missing-file first run, then the content checks; content
// that cannot be parsed or carries no documented identity field refuses
// the boot WITH a quarantine move so nothing is ever deleted.
//
// Every message is a static string: no absolute file path, no URL scheme,
// no secret and NEVER any snippet of the file content, because the content
// carries the private key and the sentence goes to the log.

export type IdentityPlan = "first-run" | "use" | "refuse";

export interface IdentityVerdict {
  plan: IdentityPlan;
  /**
   * True only when the caller must preserve the illegible file beside the
   * original (quarantine move) before exiting. Never true for a filesystem
   * read failure — see the rule-order contract above.
   */
  quarantine: boolean;
  /** One short actionable pt-BR sentence — static, log-safe, content-free. */
  message: string;
}

export const IDENTITY_FIRST_RUN_MESSAGE =
  "Primeira execução — uma identidade local nova será criada para esta máquina.";
export const IDENTITY_USE_MESSAGE = "Identidade local desta máquina lida com sucesso.";
export const IDENTITY_REFUSE_CONTENT_MESSAGE =
  "O arquivo de identidade está ilegível e foi preservado ao lado do original — restaure-o no lugar para recuperar os pareamentos, ou apague os dois arquivos para recomeçar pareando tudo de novo.";
export const IDENTITY_REFUSE_READ_MESSAGE =
  "O arquivo de identidade desta máquina não pôde ser lido — verifique a permissão dele sem apagar nada e reinicie o app.";

/** Fields the daemon state file documents (IdentityFile in index.ts). */
const KNOWN_FIELDS: readonly string[] = [
  "room",
  "publicKey",
  "secretKey",
  "ecdhPub",
  "ecdhPriv",
  "vapid",
  "clients",
  "name",
  "notify",
  "autoMode",
];

/**
 * Decide what the boot must do with the identity file. Inputs are plain
 * values (the caller owns all I/O):
 *   - `exists`: whether the file was present when stat'd;
 *   - `content`: the file text when the read succeeded, null otherwise;
 *   - `readFailure`: the filesystem error code when the read failed.
 *
 * Plans, in THIS order:
 * 1. read failure → refuse, never quarantine, never first run (see header);
 * 2. file missing → first run (the existing boot path creates identity);
 * 3. file present but empty/whitespace → first run (nothing to keep);
 * 4. content that does not parse, is not a plain object, or is an object
 *    with NO documented identity field → refuse + quarantine;
 * 5. otherwise → use the content (the v1→v2 migration in index.ts fills
 *    any missing keys).
 */
export function identityVerdict(
  exists: boolean,
  content: string | null,
  readFailure?: string | null,
): IdentityVerdict {
  if (typeof readFailure === "string" && readFailure !== "") {
    return { plan: "refuse", quarantine: false, message: IDENTITY_REFUSE_READ_MESSAGE };
  }
  if (!exists) {
    return { plan: "first-run", quarantine: false, message: IDENTITY_FIRST_RUN_MESSAGE };
  }
  if (content == null) {
    return { plan: "refuse", quarantine: false, message: IDENTITY_REFUSE_READ_MESSAGE };
  }
  if (content.trim() === "") {
    return { plan: "first-run", quarantine: false, message: IDENTITY_FIRST_RUN_MESSAGE };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { plan: "refuse", quarantine: true, message: IDENTITY_REFUSE_CONTENT_MESSAGE };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { plan: "refuse", quarantine: true, message: IDENTITY_REFUSE_CONTENT_MESSAGE };
  }
  const keys = Object.keys(parsed as Record<string, unknown>);
  if (!keys.some((k) => KNOWN_FIELDS.includes(k))) {
    return { plan: "refuse", quarantine: true, message: IDENTITY_REFUSE_CONTENT_MESSAGE };
  }
  return { plan: "use", quarantine: false, message: IDENTITY_USE_MESSAGE };
}

/**
 * Derive the quarantine file name: the original name plus a sortable UTC
 * timestamp stamp and a fixed suffix. Two different instants never collide,
 * the names sort chronologically as plain strings, the result is never
 * empty and never equals the original name.
 */
export function quarantineName(original: string, now: Date): string {
  // 2026-09-06T03:04:05.123Z → 20260906T030405123Z (lexicographically sortable)
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  const base = original.trim();
  const name = base.length > 0 ? base : "daemon.json";
  return `${name}.${stamp}.quarantine`;
}
