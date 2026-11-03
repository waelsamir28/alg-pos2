export const INVOICE_MODES = Object.freeze(['sale', 'sale_return', 'purchase', 'purchase_return', 'quote']);
export const MODE_LABELS = Object.freeze({
  sale: 'فاتورة مبيعات', sale_return: 'مرتجع مبيعات', purchase: 'فاتورة مشتريات',
  purchase_return: 'مرتجع مشتريات', quote: 'عرض أسعار'
});
export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
export function roundQuantity(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
}
export function lineGross(line) {
  if (Number.isFinite(line.returnNetTotal)) return roundMoney(line.returnNetTotal);
  return roundMoney(line.qty * line.price * (1 - (line.discPct || 0) / 100));
}
// Largest-remainder allocation in integer cents. Preserve the exact total without negative lines.
export function allocateTotals(lines, netTotal) {
  const gross = lines.map(lineGross);
  const netCents = Math.round(netTotal * 100);
  const grossCents = gross.map(value => Math.round(value * 100));
  const totalCents = grossCents.reduce((sum, value) => sum + value, 0);
  const shares = grossCents.map((cents, index) => {
    const numerator = BigInt(netCents) * BigInt(cents);
    return { index, cents: totalCents ? Number(numerator / BigInt(totalCents)) : 0, remainder: totalCents ? numerator % BigInt(totalCents) : 0n };
  });
  let remaining = netCents - shares.reduce((sum, share) => sum + share.cents, 0);
  const ordered = shares.filter(s => grossCents[s.index] > 0).sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const share of ordered) { if (remaining <= 0) break; share.cents += 1; remaining -= 1; }
  return lines.map((line, index) => ({ ...line, grossTotal: gross[index], netTotal: shares[index].cents / 100 }));
}
export function calculateTotals(lines, discountAmount = 0, discountPct = 0) {
  if (!Array.isArray(lines) || !lines.length) throw new Error('أضف صنفاً واحداً على الأقل.');
  for (const line of lines) {
    if (!Number.isFinite(line.qty) || line.qty <= 0) throw new Error(`كمية «${line.name}» يجب أن تكون أكبر من صفر.`);
    if (!Number.isFinite(line.price) || line.price < 0) throw new Error(`سعر «${line.name}» غير صالح.`);
    if (!Number.isFinite(line.discPct || 0) || line.discPct < 0 || line.discPct > 100) throw new Error(`نسبة خصم «${line.name}» يجب أن تكون بين 0 و100.`);
    if (!Number.isFinite(line.buyCost) || line.buyCost < 0) throw new Error(`تكلفة «${line.name}» غير صالحة.`);
  }
  if (!Number.isFinite(discountAmount) || discountAmount < 0 || !Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    throw new Error('الخصم الإضافي يجب أن يكون موجباً، والنسبة بين 0 و100.');
  }
  const subtotal = roundMoney(lines.reduce((sum, line) => sum + lineGross(line), 0));
  const discount = roundMoney(discountAmount + subtotal * discountPct / 100);
  if (discount > subtotal) throw new Error('إجمالي الخصم أكبر من قيمة الفاتورة.');
  const netTotal = roundMoney(subtotal - discount);
  return { subtotal, discountAmount: roundMoney(discountAmount), discountPct, discountTotal: discount, netTotal,
    items: allocateTotals(lines, netTotal) };
}
export function invoiceLines(invoice) {
  if (invoice.items.every(line => Number.isFinite(line.netTotal))) return invoice.items;
  return allocateTotals(invoice.items, invoice.netTotal);
}
export function weightedAverageCost(oldQty, oldCost, addedQty, addedUnitCost) {
  const stock = Math.max(0, oldQty);
  return roundMoney((stock * oldCost + addedQty * addedUnitCost) / (stock + addedQty));
}
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function nextId(records) {
  return records.reduce((max, record) => Math.max(max, Number(record.id) || 0), 0) + 1;
}
