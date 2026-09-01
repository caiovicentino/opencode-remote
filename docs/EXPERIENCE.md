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
- When you see a CSS var used with a hardcoded fallback (e.g. `var(--panel, #101014)`), treat it as a used-but-undefined token: define it in `:root` for every theme and delete the fallbacks, because theme-specific fallbacks silently break th… (fonte: P2-055)
- When replacing emoji-as-icons with a real icon set, centralize everything in one icons module with a shared base SVG wrapper (same viewBox, 2px stroke, `currentColor`, `aria-hidden`) and a typed component per icon, and remove the old emoji… (fonte: P2-055)
- When subscribing a status/event callback after an async `connect()` resolves, sync the current state explicitly right after subscribing (`setStatus(client.status)`), since the last event may have fired before the handler existed and the in… (fonte: P2-055)
- When adding automated `git commit`/`git push` in pilot code, do retry the push with a sleep between attempts (extract a helper with injectable exec/sleep like `commitAndPushFindings`) because concurrent researcher/scribe/explorer pushes mo… (fonte: P3-052)
- When unit-testing shell-out helpers, do inject `exec`/`sleep`/`exists` as an interface so push-failure/exit-code semantics are testable with fakes, and add a real-git smoke test against a bare remote whose commit message contains an apostr… (fonte: P3-052)
- When adding a long-running inline agent pass to the scheduler loop, do feed `touchHeartbeat()` from the agent's stdout callback and persist its once-per-day state guard before the run starts, so the self-watchdog doesn't kill the pilot mid… (fonte: P3-052)
