# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When registering an OS protocol handler in Electron (`setAsDefaultProtocolClient`), guard it with `app.isPackaged` plus explicit platform checks so a dev run never steals the OS handler from the packaged app, and declare the scheme in elec… (fonte: P3-014)
- When accepting deep links in an Electron shell, handle both delivery paths — macOS `open-url` (fires before app ready on cold start, so register early) and Windows second-instance argv — and cache the validated URI for a one-shot `ipcMain.… (fonte: P3-014)
- When validating OS-supplied strings (deep links, argv), keep the parse/validate logic in a pure module with no electron imports (window-state.ts pattern) so unit tests exercise it directly, and route the accepted result through the existin… (fonte: P3-014)
