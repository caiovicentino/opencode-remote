#!/usr/bin/env node
/**
 * P3-009: generates apps/desktop/build/icon.png (512x512) with zero deps —
 * a plain RGBA rasterizer + hand-rolled PNG encoder (Node's zlib does the
 * compression). Design: dark rounded square with a glowing `>_` terminal
 * prompt, echoing the product (remote shell control). Run `node
 * scripts/make-icon.mjs` after changing anything; the generated PNG is
 * committed so builds stay reproducible without re-running this.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const SIZE = 512;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "icon.png");

// --- PNG encoder (RGBA8, filter 0) -------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, crc]);
}

function pngEncode(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- drawing helpers ----------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));
const lerpColor = ([r1, g1, b1], [r2, g2, b2], t) => [lerp(r1, r2, t), lerp(g1, g2, t), lerp(b1, b2, t)];
const coverage = (d) => Math.min(1, Math.max(0, 0.5 - d)); // 1px anti-aliased edge

/** Signed distance of p from a rounded rect centered at (cx,cy), half-size h, radius r. */
function roundedRectSDF(px, py, cx, cy, h, r) {
  const qx = Math.abs(px - cx) - (h - r);
  const qy = Math.abs(py - cy) - (h - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance of p from a thick segment a→b with round caps of radius r. */
function segmentSDF(px, py, [ax, ay], [bx, by], r) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) - r;
}

// --- icon: dark rounded square + `>_` prompt ----------------------------------
const BG_TOP = [38, 45, 59]; // #262d3b
const BG_BOTTOM = [13, 16, 24]; // #0d1018
const FG_TOP = [134, 239, 172]; // #86efac
const FG_BOTTOM = [34, 197, 94]; // #22c55e
const CORNER = 112;
const GLYPH = [
  // chevron ">": two thick segments sharing the middle vertex
  { a: [170, 168], b: [278, 266] },
  { a: [278, 266], b: [170, 364] },
];
const CURSOR = { a: [342, 168], b: [342, 364] }; // vertical "_|" bar
const STROKE = 23; // segment radius → 46px line width
const GLYPH_TOP = 168 - STROKE; // gradient band across the glyph only
const GLYPH_BOTTOM = 364 + STROKE;

const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  const bgGrad = lerpColor(BG_TOP, BG_BOTTOM, y / (SIZE - 1));
  for (let x = 0; x < SIZE; x++) {
    const bgCov = coverage(roundedRectSDF(x + 0.5, y + 0.5, SIZE / 2, SIZE / 2, SIZE / 2 - 2, CORNER));
    const i = (y * SIZE + x) * 4;
    let [r, g, b] = bgGrad;
    let a = bgCov * 255;
    if (bgCov > 0) {
      const d = Math.min(
        ...[...GLYPH, CURSOR].map(({ a: [ax, ay], b: [bx, by] }) => segmentSDF(x + 0.5, y + 0.5, [ax, ay], [bx, by], STROKE)),
      );
      const fgCov = Math.min(1, Math.max(0, -d + 0.5));
      if (fgCov > 0) {
        const t = (y - GLYPH_TOP) / (GLYPH_BOTTOM - GLYPH_TOP);
        const fg = lerpColor(FG_TOP, FG_BOTTOM, t);
        r = lerp(r, fg[0], fgCov);
        g = lerp(g, fg[1], fgCov);
        b = lerp(b, fg[2], fgCov);
      }
    }
    rgba[i] = Math.round(r);
    rgba[i + 1] = Math.round(g);
    rgba[i + 2] = Math.round(b);
    rgba[i + 3] = Math.round(a);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
const png = pngEncode(SIZE, rgba);
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes)`);
