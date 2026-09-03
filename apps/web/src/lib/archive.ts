// P3-084: client-side archive for the conversation list (PRODUCT.md's
// "hover com ação"). The daemon/opencode API has no archive flag, so the
// archived set lives in this device's localStorage — additive only, reversible
// via the "Arquivadas" group. The storage-backed wrapper stays thin; the set
// algebra below is pure so scripts/unit.test.ts can pin it.

export const ARCHIVED_KEY = "ocr.archived";
export const ARCHIVED_MAX = 500;

export function toggleArchived(ids: string[], id: string, archived: boolean): string[] {
  const rest = ids.filter((x) => x !== id);
  if (!archived) return rest;
  return [id, ...rest].slice(0, ARCHIVED_MAX);
}

export function loadArchived(): string[] {
  try {
    const raw = localStorage.getItem(ARCHIVED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function saveArchived(ids: string[]): void {
  try {
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify(ids.slice(0, ARCHIVED_MAX)));
  } catch {}
}

export function isArchived(ids: string[], id: string): boolean {
  return ids.includes(id);
}
