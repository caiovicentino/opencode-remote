/**
 * P2-277: paste-to-attach decision logic. Pure on purpose — no React, no DOM,
 * no fetch, no I/O — in the spirit of composer.ts, degraded.ts and
 * machinestate.ts: ChatView converts the DOM ClipboardEvent items into this
 * module's plain shape and acts on the verdict, and scripts/unit.test.ts pins
 * the full table so a paste can never regress into a silent nothing.
 *
 * pastePlan receives the already-normalized clipboard items (declared type,
 * optional name, size in bytes) plus the module's own documented ceilings and
 * returns exactly one of three verdicts — "ignore", "attach" or "refuse" —
 * with the ordered items to attach and a static reason key. The rules, in
 * THIS order:
 *
 *   1. A missing, empty or non-array list is "ignore" and NEVER "refuse":
 *      paste is first and foremost a text gesture, and the product must
 *      never turn an ordinary paste into an error message.
 *   2. A plain-text item with content present is "ignore" — the field pastes
 *      the text itself — even when the list also carries an image: someone
 *      copying from a rich editor expects the text.
 *   3. An item without a recognizable type ("image" | "file" | "text") is
 *      discarded, never guessed.
 *   4. An item above the byte ceiling is "refuse" BEFORE any quantity
 *      comparison: measuring size first avoids holding in memory exactly
 *      what is already rejected.
 *   5. A quantity above the per-paste ceiling is "refuse" — never silently
 *      attaching just the first ones.
 *   6. Only the remainder is "attach": stable order (input order, same item
 *      references returned), identical result for the same input.
 */

/** Byte ceiling per pasted item (25 MB): above it the whole paste is refused. */
export const PASTE_MAX_ITEM_BYTES = 25_000_000;

/** How many attachable items a single paste may carry — matches the four
 * attachment chips the composer strip can actually show. */
export const PASTE_MAX_ITEMS = 4;

/** Documented static name for a pasted image that arrives without one. */
export const PASTE_FALLBACK_IMAGE_NAME = "pasted-image.png";

/** Documented static name for a pasted non-image file that arrives nameless. */
export const PASTE_FALLBACK_FILE_NAME = "pasted-file";

/** Static i18n reason keys (resolved through apps/web/src/lib/i18n.ts). */
export const PASTE_REFUSE_ITEM_BYTES = "pasteTooLarge";
export const PASTE_REFUSE_TOO_MANY = "pasteTooMany";

export type PasteVerdict = "ignore" | "attach" | "refuse";

/** The normalized clipboard item: a declared type, an optional name and the
 * size in bytes. `type` stays a loose string on purpose — anything outside
 * the recognized set is discarded by rule 3, never guessed. */
export interface PasteItem {
  type: string;
  name?: string | null;
  size: number;
}

export interface PastePlan {
  verdict: PasteVerdict;
  /** Ordered items to attach — the same references from the input list, in
   * input order. Empty unless verdict is "attach". */
  attach: PasteItem[];
  /** Static reason key (i18n) when verdict is "refuse", otherwise "". */
  reason: string;
}

const ATTACHABLE = new Set(["image", "file"]);

/** Pure verdict for a normalized clipboard-items list. See the header for the
 * rule order; the ceilings default to this module's documented constants. */
export function pastePlan(
  items: unknown,
  maxItemBytes: number = PASTE_MAX_ITEM_BYTES,
  maxItems: number = PASTE_MAX_ITEMS,
): PastePlan {
  // rule 1: absent/empty/non-array — ignore, never refuse
  if (!Array.isArray(items) || items.length === 0) {
    return { verdict: "ignore", attach: [], reason: "" };
  }
  // rule 2: text with content — ignore even when an image rides along
  for (const it of items as PasteItem[]) {
    if (it?.type === "text" && (it?.size ?? 0) > 0) {
      return { verdict: "ignore", attach: [], reason: "" };
    }
  }
  // rule 3: unknown types are discarded, never guessed
  const attachable = (items as PasteItem[]).filter((it) => ATTACHABLE.has(it?.type ?? ""));
  if (attachable.length === 0) {
    return { verdict: "ignore", attach: [], reason: "" };
  }
  // rule 4: byte ceiling first, before any quantity comparison
  for (const it of attachable) {
    if ((it?.size ?? 0) > maxItemBytes) {
      return { verdict: "refuse", attach: [], reason: PASTE_REFUSE_ITEM_BYTES };
    }
  }
  // rule 5: quantity ceiling — refuse, never silently truncate
  if (attachable.length > maxItems) {
    return { verdict: "refuse", attach: [], reason: PASTE_REFUSE_TOO_MANY };
  }
  // rule 6: attach — stable order, same references, deterministic
  return { verdict: "attach", attach: attachable, reason: "" };
}
