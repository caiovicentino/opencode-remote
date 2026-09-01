# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When building a golden corpus for output matchers (evidence gates, invariant checks), capture structurally different samples of the same command — verbose run, terse run, run with warnings — not just repeated identical runs; a matcher test… (fonte: P3-033)
- When recording real command output as fixtures, sanitize volatile tokens (timestamps, pids, tmp dirs, durations) but keep warnings, JSON log lines and stack traces verbatim — the matcher must learn to tolerate the noise an honest paste act… (fonte: P3-033)
- When naming corpus fixtures, embed the provenance (source task/merge id) in the filename (e.g. `2-13f3a96.txt`) so future agents can trace where each sample came from and avoid re-capturing duplicates of the same code state (fonte: P3-033)
