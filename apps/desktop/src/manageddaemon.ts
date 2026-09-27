// eval-11: the launchd-managed daemon and the app's own sidecar must never run
// on the same identity at once.
//
// deploy/install.sh installs the daemon as the launchd agent com.ocr.daemon
// (~/Library/LaunchAgents/com.ocr.daemon.plist, RunAtLoad + KeepAlive, API on
// :8792, RELAY_URL from the plist). The desktop shell, an "Open at Login" item
// since P2-218, adopts that daemon when it answers — but at login it reached
// its port walk BEFORE launchd's node+tsx daemon had bound :8792, found the
// port free and started its own sidecar there. Measured on the operator's
// machine (desktop.log vs daemon.log, 14/09, 15/09, 17/09 and 20/09): the app
// spawned its sidecar 10–19s before the managed daemon logged "daemon
// starting" followed by "metrics server unavailable: EADDRINUSE". Two daemons
// then ran on ONE identity (same daemon.json: room, keys, allowlist): the
// managed one on the real relay but with no API — un-adoptable and invisible
// to the app — and the app's sidecar with the API but dialing the default
// loopback relay, so the pairing QR pointed the phone at the phone itself
// (the 20–22/09 pairing incident). The metrics.ts bind retry (#1179) only makes
// the managed daemon adoptable after the app's sidecar dies.
//
// This module owns the one decision the port walk lacked: when a managed
// daemon is installed for the identity the shell is about to use, it gets a
// bounded grace to answer before a second daemon is started. Pure: no
// electron, no fs, no process, no timers — daemon.ts injects the facts and
// runs the wait; scripts/manageddaemon.test.ts covers every rule.
//
// RULE ORDER (first match wins):
//   1. a harness session (OCR_DESKTOP_SESSION) never waits — gate runs stay
//      exactly as they were and never depend on the operator's services;
//   2. an overridden state file (OCR_DAEMON_STATE_FILE, test-only) is another
//      identity by construction — the managed daemon does not serve it;
//   3. a preferred port other than the managed daemon's (an OCR_DAEMON_METRICS_PORT
//      / OCR_METRICS_PORT override) means the shell is not looking where the
//      managed daemon listens;
//   4. only macOS has a managed daemon (launchd); every other platform keeps
//      the sidecar as the one daemon;
//   5. no com.ocr.daemon plist → nothing to wait for;
//   6. otherwise WAIT up to MANAGED_DAEMON_GRACE_MS, adopting the moment it
//      proves its identity; past the grace the caller falls back to today's
//      behavior (its own sidecar), logging why.

import { join } from "node:path";

/** launchd label written by deploy/install.sh (cli.mjs manages the same one). */
export const MANAGED_DAEMON_LABEL = "com.ocr.daemon";

/** The port the managed daemon's plist binds (OCR_METRICS_PORT=8792) — the
 * same number as daemonport.ts DEFAULT_DAEMON_PORT. */
export const MANAGED_DAEMON_PORT = 8792;

/**
 * How long a managed daemon may take to answer before the app starts its own.
 * Measured login deltas were 10.0s, 13.5s, 16.0s and 18.7s between the app's
 * spawn and the managed daemon's first log line (its API binds within ~15ms
 * of that line), so 30s covers the worst observed case with ~1.6x margin. The
 * wait ends the moment the daemon answers; only a managed daemon that is
 * stopped or broken costs the full grace.
 */
export const MANAGED_DAEMON_GRACE_MS = 30_000;

/** Probe cadence inside the grace — the same 500ms as the health wait. */
export const MANAGED_DAEMON_POLL_MS = 500;

/** Where launchd keeps the managed daemon's agent for `home`. */
export function managedDaemonPlistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${MANAGED_DAEMON_LABEL}.plist`);
}

export interface ManagedDaemonFacts {
  /** process.platform of the shell. */
  platform: string;
  /** True under the hermetic harness (OCR_DESKTOP_SESSION set). */
  harnessSession: boolean;
  /** True when OCR_DAEMON_STATE_FILE points the shell at another identity. */
  stateFileOverride: boolean;
  /** The port the shell prefers (daemon.ts DAEMON_METRICS_PORT). */
  preferredPort: number;
  /** True when the com.ocr.daemon launchd plist exists for this user. */
  plistInstalled: boolean;
}

export type ManagedDaemonPlan =
  | { action: "wait"; graceMs: number; reason: string }
  | { action: "spawn"; reason: string };

/** Static pt-BR reasons (log-only): no path, no port text, no identifier. */
export const MANAGED_REASONS = {
  harness: "sessão de teste do harness — nenhuma espera pelo daemon gerenciado",
  stateOverride: "arquivo de estado sobrescrito — o daemon gerenciado atende outra identidade",
  portOverride: "porta sobrescrita — o daemon gerenciado escuta em outra porta",
  platform: "sem daemon gerenciado nesta plataforma — o app sobe o próprio daemon",
  notInstalled: "nenhum daemon gerenciado (launchd) instalado — o app sobe o próprio daemon",
  wait: "daemon gerenciado (launchd) instalado para esta identidade — aguardando ele responder antes de subir um segundo daemon",
} as const;

/** The decision, in the documented rule order. Never throws. */
export function managedDaemonPlan(facts: ManagedDaemonFacts): ManagedDaemonPlan {
  if (facts.harnessSession) return { action: "spawn", reason: MANAGED_REASONS.harness };
  if (facts.stateFileOverride) return { action: "spawn", reason: MANAGED_REASONS.stateOverride };
  if (facts.preferredPort !== MANAGED_DAEMON_PORT) return { action: "spawn", reason: MANAGED_REASONS.portOverride };
  if (facts.platform !== "darwin") return { action: "spawn", reason: MANAGED_REASONS.platform };
  if (!facts.plistInstalled) return { action: "spawn", reason: MANAGED_REASONS.notInstalled };
  return { action: "wait", graceMs: MANAGED_DAEMON_GRACE_MS, reason: MANAGED_REASONS.wait };
}
