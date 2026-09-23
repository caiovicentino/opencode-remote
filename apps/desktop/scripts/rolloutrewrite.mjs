/**
 * P3-460: the pure rewriting core behind apps/desktop/scripts/rollout.mjs —
 * the tool that suspends (0) or advances (0..100) the gradual rollout of an
 * ALREADY PUBLISHED release without republishing a single installer.
 *
 * Until P3-460 only the release build could declare the percentage (P3-458's
 * ROLLOUT_PERCENT at feed-build time): changing it meant re-running the whole
 * packaging workflow — two runners, signing, notarization — just to move a
 * number the client reader (apps/desktop/src/updaterollout.ts) consults from
 * the feed. This module rewrites ONLY that number, so the second slice of
 * P3-457 is a feed surgery, not a republication.
 *
 * Purity by construction — the P3-458 module hygiene, same as
 * rolloutpercent.mjs: the only import is the shared validator module (the
 * field-name constants ROLLOUT_JSON_FIELD / ROLLOUT_YML_FIELD and
 * parseRolloutPercent live in exactly one place, the P2-336 lesson). NO
 * node:fs, NO node:path, NO network, NO timers, NO randomness: the unit
 * battery imports this file directly, and the CLI's only job besides calling
 * it is to move bytes through `gh`.
 *
 * The contract is deliberately narrow (fail closed everywhere):
 *
 *   - JSON feeds (update-mac*.json, the Squirrel.Mac documents): when the
 *     field exists, ONLY its value token is replaced in place — every other
 *     byte (url, name, notes, pub_date, digests elsewhere in the file, the
 *     closing brace, the trailing newline) survives untouched. When the field
 *     is absent it is inserted as a new line right after the opening `{` with
 *     its own trailing comma, so every pre-existing byte stays exactly where
 *     it was (the birth-time writer update-feed.mjs appends the field last;
 *     order is semantically irrelevant to every consumer — Squirrel parses a
 *     map — and the rewriter refuses to move a byte it does not own). After
 *     either shape the result is re-parsed and confronted with the original:
 *     everything except the field must be identical and the field must be
 *     exactly the validated percentage, or the whole rewrite is refused.
 *   - yml feeds (latest.yml, the electron-builder document): identical
 *     semantics to update-feed.mjs's injectStagingPercentage — an existing
 *     top-level line is replaced in place, an absent one is inserted right
 *     after `version:`, indented `files:` entries never count. Parity with
 *     that function is pinned by tests over shared fixtures (the P2-338
 *     lesson: the two implementations cannot import each other — update-feed
 *     needs fs, this module must stay pure — so the battery proves they
 *     agree instead of hoping).
 *
 * Every malformed input comes back as an explicit problem list with
 * `text: null` — never a partial rewrite, never a silent skip: an operator
 * pointing this tool at a corrupt feed must see exactly why nothing changed.
 */

import { ROLLOUT_JSON_FIELD, ROLLOUT_YML_FIELD } from "./rolloutpercent.mjs";

/**
 * Belt-and-braces gate: the caller (the CLI) must run the percentage through
 * parseRolloutPercent BEFORE calling any rewrite here — same contract as
 * update-feed.mjs's injectStagingPercentage. A non-integer 0..100 value here
 * is a caller bug, thrown loudly instead of silently rewritten.
 */
function assertPercent(percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error(
      "rewriteFeedPercent: percent must be an integer 0..100 (validated by parseRolloutPercent — apps/desktop/scripts/rolloutpercent.mjs)",
    );
  }
}

/** The value-token shapes a legal JSON scalar can take, as a regex source. */
const JSON_STRING_TOKEN = '"(?:[^"\\\\]|\\\\.)*"';
const JSON_NUMBER_TOKEN = "-?(?:\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)";
const JSON_SCALAR_TOKEN = `${JSON_STRING_TOKEN}|${JSON_NUMBER_TOKEN}|null|true|false`;

function jsonKeyCountRe(field) {
  return new RegExp(`"${field}"\\s*:`, "g");
}

function jsonScalarRe(field) {
  return new RegExp(`("${field}"\\s*:\\s*)(${JSON_SCALAR_TOKEN})`);
}

/** A JSON document whose rewrite result must be confrontable with the
 * original: returns a stable string of every field EXCEPT the rollout one
 * (key order preserved — JSON.parse enumerates in document order), so the
 * post-surgery parse proves the rewrite moved nothing else. */
