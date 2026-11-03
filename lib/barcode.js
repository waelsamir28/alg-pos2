// Real Code 39 bars, generated locally (no third-party requests or font dependencies).
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
export function code39Svg(value) {
  const code = String(value).trim().toUpperCase();
  if (!code || code.length > 40 || [...code].some(c => !PATTERNS[c] || c === '*')) throw new Error('ملصق الباركود يدعم حتى 40 حرفاً من الأرقام والحروف الإنجليزية والرموز - . $ / + % والمسافة. عدّل كود الصنف.');
  let x = 20;
  const bars = [];
  for (const char of `*${code}*`) {
    [...PATTERNS[char]].forEach((width, index) => {
      const size = width === 'w' ? 5 : 2;
      if (index % 2 === 0) bars.push(`<rect x="${x}" y="0" width="${size}" height="60"/>`);
      x += size;
    });
    x += 2;
  }
  const width = x + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 84" width="${width}" height="84" style="max-width:100%;height:auto;background:#fff" role="img" aria-label="باركود ${code}"><g fill="#000">${bars.join('')}</g><text x="${width / 2}" y="80" text-anchor="middle" font-family="monospace" font-size="14" fill="#000">${code}</text></svg>`;
}
