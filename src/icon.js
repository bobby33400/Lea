'use strict';
/* icon.js — zero-dependency PNG generation for:
 *   - the monochrome menu-bar/tray template icon (gray+alpha)
 *   - a colored app icon for installers (RGBA)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, colorType, channels, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const encodeGA = (w, h, px) => encodePNG(w, h, 4, 2, px); // grayscale + alpha
const encodeRGBA = (w, h, px) => encodePNG(w, h, 6, 4, px); // truecolor + alpha

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Monochrome gauge ring for the tray (alpha only; macOS template image).
function ringPixels(size) {
  const px = Buffer.alloc(size * size * 2);
  const c = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.26;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.round(255 * Math.min(clamp01(outer - d + 0.5), clamp01(d - inner + 0.5)));
      const i = (y * size + x) * 2;
      px[i] = 0;
      px[i + 1] = a;
    }
  }
  return px;
}

// Colored app icon: terracotta rounded square with a white gauge ring.
function appIconPixels(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const m = size * 0.085; // margin
  const cr = size * 0.22; // corner radius
  const hx = (size - 2 * m) / 2;
  const hy = (size - 2 * m) / 2;
  const outerR = size * 0.3;
  const innerR = size * 0.19;
  const accent = [217, 119, 87];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // rounded-rect signed distance for the silhouette
      const qx = Math.abs(x + 0.5 - cx) - (hx - cr);
      const qy = Math.abs(y + 0.5 - cy) - (hy - cr);
      const dx = Math.max(qx, 0);
      const dy = Math.max(qy, 0);
      const sd = Math.hypot(dx, dy) + Math.min(Math.max(qx, qy), 0) - cr;
      const bgA = clamp01(0.5 - sd);

      // white ring
      const dc = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const ringA = Math.min(clamp01(outerR - dc + 0.5), clamp01(dc - innerR + 0.5));

      const r = Math.round(accent[0] * (1 - ringA) + 255 * ringA);
      const g = Math.round(accent[1] * (1 - ringA) + 255 * ringA);
      const b = Math.round(accent[2] * (1 - ringA) + 255 * ringA);
      const i = (y * size + x) * 4;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = Math.round(255 * bgA);
    }
  }
  return px;
}

function ensureTrayIcon(dir) {
  const base = path.join(dir, 'trayTemplate.png');
  const at2x = path.join(dir, 'trayTemplate@2x.png');
  try {
    fs.writeFileSync(base, encodeGA(22, 22, ringPixels(22)));
    fs.writeFileSync(at2x, encodeGA(44, 44, ringPixels(44)));
  } catch {}
  return base;
}

function writeAppIcon(file, size = 512) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeRGBA(size, size, appIconPixels(size)));
  return file;
}

module.exports = { ensureTrayIcon, writeAppIcon, encodeGA, encodeRGBA, ringPixels, appIconPixels };
