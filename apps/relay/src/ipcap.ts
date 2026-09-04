/**
 * Per-IP live-connection cap for the relay (P2-025).
 *
 * MAX_SOCKETS bounds the global pool, but a single host can open every
 * slot and deny admission to all other peers (DoS de admissão on a public
 * relay). IpCap bounds how many live connections one source IP may hold:
 * admit() on every connection attempt, release() when the socket dies,
 * counts() for observability. Like the token bucket it is pure decision
 * logic (no ws/node imports), so the handler wiring stays testable.
 *
 * The cap is only rotation-immune when every caller keys it by normalizeIp()
 * (P2-026): a dual-stack host owns 2^64 IPv6 addresses and the same IPv4
 * may arrive spelled "::ffff:a.b.c.d" or "a.b.c.d", so raw remoteAddress
 * values would mint unlimited fresh buckets.
 *
 * limit <= 0 disables the cap entirely: every admit is accepted and no
 * state is kept.
 */
export class IpCap {
  private readonly live = new Map<string, number>();

  constructor(readonly limit: number) {}

  /** Take one live slot for `ip`; false means the IP is over budget. */
  admit(ip: string): boolean {
    if (this.limit <= 0) return true;
    const n = this.live.get(ip) ?? 0;
    if (n >= this.limit) return false;
    this.live.set(ip, n + 1);
    return true;
  }

  /** Give back the slot held by one admitted connection of `ip`. */
  release(ip: string): void {
    if (this.limit <= 0) return;
    const n = this.live.get(ip) ?? 0;
    if (n <= 1) this.live.delete(ip);
    else this.live.set(ip, n - 1);
  }

  /** Live connection counts per source IP. */
  counts(): Record<string, number> {
    return Object.fromEntries(this.live);
  }
}

const HEX_GROUP_RE = /^[0-9A-Fa-f]{1,4}$/;
const V4_TAIL_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Cap key for a connection, proxy-aware (P2-128).
 *
 * `forwardedFor` is the raw `x-forwarded-for` header; `trustHops` is how many
 * trusted proxy layers sit in front of the relay (RELAY_TRUST_PROXY_HOPS).
 *
 * - trustHops <= 0 (the default): the header is ignored entirely — any client
 *   can forge `x-forwarded-for`, so it carries zero weight without an
 *   operator-configured chain. The key is the normalized remoteAddress.
 * - trustHops N > 0: the N-th entry counting from the right is the address
 *   the Nth-from-last proxy saw (XFF appends one hop per layer). A chain
 *   shorter than N, an absent header, or a malformed entry falls back to the
 *   normalized remoteAddress — a degraded chain must not mint a bogus key.
 *
 * The return value is always normalizeIp()-ed, so admit() and release() key
 * on the same rotation-immune bucket no matter which path produced it. No
 * plaintext frame or key material ever flows through here: this is envelope
 * metadata only, the relay stays blind.
 */
export function clientIp(remoteAddress: string, forwardedFor: string | undefined, trustHops: number): string {
  const fallback = normalizeIp(remoteAddress);
  const hops = Math.floor(trustHops);
  if (!forwardedFor || hops <= 0) return fallback;
  const entries = forwardedFor
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const chosen = entries[entries.length - hops];
  if (chosen === undefined || !isValidAddress(chosen)) return fallback;
  return normalizeIp(chosen);
}

/** IPv4 dotted quad or IPv6 literal — nothing else is a cap key (P2-128). */
function isValidAddress(entry: string): boolean {
  if (entry.includes(":")) return ipv6Hextets(entry) !== null;
  const m = V4_TAIL_RE.exec(entry);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Canonical cap key for a `req.socket.remoteAddress` value (P2-026).
 *
 * - IPv4 and IPv6 loopback pass through unchanged.
 * - IPv4-mapped IPv6 ("::ffff:a.b.c.d", dotted or hex tail) unmasks to the
 *   plain IPv4, so both spellings of one address share a single bucket.
 * - Every other IPv6 literal aggregates to its /64 prefix — the first 4
 *   hextets, lowercase, RFC-5952-compressed — because one host can rotate
 *   through 2^64 addresses inside its /64.
 *
 * Unparseable input returns the lowercased input, never throws: the cap
 * degrades to P2-025's raw-string behavior instead of diverging.
 */
export function normalizeIp(ip: string): string {
  if (!ip.includes(":")) return ip;
  const hextets = ipv6Hextets(ip);
  if (!hextets) return ip.toLowerCase();
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0) {
    // IPv4-mapped (::ffff:0:0/96): the mapped address is the plain IPv4
    if (h5 === 0xffff) {
      return `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
    }
    // IPv6 loopback: a single host address, never a rotation pool
    if (h5 === 0 && h6 === 0 && h7 === 1) return ip;
  }
  return compressPrefix([h0, h1, h2, h3].map((h) => h.toString(16)));
}

/** The 8 hextets of an IPv6 literal. */
type Hextets = [number, number, number, number, number, number, number, number];

/** Parse an IPv6 literal into its 8 hextets; null when it is not one. */
function ipv6Hextets(addr: string): Hextets | null {
  // embedded dotted-quad tail (::ffff:a.b.c.d, NAT64 64:ff9b::…): worth 2 hextets
  let literal = addr;
  const lastColon = addr.lastIndexOf(":");
  const last = addr.slice(lastColon + 1);
  if (last.includes(".")) {
    const m = V4_TAIL_RE.exec(last);
    if (!m) return null;
    const oct = (i: number) => {
      const n = Number(m[i]);
      return Number.isFinite(n) && n <= 255 ? n : -1;
    };
    const [o0, o1, o2, o3] = [oct(1), oct(2), oct(3), oct(4)];
    if (o0 < 0 || o1 < 0 || o2 < 0 || o3 < 0) return null;
    literal =
      addr.slice(0, lastColon + 1) + `${((o0 << 8) | o1).toString(16)}:${((o2 << 8) | o3).toString(16)}`;
  }
  const halves = literal.split("::");
  if (halves.length > 2) return null;
  const toHextets = (s: string) => (s ? s.split(":").map((g) => (HEX_GROUP_RE.test(g) ? parseInt(g, 16) : NaN)) : []);
  const head = toHextets(halves[0] ?? "");
  const back = halves.length === 2 ? toHextets(halves[1] ?? "") : [];
  if (head.some(Number.isNaN) || back.some(Number.isNaN)) return null;
  const zeros = 8 - head.length - back.length;
  if (zeros < 0 || (halves.length === 2 ? zeros === 0 : zeros !== 0)) return null;
  return [...head, ...Array<number>(Math.max(zeros, 0)).fill(0), ...back] as Hextets;
}

/** RFC-5952 compression of lowercase hextets: "::" only for runs of 2+. */
function compressPrefix(hextets: string[]): string {
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < hextets.length; ) {
    if (hextets[i] !== "0") {
      i++;
      continue;
    }
    let j = i;
    while (j < hextets.length && hextets[j] === "0") j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  if (bestStart === -1) return hextets.join(":");
  const head = hextets.slice(0, bestStart).join(":");
  const tail = hextets.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}
