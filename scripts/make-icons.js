// Generates the PWA PNG icons locally (no image libraries or network needed).
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buffer => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
function icon(size, maskable) {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = maskable ? size : Math.round(size * 0.22);
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  const cardHalfW = size * 0.30, cardHalfH = size * 0.22, cardY = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inside(x, y)) { pixels[i + 3] = 0; continue; }
      // navy → cyan diagonal gradient
      const t = (x + y) / (2 * size);
      let r = Math.round(10 + (15 - 10) * t), g = Math.round(26 + (124 - 26) * t), b = Math.round(60 + (147 - 60) * t);
      // book glyph: pale pages + spine + lines
      const dx = Math.abs(x - size / 2), dy = Math.abs(y - cardY);
      if (dx < cardHalfW && dy < cardHalfH) { r = 246; g = 250; b = 255; }
      if (dx < cardHalfW * 0.10 && dy < cardHalfH) { r = 124; g = 230; b = 255; }
      else if (dx < cardHalfW * 0.62 && dy < cardHalfH * 0.62 && dy > cardHalfH * 0.18) { r = 190; g = 214; b = 232; }
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
await mkdir(root, { recursive: true });
await writeFile(path.join(root, 'icon-192.png'), icon(192, false));
await writeFile(path.join(root, 'icon-512.png'), icon(512, false));
await writeFile(path.join(root, 'icon-maskable-512.png'), icon(512, true));
console.log('PWA icons generated.');
