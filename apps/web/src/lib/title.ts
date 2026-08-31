export function sessionTitleOf(body: unknown): string {
  const t = (body as { title?: unknown } | null | undefined)?.title;
  return typeof t === "string" ? t.trim() : "";
}
