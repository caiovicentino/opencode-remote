import { json, loadDashboard } from "../../../scripts/dashboard-harness";
const outage = { v:1, installed:true, pilot:{state:"down",reason:"pid-dead",heartbeatAgeMs:3000,since:"2026-09-24T11:07:09.623Z",silentForMs:272984000,pid:35139,pidAlive:false,lastEventAt:"2026-09-24T11:07:09.623Z"}, deploy:{prodSha:"1ebbbc1",mainSha:"b585ea2",behind:16,behindTotal:67,pendingSince:"2026-09-24T07:11:01.000Z",fetchedAt:"x",hold:{reason:"disk-guard",detail:"d",at:"t",until:null,count:69}}, disk:{freeBytes:1,totalBytes:2,minFreeBytes:3}, queue:{ready:2,blocked:12,misplaced:0,source:"origin/main"}, cost:{day:{windowMs:1,merges:0,tokens:0,usd:null,unpricedTokens:0},week:{windowMs:1,merges:63,tokens:1,usd:null,unpricedTokens:1}}, alerts:{undelivered:100,lastDeliveredAgeMs:1}, attention:[{kind:"pilot-down",level:"critical"}] };
let statusBody: unknown = outage;
let eventsBody: Record<string, unknown> = { state: { tasks: 8, merges: 6 }, heartbeatMs: 3_000, events: [], cfg: { maxTasksPerDay: 200 } };
const dash = await loadDashboard({ fetch: async (url: string) => {
  if (url === "/api/pilot-status") return json(200, statusBody);
  if (url === "/api/pilot-events") return json(200, eventsBody);
  return json(200, {});
} });
const poll = dash.fn.poll as () => Promise<void>;
const loadStatus = dash.fn.loadStatus as () => Promise<void>;
const wanted = dash.fn.pulseWanted as () => boolean;
await poll();
console.log("after pid-dead poll:", JSON.stringify({ pulses: dash.pulses.length, wanted: wanted(), status: (dash.world as { status?: { pilot?: { state?: string } } }).status?.pilot?.state }));
statusBody = { ...outage, pilot: { ...outage.pilot, state: "alive", pidAlive: true }, deploy: { ...outage.deploy, behind: 0, behindTotal: 0, hold: null, pendingSince: null }, alerts: { undelivered: 0, lastDeliveredAgeMs: 60_000 }, attention: [] };
eventsBody = { ...eventsBody, heartbeatMs: 2_000 };
await loadStatus();
await poll();
console.log("after healthy poll:", JSON.stringify({ pulses: dash.pulses.length, wanted: wanted(), status: (dash.world as { status?: { pilot?: { state?: string } } }).status?.pilot?.state, hb: (dash.world as { hbMs?: number }).hbMs }));
