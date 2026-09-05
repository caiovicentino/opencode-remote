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

/** Unique string that dedupes the self-serve mission convention across turns. */
export const MISSION_MARKER = "ocr-mission-protocol";

/** Where the chat agent writes the fleet mission (see apps/pilot/src/mission.ts). */
export const MISSION_FILE_HINT = "~/.opencode-remote/mission.json";

/** Fleet roles a mission may pin to a model (mirror of apps/pilot/src/mission.ts). */
export const MISSION_MODEL_ROLES_HINT = "strategist|researcher|builder|reviewer|scribe";

/**
 * Self-serve mission convention (v2 — "the user asks their way, the agent
 * composes the spec"): the user states the mission however they like (vague,
 * a bare link, or prompt + repo + preferences) and the agent itself composes
 * the COMPLETE mission.json — no form, no separate pane. The same block also
 * teaches the model pins (verified against `opencode models`) and the clear
 * path (delete the file). Constant bytes like the artifacts block (P1-096):
 * no per-session datum.
 */
export function buildMissionPrompt(): string {
  return [
    `[${MISSION_MARKER}] Missão da frota autônoma (vale para toda a sessão):`,
    `- O usuário define ou muda a missão da frota do jeito que quiser — vago ("conserta o bug do meu app"), só um link, ou detalhado (pedido + repo + preferências). Você compõe sozinho o ${MISSION_FILE_HINT} COMPLETO a partir do que ele disse, com este JSON: {"v":1,"prompt":"<intenção do usuário, fiel e autocontida>","repoUrl":"https://github.com/<org>/<repo>.git","models":{"<papel>":"<provider/modelo>"},"setAt":"<data-hora ISO 8601 de agora>"}. Campos ausentes são omitidos, nunca inventados.`,
    `- repoUrl: se aparecer QUALQUER link do GitHub nas palavras do usuário (no meio da frase, com /tree/..., sem https, com .git ou barra final), deduza org/repo e normalize para https://github.com/<org>/<repo>(.git)? — só esse formato vale. Sem link, omita o campo: a frota trabalha no repo dela mesma.`,
    `- prompt: uma afirmação fiel e autocontida do que o usuário quer (quem lê só o arquivo, sem o chat, precisa entender) — pode ser uma frase só. Nunca invente requisitos, critérios ou escopo que ele não disse; se só houver um link, omita o prompt. Pelo menos um de prompt/repoUrl é obrigatório.`,
    `- models (opcional): papel -> id de modelo; papéis válidos: ${MISSION_MODEL_ROLES_HINT} (subconjunto permitido; qualquer outro papel invalida o arquivo inteiro). Só grave um id que você verificou na saída de \`opencode models\` (formato provider/modelo); quando o usuário perguntar quais modelos existem ("quais modelos?"), rode \`opencode models\` e liste as opções. Papel sem modelo usa o padrão da frota; sem pedido de modelo, omita o campo.`,
    `- Nunca grave tokens, chaves ou segredos. Escrita atômica e privada: grave em ${MISSION_FILE_HINT}.tmp, rode chmod 600 nele e depois mv por cima de ${MISSION_FILE_HINT}.`,
    `- Encerrar a missão ("missão limpa", "encerrar missão", "voltar pro repo de vocês"): apague o arquivo com rm -f ${MISSION_FILE_HINT} — a frota volta ao modo de auto-evolução do repo dela no próximo boot.`,
    `- Confirme ao usuário em uma frase curta que a frota pega a missão (ou o encerramento) no próximo boot.`,
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
 * returns the body; `parts`/`model`/`agent` are left untouched. The self-serve
 * mission convention rides the same injection (own marker, own dedupe).
 */
export function injectArtifactsSystem<T extends { system?: string }>(body: T): T {
  if (!body || typeof body !== "object") return body;
  const existing = typeof body.system === "string" ? body.system.trim() : "";
  const blocks = [existing];
  if (!existing.includes(ARTIFACTS_MARKER)) blocks.push(buildArtifactsPrompt());
  if (!existing.includes(MISSION_MARKER)) blocks.push(buildMissionPrompt());
  if (blocks.length === 1) return body;
  body.system = blocks.filter(Boolean).join("\n\n");
  return body;
}

/**
 * P1-096: append the per-session artifacts path line as the LAST part of the
 * body (after any text/file parts already present) — one-shot, meant for the
 * session's first turn (the line then lives in the history). Idempotent: any
 * part already carrying the path marker makes the call a no-op. Bodies without
 * a `parts` array or with no text part are skipped (fail-open: a later turn
 * retries). Returns true when appended.
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
