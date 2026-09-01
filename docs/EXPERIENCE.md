# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When releasing a per-connection resource from both `close` and `error` handlers, add an idempotency flag on the socket (e.g. `released`) before the first release — ws can fire both events for one connection and double-release corrupts/unde… (fonte: P2-025)
- When keying admission limits off `req.socket.remoteAddress`, document the proxy case: behind a TLS-terminating proxy every client shares one IP, so the cap must be raised via env or traffic routed as TCP passthrough (fonte: P2-025)
- When testing server-side WebSocket admission, don't treat handshake `open` as proof of admission — a refused connection closes right after handshake, so resolve success only after a short grace period (~150ms) and assert the close code/rea… (fonte: P2-025)