function jsonWithoutRollout(doc) {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return `non-object:${String(doc)}`;
  const copy = { ...doc };
  delete copy[ROLLOUT_JSON_FIELD];
  return JSON.stringify(copy);
}

/**
 * Rewrite the rollout percentage of a Squirrel.Mac JSON feed document
 * (update-mac*.json). Replaces ONLY the field's value token when the field
 * exists — any layout (the writer's pretty-printed 2-space shape, compact
 * one-line JSON, hand-edited) — and, when it does not exist, inserts it as a
 * new line right after the opening `{` (pretty-printed documents only; the
 * writer's shape) with a trailing comma, so every existing byte survives.
 * The result is validated by re-parsing: it must be the same document except
 * for the field, and the field must be exactly `percent`.
 *
 * @param {string} jsonText raw feed text (never mutated)
 * @param {number} percent integer 0..100, already validated by
 *        parseRolloutPercent (re-checked here, fail closed)
 * @returns {{ text: string | null, problems: string[] }} the new text, or
 *          null with every problem listed — nothing half-rewritten
 */
export function rewriteJsonPercent(jsonText, percent) {
  assertPercent(percent);
  const problems = [];
  if (typeof jsonText !== "string" || jsonText.trim().length === 0) {
    problems.push("update-mac feed is empty — a missing or unreadable feed is a problem, never a silent skip");
    return { text: null, problems };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    problems.push(
      `update-mac feed is not valid JSON (${String(err?.message ?? err).split("\n")[0]}) — refusing to rewrite a corrupt feed`,
    );
    return { text: null, problems };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    problems.push("update-mac feed is not a JSON object — not a Squirrel.Mac feed document");
    return { text: null, problems };
  }

  const occurrences = [...jsonText.matchAll(jsonKeyCountRe(ROLLOUT_JSON_FIELD))].length;
  if (occurrences > 1) {
    problems.push(
      `update-mac feed carries ${occurrences} "${ROLLOUT_JSON_FIELD}:" occurrences — refusing to guess which one counts`,
    );
    return { text: null, problems };
  }

  let newText;
  if (occurrences === 1) {
    const scalarRe = jsonScalarRe(ROLLOUT_JSON_FIELD);
    if (!scalarRe.test(jsonText)) {
      problems.push(
        `update-mac feed carries "${ROLLOUT_JSON_FIELD}" with a non-scalar value — refusing to rewrite it`,
      );
      return { text: null, problems };
    }
    newText = jsonText.replace(scalarRe, `$1${percent}`);
  } else {
    // Absent field → insert as a new line right after the opening `{`, with
    // its own trailing comma. Requires the writer's pretty-printed shape (a
    // standalone `{` line and a standalone `}` line): anything else is a
    // problem, never a risky text splice.
    const lines = jsonText.split("\n");
    const cr = lines.some((l) => l.endsWith("\r")) ? "\r" : "";
    let first = 0;
    while (first < lines.length && (lines[first] ?? "").trim() === "") first++;
    let last = lines.length - 1;
    while (last >= 0 && (lines[last] ?? "").trim() === "") last--;
    if (
      first >= lines.length ||
      last < 0 ||
      first === last ||
      (lines[first] ?? "").trim() !== "{" ||
      (lines[last] ?? "").trim() !== "}"
    ) {
      problems.push(
        "update-mac feed is not a pretty-printed JSON object document — the absent rollout field cannot be inserted without risking other bytes (re-publish the release, or rewrite the feed by hand)",
      );
      return { text: null, problems };
    }
    const insertLine = `  "${ROLLOUT_JSON_FIELD}": ${percent}`;
    const objectIsEmpty = Object.keys(parsed).length === 0;
    // The comma (when the object is not empty) must precede the line's own
    // EOL marker so a CRLF document keeps consistent endings.
    lines.splice(first + 1, 0, objectIsEmpty ? `${insertLine}${cr}` : `${insertLine},${cr}`);
    newText = lines.join("\n");
  }

  // Post-surgery confrontation: the new text must parse, carry EXACTLY the
  // validated percentage, and be the same document everywhere else. This is
  // what turns "careful text surgery" into a proof — any collateral damage
  // (a digest, a filename, a notes string) is caught here and refuses the
  // rewrite instead of shipping.
  let after;
  try {
    after = JSON.parse(newText);
  } catch {
    problems.push("internal: the rewritten update-mac feed no longer parses as JSON — refusing to return it");
    return { text: null, problems };
  }
  if (after[ROLLOUT_JSON_FIELD] !== percent) {
    problems.push(`internal: the rewritten feed does not carry ${ROLLOUT_JSON_FIELD}=${percent} — refusing to return it`);
    return { text: null, problems };
  }
  if (jsonWithoutRollout(parsed) !== jsonWithoutRollout(after)) {
    problems.push("internal: the rewrite moved something besides the rollout field — refusing to return it");
    return { text: null, problems };
  }
  return { text: newText, problems };
}

