# Experience memory (IER)

Lições destiladas pelo pipeline (role SCRIBE) após cada merge bem-sucedido.
Cada lição é uma linha `- When <situação>, do <ação> (fonte: <ID>)`. Os prompts
de builder e strategist recebem o top-5 de lições relevantes (keyword-match,
mais recentes primeiro); o red team noturno deduplica e poda acima de
60 lições.

## Lessons
- When a shell reuses an external (adopted) daemon it did not spawn, do not apply the owned-child respawn budget/give-up semantics — only your own children can exhaust a budget; for adopted ones probe health forever with capped backoff and s… (fonte: P1-053)
- When arming a self-scheduling async watchdog, make start/stop idempotent, stop it before intentional stops or fresh spawns, and re-check the armed flag after every await — an in-flight probe must never schedule a timer or mutate state for… (fonte: P1-053)
- When recovery from a daemon outage must not require re-pairing, never rewrite the 0600 state file or allowlist during reconnect, keep the degraded state's uri null so no QR overlay can open from it, and re-run auto-pair once when the banne… (fonte: P1-053)
