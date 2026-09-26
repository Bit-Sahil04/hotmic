// Generates HotMic brand icons (assets/icons/*.png) — pure Node, no dependencies.
// Shape space: unit square. A dark rounded card, a gradient mic capsule,
// an off-white holder arc and stem. 3x3 supersampling for anti-aliasing.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

// ---------- PNG encoding ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- palette ----------
const CARD = [23, 26, 33]; // #171A21
const GRAD_TOP = [255, 61, 0]; // #FF3D00
const GRAD_BOT = [255, 145, 0]; // #FF9100
const BONE = [232, 236, 244]; // #E8ECF4

// ---------- geometry (unit square) ----------
function insideRoundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function insideCapsule(x, y, cx, y0, y1, halfW) {
  return insideRoundedRect(x, y, cx - halfW, y0, cx + halfW, y1, halfW);
}
function insideArc(x, y, cx, cy, rMid, halfStroke, a0, a1) {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d < rMid - halfStroke || d > rMid + halfStroke) return false;
  let a = Math.atan2(dy, dx); // -pi..pi
  if (a < 0) a += Math.PI * 2;
  return a >= a0 && a <= a1;
}
function insideStadium(x, y, cx, y0, y1, halfW) {
  return insideCapsule(x, y, cx, y0, y1, halfW);
}

function colorAt(x, y) {
  // card
  if (!insideRoundedRect(x, y, 0.015, 0.015, 0.985, 0.985, 0.225)) return [0, 0, 0, 0];
  // holder arc: lower half-circle behind the capsule
  if (insideArc(x, y, 0.5, 0.54, 0.29, 0.05, Math.PI * 0.08, Math.PI * 0.92)) return [...BONE, 255];
  // stem
  if (insideStadium(x, y, 0.5, 0.845, 0.965, 0.038)) return [...BONE, 255];
  // capsule (gradient, drawn last so it sits on the arc)
  if (insideCapsule(x, y, 0.5, 0.14, 0.63, 0.155)) {
    const t = Math.min(1, Math.max(0, (y - 0.14) / (0.63 - 0.14)));
    const c = GRAD_TOP.map((v, i) => Math.round(v + (GRAD_BOT[i] - v) * t));
    return [...c, 255];
  }
  return [...CARD, 255];
}

function render(S) {
  const buf = Buffer.alloc(S * S * 4);
  const SS = 3;
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = colorAt((px + (sx + 0.5) / SS) / S, (py + (sy + 0.5) / SS) / S);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * S + px) * 4;
      buf[i] = r / n; buf[i + 1] = g / n; buf[i + 2] = b / n; buf[i + 3] = a / n;
    }
  }
  return png(S, S, buf);
}

const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'assets', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const S of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${S}.png`);
  fs.writeFileSync(file, render(S));
  console.log(`${file}  ${fs.statSync(file).size} bytes`);
}