/**
 * Rewrite the staged-rollout percentage of an electron-builder update yml
 * (latest.yml, the Windows feed). Deliberately the SAME semantics as
 * update-feed.mjs's injectStagingPercentage (which this module cannot import
 * — that one needs node:fs, this one must stay pure): an existing top-level
 * line is replaced in place (same position, same line endings, every other
 * byte preserved), an absent one is inserted right after the `version:` line.
 * Line-anchored so indented `files:` entries never count; several top-level
 * lines, an empty document or a document with no top-level `version:` are
 * problems — nothing is rewritten. Parity with injectStagingPercentage is
 * pinned by tests over shared fixtures.
 *
 * @param {string} ymlText raw yml contents (never mutated)
 * @param {number} percent integer 0..100, already validated by
 *        parseRolloutPercent (re-checked here, fail closed)
 * @returns {{ text: string | null, problems: string[] }} the new yml text, or
 *          null with every problem listed
 */
export function rewriteYmlPercent(ymlText, percent) {
  assertPercent(percent);
  const problems = [];
  if (typeof ymlText !== "string" || ymlText.trim().length === 0) {
    problems.push("latest.yml is empty — a missing or unreadable feed is a problem, never a silent skip");
    return { text: null, problems };
  }
  const lines = ymlText.split("\n");
  const stagingIdx = [];
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${ROLLOUT_YML_FIELD}:`).test(lines[i] ?? "")) stagingIdx.push(i);
  }
  if (stagingIdx.length > 1) {
    problems.push(
      `latest.yml carries ${stagingIdx.length} top-level "${ROLLOUT_YML_FIELD}:" lines — refusing to guess which one counts`,
    );
    return { text: null, problems };
  }
  if (stagingIdx.length === 1) {
    const original = lines[stagingIdx[0]] ?? "";
    const eol = original.endsWith("\r") ? "\r" : "";
    lines[stagingIdx[0]] = `${ROLLOUT_YML_FIELD}: ${percent}${eol}`;
    return { text: lines.join("\n"), problems };
  }
  const versionIdx = lines.findIndex((l) => /^version:/.test(l ?? ""));
  if (versionIdx === -1) {
    problems.push(`latest.yml has no top-level "version:" line — not an electron-builder feed, nothing to inject into`);
    return { text: null, problems };
  }
  const eol = (lines[versionIdx] ?? "").endsWith("\r") ? "\r" : "";
  lines.splice(versionIdx + 1, 0, `${ROLLOUT_YML_FIELD}: ${percent}${eol}`);
  return { text: lines.join("\n"), problems };
}

/**
 * The one entry the CLI calls: rewrite the rollout percentage of a feed
 * document whose text arrives raw. The format is detected from the content —
 * a document opening with `{` is a Squirrel.Mac JSON feed (rewriteJsonPercent
 * path, the ROLLOUT_JSON_FIELD field), anything else must be an
 * electron-builder yml with a top-level `version:` line (rewriteYmlPercent
 * path, the ROLLOUT_YML_FIELD field). Both branches fail closed: an empty
 * text or a document that is neither shape comes back as problems, never a
 * silent skip.
 *
 * @param {string} feedText raw text of an update-mac*.json or a latest.yml
 * @param {number} percent integer 0..100, already validated by
 *        parseRolloutPercent (re-checked here, fail closed)
 * @returns {{ text: string | null, problems: string[] }} the rewritten text,
 *          or null with every problem listed
 */
export function rewriteFeedPercent(feedText, percent) {
  assertPercent(percent);
  if (typeof feedText !== "string" || feedText.trim().length === 0) {
    return {
      text: null,
      problems: ["update feed is empty — a missing or unreadable feed is a problem, never a silent skip"],
    };
  }
  if (/^\s*\{/.test(feedText)) return rewriteJsonPercent(feedText, percent);
  return rewriteYmlPercent(feedText, percent);
}
