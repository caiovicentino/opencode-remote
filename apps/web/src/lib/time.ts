// compact relative time for tight UI slots: "" (unknown), "5m", "2h", "3d".
// accepts ISO strings or epoch millis, matching the shape of session timestamps.

export function timeAgo(
  value: string | number | undefined,
  justNowLabel = "now",
  now = Date.now(),
): string {
  if (!value) return "";
  const ts = typeof value === "number" ? value : Date.parse(value);
  if (Number.isNaN(ts)) return "";
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 1) return justNowLabel;
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
