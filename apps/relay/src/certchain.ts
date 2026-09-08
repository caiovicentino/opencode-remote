/**
 * Certificate chain classification for the relay (P2-310).
 *
 * Pure decision module: given the subject/issuer pairs extracted from the
 * certificate file IN FILE ORDER (the caller owns the extraction — this
 * module imports nothing: no node/fs, no node/tls, no node/crypto, no
 * network of any kind, same hygiene as certexpiry.ts and certreload.ts),
 * it returns exactly one of five verdicts plus one static Portuguese
 * phrase:
 *
 *   complete     — two or more certificates and the issuer of each one
 *                  equals the subject of the next: the file carries the
 *                  leaf and its intermediates together, in order.
 *   self-signed  — exactly one certificate whose subject equals its issuer.
 *   leaf-only    — exactly one certificate whose subject differs from its
 *                  issuer: the dangerous case. Clients that do not already
 *                  hold the intermediate in cache may refuse the handshake
 *                  even though the relay itself is satisfied.
 *   broken-order — two or more certificates and at least one link does not
 *                  chain (wrong file order or a gap).
 *   unknown      — fail-closed for an empty, non-textual or non-parseable
 *                  input: a chain that cannot be assessed is never
 *                  announced as healthy.
 *
 * The comparison is exact string equality between one certificate's issuer
 * and the next certificate's subject, exactly as the standard Node
 * X509Certificate fields report them — no normalization, no new
 * dependency.
 *
 * The verdict only EXPLAINS, it never refuses: nothing in the relay closes
 * a connection, exits the process or skips an admission check because of
 * it. The relay stays blind here too: every phrase is static and never
 * carries a subject, issuer, serial number, fingerprint, path, host or
 * port — the module inspects only the pairs it was handed and publishes
 * nothing about them but the verdict.
 */

/** The exactly-five outcomes the relay can reach for a certificate file. */
export type CertChainVerdict = "complete" | "self-signed" | "leaf-only" | "broken-order" | "unknown";

/** One extracted certificate: its subject and issuer, in file order. */
export interface CertLink {
  subject: string;
  issuer: string;
}

export interface CertChainOutcome {
  verdict: CertChainVerdict;
  /** Short static phrase; safe for logs by construction (see header). */
  reason: string;
}

/** One static Portuguese phrase per verdict — no cert material, ever. */
const PHRASES: Record<CertChainVerdict, string> = {
  complete:
    "cadeia de certificados do relay completa: o arquivo traz folha e intermediários na ordem correta",
  "self-signed":
    "cadeia de certificados do relay autoassinada: um único certificado sem intermediários no arquivo",
  "leaf-only":
    "cadeia de certificados do relay incompleta: o arquivo traz apenas a folha e clientes sem o intermediário em cache podem recusar a conexão",
  "broken-order":
    "cadeia de certificados do relay fora de ordem: algum elo não encadeia com o seguinte no arquivo",
  unknown:
    "cadeia de certificados do relay não pôde ser avaliada: classificação desconhecida por entrada vazia ou ilegível",
};

function outcome(verdict: CertChainVerdict): CertChainOutcome {
  return { verdict, reason: PHRASES[verdict] };
}

/** A usable pair carries two non-blank textual fields — nothing else counts. */
function isLink(v: unknown): v is CertLink {
  if (typeof v !== "object" || v === null) return false;
  const candidate = v as Partial<CertLink>;
  return (
    typeof candidate.subject === "string" &&
    candidate.subject.trim().length > 0 &&
    typeof candidate.issuer === "string" &&
    candidate.issuer.trim().length > 0
  );
}

/**
 * Classify the given subject/issuer pairs, in the order the certificates
 * appear in the file. Deterministic: the same input always produces the
 * same outcome. The input is validated fail-closed — an empty, non-array
 * or non-textual entry set is `unknown`, never a guessed verdict.
 */
export function certChainVerdict(input: unknown): CertChainOutcome {
  if (!Array.isArray(input) || input.length === 0) return outcome("unknown");
  if (!input.every(isLink)) return outcome("unknown");
  const links = input as CertLink[];
  // exactly one certificate: the whole story is that one certificate
  if (links.length === 1) {
    const only = links[0]!;
    return outcome(only.subject === only.issuer ? "self-signed" : "leaf-only");
  }
  // two or more: every issuer must equal the subject of the NEXT certificate
  // in file order — one broken or misplaced link makes the whole chain
  // broken-order
  const chained = links.every((link, i) => i === links.length - 1 || link.issuer === links[i + 1]!.subject);
  return outcome(chained ? "complete" : "broken-order");
}
