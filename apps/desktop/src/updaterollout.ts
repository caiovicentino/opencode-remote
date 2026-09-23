// P2-342: the gradual-rollout verdict — the pure bridge between the update
// feed's rollout percentage and the decision to offer a release to THIS
// installation. Until today every published release reached 100% of the fleet
// in the same instant: a defective build shipped everywhere at once and the
// only brake was reverting the feed by hand. The feed can now carry a
// percentage — `rolloutPercent` in the macOS Squirrel JSON feed
// (update-mac*.json), electron-builder's own `stagingPercentage` in the
// Windows latest.yml — and each installation lands in one of 100 buckets
// derived from its own stable installation id: the release is offered when
// the machine's bucket is below the published percentage. An owner bumping
// the percentage widens the rollout gradually; a percentage of 0 is the
// release brake (nobody gets the version, not even through an explicit
// check).
//
// Same module hygiene as updateguard.ts / winupdate.ts: NO electron, NO
// node:fs, no node:path, no fetch, no I/O of any kind, no timers, and NO
// imports at all — main.ts resolves the harness flag, reads the stable
// installation id from userData (rolloutidstore.ts) and hands everything in
// as plain values; scripts/desktop-update.test.ts exercises every rule in
// plain Node. The hash is a local FNV-1a so the module stays import-free
// (the P2-335 lesson: a diagnostic module imported by the unit battery must
// never drag a dependency that boots something).
//
// RULE ORDER CONTRACT (the gate depends on it) — the rules below are written
// in this order and the order is part of the API:
//
//  1. an active test-harness session is OFERECER before any other decision
//     (the P2-221 lesson: the hermetic harness drives the operator's machine
//     and must never observe a hold the owner did not ask for);
//  2. the percentage field is missing, null, non-numeric, fractional or
//     outside 0..100 → OFERECER — fail-open, byte-for-byte the behavior of
//     every release before P2-342. Holding by doubt would freeze the whole
//     fleet on a version that may be perfectly fine (the P2-291 lesson);
//  3. percentage 0 → ADIAR for everyone, INCLUDING the owner's explicit
//     "Verificar atualizações" click — this is the release brake;
//  4. the owner's explicit check ignores percentages between 1 and 99 →
//     OFERECER (the owner asked now; the bucket may wait);
//  5. otherwise the bucket is the deterministic hash of the installation id
//     concatenated with the offered version, modulo 100, and the verdict is
//     OFERECER only when the bucket is strictly below the percentage;
//  6. the result is identical for the same input in two calls — no clock,
//     no randomness, no I/O.
//
// A numeric percentage can arrive as a real number (the JSON feed) or as an
// integer-valued text token (the yml feeds carry text); both are accepted
// when they name an integer in 0..100. A fractional value (12.5, "12.5") is
// never accepted — rule 2 fails it open rather than rounding.
//
// Label hygiene (the P2-140 and P2-182 lessons): every label and sentence is
// static pt-BR — the language of the neighboring update-guard verdict — with
// no file path, no address, no port and no secret, and every string fits
// inside TRAY_TIP_MAX_CHARS (128, traystatus.ts).

/** Exactly one of two documented verdicts, per the rule order in the header. */
export type UpdateRolloutDecision = "oferecer" | "adiar";

export interface UpdateRolloutView {
  decision: UpdateRolloutDecision;
  /** Short static label of the reason — safe for log lines and the tray. */
  label: string;
  /** One static sentence, safe for the shell log — no path, no address. */
  phrase: string;
  /** Stable reason id: harness | campo | freio | clique | balde. */
  reason: string;
}

export interface UpdateRolloutInput {
  /** True when the hermetic test harness owns this session
   * (OCR_DESKTOP_SESSION) — always oferecer, before everything else. */
  harnessSession: boolean;
  /** The raw rollout field as the feed carried it: `rolloutPercent` from the
   * macOS JSON feed or `stagingPercentage` from a yml feed. Undefined when
   * the feed did not carry the field. */
  rollout: unknown;
  /** The stable installation id (a random UUID persisted once in userData),
   * or null when the store failed — null fails open (rule 2's direction). */
  installationId: string | null;
  /** The version the feed offers (the same value the P2-291 guard sees). */
  offeredVersion: string;
  /** True only for the owner's explicit "Verificar atualizações" click. */
  explicitCheck: boolean;
}

// --- static copy (pt-BR, path-free, address-free, secret-free) ---------------

const LABEL_OFFER = "OpenCode Remote — atualização liberada nesta máquina";
const LABEL_DEFER = "OpenCode Remote — atualização adiada nesta máquina";

const PHRASE_HARNESS = "Sessão de teste do harness — a liberação gradual não decide nada nesta execução.";
const PHRASE_INPUT =
  "Percentual ausente ou ilegível no feed — nada é adiado por dúvida; a oferta segue o comportamento de hoje.";
