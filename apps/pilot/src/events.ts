import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FILE = join(homedir(), ".opencode-remote/pilot/events.jsonl");
const MAX_LINES = 400;

export interface PilotEvent {
  ts: string;
  type: "phase" | "agent" | "result" | "deploy" | "loop";
  task?: string;
  phase?: string;
  ok?: boolean;
  detail?: string;
}

/** Append a pipeline event for the dashboard/API. Keeps the file bounded. */
export function emit(type: PilotEvent["type"], fields: Omit<PilotEvent, "ts" | "type"> = {}) {
  try {
    const evt: PilotEvent = { ts: new Date().toISOString(), type, ...fields };
    if (evt.detail && evt.detail.length > 220) evt.detail = evt.detail.slice(0, 220);
    appendFileSync(FILE, JSON.stringify(evt) + "\n");
    trim();
  } catch {}
}

function trim() {
  try {
    const lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      writeFileSync(FILE, lines.slice(-MAX_LINES).join("\n") + "\n");
    }
  } catch {}
}

export function readEvents(limit = 200): PilotEvent[] {
  try {
    return readFileSync(FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as PilotEvent);
  } catch {
    return [];
  }
}
