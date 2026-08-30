import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  hour: number; // machine-local time
  minute: number;
  lastRun?: string; // local YYYY-MM-DD of the last fire
  lastSessionID?: string; // session awaiting result persistence
  lastStatus?: "ok" | "error";
  lastError?: string;
}

const FILE = () => join(homedir(), ".opencode-remote", "routines.json");

export function loadRoutines(): Routine[] {
  try {
    return JSON.parse(readFileSync(FILE(), "utf8")) as Routine[];
  } catch {
    return [];
  }
}

export function saveRoutines(rs: Routine[]) {
  writeFileSync(FILE(), JSON.stringify(rs, null, 2));
  chmodSync(FILE(), 0o600);
}
