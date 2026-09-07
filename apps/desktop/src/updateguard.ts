// P2-291: the update guard — the pure bridge between the boot-health verdict
// (boothealth.ts, P2-270) and the update flow. Stage 5 of docs/VISION.md saw
// the signed installer deliver a version that dies before painting a window:
// P2-270 correctly accuses it (verdict "recuperar"), yet every recheck still
// walked the feed, re-downloaded and re-offered the very same release, and the
// owner — who has no remote access to the machine precisely because the shell
// never opens — had exactly one apagado tray label and no way out. This
// module owns that DECISION: it maps (the normalized boot-health verdict, the
// running version, the version the feed offers, the already-resolved update
// state and the owner's explicit release mark) to exactly one of three
// documented verdicts — seguir, segurar or recusar-oferta — plus a short
// static reason label and one static sentence.
//
// Same module hygiene as boothealth.ts / gpuplan.ts / proxyplan.ts: NO
// electron, NO node:fs, NO node:path, no fetch, no I/O of any kind, no
// timers — main.ts resolves the session flag and the owner-release mark and
// hands everything in as plain values, and scripts/unit.test.ts plus the
// portable scripts/boothealth.test.ts exercise every rule in plain Node.
//
// RULE ORDER CONTRACT (the gate depends on it) — the rules below are written
// in this order and the order is part of the API:
//
//  1. an active test-harness session is SEGUIR before any other decision,
//     and the wiring writes nothing and changes no screenshot framing (the
//     P2-235 and P2-238 lessons: the harness drives the operator's machine);
//  2. absent input, non-object input or non-textual fields are SEGUIR and
//     NEVER segurar — holding by doubt would freeze the whole fleet on a
//     defective version, and that is the only safe direction here;
//  3. a verdict other than "recuperar" is SEGUIR;
//  4. verdict "recuperar" with an offered version textually equal to the
//     running version is RECUSAR-OFERTA — nothing is downloaded nor
//     re-offered;
//  5. verdict "recuperar" with an offered version different from the running
//     one is SEGUIR — a new version is exactly the escape route;
//  6. the owner's explicit release mark is SEGUIR regardless of the verdict —
//     the owner's explicit choice always wins, so this rule is EVALUATED
//     before rule 4 (both co-true cases are proven by the unit battery);
//  7. the result is identical for the same input in two calls — no clock, no
//     randomness, no I/O.
//
// The "segurar" verdict stays documented and reachable by the type so
// callers can switch exhaustively, but NO current rule emits it: a hold
// imposed on uncertain input is exactly the frozen-fleet failure rule 2
// refuses to create.
//
// Label hygiene (the P2-140 and P2-182 lessons): every label and sentence is
// static pt-BR — the language of the neighboring boot-health tray label —
// with no file path, no address, no port and no secret, and every string fits
// inside TRAY_TIP_MAX_CHARS (128, traystatus.ts).

/** Exactly one of three documented verdicts, per the rule order in the
 * header. "segurar" is deliberately never emitted today (see the header). */
export type UpdateGuardDecision = "seguir" | "segurar" | "recusar-oferta";

export interface UpdateGuardView {
  decision: UpdateGuardDecision;
  /** Short static label of the reason — safe for log lines and the tray. */
  label: string;
  /** One static sentence, safe for the shell log — no path, no address. */
  phrase: string;
  /** Stable reason id: harness | entrada | liberacao | veredito |
   * mesma-versao | nova-versao. */
  reason: string;
}

export interface UpdateGuardInput {
  /** True when the hermetic test harness owns this session
   * (OCR_DESKTOP_SESSION) — always seguir, before everything else. */
  harnessSession: boolean;
  /** The boot-health verdict, already normalized by boothealth.ts. */
  bootVerdict: string;
  /** The version actually running (app.getVersion()). */
  runningVersion: string;
  /** The version the feed offers (null when none is known yet). */
  offeredVersion: string | null;
  /** The already-resolved update state (UpdateStatus or null). Accepted as
   * part of the input contract; no current rule branches on it. */
  updateState: string | null;
  /** The owner's explicit release mark (boothealth.json additive field). */
  ownerRelease: boolean;
}

// --- static copy (pt-BR, path-free, address-free, secret-free) ---------------

const LABEL_FOLLOW = "OpenCode Remote — atualização automática livre";
const LABEL_REFUSE = "OpenCode Remote — reoferta recusada";

const PHRASE_HARNESS =
  "Sessão de teste do harness — o guarda não decide nada, não escreve nada e não muda enquadramento.";
