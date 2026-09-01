# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When adding rate-based circuit breakers with sliding windows, require the window to be full (e.g., cycles.length >= window size) before evaluating the failure rate, so a partial window can never trip the breaker on a tiny sample (fonte: P2-032)
- When adding breaker/pause fields to persisted runtime state that resets on date rollover, explicitly carry those fields through the reset and normalize them on load (validate types, backfill legacy files, reject malformed values), or the m… (fonte: P2-032)
- When counting failure evidence from multiple overlapping sources, record events only at the point of truth (e.g., after the push to main actually succeeds) and dedupe by entity key across sources, so retry cycles and double-recorded artifa… (fonte: P2-032)
