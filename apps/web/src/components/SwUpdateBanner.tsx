// P2-266: the calm one-line strip that offers a ready app update. Shown only
// when the sw-update plan in main.tsx says "offer"; the button is the ONLY
// path that posts the documented swap message to the waiting worker — the
// page never reloads and the worker never skips waiting on its own.
// Copy comes from i18n (pt-BR + en), zero emoji, and the single entrance
// animation is neutralized by the global prefers-reduced-motion query
// (P3-087) like every other motion in the app.

import { useSyncExternalStore } from "react";
import { useT } from "../lib/i18n";

let visible = false;
let onAccept: (() => void) | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

export function showSwUpdateBanner(accept: () => void): void {
  onAccept = accept;
  if (visible) return;
  visible = true;
  emit();
}

export function hideSwUpdateBanner(): void {
  if (!visible) return;
  visible = false;
  emit();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export default function SwUpdateBanner() {
  const t = useT();
  const show = useSyncExternalStore(subscribe, () => visible);
  if (!show) return null;
  return (
    <div className="sw-update-banner" role="status">
      <span className="sw-update-text">{t("swUpdateReady")}</span>
      <button
        type="button"
        className="sw-update-btn"
        onClick={() => {
          hideSwUpdateBanner();
          onAccept?.();
        }}
      >
        {t("swUpdateAction")}
      </button>
    </div>
  );
}
