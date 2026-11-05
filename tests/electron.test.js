import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// the Electron main process loads this file with require(), so the test does the same
const { createLocalServer, resolveAsset } = createRequire(import.meta.url)('../electron/local-server.js');

const ROOT = new URL('..', import.meta.url).pathname;

test('the desktop server exposes the app bundle and nothing else', async t => {
  const server = await createLocalServer({ root: ROOT, port: 0 });
  t.after(() => server.close());
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<title>/);
  assert.match(html, /app\.js/);

  // what the desktop window loads is exactly the shipped bundle
  const { readFile } = await import('node:fs/promises');
  assert.equal(html, await readFile(new URL('../index.html', import.meta.url), 'utf8'));
  assert.equal(await (await fetch(new URL('app.js', server.url))).text(), await readFile(new URL('../app.js', import.meta.url), 'utf8'));

  // every asset the page needs resolves over the same origin
  for (const [asset, type] of [['app.js', /javascript/], ['lib/finance.js', /javascript/], ['sw.js', /javascript/],
    ['manifest.webmanifest', /manifest/], ['icon-192.png', /image\/png/], ['fonts/cairo-arabic-400-normal.woff2', /woff2/]]) {
    const res = await fetch(new URL(asset, server.url));
    assert.equal(res.status, 200, asset);
    assert.match(res.headers.get('content-type'), type, asset);
  }

  // internal files are never served
  for (const blocked of ['package.json', 'main.js', 'api/sync.js', 'tests/app.test.js', '../package.json', 'node_modules/jsdom/package.json']) {
    const res = await fetch(new URL(blocked, server.url));
    assert.ok([404, 400].includes(res.status), `${blocked} must not be served (got ${res.status})`);
  }
  // unknown paths inside the bundle still 404
  assert.equal((await fetch(new URL('lib/missing.js', server.url))).status, 404);
});

test('the desktop server keeps cloud sync off when no handler is provided', async t => {
  const server = await createLocalServer({ root: ROOT, port: 0 });
  t.after(() => server.close());
  const res = await fetch(new URL('api/sync', server.url), { method: 'POST', body: '{}' });
  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.match((await res.json()).error, /غير متاحة/);
});

test('the desktop server forwards /api/sync to the handler with a parsed body', async t => {
  const calls = [];
  const syncHandler = async (req, res) => {
    calls.push({ method: req.method, body: req.body });
    return res.status(200).json({ ok: true, revision: 7 });
  };
  const server = await createLocalServer({ root: ROOT, port: 0, syncHandler });
  t.after(() => server.close());

  const res = await fetch(new URL('api/sync', server.url), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify({ rev: 3 })
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revision: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { rev: 3 });

  // a plain GET is passed through as well (the handler answers 405 for it)
  await fetch(new URL('api/sync', server.url));
  assert.equal(calls.at(-1).method, 'GET');
});

test('the desktop server rejects oversized sync payloads without dying', async t => {
  const server = await createLocalServer({ root: ROOT, port: 0, syncHandler: async (req, res) => res.status(200).json({ ok: true }) });
  t.after(() => server.close());
  const res = await fetch(new URL('api/sync', server.url), { method: 'POST', body: 'x'.repeat(4 * 1024 * 1024 + 10) });
  assert.equal(res.status, 413);
  // the server is still serving pages afterwards
  assert.equal((await fetch(server.url)).status, 200);
});

test('the asset resolver only maps bundle files', () => {
  assert.equal(resolveAsset('/'), 'index.html');
  assert.equal(resolveAsset('/app.js'), 'app.js');
  assert.equal(resolveAsset('/lib/barcode.js'), 'lib/barcode.js');
  assert.equal(resolveAsset('/fonts/cairo-latin-700-normal.woff2'), 'fonts/cairo-latin-700-normal.woff2');
  assert.equal(resolveAsset('/package.json'), null);
  assert.equal(resolveAsset('/lib/../package.json'), null);
  assert.equal(resolveAsset('/tests/app.test.js'), null);
  assert.equal(resolveAsset('/fonts/../app.js'), null);
});

test('the electron repair script is wired into the package scripts and fails clearly', async t => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['fix:electron'], 'node scripts/fix-electron.js');
  // running the app must verify the runtime first, so the cryptic Electron error never appears alone
  assert.match(pkg.scripts['pre-electron'] || '', /fix-electron\.js --verify/);
  assert.equal(pkg.scripts.electron, 'electron .');
  // the script itself must refuse politely when the package is missing instead of throwing a stack trace
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const result = await run(process.execPath, [new URL('../scripts/fix-electron.js', import.meta.url).pathname], { cwd: '/tmp' })
    .then(out => ({ code: 0, ...out }))
    .catch(error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /node_modules\/electron غير موجود/);
});
