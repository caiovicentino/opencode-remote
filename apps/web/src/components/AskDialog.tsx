import { useEffect, useRef, useState } from "react";
import { canConfirmAskValue, type AskDialogDescriptor } from "../lib/askdialog";

interface Props {
  descriptor: AskDialogDescriptor;
  /** Rename compares against it: a value identical to the current title can't be confirmed. */
  currentTitle?: string;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

/** P2-323: the one calm confirmation dialog for rename / delete / rewind.
 * A centered card over a softened scrim — never the browser's native
 * prompt/confirm, which Electron does not implement (rename) and which
 * ignores the UI language and theme (the other two). Esc closes, Enter
 * confirms (implicit form submission; a refused value keeps the submit
 * button disabled), focus lands on the field — or the confirm button — on
 * open and returns to the element that opened the dialog on close. Motion
 * is 150–300ms ease-out and dies under the global prefers-reduced-motion
 * block. */
export default function AskDialog({ descriptor, currentTitle, onConfirm, onClose }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(descriptor.initialInput);
  const withInput = descriptor.withInput;
  // delete/rewind carry no field: the value is fixed and always confirmable
  const canConfirm = withInput ? canConfirmAskValue(value, currentTitle) : true;

  // `onClose` is an inline arrow at every call site — read it through a ref so
  // the open-time effects never re-run when a parent re-render (a streamed
  // token, a background list refresh) hands in a fresh identity.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Capture the opener and aim the initial focus exactly once per open —
  // re-running this mid-dialog would yank the caret out of the field and
  // replace the captured opener with the dialog's own (unmounting) field.
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    const field = inputRef.current;
    if (field) field.focus();
    else cardRef.current?.querySelector<HTMLButtonElement>(".ask-confirm")?.focus();
  }, []);

  // Esc closes through the ref; the unmount-only cleanup returns focus to the
  // element that opened the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const trigger = openerRef.current;
      if (trigger) {
        trigger.focus();
        // Hover-revealed openers (row action buttons) are display:none while
        // the dialog holds the focus — focus() no-ops on a hidden element,
        // so fall back to the nearest focusable ancestor (the row itself).
        if (document.activeElement !== trigger) {
          trigger.closest<HTMLElement>("[tabindex]:not([tabindex='-1'])")?.focus();
        }
      }
    };
  }, []);

  function submit() {
    if (!canConfirm) return;
    onConfirm(withInput ? value : "");
  }

  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    // a disabled confirm is unfocusable — leaving it in the cycle would let
    // Tab from cancel escape the modal instead of wrapping
    const nodes = cardRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input, [tabindex]:not([tabindex='-1'])",
    );
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="ask-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className="ask-card ask-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        aria-describedby="ask-body"
        onKeyDown={trapTab}
      >
        <h2 id="ask-title" className="ask-title">
          {descriptor.title}
        </h2>
        <p id="ask-body" className="ask-body">
          {descriptor.body}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {withInput && (
            <input
              ref={inputRef}
              className="ask-input"
              aria-label={descriptor.inputLabel}
              placeholder={descriptor.inputLabel}
              value={value}
              maxLength={200}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <div className="ask-actions">
            <button type="button" className="ask-cancel" onClick={onClose}>
              {descriptor.cancelLabel}
            </button>
            <button
              type="submit"
              className={`ask-confirm${descriptor.tone === "destructive" ? " danger" : ""}`}
              disabled={!canConfirm}
            >
              {descriptor.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
