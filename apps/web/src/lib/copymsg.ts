/**
 * P2-282: copy-a-message decision logic. Pure on purpose — no React, no DOM,
 * no fetch, no I/O — in the spirit of composer.ts, thinking.ts and
 * chatfind.ts: ChatView converts the already-normalized parts of a bubble
 * into this module's plain shape and acts on the verdict, and
 * scripts/unit.test.ts pins the full table so a copy button can never regress
 * into copying nothing (a button that copies nothing is worse than no
 * button).
 *
 * copyPlan receives the already-normalized parts of ONE message (declared
 * type, text, and for code blocks the declared language) and returns exactly
 * one of two verdicts — "unavailable" or "copy" — plus the final text and a
 * static reason key. The rules, in THIS order:
 *
 *   1. A missing, empty or non-array list is "unavailable" and NEVER copies
 *      empty text: a button that copies nothing is worse than no button.
 *   2. Reasoning and tool-call parts are discarded BEFORE any joining and
 *      never enter the copied text — whoever copies wants the answer, not
 *      the machine's internal trail. Unrecognized types are discarded too,
 *      never guessed.
 *   3. A usable part whose text is empty or whitespace-only is discarded
 *      (no doubled blank lines in the result).
 *   4. A code block enters with its fences and its declared language
 *      preserved; a language that could break the fence is dropped, the
 *      block is not.
 *   5. A message left without any usable part is "unavailable" (proof that
 *      the stripping rules run before the final emptiness check).
 *   6. Only the remainder is "copy": parts joined by one blank line, stable
 *      order, no truncation, no header, no date, no model name — identical
 *      result for the same input in two calls.
 */

/** Static i18n reason key (resolved through apps/web/src/lib/i18n.ts). */
export const COPY_UNAVAILABLE_NOTHING = "copyMsgNothing";

export type CopyVerdict = "unavailable" | "copy";

/** The normalized part of one message: a declared type, its text and — for
 * code blocks — the declared language. `type` stays a loose string on
 * purpose: anything outside the recognized set ("text" | "code") is
 * discarded by rule 2, never guessed. */
export interface CopyPart {
  type: string;
  text?: string | null;
  language?: string | null;
}

export interface CopyPlan {
  verdict: CopyVerdict;
  /** Final text to place on the clipboard; "" unless verdict is "copy". */
  text: string;
  /** Static reason key (i18n) when verdict is "unavailable", otherwise "". */
  reason: string;
}

/** A declared language may only decorate the opening fence when it cannot
 * break the fence itself — plain language tokens only. */
const SAFE_LANGUAGE = /^[A-Za-z0-9_+#.-]*$/;

/** Pure verdict for a normalized message-part list. See the header for the
 * rule order; the caller owns the normalization, this owns the decision. */
export function copyPlan(parts: unknown): CopyPlan {
  // rule 1: absent/empty/non-array — unavailable, never an empty copy
  if (!Array.isArray(parts) || parts.length === 0) {
    return { verdict: "unavailable", text: "", reason: COPY_UNAVAILABLE_NOTHING };
  }
  const usable: string[] = [];
  for (const part of parts as CopyPart[]) {
    const type = part?.type ?? "";
    // rule 2: the machine's internal trail is dropped before any joining
    if (type !== "text" && type !== "code") continue;
    const raw = typeof part?.text === "string" ? part.text : "";
    // rule 3: empty or whitespace-only text is discarded, whatever the kind
    if (!raw.trim()) continue;
    if (type === "code") {
      // rule 4: fences and the declared language preserved
      const lang = typeof part?.language === "string" ? part.language.trim() : "";
      const opening = SAFE_LANGUAGE.test(lang) ? `\`\`\`${lang}` : "```";
      usable.push(`${opening}\n${raw}\n\`\`\``);
    } else {
      usable.push(raw);
    }
  }
  // rule 5: nothing usable left — unavailable (rule order made visible)
  if (usable.length === 0) {
    return { verdict: "unavailable", text: "", reason: COPY_UNAVAILABLE_NOTHING };
  }
  // rule 6: stable order, one blank line between parts, deterministic
  return { verdict: "copy", text: usable.join("\n\n"), reason: "" };
}
