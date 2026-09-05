#!/usr/bin/env node
/**
 * P2-196: boot smoke for the relay image, run by the relay-image job of
 * .github/workflows/release.yml between the docker build and the GHCR push.
 *
 * The job used to build the image and — with PUBLISH_RELAY_IMAGE=true — push
 * it without ever executing it, so an image that compiles but does not boot
 * (a CMD pointing at a dist the final stage never copied, an embedded
 * RELAY_WEB_DIR that is missing, a boot refused by the P2-188 preflight)
 * became the image the stage-4 operator pulls — exactly the gap P2-147
 * closed for the desktop packaging and P2-164 for the Windows bundle.
 *
 * Like scripts/release-assets.ts the verdict is a pure, testable contract:
 * `imageSmokeVerdict` takes the list of probe results and returns problems in
 * the same human-readable format — one problem per failed probe, never
 * short-circuiting, so the operator sees every failure at once. The named
 * probes are:
 *
 *   healthz         → GET /healthz answers 200 with today's counter body
 *                     (ok:true, version, uptimeS, rooms, roomsRejected)
 *   web-root        → GET / answers 200, text/html, carrying every security
 *                     header P2-192 introduced (HSTS is TLS-gated and only
 *                     checked when present-allowed: the smoke runs over
 *                     plain http:// by design)
 *   hashed-asset    → the content-hashed bundle asset referenced by the
 *                     entry document answers 200
 *   dotfile         → a dotfile path answers 404 (the allowlist holds)
 *   method-not-get  → a non-GET request answers 405
 *   container-user  → the process user inside the container is not root
 *
 * The CLI reads the base URL and the container user from argv, performs the
 * HTTP probes with the global fetch and a documented timeout, prints one
 * line per problem and exits 1; everything passing exits silently with 0.
 *
 * Run: npx tsx scripts/relay-image-smoke.ts http://127.0.0.1:<port> <user>
 */
import { pathToFileURL } from "node:url";

/** Per-request fetch timeout, documented in docs/RELAY-HOSTING.md. */
export const FETCH_TIMEOUT_MS = 5000;

/** Result of one smoke probe, as the CLI observes it off the wire. */
export interface SmokeProbeInput {
  /** One of the six named probes below — anything else is a problem. */
  name: string;
  /** HTTP status observed; 0 means the request never answered. */
  status?: number;
  /** Raw response body (healthz counters, entry document). */
  body?: string;
  /** content-type of the response, when the probe carries one. */
  contentType?: string;
  /** Response headers, lowercase-keyed, when the probe carries them. */
  headers?: Record<string, string>;
  /** Process user inside the container (`docker exec … whoami`). */
  user?: string;
}

/** The security headers every 200 document must carry over plain HTTP
 * (webheaders.ts P2-192 map minus the TLS-gated strict-transport-security). */
const EXPECTED_HEADERS: ReadonlyArray<[header: string, mustInclude: string]> = [
  ["content-security-policy", "default-src"],
  ["referrer-policy", "no-referrer"],
  ["permissions-policy", "geolocation=()"],
  ["x-frame-options", "deny"],
  ["cross-origin-opener-policy", "same-origin"],
  ["cross-origin-resource-policy", "same-origin"],
];

/**
 * One problem per failed probe, in probe order, never short-circuiting: the
 * operator fixes everything in one round. An empty probe list is itself a
 * problem — a smoke that ran nothing proves nothing (fail-closed).
 */
export function imageSmokeVerdict(probes: readonly SmokeProbeInput[]): string[] {
  if (probes.length === 0) {
    return ["no probes ran — a smoke without probes proves nothing (fail-closed)"];
  }
  const problems: string[] = [];
  for (const probe of probes) {
    const problem = probeProblem(probe);
    if (problem !== "") problems.push(problem);
  }
  return problems;
}

