import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/sync.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/lib/finance.js', ['lib/finance.js', 'text/javascript; charset=utf-8']],
  ['/lib/data.js', ['lib/data.js', 'text/javascript; charset=utf-8']],
  ['/lib/barcode.js', ['lib/barcode.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/icon-maskable-512.png', ['icon-maskable-512.png', 'image/png']],
  ['/fonts/cairo-arabic-400-normal.woff2', ['fonts/cairo-arabic-400-normal.woff2', 'font/woff2']],
  ['/fonts/cairo-arabic-700-normal.woff2', ['fonts/cairo-arabic-700-normal.woff2', 'font/woff2']],
  ['/fonts/cairo-latin-400-normal.woff2', ['fonts/cairo-latin-400-normal.woff2', 'font/woff2']],
  ['/fonts/cairo-latin-700-normal.woff2', ['fonts/cairo-latin-700-normal.woff2', 'font/woff2']]
]);
const server = createServer(async (req, res) => {
  res.status = code => { res.statusCode = code; return res; };
  res.json = data => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); return res; };
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/api/sync') {
      if (req.method !== 'POST') return await handler(req, res);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) return res.status(413).json({ error: 'حجم الطلب أكبر من الحد المسموح.' });
        chunks.push(chunk);
      }
      req.body = Buffer.concat(chunks).toString('utf8');
      return await handler(req, res);
    }
    if (pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
    const file = files.get(pathname);
    if (!file || !['GET', 'HEAD'].includes(req.method)) { res.statusCode = 404; return res.end('Not found'); }
    const content = await readFile(path.join(root, file[0]));
    res.setHeader('Content-Type', file[1]); res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error('Local preview request failed:', error.name || 'Error');
    if (!res.headersSent) res.status(500).json({ error: 'تعذر تحميل الصفحة.' });
    else res.end();
  }
});
const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => console.log(`POS preview ready on http://0.0.0.0:${port}. Local data works without Neon; cloud sync requires DATABASE_URL and SYNC_TOKEN.`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
