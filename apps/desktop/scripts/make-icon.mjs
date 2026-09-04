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

// --- tray template image (P3-015) ---------------------------------------------
// Monochrome `>_` glyph (same geometry as the app icon, scaled) rendered as
// pure alpha — macOS template images ignore color and recolor the mask to
// match the light/dark menu bar. Shipped as 16x16 + 32x32 @2x; Electron's
// createFromPath auto-picks the sibling @2x file on Retina screens.
const TRAY_SIZES = [
  [16, "trayTemplate.png"],
  [32, "trayTemplate@2x.png"],
];

function trayIconPng(size) {
  const s = size / SIZE; // scale the 512px master geometry down
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.min(
        ...[...GLYPH, CURSOR].map(({ a: [ax, ay], b: [bx, by] }) =>
          segmentSDF(x + 0.5, y + 0.5, [ax * s, ay * s], [bx * s, by * s], STROKE * s),
        ),
      );
      const cov = coverage(d);
      const i = (y * size + x) * 4;
      out[i + 3] = Math.round(cov * 255); // RGB stays 0: only alpha matters
    }
  }
  return pngEncode(size, out);
}

for (const [size, name] of TRAY_SIZES) {
  const path = join(dirname(OUT), name);
  const buf = trayIconPng(size);
  writeFileSync(path, buf);
  console.log(`wrote ${path} (${size}x${size}, ${buf.length} bytes)`);
}

// --- Windows taskbar overlay (P2-150) ------------------------------------------
// Small solid brand-green disk: the glyph win.setOverlayIcon() composites onto
// the taskbar icon when unread messages arrive (app.setBadgeCount is a no-op
// on Windows). 32x32 stays crisp at 125–200% taskbar DPI and Windows downscales
// to the 16-DIP overlay slot; the edge is anti-aliased by the same SDF
// coverage helper as the tray template. Solid fill — the count itself is never
// drawn (the OS slot is too small); screen readers get it via the overlay
// description (badge.ts).
const OVERLAY_SIZE = 32;
const OVERLAY_RADIUS = 13;
const OVERLAY_GREEN = [34, 197, 94]; // #22c55e — the app icon's glyph green

function overlayBadgePng() {
  const out = Buffer.alloc(OVERLAY_SIZE * OVERLAY_SIZE * 4);
  const c = OVERLAY_SIZE / 2;
  for (let y = 0; y < OVERLAY_SIZE; y++) {
    for (let x = 0; x < OVERLAY_SIZE; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) - OVERLAY_RADIUS;
      const cov = coverage(d);
      const i = (y * OVERLAY_SIZE + x) * 4;
      out[i] = OVERLAY_GREEN[0];
      out[i + 1] = OVERLAY_GREEN[1];
      out[i + 2] = OVERLAY_GREEN[2];
      out[i + 3] = Math.round(cov * 255);
    }
  }
  return pngEncode(OVERLAY_SIZE, out);
}

const overlayPath = join(dirname(OUT), "overlayBadge.png");
const overlayBuf = overlayBadgePng();
writeFileSync(overlayPath, overlayBuf);
console.log(`wrote ${overlayPath} (${OVERLAY_SIZE}x${OVERLAY_SIZE}, ${overlayBuf.length} bytes)`);
