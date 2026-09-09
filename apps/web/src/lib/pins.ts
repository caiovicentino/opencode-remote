// P3-357: client-side pinning for the conversation list — the user keeps one
// or more conversations fixed at the top of the list so they never sink under
// newer chatter. The daemon/opencode API has no pin flag, so the pinned set
// lives in this device's localStorage (same call as archive.ts's P3-084).
// The set algebra below is pure so scripts/unit.test.ts can pin it (pun
// intended); the storage-backed wrapper stays thin.

export const PINNED_KEY = "ocr.pinned";
export const PINNED_MAX = 100;

export function togglePinned(ids: string[], id: string, pinned: boolean): string[] {
  const rest = ids.filter((x) => x !== id);
  if (!pinned) return rest;
  return [id, ...rest].slice(0, PINNED_MAX);
}

export function loadPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function savePinned(ids: string[]): void {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(ids.slice(0, PINNED_MAX)));
  } catch {}
}

export function isPinned(ids: string[], id: string): boolean {
  return ids.includes(id);
}
