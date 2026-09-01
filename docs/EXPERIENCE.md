# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When a local test harness exposes a control socket or log file, do create every session artifact (socket, token file, log) inside a fresh 0700 session-owned dir and chmod the socket 0600 after bind — predictable paths in world-writable /tm… (fonte: P1-051)
- When a gate's verdict is "CLI exited 0" against a well-named socket or endpoint, do use a unique per-run session name and require the server to prove identity (answer = sha256(token:nonce) over a per-request nonce) — an impostor binding th… (fonte: P1-051)
- When hermetic tests need deterministic app behavior, do add explicit test-only env escape hatches (like OCR_DAEMON_FORCE_DOWN or OCR_USER_DATA_DIR) applied at the earliest possible point of the main process before anything reads the affect… (fonte: P1-051)
