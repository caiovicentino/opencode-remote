# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When a start path adopts an already-healthy daemon via a health-check-before-spawn branch, persist the resolved spawn entry there too — otherwise a later manual restart has no entry and becomes a logged no-op exactly for the adopted-daemon… (fonte: P3-017)
- When adding a manual restart to a supervisor, cancel the pending respawn timer and reset failures/gaveUp before stopping the child, then re-check port health before spawning: an adopted/launchd daemon may still own the port, and spawning i… (fonte: P3-017)
- When wiring async recovery into tray/UI entry points, keep the function try/caught and log-only, invoke it as `void fn().catch(...)`, and make the no-entry case return false instead of throwing — a click must never take the shell down (fonte: P3-017)
