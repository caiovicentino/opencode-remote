import { useEffect, useRef } from "react";
import { dropVerdict, type DropSurface, type DropVerdict } from "./dropgate";

/**
 * P3-398: window-level drag/drop absorption for one surface. App computes the
 * current surface (gate while unpaired, home on any paired non-chat view,
 * null when ChatView's own listeners own the window) and the verdict action;
 * this hook owns the listener mechanics: dragover paints the shared
 * dragging-files highlight, drop clears it and hands the delivered FileList
 * plus the lib/dropgate verdict to the caller. The Electron window never
 * navigates to a dropped file while the hook is live.
 *
 * Kept out of App.tsx on purpose — the P2-220 pin holds App at zero window
 * listeners; the gesture lives here next to the pure verdict it consumes.
 */
export function useDropAbsorb(
  surface: DropSurface | null,
  bridgePresent: () => unknown,
  onVerdict: (verdict: DropVerdict, files: File[]) => void,
): void {
  const verdictRef = useRef(onVerdict);
  verdictRef.current = onVerdict;
  useEffect(() => {
    if (!surface) return;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      document.body.classList.add("dragging-files");
    };
    const onLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) document.body.classList.remove("dragging-files");
    };
    const onDrop = (e: DragEvent) => {
      document.body.classList.remove("dragging-files");
      if (!hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      verdictRef.current(dropVerdict(surface, !!bridgePresent(), files.length), files);
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      document.body.classList.remove("dragging-files");
    };
  }, [surface, bridgePresent]);
}
