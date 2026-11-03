import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: 'DATABASE_URL غير موجود في إعدادات Vercel' });
    }

    const sql = neon(process.env.DATABASE_URL);

    // إنشاء الجدول تلقائياً في Neon لو مش موجود
    await sql`
      CREATE TABLE IF NOT EXISTS pos_store (
        id INT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;

    // حفظ ورفع البيانات إلى Neon
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await sql`
        INSERT INTO pos_store (id, payload, updated_at)
        VALUES (1, ${JSON.stringify(body)}::jsonb, NOW())
        ON CONFLICT (id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = NOW();
      `;
      return res.status(200).json({ ok: true });
    }

    // سحب البيانات من Neon للكمبيوتر أو الموبايل
    if (req.method === 'GET') {
      const rows = await sql`SELECT payload FROM pos_store WHERE id = 1;`;
      if (rows.length > 0) {
        return res.status(200).json(rows[0].payload);
      }
      return res.status(200).json({ empty: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
