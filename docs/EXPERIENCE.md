# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When adding user-facing decision logic to an Electron main-process file, extract the pure decision function into a module with no electron imports (same pattern as tray.ts) so scripts/unit.test.ts can exercise all branches without booting… (fonte: P3-013)
- When deriving one-shot events from a recurring health poll, track previous state starting at null and only fire on a real prev !== next change — the first observation after boot and stable states must both map to "none" or every 3s poll re… (fonte: P3-013)
- When invoking platform APIs that can be unsupported, denied, or throw inside a long-lived poll loop, guard with isSupported() plus try/catch that logs and continues, so a notification failure can never kill the poller that other features (… (fonte: P3-013)
