// P2-144: pure PNG sanity check for evidence screenshots. No disk access, no
// dependencies: the caller hands in the bytes and gets a verdict with the
// exact failure reason, so a truncated/partial PNG fails at capture time
// instead of poisoning the gate's evidence check later (as in P2-117).
// Required by the constitution of evidence: the eight-byte signature, an IHDR
// chunk with non-zero width and height, and the final IEND chunk. CRCs are not
// verified on purpose — the goal is to catch truncation, not to re-implement
// a full PNG decoder.

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {Buffer} buf raw bytes of a supposed PNG file
 * @returns {{ ok: true, width: number, height: number, reason: null } |
 *           { ok: false, width: null, height: null, reason: string }}
 */
export function checkPng(buf) {
  const fail = (reason) => ({ ok: false, width: null, height: null, reason });
  if (!Buffer.isBuffer(buf)) return fail("input is not a Buffer");
  if (buf.length < 8) {
    return fail(`truncated: ${buf.length} byte(s) is shorter than the 8-byte PNG signature`);
  }
  if (!buf.subarray(0, 8).equals(SIG)) return fail("not a PNG: bad signature");
  if (buf.length < 24) return fail("truncated: shorter than signature + IHDR chunk header");
  let off = 8;
  let width = null;
  let height = null;
  let sawIHDR = false;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (off + 12 + len > buf.length) {
      return fail(`truncated: ${type} chunk runs past end of file`);
    }
    if (type === "IHDR") {
      if (len < 8) return fail("truncated: IHDR chunk shorter than 8 bytes of data");
      width = buf.readUInt32BE(off + 8);
      height = buf.readUInt32BE(off + 12);
      sawIHDR = true;
      if (width === 0 || height === 0) {
        return fail(`IHDR dimension is zero: ${width}x${height}`);
      }
    }
    if (type === "IEND") {
      if (!sawIHDR) return fail("missing IHDR chunk");
      return { ok: true, width, height, reason: null };
    }
    off += 12 + len;
  }
  if (!sawIHDR) return fail("missing IHDR chunk");
  return fail("missing IEND chunk");
}
