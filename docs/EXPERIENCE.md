# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When an Electron main process spawns cleanup-sensitive children (daemon sidecar), install `uncaughtException`/`unhandledRejection` handlers at the very top of the entrypoint that log the stack and route through `app.quit()` — an uncaught e… (fonte: P3-011)
- When auto-recovering a crashed renderer via `render-process-gone`, bound reloads with a rolling-window budget (max 3 per 60s shared across windows), skip `reason === "clean-exit"` (deliberate teardown, not a crash), and check `isDestroyed(… (fonte: P3-011)
- When Electron main-process logic needs unit tests, extract it into modules typed against structural subsets of Electron APIs (no `electron` import) with injectable log/quit sinks, so plain tsx scripts can fake the window/app and exercise t… (fonte: P3-011)
