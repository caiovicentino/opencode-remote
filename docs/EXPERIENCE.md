# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When failure state persists in a side file across pipeline attempts (e.g., a gate-fail JSON), every failure path that can end the task must also write or clear it before returning — otherwise downstream scribes read a stale step/tail from… (fonte: P2-031)
- When a structured record carries both a summary field (findings) and a detail field (tail), never populate both from the same source string — derive the summary from higher-level info (e.g., the failing step name) so prompt renderings don'… (fonte: P2-031)
- When documenting enum-like values (step names) in doc comments or docs, restrict them to what code paths actually produce — advertising values no writer emits (e.g., "review"/"crash") makes prompt semantics lie, so fix comments and docs in… (fonte: P2-031)