const PHRASE_ZERO =
  "Percentual zero no feed — o freio da liberação segura a versão para toda máquina, inclusive com verificação explícita.";
const PHRASE_EXPLICIT =
  "Verificação explícita do dono — o percentual entre 1 e 99 não segura esta máquina.";
const PHRASE_BUCKET_OFFER =
  "O balde desta instalação ficou abaixo do percentual publicado — a versão é oferecida agora.";
const PHRASE_BUCKET_DEFER =
  "O balde desta instalação ainda não alcançou o percentual publicado — a versão chega nas próximas horas.";

const OFFER_HARNESS: UpdateRolloutView = {
  decision: "oferecer",
  label: LABEL_OFFER,
  phrase: PHRASE_HARNESS,
  reason: "harness",
};
const OFFER_INPUT: UpdateRolloutView = {
  decision: "oferecer",
  label: LABEL_OFFER,
  phrase: PHRASE_INPUT,
  reason: "campo",
};
const DEFER_ZERO: UpdateRolloutView = {
  decision: "adiar",
  label: LABEL_DEFER,
  phrase: PHRASE_ZERO,
  reason: "freio",
};
const OFFER_EXPLICIT: UpdateRolloutView = {
  decision: "oferecer",
  label: LABEL_OFFER,
  phrase: PHRASE_EXPLICIT,
  reason: "clique",
};
const OFFER_BUCKET: UpdateRolloutView = {
  decision: "oferecer",
  label: LABEL_OFFER,
  phrase: PHRASE_BUCKET_OFFER,
  reason: "balde",
};
const DEFER_BUCKET: UpdateRolloutView = {
  decision: "adiar",
  label: LABEL_DEFER,
  phrase: PHRASE_BUCKET_DEFER,
  reason: "balde",
};

/** FNV-1a 32-bit over the UTF-16 code units of the text — small, dependency-
 * free and stable across processes and platforms (no crypto import, no node
 * builtin, no timer, no I/O). */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The rollout bucket of an installation for one offered version: the
 * deterministic hash of the installation id concatenated with the offered
 * version, modulo 100. A colon joins the two halves so the pair (id,
 * version) can never be re-cut into a different pair with the same text.
 * Same inputs always produce the same bucket — the stability the rollout
 * needs (a machine's seat in the rollout never wobbles between checks).
 */
export function rolloutBucket(installationId: string, offeredVersion: string): number {
  return fnv1a(`${installationId}:${offeredVersion}`) % 100;
}

/**
 * Tolerant reader of the feed's rollout field: an integer in 0..100 passes
 * (as a real number or as a digit-only token — the yml feeds carry text),
 * everything else fails open with null. Never an exception.
 */
function readRolloutPercent(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 100) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && raw.length <= 10) {
    const n = Number.parseInt(raw, 10);
    if (n >= 0 && n <= 100) return n;
  }
  return null;
}

/** Tolerant reader of the whole input: whatever comes in, a usable input or
 * null comes out — never an exception. A non-object (or array), a non-empty
 * offeredVersion requirement or a stray installationId type all make the
 * input unusable (rule 2: oferecer, never adiar). */
function readInput(raw: unknown): UpdateRolloutInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.offeredVersion !== "string" || r.offeredVersion.length === 0) return null;
  if (r.installationId != null && (typeof r.installationId !== "string" || r.installationId.length === 0)) {
    return null;
  }
  return {
    harnessSession: r.harnessSession === true,
    rollout: r.rollout,
    installationId: typeof r.installationId === "string" ? r.installationId : null,
    offeredVersion: r.offeredVersion,
    explicitCheck: r.explicitCheck === true,
  };
}

/**
 * Pure rollout verdict. Rules apply in this exact order (see the header):
 * 1. harness session → oferecer before everything;
 * 2. missing/null/non-numeric/fractional/out-of-range percentage → oferecer
 *    (fail-open, byte-for-byte today's behavior);
 * 3. percentage 0 → adiar for everyone, including the explicit click (the
 *    release brake);
 * 4. the owner's explicit check → oferecer (percentages 1..99 are ignored);
 * 5. otherwise oferecer only when the installation's bucket is strictly
 *    below the percentage;
 * 6. the same input in two calls yields an identical view.
 */
export function updateRollout(raw: unknown): UpdateRolloutView {
  const input = readInput(raw);
  if (!input) return OFFER_INPUT;
  if (input.harnessSession) return OFFER_HARNESS;
  const percent = readRolloutPercent(input.rollout);
  if (percent === null) return OFFER_INPUT;
  if (percent === 0) return DEFER_ZERO;
  if (input.explicitCheck) return OFFER_EXPLICIT;
  if (input.installationId === null) return OFFER_INPUT;
  const bucket = rolloutBucket(input.installationId, input.offeredVersion);
  if (bucket < percent) return OFFER_BUCKET;
  return DEFER_BUCKET;
}
