# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When a dashboard counter must be honest (match `git log --since=00:00`), derive it from a persistent daily counter in state.json that rolls at midnight with the other budgets — never count occurrences in a truncated events tail (slice(-200… (fonte: P2-045)
- When adding a field to state.json, backfill it defensively in loadState (typeof/finite guard) and zero it in the date-rollover reset branch, so legacy state files predating the field never surface undefined/NaN. (fonte: P2-045)
- When a widget depends on an optional artifact (e.g. history.jsonl) or a structured signal, implement the aggregation as pure functions over the records in a shared module testable by the eval battery, have the API return `exists:false` for… (fonte: P2-045)
