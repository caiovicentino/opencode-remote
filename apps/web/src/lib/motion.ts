import { useEffect, useState } from "react";

/**
 * P3-087: exit-animation helper. Keeps a component mounted for `ms`
 * milliseconds after `open` goes false so the CSS exit class can play
 * ("closing"), then flips to "closed" so the parent can unmount it.
 * Under prefers-reduced-motion the exit is instant — no lingering shell.
 * Re-opening while closing cancels the timer and returns to "open".
 */
export type ExitPhase = "open" | "closing" | "closed";

export function useExitAnimation(open: boolean, ms = 300): ExitPhase {
  const [phase, setPhase] = useState<ExitPhase>(open ? "open" : "closed");
  useEffect(() => {
    if (open) {
      setPhase("open");
      return;
    }
    setPhase((prev) => (prev === "closed" ? "closed" : "closing"));
    if (
      typeof matchMedia !== "undefined" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setPhase("closed");
      return;
    }
    const t = setTimeout(() => setPhase("closed"), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return phase;
}
