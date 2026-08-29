/** Structured JSON-lines logging. One line per event, machine-parseable. */
export type Level = "debug" | "info" | "warn" | "error";

const MIN = (process.env.OCR_LOG_LEVEL ?? "info") as Level;
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function log(level: Level, msg: string, data?: unknown) {
  if (ORDER[level] < ORDER[MIN]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data !== undefined ? { data } : {}),
  });
  (level === "error" ? console.error : console.log)(line);
}
