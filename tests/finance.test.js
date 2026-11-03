import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTotals, invoiceLines, weightedAverageCost, localDate, nextId, roundQuantity } from '../lib/finance.js';
import { emptyDatabase, normalizeDatabase, returnedQuantity } from '../lib/data.js';
import { code39Svg } from '../lib/barcode.js';

const line = (overrides = {}) => ({ id: 1, code: '1001', name: 'كتاب', qty: 2, price: 100, discPct: 10, buyCost: 60, ...overrides });
const invoice = (mode, items, overrides = {}) => {
  const totals = calculateTotals(items);
  return { id: 1, date: '2026-11-03', time: '12:00', mode, partyId: 1, partyName: 'عميل', prevBalance: 0,
    ...totals, paidAmount: totals.netTotal, remainAmount: 0, newBalance: 0, items: totals.items, ...overrides };
};
test('invoice discount is allocated exactly and survives normalization', () => {
  const totals = calculateTotals([line(), line({ id: 2, qty: 1, price: 50, discPct: 0 })], 20, 10);
  assert.equal(totals.subtotal, 230); assert.equal(totals.discountTotal, 43); assert.equal(totals.netTotal, 187);
  assert.equal(totals.items.reduce((s, c) => s + c.netTotal, 0), 187);
  const normalized = normalizeDatabase({ ...emptyDatabase(), invoices: [invoice('sale', [line(), line({ id: 2, qty: 1, price: 50, discPct: 0 })], { ...totals, discountAmount: 20, discountPct: 10, netTotal: 187, paidAmount: 187 })] });
  assert.equal(invoiceLines(normalized.invoices[0]).reduce((s, c) => s + c.netTotal, 0), 187);
});
test('largest remainder allocation handles zero-value lines and exact cents', () => {
  const line = (id, qty, price) => ({ id, code: String(id), name: 'صنف', qty, price, discPct: 0, buyCost: 0 });
  const totals = calculateTotals([line(1, 1, 0.01), line(2, 1, 0.01), line(3, 1, 0), line(4, 1, 0.01)], 0.01);
  assert.equal(totals.netTotal, 0.02);
  assert.equal(totals.items.reduce((s, c) => s + c.netTotal, 0), 0.02);
  assert.ok(totals.items.every(c => c.netTotal >= 0));
  assert.equal(totals.items[2].netTotal, 0);
});
test('invalid quantities, prices, discounts and excess discount are rejected', () => {
  for (const change of [{ qty: 0 }, { qty: -1 }, { qty: NaN }, { price: -1 }, { price: Infinity }, { discPct: 101 }, { discPct: -1 }, { buyCost: -1 }]) assert.throws(() => calculateTotals([line(change)]));
  assert.throws(() => calculateTotals([line()], 1000));
  assert.throws(() => calculateTotals([line()], -1));
  assert.throws(() => calculateTotals([line()], 0, 101));
  assert.throws(() => calculateTotals([]));
});
test('weighted purchase cost includes discounts; returns do not use this recalculation', () => {
  assert.equal(weightedAverageCost(10, 100, 10, 80), 90);
  assert.equal(weightedAverageCost(0, 100, 5, 80), 80);
  assert.equal(roundQuantity(0.1 + 0.2), 0.3);
  assert.equal(localDate(new Date(2026, 10, 3, 0, 10)), '2026-11-03');
  assert.equal(nextId([{ id: 4 }, { id: 9 }]), 10);
});
test('backup validation rejects missing sections, duplicate IDs/codes and inconsistent money', () => {
  assert.throws(() => normalizeDatabase({ items: [] }));
  const db = emptyDatabase(); db.items = [{ id: 1, code: 'A', name: 'كتاب', cat: 'كتب', qty: 1, minQty: 0, buy: 1, sell: 2, wholesale: 2, minSell: 0 }];
  db.items.push({ ...db.items[0], code: 'a' }); assert.throws(() => normalizeDatabase(db), /مكررة/);
  db.items[1].code = 'B'; db.items[1].id = 1; assert.throws(() => normalizeDatabase(db), /مكررة/);
  db.items.pop(); db.invoices = [invoice('sale', [line()], { paidAmount: 200 })]; assert.throws(() => normalizeDatabase(db));
  db.invoices[0].date = '2026-02-30'; assert.throws(() => normalizeDatabase(db));
});
test('legacy database and quote payment display remain compatible', () => {
  const db = emptyDatabase(); db.invoices = [invoice('quote', [line()], { paidAmount: 180 })];
  const normalized = normalizeDatabase(db);
  assert.equal(normalized.invoices[0].paidAmount, 0);
  assert.equal(normalized.invoices[0].remainAmount, 0);
  assert.equal(invoiceLines(normalized.invoices[0])[0].netTotal, 180);
});
test('partial returns accumulate by original invoice and item', () => {
  const original = invoice('sale', [line()]);
  const returned = invoice('sale_return', [line({ qty: 0.25 })], { id: 2, sourceId: 1 });
  const db = { ...emptyDatabase(), invoices: [original, returned] };
  assert.equal(returnedQuantity(db.invoices, 1, 1), 0.25);
  assert.equal(returnedQuantity(db.invoices, 1, 999), 0);
  const bad = { ...db, invoices: [original, { ...returned, sourceId: 999 }] };
  assert.throws(() => normalizeDatabase(bad), /الأصلية/);
});
test('Code39 has start/stop bars and rejects unsupported input', () => {
  const svg = code39Svg('a-123');
  assert.match(svg, /^<svg/); assert.match(svg, /A-123/); assert.ok((svg.match(/<rect /g) || []).length > 30);
  assert.throws(() => code39Svg('كتاب')); assert.throws(() => code39Svg('A*B')); assert.throws(() => code39Svg('A'.repeat(41)));
});

test('strict validation rejects inconsistent line totals and excessive partial returns', () => {
  const db = { ...emptyDatabase(), invoices: [invoice('sale', [line()])] };
  db.invoices[0].items[0].netTotal = 1;
  assert.throws(() => normalizeDatabase(db), /مجموع/);
  db.invoices[0].items[0].netTotal = 180;
  db.invoices.push(invoice('sale_return', [line({ qty: 3 })], { id: 2, sourceId: 1 }));
  assert.throws(() => normalizeDatabase(db), /كمية المرتجع/);
});
