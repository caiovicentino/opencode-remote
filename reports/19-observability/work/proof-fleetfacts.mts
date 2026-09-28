import { fleetFacts } from "../../../apps/web/src/components/MissionControlView";
import { translate } from "../../../apps/web/src/lib/i18n";
const pt = (k: string, v?: Record<string, string | number>) => translate("pt", k, v);
const digest = {
  installed: true,
  pilot: { state: "down", heartbeatAgeMs: 272_980_137, since: "2026-09-24T11:07:13.162Z" },
  deploy: { behind: 16, pendingSince: "2026-09-24T07:11:01.000Z", hold: { reason: "disk-guard", count: 69 } },
  disk: { freeBytes: 81_197_068_288, minFreeBytes: 5_368_709_120 },
  queue: { ready: 2, blocked: 12 },
  cost: { week: { merges: 63, tokens: 1_282_221_897, unpricedTokens: 1_282_221_897 } }, // NO usd key
  alerts: { undelivered: 100 },
  attention: [{ kind: "pilot-down", level: "critical" }],
} as never;
try {
  console.log("fleetFacts(old-code):", fleetFacts(digest, pt));
} catch (err) {
  console.log("CRASH(old-code):", String((err as Error).message));
}
