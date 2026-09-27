// eval-11 (red-team finding routed by eval-15): one click on a web page's
// opencode-remote://pair link re-paired a RUNNING desktop to whatever daemon
// the link names. main.ts forwarded every well-formed link (deeplink.ts only
// checks the shape) straight to the renderer, whose "only while unpaired"
// guard reads the PERSISTED pairing — and local mode (P1-070) persists none,
// so a desktop connected to its own machine counted as unpaired and connected
// to the attacker's daemon through the attacker's relay, persisting it. That
// daemon then held a live E2E session with the app, screen-peek responder
// included.
//
// This module owns the consent the shell now asks for before a link reaches
// the renderer: the facts shown to the owner (the machine name and the relay
// host the link carries — never the key material), the rule order that keeps
// harness sessions dialog-free, and the dialog vocabulary in both shell
// languages. Pure: no electron, no fs, no timers — main.ts shows the dialog and
// applies the answer; scripts/deeplinkconsent.test.ts covers every rule.
//
// RULE ORDER (first match wins):
//   1. a harness session (OCR_DESKTOP_SESSION) never opens a dialog (P1-081):
//      the test-only hatch OCR_DESKTOP_DEEPLINK_ANSWER=pair|cancel answers in
//      place, and without it the link is REFUSED — a gate run must never be
//      paired to a daemon by a link it did not ask for;
//   2. everything else ASKS: the owner confirms the machine and relay by name,
//      with Cancel as the default and the Escape answer.

/** Longest machine name / relay host shown in the dialog. */
export const DEEP_LINK_FACT_MAX = 64;

export interface DeepLinkFacts {
  /** The link's `name` parameter (the machine), "" when absent/unreadable. */
  machine: string;
  /** Host (and port) of the link's `relay` parameter, "" when unreadable. */
  relayHost: string;
}

/** Control characters and bidi overrides never reach a native dialog. */
function clean(value: string): string {
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "").trim();
  return printable.length > DEEP_LINK_FACT_MAX ? `${printable.slice(0, DEEP_LINK_FACT_MAX - 1)}…` : printable;
}

/**
 * The facts a validated pair link carries, decoded exactly like the renderer's
 * parsePairingUri decodes them (hand-split on & and the first =, then
 * decodeURIComponent). Never throws; an unreadable value degrades to "".
 * The key (`k`), room and VAPID parameters are never read here.
 */
export function deepLinkFacts(uri: string): DeepLinkFacts {
  const facts: DeepLinkFacts = { machine: "", relayHost: "" };
  const q = typeof uri === "string" ? uri.indexOf("?") : -1;
  if (q === -1) return facts;
  for (const part of uri.slice(q + 1).split("&")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(part.slice(0, eq));
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      continue;
    }
    if (key === "name" && facts.machine === "") facts.machine = clean(value);
    if (key === "relay" && facts.relayHost === "") {
      try {
        facts.relayHost = clean(new URL(value).host);
      } catch {
        facts.relayHost = "";
      }
    }
  }
  return facts;
}

export type DeepLinkConsentPlan =
  | { action: "ask" }
  | { action: "accept" | "refuse"; reason: string };

/** Static reasons for the log line (no URI, no machine, no host). */
export const DEEP_LINK_CONSENT_REASONS = {
  hatchPair: "sessão de teste — hatch respondeu parear",
  hatchCancel: "sessão de teste — hatch respondeu cancelar",
  harness: "sessão de teste sem hatch — link recusado sem abrir diálogo",
} as const;

/** The decision, in the documented rule order. Never throws. */
export function deepLinkConsentPlan(input: { harnessSession: boolean; hatchAnswer: unknown }): DeepLinkConsentPlan {
  if (input.harnessSession) {
    if (input.hatchAnswer === "pair") return { action: "accept", reason: DEEP_LINK_CONSENT_REASONS.hatchPair };
    if (input.hatchAnswer === "cancel") return { action: "refuse", reason: DEEP_LINK_CONSENT_REASONS.hatchCancel };
    return { action: "refuse", reason: DEEP_LINK_CONSENT_REASONS.harness };
  }
  return { action: "ask" };
}

export interface DeepLinkPrompt {
  title: string;
  message: string;
  detail: string;
  confirm: string;
  cancel: string;
}

/** Button indexes of the native dialog; main.ts passes Cancel as both the
 * default and the Escape answer, so an accidental Enter never pairs. */
export const DEEP_LINK_BUTTON_INDEX = { confirm: 0, cancel: 1 } as const;

/** The dialog text for the shell language ("pt" or anything else → en). */
export function deepLinkPrompt(facts: DeepLinkFacts, lang: string): DeepLinkPrompt {
  const machine = facts.machine || (lang === "pt" ? "sem nome" : "unnamed");
  const relay = facts.relayHost || (lang === "pt" ? "desconhecido" : "unknown");
  if (lang === "pt") {
    return {
      title: "Parear com uma máquina",
      message: `Conectar este app à máquina "${machine}"?`,
      detail:
        `Um link pediu para parear pelo relay ${relay}. Só confirme se foi você quem abriu este convite: ` +
        "a máquina pareada passa a receber o que você envia por este app, e uma conexão atual é trocada por ela.",
      confirm: "Parear",
      cancel: "Cancelar",
    };
  }
  return {
    title: "Pair with a machine",
    message: `Connect this app to the machine "${machine}"?`,
    detail:
      `A link asked to pair through the relay ${relay}. Only confirm if you opened this invite yourself: ` +
      "the paired machine receives what you send from this app, and a current connection is replaced by it.",
    confirm: "Pair",
    cancel: "Cancel",
  };
}
