# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When creating a per-task branch with `git checkout -b pilot/<ID>`, first delete any stale branch of the same name (e.g. `git branch -D pilot/<ID>` if it exists) — aborted pipeline attempts leave the branch behind and every retry fails with… (fonte: P2-019)
- When a server-side Map is keyed by client-supplied identifiers (room ids, channels, topics), enforce both a charset/length grammar and a per-connection cap on distinct keys — check the cap before the join but let re-joins of already-held k… (fonte: P2-019)
- When a frame violates a soft protocol rule on a long-lived socket, drop the frame and increment a counter instead of closing the connection, exposing the counter on /metrics and /healthz with only id prefixes logged — this keeps legit clie… (fonte: P2-019)