const PHRASE_INPUT =
  "Entrada ausente ou ilegível — nada é segurado por dúvida; segurar congelaria a frota numa versão defeituosa.";
const PHRASE_RELEASE =
  "Liberação registrada pelo dono — a escolha explícita do dono sempre vence.";
const PHRASE_VERDICT =
  "Veredito de inicialização sem acusação — nenhuma oferta a recusar.";
const PHRASE_SAME =
  "O feed reoferece a própria versão em execução, já acusada pela saúde de boot — nada é baixado nem reoferecido.";
const PHRASE_NEW =
  "O feed oferece versão diferente da em execução — uma versão nova é exatamente a rota de fuga.";

/** The static tray label of the release item, through the same pure text
 * mechanism tray.ts already uses for its other labels (P2-291). */
export const UPDATE_GUARD_RELEASE_LABEL = "OpenCode Remote — retomar atualização automática";

const FOLLOW_HARNESS: UpdateGuardView = {
  decision: "seguir",
  label: LABEL_FOLLOW,
  phrase: PHRASE_HARNESS,
  reason: "harness",
};
const FOLLOW_INPUT: UpdateGuardView = {
  decision: "seguir",
  label: LABEL_FOLLOW,
  phrase: PHRASE_INPUT,
  reason: "entrada",
};
const FOLLOW_RELEASE: UpdateGuardView = {
  decision: "seguir",
  label: LABEL_FOLLOW,
  phrase: PHRASE_RELEASE,
  reason: "liberacao",
};
const FOLLOW_VERDICT: UpdateGuardView = {
  decision: "seguir",
  label: LABEL_FOLLOW,
  phrase: PHRASE_VERDICT,
  reason: "veredito",
};
const FOLLOW_NEW: UpdateGuardView = {
  decision: "seguir",
  label: LABEL_FOLLOW,
  phrase: PHRASE_NEW,
  reason: "nova-versao",
};
const REFUSE_SAME: UpdateGuardView = {
  decision: "recusar-oferta",
  label: LABEL_REFUSE,
  phrase: PHRASE_SAME,
  reason: "mesma-versao",
};

/** Tolerant reader of the single guard input: whatever comes in, a usable
 * input or null comes out — never an exception. A non-object (or array), an
 * absent/non-textual bootVerdict or runningVersion, or an offeredVersion /
 * updateState that is neither absent nor a non-empty string all make the
 * input unusable (rule 2: seguir, never segurar). */
function readInput(raw: unknown): UpdateGuardInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const bootVerdict = typeof r.bootVerdict === "string" && r.bootVerdict.length > 0 ? r.bootVerdict : null;
  const runningVersion =
    typeof r.runningVersion === "string" && r.runningVersion.length > 0 ? r.runningVersion : null;
  if (!bootVerdict || !runningVersion) return null;
  if (r.offeredVersion != null && (typeof r.offeredVersion !== "string" || r.offeredVersion.length === 0)) {
    return null;
  }
  if (r.updateState != null && (typeof r.updateState !== "string" || r.updateState.length === 0)) {
    return null;
  }
  return {
    harnessSession: r.harnessSession === true,
    bootVerdict,
    runningVersion,
    offeredVersion: typeof r.offeredVersion === "string" ? r.offeredVersion : null,
    updateState: typeof r.updateState === "string" ? r.updateState : null,
    ownerRelease: r.ownerRelease === true,
  };
}

/**
 * Pure guard decision. Rules apply in this exact order (see the header):
 * 1. harness session → seguir before everything;
 * 2. absent/non-object/non-textual input → seguir, never segurar;
 * 3. verdict other than "recuperar" → seguir;
 * 4. verdict "recuperar" + offered version textually equal to the running
 *    one → recusar-oferta (nothing downloaded nor re-offered);
 * 5. verdict "recuperar" + different offered version → seguir (escape
 *    route);
 * 6. the owner's explicit release mark → seguir regardless of the verdict
 *    (evaluated before rule 4 — the owner's choice always wins);
 * 7. the same input in two calls yields an identical view.
 */
export function updateGuard(raw: unknown): UpdateGuardView {
  const input = readInput(raw);
  if (!input) return FOLLOW_INPUT;
  if (input.harnessSession) return FOLLOW_HARNESS;
  if (input.ownerRelease) return FOLLOW_RELEASE;
  if (input.bootVerdict !== "recuperar") return FOLLOW_VERDICT;
  if (input.offeredVersion === input.runningVersion) return REFUSE_SAME;
  return FOLLOW_NEW;
}
