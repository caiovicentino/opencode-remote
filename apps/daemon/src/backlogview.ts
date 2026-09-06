// P2-240: honest queue view for GET /api/pilot-ready.
//
// The dashboard route used to slice BACKLOG.md with `md.split("\n## Ready\n")[1]`,
// which runs from the first matching heading all the way to EOF. With the
// repeated `## Blocked` headings the stop-loss produces and the long `## Done`
// tail, every unmarked line living after the first heading leaked into BOTH
// lists — the panel reported ready tasks with a completely empty queue.
//
// This module is the same hygiene as paginate.ts/routinelease.ts: 100% pure
// (no Node built-ins, no child processes, no network calls) so
// scripts/unit.test.ts can import it without booting the daemon. The caller
// injects the file text.

export interface BacklogSection {
  /** heading depth: 1 for `#`, 2 for `##`, … up to 6 for `######` */
  level: number;
  /** heading text without the leading #'s, trimmed */
  heading: string;
  /** body lines between this heading and the NEXT heading of the same level
   * (exclusive), or until EOF when no sibling follows; read order preserved */
  lines: string[];
}

export interface QueueTask {
  id: string;
  title: string;
  area: string;
}

export interface QueueView {
  /** unmarked task lines living under a `Ready` heading */
  ready: QueueTask[];
  /** unmarked task lines living under ANY `Blocked` heading (repeats included) */
  blocked: QueueTask[];
  /** unmarked task lines under Done or any unknown heading (or before the
   * first heading): they belong to no queue, so they are only counted */
  misplaced: number;
}

const HEADING_RE = /^(#{1,6})(?:\s+(.*))?$/;

/**
 * Split the file into heading-delimited sections. A section spans from its
 * own heading up to (but excluding) the next heading of the SAME level, so a
 * `##` body keeps its `###` subsections. Text without any heading yields an
 * empty list. Never throws.
 */
export function backlogSections(text: string): BacklogSection[] {
  try {
    const rows = String(text ?? "").split("\n");
    const marks: { index: number; level: number; heading: string }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const m = rows[i]!.match(HEADING_RE);
      if (m) marks.push({ index: i, level: m[1]!.length, heading: (m[2] ?? "").trim() });
    }
    return marks.map((mark, k) => {
      let end = rows.length;
      for (let j = k + 1; j < marks.length; j++) {
        if (marks[j]!.level === mark.level) {
          end = marks[j]!.index;
          break;
        }
      }
      return { level: mark.level, heading: mark.heading, lines: rows.slice(mark.index + 1, end) };
    });
  } catch {
    return [];
  }
}

/**
 * id/title/area extraction with EXACTLY the criteria the route always used —
 * same id regex, same em-dash title terminator, same lowercase `(area: …)` tag.
 * A line that does not match the format never throws: it degrades to id "?"
 * with the whole line as title and an empty area.
 */
function parseTaskLine(line: string): QueueTask {
  const m = line.match(/\(([P\d][\w.-]*)\)\s*\[.*?\]\s*([^—]+)/);
  const area = (line.match(/\(area:\s*(\w+)\)/)?.[1] ?? "").toLowerCase();
  return { id: m?.[1] ?? "?", title: (m?.[2] ?? line).trim(), area };
}

/**
 * Classify every unmarked (`- [ ]`) task line of the file by the heading it
 * lives under, applying the rules IN this order:
 *   1. only unmarked lines enter a list; a done-marked (`- [x]`) line never
 *      enters either list;
 *   2. a line under a Ready heading enters `ready`;
 *   3. a line under ANY Blocked heading — the file repeats them — enters
 *      `blocked`;
 *   4. an unmarked line under Done, under any other unknown heading or before
 *      the first heading enters NO list and is only counted as `misplaced`;
 *   5. the same identifier never shows up twice in the same list nor in both
 *      lists at once — the first occurrence in read order wins.
 * Pure and stable: the same input always yields the same view. Never throws.
 */
export function queueView(text: string): QueueView {
  const empty: QueueView = { ready: [], blocked: [], misplaced: 0 };
  try {
    const rows = String(text ?? "").split("\n");
    const ready: QueueTask[] = [];
    const blocked: QueueTask[] = [];
    let misplaced = 0;
    const seen = new Set<string>();
    // a line lives under the nearest heading above it; before the first
    // heading there is no section, which rules 4 treats as unknown ground
    let section: "ready" | "blocked" | "other" = "other";
    for (const row of rows) {
      const heading = row.match(HEADING_RE);
      if (heading) {
        const name = (heading[2] ?? "").trim().toLowerCase();
        section = name === "ready" ? "ready" : name === "blocked" ? "blocked" : "other";
        continue;
      }
      if (row.startsWith("- [x]")) continue; // rule 1: done stays done
      if (!row.startsWith("- [ ]")) continue; // not a task line at all
      if (section === "other") {
        misplaced++; // rule 4: Done/unknown ground counts, never lists
        continue;
      }
      const task = parseTaskLine(row);
      if (seen.has(task.id)) continue; // rule 5: first occurrence wins
      if (section === "ready") ready.push(task);
      else blocked.push(task);
      seen.add(task.id);
    }
    return { ready, blocked, misplaced };
  } catch {
    return empty;
  }
}
