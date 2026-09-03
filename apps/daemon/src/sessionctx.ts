// P1-068: artifacts protocol injected into every session the daemon creates.
// Pure helpers kept in their own module (same pattern as localws.ts) so tests
// pin them without booting a daemon — index.ts runs main() on import.
// P1-096: the `system` block is byte-identical for every session so the
// provider prefix-caches it; the only per-session datum (the artifacts dir)
// travels as a one-shot text part on the session's first turn.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Unique string that dedupes the injected block across turns. */
export const ARTIFACTS_MARKER = "ocr-artifacts-protocol";

/** Unique string that dedupes the per-session path line across turns (P1-096). */
export const ARTIFACTS_PATH_MARKER = "ocr-artifacts-path";

/**
 * Prompt block appended to every turn of a daemon-created session.
 * Takes no session input: two sessions must produce the exact same bytes
 * (P1-096 — a per-session byte would zero the provider's prefix cache).
 */
export function buildArtifactsPrompt(): string {
  return [
    `[${ARTIFACTS_MARKER}] Protocolo de artifacts (vale para toda a sessão):`,
    `- Todo documento/preview gerado (html, md, csv, pdf…) vira um arquivo self-contained gravado no diretório de artifacts da sessão (caminho exato na linha [${ARTIFACTS_PATH_MARKER}]; crie o diretório se não existir).`,
    `- Mencione o filename do artifact na sua resposta — o app lista os arquivos no pane "Artifacts" e anexa um card na mensagem.`,
    `- Para o usuário baixar no celular, salve em ~/.opencode-remote/uploads/ e inclua na resposta uma linha no formato exato [file: <caminho absoluto>] — ela vira um card de download.`,
    `- Sites/servidores locais são permitidos (http.server, vite, dev servers): ao subir um, mencione na resposta a URL http://localhost:<porta> — o app abre o preview interativo sozinho no pane Browser.`,
  ].join("\n");
}

/** The single per-session line of the protocol: the concrete artifacts dir. */
export function buildArtifactsPathLine(sessionId: string): string {
  const dir = join(homedir(), ".opencode-remote", "artifacts", sessionId);
  return `[${ARTIFACTS_PATH_MARKER}] Diretório de artifacts desta sessão: ${dir}/`;
}

/**
 * True when the workspace's own AGENTS.md already teaches the artifacts
 * protocol (the dedupe marker or the artifacts path). Any read failure
 * returns false — fail-open: a redundant instruction is cheaper than a
 * session that never learns the protocol.
 */
export function workspaceCoversArtifacts(directory: string): boolean {
  if (!directory || typeof directory !== "string") return false;
  for (const name of ["AGENTS.md", "agents.md"]) {
    try {
      const content = readFileSync(join(directory, name), "utf8");
      if (content.includes(ARTIFACTS_MARKER) || content.includes(".opencode-remote/artifacts")) {
        return true;
      }
    } catch {
      // missing/unreadable candidate: try the next spelling
    }
  }
  return false;
}

/**
 * Append the artifacts protocol to the `system` field of a
 * POST /session/<id>/message body (SessionPromptData in the opencode SDK).
 * Appends after any client-provided system prompt — never overwrites — and a
 * second call on the same body is a no-op (marker dedupe). Mutates and
 * returns the body; `parts`/`model`/`agent` are left untouched.
 */
export function injectArtifactsSystem<T extends { system?: string }>(body: T): T {
  if (!body || typeof body !== "object") return body;
  const existing = typeof body.system === "string" ? body.system.trim() : "";
  if (existing.includes(ARTIFACTS_MARKER)) return body;
  body.system = [existing, buildArtifactsPrompt()].filter(Boolean).join("\n\n");
  return body;
}

/**
 * P1-096: append the per-session artifacts path line as the LAST text part of
 * the body — one-shot, meant for the session's first turn (the line then lives
 * in the history). Idempotent: any part already carrying the path marker makes
 * the call a no-op. Bodies without a `parts` array or with no text part are
 * skipped (fail-open: a later turn retries). Returns true when appended.
 */
export function injectArtifactsPathPart<T extends { parts?: unknown[] }>(
  body: T,
  sessionId: string,
): boolean {
  if (!body || typeof body !== "object" || !Array.isArray(body.parts)) return false;
  const parts: unknown[] = body.parts;
  const marker = `[${ARTIFACTS_PATH_MARKER}]`;
  let hasText = false;
  for (const p of parts) {
    const text = (p as { text?: unknown } | null)?.text;
    if (typeof text !== "string") continue;
    hasText = true;
    if (text.includes(marker)) return false;
  }
  if (!hasText) return false;
  parts.push({ type: "text", text: buildArtifactsPathLine(sessionId) });
  return true;
}
