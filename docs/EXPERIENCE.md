# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When touching Electron main-process modules, keep them free of `electron` imports and inject a structural fs/dir subset (the window-state.ts pattern) so the real logic runs under plain tsx tests instead of needing a packaged app to verify. (fonte: P3-012)
- When rotating a log file with `rename`, unlink the destination (`.1`) first — rename cannot overwrite an existing file on Windows and the rotation would silently fail there. (fonte: P3-012)
- When adding a side-channel sink (log file, telemetry), wrap every fs write in try/catch so failures degrade to the console mirror and never throw — a full disk or a logs dir deleted mid-run must not crash the shell; on ENOENT, recreate the… (fonte: P3-012)
