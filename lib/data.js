import { INVOICE_MODES, roundQuantity, roundMoney, invoiceLines, lineGross } from './finance.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '') => typeof value === 'string' ? value.trim() : fallback;
const number = (value, label, { min = -Number.MAX_SAFE_INTEGER, fallback } = {}) => {
  const result = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > Number.MAX_SAFE_INTEGER) throw new Error(`${label}: قيمة رقمية غير صالحة.`);
  return result;
};
const id = (value, label) => {
  const result = number(value, label, { min: 1 });
  if (!Number.isSafeInteger(result)) throw new Error(`${label}: المعرّف يجب أن يكون عدداً صحيحاً.`);
  return result;
};
const date = (value, label) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${label}: التاريخ غير صالح.`);
  return value;
};
const unique = (values, label) => {
  if (new Set(values).size !== values.length) throw new Error(`${label}: توجد قيم مكررة.`);
};
const array = (value, label) => {
  if (!Array.isArray(value) || value.length > 100000) throw new Error(`${label}: قائمة غير صالحة.`);
  return value;
};
export const DEFAULT_SETTINGS = Object.freeze({
  name: 'مكتبة الجمال',
  address: 'العنوان: الشارع الرئيسي - بجوار المدرسة', phone: '01000000000', pin: '1234'
});
export function emptyDatabase() {
  return {
    settings: { ...DEFAULT_SETTINGS },
    categories: ['كتب خارجية', 'كشاكيل وكراسات', 'أقلام وأدوات كتابة', 'هدايا وألعاب', 'أدوات هندسية وفنية'],
    items: [], parties: [{ id: 1, type: 'customer', name: 'عميل نقدي', phone: '', balance: 0, notes: 'افتراضي' }],
    invoices: [], treasury: []
  };
}
export function normalizeDatabase(input, { strict = true } = {}) {
  if (!object(input)) throw new Error('الملف لا يحتوي على بيانات البرنامج.');
  for (const key of ['categories', 'items', 'parties', 'invoices', 'treasury']) array(input[key], key);
  if (!object(input.settings)) throw new Error('بيانات المنشأة غير صالحة.');
  const settings = {
    name: text(input.settings.name, DEFAULT_SETTINGS.name), address: text(input.settings.address),
    phone: text(input.settings.phone), pin: text(input.settings.pin, '1234') || '1234'
  };
  if (!settings.name) throw new Error('اسم المنشأة مطلوب.');
  const categories = array(input.categories, 'المجموعات').map(c => {
    if (typeof c !== 'string' || !c.trim()) throw new Error('اسم المجموعة غير صالح.');
    return c.trim();
  });
  unique(categories.map(c => c.toLocaleLowerCase()), 'المجموعات');
  const items = input.items.map(i => {
    if (!object(i)) throw new Error('بيانات صنف غير صالحة.');
    const item = {
      id: id(i.id, 'الصنف'), code: text(String(i.code ?? '')), name: text(i.name), cat: text(i.cat),
      type: text(i.type, 'عام'), warehouse: text(i.warehouse, 'الرئيسي'), unit: text(i.unit, 'عدد'),
      qty: number(i.qty, 'رصيد الصنف'), minQty: number(i.minQty, 'حد الطلب', { min: 0 }),
      buy: number(i.buy, 'سعر الشراء', { min: 0 }), profitPct: number(i.profitPct, 'نسبة الربح', { fallback: 0 }),
      sell: number(i.sell, 'سعر البيع', { min: 0 }), wholesale: number(i.wholesale, 'سعر الجملة', { min: 0 }),
      minSell: number(i.minSell, 'الحد الأدنى للبيع', { min: 0 }), notes: text(i.notes)
    };
    if (!item.code || !item.name || !item.cat) throw new Error('كود الصنف واسمه ومجموعته مطلوبة.');
    if (!categories.includes(item.cat)) categories.push(item.cat);
    return item;
  });
  unique(items.map(i => i.id), 'معرّفات الأصناف');
  if (strict) unique(items.map(i => i.code.toLocaleLowerCase()), 'أكواد الأصناف');
  const parties = input.parties.map(p => {
    if (!object(p) || !['customer', 'supplier'].includes(p.type) || !text(p.name)) throw new Error('بيانات العملاء أو الموردين غير صالحة.');
    return { id: id(p.id, 'الحساب'), type: p.type, name: text(p.name), phone: text(p.phone), balance: number(p.balance, 'رصيد الحساب'), notes: text(p.notes) };
  });
  unique(parties.map(p => p.id), 'معرّفات الحسابات');
  const invoices = input.invoices.map(inv => {
    if (!object(inv) || !INVOICE_MODES.includes(inv.mode)) throw new Error('نوع الفاتورة غير صالح.');
    const lines = array(inv.items, 'أصناف الفاتورة');
    if (!lines.length) throw new Error('الفاتورة لا تحتوي على أصناف.');
    const result = {
      id: id(inv.id, 'الفاتورة'), date: date(inv.date, 'الفاتورة'), time: text(inv.time), mode: inv.mode,
      partyId: inv.partyId == null || inv.partyId === 0 ? 0 : id(inv.partyId, 'حساب الفاتورة'),
      partyName: text(inv.partyName, 'عميل نقدي'), prevBalance: number(inv.prevBalance, 'الرصيد السابق', { fallback: 0 }),
      netTotal: number(inv.netTotal, 'صافي الفاتورة', { min: 0 }), paidAmount: number(inv.paidAmount, 'المدفوع', { min: 0 }),
      remainAmount: number(inv.remainAmount, 'المتبقي', { min: 0 }), newBalance: number(inv.newBalance, 'الرصيد الحالي', { fallback: 0 }),
      items: lines.map(c => {
        if (!object(c) || !text(c.name)) throw new Error('بيانات صنف الفاتورة غير صالحة.');
        const line = {
          id: id(c.id, 'صنف الفاتورة'), code: text(String(c.code ?? '')), name: text(c.name),
          qty: number(c.qty, 'كمية الفاتورة', { min: Number.EPSILON }), price: number(c.price, 'سعر الفاتورة', { min: 0 }),
          discPct: number(c.discPct, 'خصم الصنف', { min: 0, fallback: 0 }), buyCost: number(c.buyCost, 'تكلفة الصنف', { min: 0, fallback: 0 }),
          minSell: number(c.minSell, 'الحد الأدنى للبيع', { min: 0, fallback: 0 })
        };
        if (line.discPct > 100) throw new Error('خصم الصنف أكبر من 100%.');
        if (c.netTotal !== undefined) line.netTotal = number(c.netTotal, 'صنف الفاتورة بعد الخصم', { min: 0 });
        if (c.grossTotal !== undefined) line.grossTotal = number(c.grossTotal, 'إجمالي الصنف', { min: 0 });
        return line;
      })
    };
    // Quotes have a value, but no payment or receivable. Older versions displayed a notional cash payment.
    if (inv.mode === 'quote') { result.paidAmount = 0; result.remainAmount = 0; }
    else if (result.paidAmount > result.netTotal || Math.abs(result.netTotal - result.paidAmount - result.remainAmount) > 0.011) throw new Error('المدفوع والمتبقي لا يتطابقان مع صافي الفاتورة.');
    if (inv.store && object(inv.store)) result.store = { name: text(inv.store.name), address: text(inv.store.address), phone: text(inv.store.phone) };
    if (inv.sourceId != null) result.sourceId = id(inv.sourceId, 'الفاتورة الأصلية');
    if (inv.quoteId != null) result.quoteId = id(inv.quoteId, 'عرض السعر');
    if (inv.convertedToId != null) result.convertedToId = id(inv.convertedToId, 'فاتورة التحويل');
    for (const key of ['subtotal', 'discountAmount', 'discountPct', 'discountTotal']) if (inv[key] !== undefined) result[key] = number(inv[key], key, { min: 0 });
    unique(result.items.map(c => c.id), 'أصناف الفاتورة');
    return result;
  });
  unique(invoices.map(i => i.id), 'أرقام الفواتير');
  if (strict) {
    for (const inv of invoices) {
      const lines = invoiceLines(inv);
      if (Math.abs(roundMoney(lines.reduce((sum, c) => sum + c.netTotal, 0)) - inv.netTotal) > 0.011) throw new Error('مجموع أصناف الفاتورة لا يساوي صافيها.');
      if (lines.some(c => c.netTotal > lineGross(c) + 0.011)) throw new Error('صنف الفاتورة بعد الخصم أكبر من إجماليه.');
      if (inv.sourceId) {
        const source = invoices.find(i => i.id === inv.sourceId);
        const expected = inv.mode === 'sale_return' ? 'sale' : 'purchase';
        if (!source || source.mode !== expected || source.partyId !== inv.partyId) throw new Error('الفاتورة الأصلية للمرتجع غير صالحة.');
        for (const line of inv.items) {
          const original = source.items.find(c => c.id === line.id);
          if (!original || line.qty > original.qty - returnedQuantity(invoices.filter(i => i.id !== inv.id), source.id, line.id) + 0.000001) throw new Error('كمية المرتجع أكبر من أصل الفاتورة.');
        }
      }
    }
  }
  const treasury = input.treasury.map(t => {
    if (!object(t) || !['in', 'out', 'expense'].includes(t.type)) throw new Error('نوع حركة الخزنة غير صالح.');
    const move = { id: id(t.id, 'حركة الخزنة'), date: date(t.date, 'الخزنة'), type: t.type,
      amount: number(t.amount, 'مبلغ الخزنة', { min: Number.EPSILON }), note: text(t.note) };
    if (t.partyId != null) move.partyId = id(t.partyId, 'حساب السند');
    if (t.invoiceId != null) move.invoiceId = id(t.invoiceId, 'فاتورة السند');
    return move;
  });
  unique(treasury.map(t => t.id), 'معرّفات حركات الخزنة');
  return { settings, categories, items, parties, invoices, treasury };
}
export function returnedQuantity(invoices, sourceId, itemId) {
  return roundQuantity(invoices.filter(inv => inv.sourceId === sourceId && ['sale_return', 'purchase_return'].includes(inv.mode))
    .reduce((sum, inv) => sum + inv.items.filter(c => c.id === itemId).reduce((n, c) => n + c.qty, 0), 0));
}
