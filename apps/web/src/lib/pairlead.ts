// P3-415 (eval-09): which pairing path leads a ceremony render — the ONE
// action that wears the accent fill (docs/PRODUCT.md: accent = the screen's
// highest action). Pure so scripts/pair-lead.test.ts pins every render shape.

export type CeremonyLead = "reconnect" | "host" | "paste" | "scan";

export interface CeremonyShape {
  /** Desktop shell: paste-first (P2-117). The phone leads with the scanner. */
  preferPaste: boolean;
  /** The host "pair a phone with this machine" entry renders (P3-334). */
  hostEntry: boolean;
  /** The agent-down verdict card renders WITH its reconnect action (P3-443). */
  reconnect: boolean;
}

/** Order: the agent-down card's reconnect fixes the cause its own copy names
 * first ("reconnect the daemon, or paste a code…"); the host entry is the
 * desktop's primary story wherever it renders (P3-334); only then is the
 * client ceremony the lead — the paste form on the desktop (P3-433: its
 * submit wears the accent where it is the sole path), the scanner on the
 * phone. The two top rows never co-occur today (the agent-down state hides
 * the host entry, P3-427); the order keeps the verdict total anyway. */
export function ceremonyLead(shape: CeremonyShape): CeremonyLead {
  if (shape.reconnect) return "reconnect";
  if (shape.hostEntry) return "host";
  return shape.preferPaste ? "paste" : "scan";
}
