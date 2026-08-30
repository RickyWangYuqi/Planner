// 纯 Node.js 生成应用图标（1024x1024 RGBA PNG，无第三方依赖）
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIZE = 1024;

// ---------- 几何工具 ----------
function inRoundedRect(x, y, rx, ry, rw, rh, r) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.max(rx + r, Math.min(x, rx + rw - r));
  const cy = Math.max(ry + r, Math.min(y, ry + rh - r));
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

// ---------- 配色 ----------
const ACCENT = [46, 124, 246];
const ACCENT_DARK = [24, 92, 205];
const TEAL = [32, 178, 170];

// ---------- 逐像素绘制 ----------
const px = new Uint8Array(SIZE * SIZE * 4);
const CHECK_STROKE = 72;
const CHECK = [
  [390, 560, 492, 662],
  [492, 662, 678, 452],
];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let color = [0, 0, 0, 0];

    if (inRoundedRect(x, y, 24, 24, 976, 976, 220)) {
      color = [...mix(ACCENT, TEAL, (x + y) / (2 * SIZE)), 255];
    }
    if (inRoundedRect(x, y, 300, 170, 110, 90, 26) || inRoundedRect(x, y, 430, 170, 110, 90, 26)) {
      color = [...ACCENT_DARK, 255];
    }
    if (inRoundedRect(x, y, 250, 250, 524, 570, 64)) {
      color = [255, 255, 255, 255];
    }
    if (inRoundedRect(x, y, 300, 300, 424, 110, 32)) {
      color = [...mix(ACCENT, ACCENT_DARK, (y - 300) / 110), 255];
    }
    for (const [x1, y1, x2, y2] of CHECK) {
      if (distToSeg(x, y, x1, y1, x2, y2) <= CHECK_STROKE / 2) {
        color = [...ACCENT, 255];
        break;
      }
    }

    const i = (y * SIZE + x) * 4;
    px[i] = color[0];
    px[i + 1] = color[1];
    px[i + 2] = color[2];
    px[i + 3] = color[3];
  }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // 位深
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: None
  for (let x = 0; x < SIZE * 4; x++) raw[y * (SIZE * 4 + 1) + 1 + x] = px[y * SIZE * 4 + x];
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(__dirname, "..", "app-icon.png");
writeFileSync(out, png);
console.log(`icon generated: ${out} (${png.length} bytes)`);
