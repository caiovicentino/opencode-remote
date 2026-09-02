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
- When adding state preservation across attempts (e.g., keeping a task branch between runs), audit every pre-existing reset/fallback path that touches that state — a reset to origin/main that was safe on a fresh workspace destroys preserved… (fonte: P1-060)
- When parsing multiple trailing metadata tags from a backlog line, strip them right-to-left in a loop anchored at end-of-line so tags work in any order and a tag mentioned mid-spec stays part of the spec text (fonte: P1-060)
- When reviewing long-horizon work, review the incremental diff since a round checkpoint instead of the truncated whole-branch diff, and re-validate any sha/id loaded from a file outside the repo against a strict charset (e.g. /^[0-9a-f]{7,4… (fonte: P1-060)
- When adding an escalation/arbitration layer (stronger reviewer) that can reject a build, union its verified kept findings with the earlier rounds' verified kept findings (dedup) before feeding the builder — an arbiter must add evidence, ne… (fonte: P1-059)
- When spawning a non-streaming CLI (e.g. `claude -p` emits only the final answer), do not depend on stdout activity for liveness — feed self-watchdog heartbeats on a timer, treat the run as valid only if exit 0 + non-empty output + expected… (fonte: P1-059)
- When capping a directory listing into an LLM prompt, sort by mtime descending BEFORE slicing — `readdirSync` order is arbitrary and a raw cap silently drops the newest carryover evidence (fonte: P1-059)
- When a server hosts sessions over multiple transports (e.g., relay + direct loopback WS), do scope connection-loss teardown to the failed transport's sockets (match `session.socket === ws`) instead of clearing the whole session map — clear… (fonte: P1-061)
- When an expiry/stale sweep keys on `lastSeen`, do refresh that timestamp on every liveness signal including pings — otherwise broadcast() skips an open, heartbeating socket and the client stays "paired" but blind, never triggering a reconn… (fonte: P1-061)
- When adding a new dial/failover path to a client, do write an integration test that drives the real `connect()` with the credential provider stubbed, not just unit-pinned pure helpers — silent-socket bugs (e.g., missing send-on-open → 3s t… (fonte: P1-061)
- When a viewer component must render both as a fixed full-screen overlay and embedded inside a flex pane, add a `variant` prop that switches only the positioning styles instead of forking the component, and gate the two render sites with co… (fonte: P2-062)
- When UI must switch layout at a viewport threshold, initialize state from `window.innerWidth` and keep it live with `matchMedia(min-width).addEventListener("change", ...)` — a one-shot check or ad-hoc resize handler goes stale when the win… (fonte: P2-062)
- When wrapping an existing max-width reading column into a flex row, explicitly override the parent constraint (`max-width: none`, including scoped variants like `.desk-main .screen`) and set `min-width: 0`/`min-height: 0` on the flex child… (fonte: P2-062)
- When an agent ingests untrusted external content (fetched web pages, pushed text) on the host, do not run it with shell or edit permissions — run it with a bash/edit/external_directory:deny sandbox, make it emit proposals as plain text bet… (fonte: P1-057)
- When a runner commits or pushes on behalf of an agent, do not push blindly — gate the push on git diff --name-only origin/main...HEAD matching exactly one allowlisted path, re-read the guard from the real branch diff on every retry, and ne… (fonte: P1-057)
- When serving an authenticated dashboard, do not embed the apiToken in the rendered HTML — have the browser exchange the Bearer token once for a short-lived HttpOnly SameSite=Strict session cookie, keep sessions memory-only so a daemon rest… (fonte: P1-057)
