import { createHash, timingSafeEqual } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { normalizeDatabase } from '../lib/data.js';

const MAX_BYTES = 4 * 1024 * 1024;
let sqlClient;
let databaseUrl;
const schemaPromises = new WeakMap();
const digest = value => createHash('sha256').update(value).digest();
function authorized(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(token));
}
function getSql() {
  const url = process.env.DATABASE_URL;
  if (!url) { const error = new Error('إعداد DATABASE_URL غير موجود على الخادم.'); error.status = 503; throw error; }
  if (url !== databaseUrl) { databaseUrl = url; sqlClient = neon(url); }
  return sqlClient;
}
async function ensureSchema(sql) {
  if (!schemaPromises.has(sql)) {
    const ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS pos_store (
        id INT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        revision BIGINT NOT NULL DEFAULT 0
      )`;
      // Preserve existing installations and their payloads while adding optimistic concurrency.
      await sql`ALTER TABLE pos_store ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0`;
    })().catch(error => { schemaPromises.delete(sql); throw error; });
    schemaPromises.set(sql, ready);
  }
  return schemaPromises.get(sql);
}
export function createSyncHandler({ sql, token }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ error: 'طريقة الطلب غير مسموحة.' });
      }
      if (typeof token !== 'string' || token.length < 32) return res.status(503).json({ error: 'المزامنة غير مهيأة: أضف SYNC_TOKEN عشوائياً بطول 32 حرفاً على الأقل في إعدادات الخادم.' });
      if (!authorized(req.headers?.authorization, token)) return res.status(401).json({ error: 'مفتاح المزامنة غير صحيح.' });
      await ensureSchema(sql);
      if (req.method === 'GET') {
        const rows = await sql`SELECT payload, revision, updated_at FROM pos_store WHERE id = 1`;
        if (!rows.length) return res.status(200).json({ empty: true, revision: 0 });
        return res.status(200).json({ payload: rows[0].payload, revision: Number(rows[0].revision), updatedAt: rows[0].updated_at });
      }
      if (!String(req.headers?.['content-type'] || '').toLowerCase().startsWith('application/json')) return res.status(415).json({ error: 'أرسل البيانات بصيغة application/json.' });
      let body = req.body;
      if (Buffer.isBuffer(body)) body = body.toString('utf8');
      if (typeof body === 'string') {
        if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) return res.status(413).json({ error: 'حجم البيانات أكبر من 4 ميجابايت.' });
        try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'صيغة JSON غير صالحة.' }); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'بيانات المزامنة غير صالحة.' });
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BYTES) return res.status(413).json({ error: 'حجم البيانات أكبر من 4 ميجابايت.' });
      const { payload, baseRevision } = body;
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision >= Number.MAX_SAFE_INTEGER) return res.status(400).json({ error: 'رقم نسخة المزامنة غير صالح.' });
      let normalized;
      try { normalized = normalizeDatabase(payload); } catch (error) { return res.status(400).json({ error: `بيانات غير صالحة: ${error.message}` }); }
      const json = JSON.stringify(normalized);
      // Compare-and-swap is one atomic SQL statement. Two devices cannot silently overwrite each other.
      const rows = baseRevision === 0
        ? await sql`INSERT INTO pos_store (id, payload, revision, updated_at)
            VALUES (1, ${json}::jsonb, 1, NOW())
            ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, revision = pos_store.revision + 1, updated_at = NOW()
            WHERE pos_store.revision = 0 RETURNING revision`
        : await sql`UPDATE pos_store SET payload = ${json}::jsonb, revision = revision + 1, updated_at = NOW()
            WHERE id = 1 AND revision = ${baseRevision} RETURNING revision`;
      if (!rows.length) return res.status(409).json({ error: 'النسخة السحابية تغيرت منذ آخر مزامنة. لم تُستبدل البيانات؛ اسحب النسخة الأحدث أولاً.' });
      return res.status(200).json({ ok: true, revision: Number(rows[0].revision) });
    } catch (error) {
      // Do not disclose connection strings, SQL details, or provider errors to browsers.
      console.error('POS sync failed:', error.name || 'Error');
      return res.status(error.status || 500).json({ error: error.status ? error.message : 'تعذر إكمال المزامنة على الخادم. البيانات المحلية لم تُحذف. راجع إعدادات قاعدة البيانات وسجلات الخادم.' });
    }
  };
}
export default async function handler(req, res) {
  const token = process.env.SYNC_TOKEN;
  if (typeof token !== 'string' || token.length < 32) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'أضف SYNC_TOKEN عشوائياً بطول 32 حرفاً على الأقل في إعدادات Vercel لحماية المزامنة.' });
  }
  try { return await createSyncHandler({ sql: getSql(), token })(req, res); }
  catch (error) { res.setHeader('Cache-Control', 'no-store'); return res.status(503).json({ error: error.message }); }
}
