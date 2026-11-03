// Real Code 39 bars & ISO/IEC 18004 QR Code SVG, generated locally (no third-party requests or font dependencies).
const PATTERNS = {
  '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn', '4': 'nnnwwnnnw',
  '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw', '8': 'wnnwnnwnn', '9': 'nnwwnnwnn',
  A: 'wnnnnwnnw', B: 'nnwnnwnnw', C: 'wnwnnwnnn', D: 'nnnnwwnnw', E: 'wnnnwwnnn', F: 'nnwnwwnnn',
  G: 'nnnnnwwnw', H: 'wnnnnwwnn', I: 'nnwnnwwnn', J: 'nnnnwwwnn', K: 'wnnnnnnww', L: 'nnwnnnnww',
  M: 'wnwnnnnwn', N: 'nnnnwnnww', O: 'wnnnwnnwn', P: 'nnwnwnnwn', Q: 'nnnnnnwww', R: 'wnnnnnwwn',
  S: 'nnwnnnwwn', T: 'nnnnwnwwn', U: 'wwnnnnnnw', V: 'nwwnnnnnw', W: 'wwwnnnnnn', X: 'nwnnwnnnw',
  Y: 'wwnnwnnnn', Z: 'nwwnwnnnn', '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnnwnn',
  '$': 'nwnwnwnnn', '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
};

export function code39Svg(value, options = {}) {
  const code = String(value).trim().toUpperCase();
  if (!code || code.length > 40 || [...code].some(c => !PATTERNS[c] || c === '*')) {
    throw new Error('ملصق الباركود يدعم حتى 40 حرفاً من الأرقام والحروف الإنجليزية والرموز - . $ / + % والمسافة. عدّل كود الصنف.');
  }
  const barHeight = options.barHeight || 60;
  const showAsterisks = Boolean(options.showAsterisks);
  const hideText = Boolean(options.hideText);
  const label = showAsterisks ? `*${code}*` : code;
  let x = 16;
  const bars = [];
  for (const char of `*${code}*`) {
    [...PATTERNS[char]].forEach((width, index) => {
      const size = width === 'w' ? 5 : 2;
      if (index % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${size}" height="${barHeight}"/>`);
      x += size;
    });
    x += 2;
  }
  const width = x + 16;
  const totalHeight = hideText ? barHeight + 4 : barHeight + 24;
  const textNode = hideText ? '' : `<text x="${width / 2}" y="${barHeight + 19}" text-anchor="middle" font-family="Tahoma, monospace" font-size="14" fill="#000">${label}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${totalHeight}" width="${width}" height="${totalHeight}" style="max-width:100%;height:auto;background:#fff" role="img" aria-label="باركود ${code}"><g fill="#000">${bars.join('')}</g>${textNode}</svg>`;
}

const QR_VERSIONS = [
  { version: 1, size: 21, dataBytes: 19, ecBytes: 7, align: [] },
  { version: 2, size: 25, dataBytes: 34, ecBytes: 10, align: [6, 18] },
  { version: 3, size: 29, dataBytes: 55, ecBytes: 15, align: [6, 22] },
  { version: 4, size: 33, dataBytes: 80, ecBytes: 20, align: [6, 26] },
  { version: 5, size: 37, dataBytes: 108, ecBytes: 26, align: [6, 30] }
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let v = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = v;
    GF_LOG[v] = i;
    v <<= 1;
    if (v & 0x100) v ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function reedSolomonEC(data, ecCount) {
  let gen = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = next;
  }
  const rem = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    for (let j = 0; j < ecCount; j++) rem[j] ^= gfMul(gen[j + 1], factor);
  }
  return rem;
}

export function zatcaQrPayload({ seller = '', vatNo = '', timestamp = '', total = '0.00', tax = '0.00' } = {}) {
  const enc = new TextEncoder();
  const fields = [String(seller).slice(0, 28), String(vatNo).slice(0, 15), String(timestamp).slice(0, 20), String(total), String(tax)];
  const chunks = [];
  fields.forEach((val, idx) => {
    const bytes = enc.encode(val);
    chunks.push(idx + 1, bytes.length, ...bytes);
  });
  let binary = '';
  chunks.forEach(b => { binary += String.fromCharCode(b); });
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(Uint8Array.from(chunks)).toString('base64');
}

export function qrCodeSvg(content, pixelSize = 108) {
  const utf8 = [...new TextEncoder().encode(String(content || 'POS').slice(0, 100))];
  const spec = QR_VERSIONS.find(v => utf8.length + 2 <= v.dataBytes) || QR_VERSIONS[QR_VERSIONS.length - 1];
  const payload = utf8.slice(0, spec.dataBytes - 2);
  const bits = [];
  const pushBits = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  pushBits(0b0100, 4);
  pushBits(payload.length, 8);
  payload.forEach(b => pushBits(b, 8));
  const maxBits = spec.dataBytes * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const data = new Uint8Array(spec.dataBytes);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b];
    data[i] = byte;
  }
  const pads = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < spec.dataBytes; i++, p++) data[i] = pads[p % 2];
  const ec = reedSolomonEC(data, spec.ecBytes);
  const codewords = [...data, ...ec];

  const n = spec.size;
  const grid = Array.from({ length: n }, () => new Int8Array(n));
  const used = Array.from({ length: n }, () => new Uint8Array(n));
  const setModule = (r, c, dark) => {
    if (r >= 0 && r < n && c >= 0 && c < n) { grid[r][c] = dark ? 1 : 0; used[r][c] = 1; }
  };
  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setModule(top + r, left + c, inOuter || inInner);
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, n - 7);
  placeFinder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }
  if (spec.align.length) {
    for (const ar of spec.align) {
      for (const ac of spec.align) {
        if (used[ar][ac]) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            setModule(ar + r, ac + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
          }
        }
      }
    }
  }
  for (let i = 0; i < 9; i++) {
    if (!used[8][i]) used[8][i] = 1;
    if (!used[i][8]) used[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    used[8][n - 1 - i] = 1;
    used[n - 1 - i][8] = 1;
  }
  setModule(n - 8, 8, true);

  const stream = [];
  for (const cw of codewords) for (let b = 7; b >= 0; b--) stream.push((cw >> b) & 1);

  let idx = 0;
  let upward = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      const r = upward ? n - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!used[r][c]) {
          const bit = idx < stream.length ? stream[idx++] : 0;
          grid[r][c] = ((r + c) % 2 === 0 ? bit ^ 1 : bit) ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }

  // Format information: BCH(15,5) for EC level L (01) with mask 0 (000), XOR 101010000010010.
  // Bit 14 is the most significant bit; copy A wraps the top-left finder, copy B splits between the finders.
  let format = (0b01 << 3) | 0b000;
  let bch = format << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >> (10 + i)) & 1) bch ^= 0x537 << i;
  }
  const formatBits = ((format << 10) | bch) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const bit = (formatBits >> i) & 1;
    if (i < 6) grid[i][8] = bit;
    else if (i === 6) grid[7][8] = bit;
    else if (i === 7) grid[8][8] = bit;
    else if (i === 8) grid[8][7] = bit;
    else grid[8][14 - i] = bit;
    if (i < 8) grid[8][n - 1 - i] = bit;
    else grid[n - 15 + i][8] = bit;
  }
  grid[n - 8][8] = 1;

  const quiet = 2;
  const total = n + quiet * 2;
  const rects = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c]) rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" style="background:#fff;display:inline-block" role="img" aria-label="رمز الاستجابة السريعة QR"><g fill="#000">${rects.join('')}</g></svg>`;
}
