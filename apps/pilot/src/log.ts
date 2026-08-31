const TZ = "America/Sao_Paulo";

/** Local-time ISO string (GMT-3) — the whole team reads timestamps in local. */
export function nowLocalISO(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: TZ }).replace(" ", "T") + "-03:00";
}

export function log(level: string, msg: string, data?: unknown) {
  console.log(JSON.stringify({ ts: nowLocalISO(), level, msg, data }));
}
