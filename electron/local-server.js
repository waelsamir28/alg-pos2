/**
 * Local HTTP server for the desktop build.
 *
 * Electron would load `file://` URLs, where the app's root-absolute paths (/app.js, /lib/…,
 * /api/sync) and a stable localStorage origin both break. Serving the same bundle over a
 * loopback origin keeps browser behaviour identical to the web build — including one persistent
 * localStorage database between launches, which is why the port is fixed.
 *
 * ES module, like the rest of this package (`"type": "module"`), so the Electron main process
 * can import it directly.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PORT = 41730;
const MAX_PORT_TRIES = 6;
const MAX_BYTES = 4 * 1024 * 1024;
const PUBLIC_FILES = new Set([
  'index.html',
  'app.js',
  'sw.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png'
]);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
};

/** Only the app bundle is reachable: no traversal, no package.json, no source folders. */
export function resolveAsset(pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null; // malformed escape sequence
  }
  if (!rel || rel.includes('..') || path.isAbsolute(rel)) return null;
  if (PUBLIC_FILES.has(rel)) return rel;
  if (/^(lib|fonts)\/[A-Za-z0-9._-]+$/.test(rel)) return rel;
  return null;
}

async function readBody(req, limit = MAX_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Payload too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listen(instance, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      instance.removeListener('error', onError);
      reject(error);
    };
    instance.once('error', onError);
    instance.listen(port, '127.0.0.1', () => {
      instance.removeListener('error', onError);
      resolve(instance.address().port);
    });
  });
}

/**
 * @param {{ root: string, port?: number, syncHandler?: Function|null }} options
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function createLocalServer({ root, port = DEFAULT_PORT, syncHandler = null } = {}) {
  if (!root) throw new Error('root is required');
  const instance = createServer(async (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = data => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data));
      return res;
    };
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/api/sync') {
        if (!syncHandler) return res.status(503).json({ error: 'المزامنة السحابية غير متاحة في نسخة سطح المكتب.' });
        if (req.method !== 'POST') return await syncHandler(req, res);
        req.body = await readBody(req);
        return await syncHandler(req, res);
      }
      if (pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }
      const asset = resolveAsset(pathname);
      if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.statusCode = 404; return res.end('Not found'); }
      const content = await readFile(path.join(root, asset));
      res.setHeader('Content-Type', MIME[path.extname(asset).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      const code = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : (error.status || 500);
      if (!res.headersSent) res.status(code).json({ error: code === 404 ? 'Not found' : 'تعذر تحميل الصفحة.' });
      else res.end();
    }
  });

  // A stable port keeps the localStorage database across launches; if it is taken by another
  // copy, walk forward instead of crashing (the window still opens, on a fresh origin).
  let bound = null;
  let lastError = null;
  for (let offset = 0; offset < MAX_PORT_TRIES; offset += 1) {
    try {
      bound = await listen(instance, port + offset);
      break;
    } catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  if (!bound) {
    const error = new Error(`لا يوجد منفذ محلي متاح (${port}-${port + MAX_PORT_TRIES - 1}).`);
    error.code = lastError?.code || 'EADDRINUSE';
    throw error;
  }

  return {
    url: `http://127.0.0.1:${bound}/`,
    port: bound,
    close: () => new Promise(resolve => instance.close(() => resolve()))
  };
}
