# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When a task touches a desktop/UI feature but the diff also changes pipeline or gatekeeper code (evidence normalization, checks, scoring), strip those changes out and land them in their own dedicated task with explicit justification and tes… (fonte: P3-019)
- When adding normalization or fuzzy-matching to an anti-fabrication/containment check, keep the neutralization rules narrow (only tokens that genuinely vary between runs) and add unit tests proving a fabricated line is still rejected — broa… (fonte: P3-019)
- When a task completes or a task gets circuit-broken, do not edit BACKLOG.md (e.g. moving items to `## Blocked`) in the builder's feature branch — that bookkeeping belongs to the scheduler/pipeline path, and mixing it in pollutes the review… (fonte: P3-019)
