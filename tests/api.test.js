import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncHandler } from '../api/sync.js';
import { emptyDatabase } from '../lib/data.js';

const token = 'test-only-' + 'a'.repeat(40);
function harness({ row = null } = {}) {
  const queries = []; let current = row;
  const sql = async (strings, ...values) => {
    const query = strings.join('?'); queries.push({ query, values });
    if (query.includes('CREATE TABLE') || query.includes('ALTER TABLE')) return [];
    if (query.includes('SELECT')) return current ? [current] : [];
    if (query.includes('INSERT')) {
      if (!current) current = { payload: JSON.parse(values[0]), revision: 1 };
      else if (current.revision === 0) current = { payload: JSON.parse(values[0]), revision: 1 };
      else return [];
      return [{ revision: current.revision }];
    }
    if (query.includes('UPDATE')) {
      if (!current || current.revision !== values[1]) return [];
      current = { payload: JSON.parse(values[0]), revision: current.revision + 1 };
      return [{ revision: current.revision }];
    }
    throw new Error('Unexpected query');
  };
  const handler = createSyncHandler({ sql, token });
  const call = (method = 'GET', body, auth = `Bearer ${token}`) => {
    const response = { code: 200, headers: {}, body: null };
    const res = { setHeader: (key, value) => { response.headers[key] = value; }, status: code => { response.code = code; return res; }, json: data => { response.body = data; return res; } };
    return handler({ method, headers: { authorization: auth, 'content-type': 'application/json' }, body }, res).then(() => response);
  };
  return { call, queries, current: () => current };
}

test('API requires authentication and denies unsupported methods', async () => {
  const h = harness(); assert.equal((await h.call('GET', undefined, '')).code, 401);
  assert.equal((await h.call('GET', undefined, 'Bearer wrong')).code, 401);
  const method = await h.call('DELETE'); assert.equal(method.code, 405); assert.equal(method.headers.Allow, 'GET, POST');
});
test('API initializes schema once, reads empty state and stores a revisioned snapshot', async () => {
  const h = harness(); const empty = await h.call(); assert.equal(empty.body.empty, true); assert.equal(empty.headers['Cache-Control'], 'no-store');
  const payload = emptyDatabase(); const first = await h.call('POST', { payload, baseRevision: 0 });
  assert.equal(first.code, 200); assert.equal(first.body.revision, 1);
  const read = await h.call(); assert.deepEqual(read.body.payload, payload); assert.equal(read.body.revision, 1);
  const second = await h.call('POST', { payload, baseRevision: 1 }); assert.equal(second.body.revision, 2);
  assert.equal(h.queries.filter(q => q.query.includes('CREATE TABLE')).length, 1);
  assert.match(h.queries.find(q => q.query.trim().startsWith('UPDATE')).query, /WHERE id = 1 AND revision/);
});
test('stale device gets 409 and cannot overwrite a newer snapshot', async () => {
  const h = harness(); const payload = emptyDatabase(); await h.call('POST', { payload, baseRevision: 0 });
  payload.settings.name = 'Old device'; const stale = await h.call('POST', { payload, baseRevision: 0 });
  assert.equal(stale.code, 409); assert.notEqual(h.current().payload.settings.name, 'Old device'); assert.equal(h.current().revision, 1);
});
test('API validates JSON, revision, schema and financial consistency', async () => {
  const h = harness();
  assert.equal((await h.call('POST', '{bad')).code, 400);
  assert.equal((await h.call('POST', { payload: emptyDatabase(), baseRevision: -1 })).code, 400);
  assert.equal((await h.call('POST', { payload: { items: [] }, baseRevision: 0 })).code, 400);
  const db = emptyDatabase(); db.treasury = [{ id: 1, date: '2026-11-03', type: 'in', amount: -5, note: 'bad' }];
  assert.equal((await h.call('POST', { payload: db, baseRevision: 0 })).code, 400);
});
test('API hides internal database error details', async () => {
  const handler = createSyncHandler({ token, sql: async () => { throw new Error('postgres://secret-password@example/db'); } });
  const result = { code: 0, body: null };
  const res = { setHeader() {}, status(code) { result.code = code; return this; }, json(body) { result.body = body; return this; } };
  const original = console.error; console.error = () => {};
  try { await handler({ method: 'GET', headers: { authorization: `Bearer ${token}` } }, res); } finally { console.error = original; }
  assert.equal(result.code, 500); assert.doesNotMatch(JSON.stringify(result.body), /secret-password/);
});
test('API fails closed when server token is absent or too short', async () => {
  const handler = createSyncHandler({ token: '', sql: async () => [] });
  let code;
  await handler({ method: 'GET', headers: {} }, { setHeader() {}, status(value) { code = value; return this; }, json() { return this; } });
  assert.equal(code, 503);
});

test('oversized payloads and wrong content types are rejected', async () => {
  const h = harness();
  const response = await h.call('POST', JSON.stringify({ payload: 'x'.repeat(4 * 1024 * 1024), baseRevision: 0 }));
  assert.equal(response.code, 413);
  let code;
  const res = { setHeader() {}, status(value) { code = value; return this; }, json() { return this; } };
  await createSyncHandler({ sql: async () => [], token })({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, body: '{}' }, res);
  assert.equal(code, 415);
});
