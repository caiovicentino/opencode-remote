/**
 * TLS pair preflight (P2-154).
 *
 * Pure decision module: whether the relay terminates TLS itself
 * (RELAY_TLS_CERT + RELAY_TLS_KEY) or serves plain HTTP behind the provider
 * terminator, and whether the configured combination may boot at all.
 * Imports nothing (no node/fs, no node/http) so the wiring in index.ts stays
 * thin and the decisions stay unit-testable — same pattern as limits.ts and
 * metricsbind.ts, including the `problems` format (P2-132).
 *
 * Fail-closed in the P2-132/P2-141 spirit: a half-configured pair (one
 * variable set without the other), a present-but-blank value, or an
 * unreadable file are all problems. Any problem means the relay must not
 * open a listener: index.ts logs every reason once at boot and exits 1,
 * instead of silently falling back to plain HTTP on a public host or dying
 * with a stack trace that leaks the certificate path. Problem text cites
 * the failing variable and never the path.
 *
 * The relay stays blind here too: only file readability is probed — no
 * certificate or key material ever flows through this module.
 */

export type TlsMode = "tls" | "plain";

export interface TlsPlan {
  /** "tls" only when both variables are set, non-blank and readable. */
  mode: TlsMode;
  /** Raw env paths; populated when the corresponding variable is usable. */
  certPath: string;
  keyPath: string;
  /** Non-empty means the boot must NOT open any listener (fail-closed). */
  problems: string[];
}

/**
 * Resolve the TLS plan from the process env.
 *
 * - Both variables absent: mode "plain" with no problems — TLS terminated
 *   at the provider/proxy in front is the documented default layout (the
 *   P2-127 container forwards plain HTTP to the relay).
 * - Exactly one variable set: problem — the pair is mandatory together, a
 *   silent downgrade to plain HTTP must never happen on a public host.
 * - A set-but-blank value: problem — the intent is ambiguous, refusing to
 *   guess.
 * - A failed readability probe: problem citing the variable, never the
 *   path (logs are shipped off-host; paths are host-local detail).
 *
 * `readable` is injected so this module stays pure and tests can simulate
 * unreadable files without touching a filesystem.
 */
export function tlsPlan(
  env: Record<string, string | undefined>,
  readable: (path: string) => boolean,
): TlsPlan {
  const problems: string[] = [];
  const certRaw = env.RELAY_TLS_CERT;
  const keyRaw = env.RELAY_TLS_KEY;
  const certSet = certRaw !== undefined;
  const keySet = keyRaw !== undefined;

  // both absent: provider TLS in front is the documented mode, nothing to check
  if (!certSet && !keySet) {
    return { mode: "plain", certPath: "", keyPath: "", problems };
  }

  // present but blank: an operator configured half a thought
  if (certSet && certRaw.trim() === "") {
    problems.push(
      "RELAY_TLS_CERT is set but blank: refusing to guess between plain HTTP and a broken TLS pair (fail-closed)",
    );
  }
  if (keySet && keyRaw.trim() === "") {
    problems.push(
      "RELAY_TLS_KEY is set but blank: refusing to guess between plain HTTP and a broken TLS pair (fail-closed)",
    );
  }

  // the pair is mandatory together
  if (certSet && !keySet) {
    problems.push(
      "RELAY_TLS_CERT is set without RELAY_TLS_KEY: the TLS pair is mandatory together, a half-configured relay serves plain HTTP (fail-closed)",
    );
  }
  if (keySet && !certSet) {
    problems.push(
      "RELAY_TLS_KEY is set without RELAY_TLS_CERT: the TLS pair is mandatory together, a half-configured relay serves plain HTTP (fail-closed)",
    );
  }

  const certPath = certSet && certRaw.trim() !== "" ? certRaw : "";
  const keyPath = keySet && keyRaw.trim() !== "" ? keyRaw : "";

  // probe whatever side carries a usable path — all problems collected in
  // one pass; the reason names the variable, the path never reaches a log
  if (certPath !== "" && !readable(certPath)) {
    problems.push(
      "RELAY_TLS_CERT points to a file the relay cannot read (check existence and permissions for the relay user): refusing to boot with a broken certificate (fail-closed)",
    );
  }
  if (keyPath !== "" && !readable(keyPath)) {
    problems.push(
      "RELAY_TLS_KEY points to a file the relay cannot read (check existence and permissions for the relay user): refusing to boot with a broken key (fail-closed)",
    );
  }

  const mode: TlsMode = problems.length === 0 && certPath !== "" && keyPath !== "" ? "tls" : "plain";
  return { mode, certPath, keyPath, problems };
}