/** The single problem of one probe, or "" when the probe passed. */
function probeProblem(probe: SmokeProbeInput): string {
  switch (probe.name) {
    case "healthz": {
      const reasons: string[] = [];
      if (probe.status !== 200) reasons.push(`answered ${probe.status ?? "nothing"}, expected 200`);
      const parsed = parseCounters(probe.body);
      if (typeof parsed === "string") {
        reasons.push(`body is not today's counter body: ${parsed}`);
      } else if (probe.status === 200) {
        reasons.push(...parsed);
      }
      return reasons.length === 0 ? "" : `healthz: ${reasons.join("; ")}`;
    }
    case "web-root": {
      const reasons: string[] = [];
      if (probe.status !== 200) reasons.push(`answered ${probe.status ?? "nothing"}, expected 200`);
      if (probe.status === 200 && !(probe.contentType ?? "").toLowerCase().startsWith("text/html")) {
        reasons.push(`content-type is ${probe.contentType || "absent"}, expected text/html`);
      }
      const headers = probe.headers ?? {};
      for (const [header, mustInclude] of EXPECTED_HEADERS) {
        const value = headers[header];
        if (value === undefined || value.trim() === "") {
          reasons.push(`header ${header} is missing — the P2-192 lockdown must ship on every 200 document`);
        } else if (!value.toLowerCase().includes(mustInclude)) {
          reasons.push(`header ${header} is "${value}", expected it to include "${mustInclude}"`);
        }
      }
      return reasons.length === 0 ? "" : `web-root: ${reasons.join("; ")}`;
    }
    case "hashed-asset":
      return probe.status === 200
        ? ""
        : `hashed-asset: answered ${probe.status ?? "nothing"}, expected 200 ` +
            "(status 0 means no hashed asset was discovered in the entry document or the request failed)";
    case "dotfile":
      return probe.status === 404 ? "" : `dotfile: answered ${probe.status ?? "nothing"}, expected 404`;
    case "method-not-get":
      return probe.status === 405 ? "" : `method-not-get: answered ${probe.status ?? "nothing"}, expected 405`;
    case "container-user": {
      const user = (probe.user ?? "").trim();
      if (user === "") return "container-user: the process user is empty — cannot prove the container is not root (fail-closed)";
      return user.toLowerCase() === "root" || user === "0"
        ? `container-user: the container runs as "${user}" — the image must ship as the non-root node user`
        : "";
    }
    default:
      return `unknown probe "${probe.name}" — expected one of healthz, web-root, hashed-asset, dotfile, method-not-get, container-user`;
  }
}

/** Validate the /healthz counter body (today's shape, healthzPayload). */
function parseCounters(body: string | undefined): string[] | string {
  if (body === undefined || body.trim() === "") return "body is empty";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `body is not JSON: ${body.slice(0, 64)}`;
  }
  if (typeof parsed !== "object" || parsed === null) return "body is not a JSON object";
  const counters = parsed as Record<string, unknown>;
  const problems: string[] = [];
  if (counters["ok"] !== true) problems.push('counter "ok" is not true');
  if (typeof counters["version"] !== "string" || counters["version"] === "") {
    problems.push('counter "version" is not a non-empty string');
  }
  for (const field of ["uptimeS", "rooms", "roomsRejected"]) {
    if (typeof counters[field] !== "number" || !Number.isFinite(counters[field] as number) || (counters[field] as number) < 0) {
      problems.push(`counter "${field}" is not a non-negative number`);
    }
  }
  return problems;
}

/** One fetch with the documented timeout; status 0 when it never answers. */
async function probeFetch(base: string, path: string, method: string): Promise<SmokeProbeInput> {
  const url = `${base}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { name: "probe", status: 0, body: err instanceof Error ? err.message : String(err) };
  }
  const body = await res.text().catch(() => "");
  return {
    name: "probe",
    status: res.status,
    body,
    contentType: res.headers.get("content-type") ?? "",
    headers: Object.fromEntries(res.headers.entries()),
  };
}

/** First content-hashed asset reference of the entry document, if any.
 * Vite 6 emits `assets/<name>-<hash>.js|css` with an 8-char base64-ish hash. */
function hashedAssetRef(document: string | undefined): string | null {
  if (!document) return null;
  const match = /(?:src|href)=["'](\/assets\/[^"'#?]+-[A-Za-z0-9_-]{6,}\.(?:js|css))["']/.exec(document);
  return match?.[1] ?? null;
}

async function cli(argv: readonly string[]): Promise<void> {
  const base = (argv[0] ?? "").replace(/\/+$/, "");
  const user = argv[1] ?? "";
  if (!/^https?:\/\/[^\s]+$/i.test(base) || argv.length < 2) {
    console.error(
      "relay-image-smoke: usage: tsx scripts/relay-image-smoke.ts <base-url> <container-user>\n" +
        "  (base URL of the booted container, user from `docker exec <c> whoami`)",
    );
    process.exitCode = 1;
    return;
  }

  const healthz = await probeFetch(base, "/healthz", "GET");
  const root = await probeFetch(base, "/", "GET");
  const asset = hashedAssetRef(root.body);
  const hashed = asset
    ? await probeFetch(base, asset, "GET")
    : { name: "probe", status: 0, body: "", headers: {} };
  const dotfile = await probeFetch(base, "/.env", "GET");
  const wrongMethod = await probeFetch(base, "/", "DELETE");

  const problems = imageSmokeVerdict([
    { name: "healthz", status: healthz.status, body: healthz.body },
    {
      name: "web-root",
      status: root.status,
      contentType: root.contentType,
      headers: root.headers,
    },
    { name: "hashed-asset", status: hashed.status },
    { name: "dotfile", status: dotfile.status },
    { name: "method-not-get", status: wrongMethod.status },
    { name: "container-user", user },
  ]);
  if (problems.length > 0) {
    console.error(`relay-image-smoke: FAIL ${base}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`relay-image-smoke: ${problems.length} problem(s) found`);
    process.exitCode = 1;
    return;
  }
  // Silent on success: in the workflow the absence of output IS the green
  // signal; the job continues to the push step.
}

// CLI guard: skip main() when imported by the unit test.
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) void cli(process.argv.slice(2));
