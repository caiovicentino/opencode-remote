/**
 * Process metrics for the relay (P2-313) — pure observation module.
 *
 * The hosted operator's alerting (docs/VISION.md stage 4) is built on metric
 * scraping, yet until now nothing on the /metrics surface described the
 * relay process itself: memory could grow and the event loop could lag with
 * no series to show it, so the only alert was the process dying. This
 * module turns the numbers the caller already holds — process memoryUsage,
 * uptime and the liveness sweep's own scheduling delay — into exactly the
 * additive /metrics lines to publish, with zero new policy: no new timer,
 * no new route, no new request, no new dependency, and no knob, limit,
 * admission or termination decision may ever read them.
 *
 * The rules procMetrics() applies, IN THIS ORDER (the order is load-bearing
 * and covered by tests):
 *
 *   1. A series whose input is not a non-negative finite number (missing,
 *      negative, non-numeric, NaN, ±Infinity) is omitted ENTIRELY —
 *      fail-closed. Publishing a memory or delay nobody measured is worse
 *      than staying silent: a scraper alerting on an invented zero would
 *      call a degrading relay healthy.
 *   2. A valid input publishes exactly one gauge, preceded by its TYPE
 *      header, in the same grammar as every other relay line:
 *
 *        relay_resident_bytes        resident set size (RSS) in bytes
 *        relay_heap_used_bytes       V8 heap in use, in bytes
 *        relay_heap_total_bytes      V8 heap allocated, in bytes
 *        relay_uptime_seconds        whole seconds since the process started
 *        relay_scheduling_delay_ms   largest liveness-sweep scheduling delay
 *                                    observed since the previous scrape, in
 *                                    milliseconds (window max, reset per
 *                                    scrape by the caller)
 *
 *   3. The result is deterministic: identical inputs produce identical
 *      lines in identical order on every call.
 *
 * THE RELAY STAYS BLIND (boundary): no returned line ever carries an
 * address, a port, a room id, a token or any other identifiable material —
 * only the fixed metric names above and the whole numbers the caller
 * already holds.
 *
 * procMetricsJson() applies the SAME rule 1 to the same kind of inputs for
 * the JSON metrics body (which already publishes uptime_s, so uptime has no
 * JSON twin here): each valid input becomes one additive field keyed by the
 * body's snake_case grammar, each invalid input is omitted.
 *
 * Pure module — imports nothing at all (no node:fs, node:process,
 * node:http, no fetch, no I/O, no timers), same hygiene as certmetrics.ts,
 * so the unit battery can load it without booting anything. The caller
 * samples the process; this module only formats.
 */

/**
 * The one validation rule (rule 1): a published number is a non-negative
 * finite number. Everything else is omitted — never coerced, never floored
 * into an invented zero.
 */
function seriesValue(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Exactly the additive Prometheus lines for the process numbers the caller
 * sampled — see the header rules, applied in that order. Never mutates
 * anything, never invents a zero, never carries identifiable material.
 */
export function procMetrics(
  residentBytes: unknown,
  heapUsedBytes: unknown,
  heapTotalBytes: unknown,
  uptimeSeconds: unknown,
  schedulingDelayMs: unknown,
): string[] {
  const series: Array<[string, unknown]> = [
    ["relay_resident_bytes", residentBytes],
    ["relay_heap_used_bytes", heapUsedBytes],
    ["relay_heap_total_bytes", heapTotalBytes],
    ["relay_uptime_seconds", uptimeSeconds],
    ["relay_scheduling_delay_ms", schedulingDelayMs],
  ];
  const lines: string[] = [];
  for (const [name, input] of series) {
    const v = seriesValue(input);
    if (v === undefined) continue;
    lines.push(`# TYPE ${name} gauge`, `${name} ${v}`);
  }
  return lines;
}

/**
 * The same numbers for the JSON metrics body, keyed additively next to the
 * existing uptime_s — same rule 1, so an input omitted from the Prometheus
 * text is omitted here too. uptime has no entry: the body already publishes
 * uptime_s and nothing may duplicate or shadow it.
 */
export function procMetricsJson(
  residentBytes: unknown,
  heapUsedBytes: unknown,
  heapTotalBytes: unknown,
  schedulingDelayMs: unknown,
): Record<string, number> {
  const series: Array<[string, unknown]> = [
    ["resident_bytes", residentBytes],
    ["heap_used_bytes", heapUsedBytes],
    ["heap_total_bytes", heapTotalBytes],
    ["scheduling_delay_ms", schedulingDelayMs],
  ];
  const out: Record<string, number> = {};
  for (const [key, input] of series) {
    const v = seriesValue(input);
    if (v === undefined) continue;
    out[key] = v;
  }
  return out;
}
