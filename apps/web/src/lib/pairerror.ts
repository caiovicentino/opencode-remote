/**
 * EVAL4-F1 (fable r4, product track): the pairing screen used to print the
 * raw Error.message of OcrClient.connect() — English only, and one of them
 * ("rejected by daemon: … clear it with `manage.ts revoke-all` …") is a CLI
 * instruction shown to a phone user who has no terminal. This pure module
 * turns the client's failure messages into dictionary keys (en+pt) with an
 * actionable hint. No DOM, no React, no i18n import — the caller resolves the
 * keys through useT(), so every screen stays in ONE locale (P2-118).
 *
 * The raw messages are the ones client.ts throws today; matching is by
 * substring so a future wording tweak degrades to "unknown" (raw message
 * shown verbatim) instead of a wrong hint.
 */

export type PairErrorKind =
  | "timeout" // relay reachable, daemon never confirmed the hello
  | "closed" // relay socket closed/refused before the handshake finished
  | "rejected" // daemon answered not-allowed (revoked / pair window closed)
  | "gate" // biometric unlock cancelled or failed
  | "version" // pairing URI from a newer/older protocol
  | "unknown";

export function classifyPairError(message: string): PairErrorKind {
  const m = message.toLowerCase();
  if (m.includes("rejected by daemon")) return "rejected";
  if (m.includes("pairing timeout")) return "timeout";
  if (m.includes("closed before pairing") || m.includes("daemon unreachable")) return "closed";
  if (m.includes("biometric")) return "gate";
  if (m.includes("unsupported protocol")) return "version";
  return "unknown";
}

export interface PairErrorCopy {
  /** dict key of the one-line message; null → show the raw message. */
  msgKey: string | null;
  /** dict key of the actionable hint under it; null → no hint. */
  hintKey: string | null;
}

/** Keys for each kind. Both keys exist in en and pt (pinned by the caller's dict). */
export function pairErrorCopy(kind: PairErrorKind): PairErrorCopy {
  switch (kind) {
    case "rejected":
      return { msgKey: "pairErrRejected", hintKey: "pairErrRejectedHint" };
    case "timeout":
      return { msgKey: "pairErrTimeout", hintKey: "pairErrTimeoutHint" };
    case "closed":
      return { msgKey: "pairErrClosed", hintKey: "pairErrClosedHint" };
    case "gate":
      return { msgKey: "pairErrGate", hintKey: "pairErrGateHint" };
    case "version":
      return { msgKey: "pairErrVersion", hintKey: "pairErrVersionHint" };
    default:
      return { msgKey: null, hintKey: null };
  }
}
