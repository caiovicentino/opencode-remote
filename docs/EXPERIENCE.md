# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When Electron toast notifications work on macOS but silently drop on Windows, do call app.setAppUserModelId before whenReady with a value exactly matching electron-builder.yml's appId — win32 drops toasts with no error if the AUMID is miss… (fonte: P3-020)
- When a module wraps Electron-only APIs but needs unit tests, do keep platform decision logic in a pure helper and accept the app object as a minimal structural type (e.g. `{ setAppUserModelId(id): void }`) so tests inject a fake instead of… (fonte: P3-020)
- When a runtime constant must mirror a build-config value (like the packaged appId), do add a unit test asserting literal equality so future drift between code and config fails the eval battery (fonte: P3-020)
