// P2-323: descriptors for the three in-app confirmation dialogs (rename,
// delete, rewind). SessionsView used to call window.prompt for rename —
// which the Electron/Chromium shell does not implement, so the action died
// silently in the packaged app — and window.confirm for delete/rewind, a
// blocking native box that ignores the UI language and the theme.
//
// Pure and dependency-free (same hygiene as permissionCards.ts and
// routinehistoryview.ts: no React, no fetch, no window, no clock reads) so
// scripts/unit.test.ts can pin the semantics directly. The `t` function is
// injected by the caller — nothing user-visible is born hardcoded here.

/** Minimal translate function — the `t` shape useT() hands to components. */
export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/** The closed intent set — one per former native-dialog call site. */
export type AskIntent = "rename" | "delete" | "rewind";

export const ASK_INTENTS: readonly AskIntent[] = ["rename", "delete", "rewind"];

/** Visual weight of the confirm action: neutral for renames, destructive
 * for actions that discard work. Drives the confirm button class only. */
export type AskTone = "neutral" | "destructive";

/** Everything the AskDialog component needs to render — fully resolved, no
 * dictionary lookups left for the view layer. */
export interface AskDialogDescriptor {
  intent: AskIntent;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: AskTone;
  /** true only for rename — the dialog shows a text field. */
  withInput: boolean;
  /** Initial field value (the current title, verbatim) when withInput. */
  initialInput: string;
  /** Accessible label for the field when withInput. */
  inputLabel: string;
}

const TONE_BY_INTENT: Record<AskIntent, AskTone> = {
  rename: "neutral",
  delete: "destructive",
  rewind: "destructive",
};

/** Only a real string counts as "current title" — anything else (null,
 * undefined, numbers, objects) is treated as an absent title. */
function safeTitle(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Build the render-ready descriptor for one of the three supported intents.
 * An unknown intent is refused in a fail-closed manner (throws) — the caller
 * must never end up showing a half-configured dialog. Pure: the same inputs
 * always produce the identical descriptor.
 */
export function buildAskDialog(
  intent: unknown,
  t: TranslateFn,
  currentTitle?: unknown,
): AskDialogDescriptor {
  if (typeof intent !== "string" || !(ASK_INTENTS as readonly string[]).includes(intent)) {
    throw new Error(`askdialog: unknown intent ${JSON.stringify(intent)}`);
  }
  const ask = intent as AskIntent;
  const title = safeTitle(currentTitle);
  switch (ask) {
    case "rename":
      return {
        intent: ask,
        title: t("askRenameTitle"),
        body: t("askRenameBody"),
        confirmLabel: t("rename"),
        cancelLabel: t("askCancel"),
        tone: TONE_BY_INTENT[ask],
        withInput: true,
        initialInput: title,
        inputLabel: t("renamePrompt"),
      };
    case "delete":
      return {
        intent: ask,
        title: t("askDeleteTitle"),
        body: t("deleteConfirm"),
        confirmLabel: t("delete"),
        cancelLabel: t("askCancel"),
        tone: TONE_BY_INTENT[ask],
        withInput: false,
        initialInput: "",
        inputLabel: "",
      };
    case "rewind":
      return {
        intent: ask,
        title: t("askRewindTitle"),
        body: t("rewindConfirm"),
        confirmLabel: t("askRewindConfirm"),
        cancelLabel: t("askCancel"),
        tone: TONE_BY_INTENT[ask],
        withInput: false,
        initialInput: "",
        inputLabel: "",
      };
  }
}

/**
 * Decide whether the typed value may be confirmed. Refuses anything that is
 * not a plain string, empty or whitespace-only values, and — for rename — a
 * value identical to the current title (a no-op rename). Comparison trims
 * both sides, so "Title " vs "Title" counts as unchanged. Pure and total:
 * hostile input returns false, it never throws.
 */
export function canConfirmAskValue(value: unknown, currentTitle?: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (typeof currentTitle === "string" && trimmed === currentTitle.trim()) return false;
  return true;
}
