/**
 * アイコン（SVG と PNG）をまとめて書き出す。
 *
 *   node tools/generate-icons.mjs
 *
 * 外部ライブラリは使いません。図形の定義（SHAPES）を唯一の原本として、
 * SVG の書き出しと PNG のラスタライズの両方をここで行うので、
 * 図柄を変えたいときは SHAPES だけ直してこのスクリプトを流し直します。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'assets');
mkdirSync(assets, { recursive: true });

const BG = '#2f6df0';

/** 座標はすべて 0〜1 の相対値。上に伸びる4本の棒＝右肩上がりのチャート。 */
const BARS = [
  { x: 0.15, h: 0.18, a: 0.50 },
  { x: 0.34, h: 0.28, a: 0.66 },
  { x: 0.53, h: 0.39, a: 0.82 },
  { x: 0.72, h: 0.52, a: 1.00 },
];
const BAR_W = 0.13;
const BASE_Y = 0.78;

/** @type {Array<object>} 描画順（後のものが上に載る） */
const SHAPES = [
  { type: 'roundRect', x: 0, y: 0, w: 1, h: 1, r: 0.22, color: BG, alpha: 1, bg: true },
  ...BARS.map((b) => ({
    type: 'roundRect',
    x: b.x, y: BASE_Y - b.h, w: BAR_W, h: b.h, r: 0.028,
    color: '#ffffff', alpha: b.a,
  })),
];

// ---------- SVG ----------

function toSvg({ inset = 0, rounded = true } = {}) {
  const scale = 1 - inset * 2;
  const body = SHAPES.map((s) => {
    if (s.bg) {
      const r = rounded ? 0.22 * 512 : 0;
      return `  <rect x="0" y="0" width="512" height="512" rx="${r}" fill="${s.color}"/>`;
    }
    const x = (inset + s.x * scale) * 512;
    const y = (inset + s.y * scale) * 512;
    const w = s.w * scale * 512;
    const h = s.h * scale * 512;
    const r = s.r * scale * 512;
    return `  <rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" rx="${round(r)}" fill="${s.color}" fill-opacity="${s.alpha}"/>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="日本株ポートフォリオ">\n${body}\n</svg>\n`;
}

const round = (n) => Math.round(n * 100) / 100;

// ---------- ラスタライズ ----------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function insideRoundRect(px, py, s) {
  const { x, y, w, h, r } = s;
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const rx = Math.min(r, w / 2);
  const ry = Math.min(r, h / 2);
  // 角の内側（円の中心）からの距離だけ判定すればよい
  const cx = px < x + rx ? x + rx : px > x + w - rx ? x + w - rx : px;
  const cy = py < y + ry ? y + ry : py > y + h - ry ? y + h - ry : py;
  const dx = px - cx;
  const dy = py - cy;
  if (dx === 0 || dy === 0) return true;
  return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
}

/**
 * @param {number} size 出力の一辺（px）
 * @param {{inset?: number, rounded?: boolean, ss?: number}} opts
 * @returns {Buffer} RGBA のピクセル列
 */
function rasterize(size, { inset = 0, rounded = true, ss = 4 } = {}) {
  const scale = 1 - inset * 2;
  const shapes = SHAPES.map((s) => {
    if (s.bg) {
      return { ...s, x: 0, y: 0, w: 1, h: 1, r: rounded ? 0.22 : 0, rgb: hexToRgb(s.color) };
    }
    return {
      ...s,
      x: inset + s.x * scale,
      y: inset + s.y * scale,
      w: s.w * scale,
      h: s.h * scale,
      r: s.r * scale,
      rgb: hexToRgb(s.color),
    };
  });

  const out = Buffer.alloc(size * size * 4);
  const step = 1 / (size * ss);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (px * ss + sx + 0.5) * step;
          const uy = (py * ss + sy + 0.5) * step;
          // 1サンプルぶんの色を、下から順に重ねて決める
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const s of shapes) {
            if (!insideRoundRect(ux, uy, s)) continue;
            const sa = s.alpha;
            cr = s.rgb[0] * sa + cr * (1 - sa);
            cg = s.rgb[1] * sa + cg * (1 - sa);
            cb = s.rgb[2] * sa + cb * (1 - sa);
            ca = sa + ca * (1 - sa);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      const alpha = a / n;
      // 上の合成は「アルファ済みの色」なので、そのまま平均して非プリマルチに戻す
      out[i] = alpha > 0 ? Math.round(Math.min(r / n / alpha, 255)) : 0;
      out[i + 1] = alpha > 0 ? Math.round(Math.min(g / n / alpha, 255)) : 0;
      out[i + 2] = alpha > 0 ? Math.round(Math.min(b / n / alpha, 255)) : 0;
      out[i + 3] = Math.round(alpha * 255);
    }
  }
  return out;
}

// ---------- PNG 書き出し ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
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
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  // 10..12 = compression / filter / interlace はすべて 0

  // 各行の先頭にフィルタ種別（0 = None）を挟む
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 実行 ----------

writeFileSync(join(assets, 'icon.svg'), toSvg());
writeFileSync(join(assets, 'icon-maskable.svg'), toSvg({ inset: 0.19, rounded: false }));

const jobs = [
  ['apple-touch-icon.png', 180, {}],
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['favicon-32.png', 32, {}],
  ['icon-maskable-512.png', 512, { inset: 0.19, rounded: false }],
];

for (const [name, size, opts] of jobs) {
  const png = toPng(rasterize(size, opts), size);
  writeFileSync(join(assets, name), png);
  console.log(`${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)}KB`);
}
console.log('icon.svg / icon-maskable.svg も書き出しました');
