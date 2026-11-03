import nodeTest from 'node:test';
let queue = Promise.resolve();
const test = (name, fn) => nodeTest(name, t => { const run = queue.then(() => fn(t)); queue = run.catch(() => {}); return run; });
import assert from 'node:assert/strict';
import { fixture, seedDatabase, addLine, backupObject, blobText, DB_KEY, META_KEY, TOKEN_KEY } from './helpers.js';
import { localDate } from '../lib/finance.js';
import { File as NodeFile } from 'node:buffer';

async function ready(t, options) { const f = fixture(t, options); await f.load(); return f; }

test('initial screen is empty, offline-safe and all navigation buttons have implementations', async t => {
  const f = await ready(t);
  assert.equal(f.$('kpiCash').textContent, '0.00'); assert.equal(f.$('itemsTbody').querySelectorAll('tr').length, 1);
  assert.match(f.$('syncStatusBadge').textContent, /محلي/);
  for (const button of f.window.document.querySelectorAll('[onclick]')) {
    const name = button.getAttribute('onclick').match(/^(\w+)\(/)?.[1];
    if (name) assert.equal(typeof f.window[name], 'function', name);
  }
  f.window.openPartySec('supplier'); assert.equal(f.$('partyType').value, 'supplier');
  f.window.openPartySec('customer'); assert.equal(f.$('partyType').value, 'customer');
  f.window.lockApp(); assert.equal(f.$('lockModal').style.display, 'flex');
  f.fill('unlockPinInp', 'wrong'); f.window.unlockApp(); assert.equal(f.$('lockModal').style.display, 'flex');
  f.fill('unlockPinInp', '1234'); f.window.unlockApp(); assert.equal(f.$('lockModal').style.display, 'none');
});

test('item creation/edit/reset and duplicate barcode validation', async t => {
  const f = await ready(t);
  f.fill('itemName', 'كراسة'); f.fill('itemQty', 4); f.fill('itemBuyPrice', 10); f.window.calcPriceFromProfit(); f.window.saveItem();
  assert.equal(f.saved().items.length, 1); assert.equal(f.saved().items[0].sell, 12);
  const id = f.saved().items[0].id; f.window.editItem(id); f.fill('itemName', 'كراسة كبيرة'); f.fill('itemMinQty', 2); f.window.saveItem();
  assert.equal(f.saved().items[0].name, 'كراسة كبيرة'); assert.equal(f.$('itemMinQty').value, '3'); assert.equal(f.$('itemProfitPct').value, '20');
  const before = f.saved(); f.fill('itemCode', before.items[0].code); f.fill('itemName', 'مكرر'); f.window.saveItem();
  assert.deepEqual(f.saved(), before); assert.match(f.alerts.at(-1), /مستخدم/);
});

test('failed local write leaves stock, balances and invoices unchanged', async t => {
  const f = await ready(t, { db: seedDatabase() });
  addLine(f, '1001', 2);
  const before = f.saved();
  f.window.Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
  f.window.saveInvoice(false);
  assert.deepEqual(f.saved(), before); assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
  assert.match(f.$('appNotice').textContent, /لم يُحفظ/);
});

test('sale discounts reduce profit, cash and stock exactly once', async t => {
  const f = await ready(t, { db: seedDatabase() });
  addLine(f, '1001', 2); f.fill('invDiscAmount', 20); f.fill('invDiscPct', 10); f.window.calcInvoiceTotals();
  assert.equal(f.$('invNetTotal').value, '250.00'); f.window.saveInvoice(false);
  const db = f.saved(); assert.equal(db.items[0].qty, 8); assert.equal(db.invoices[0].netTotal, 250); assert.equal(db.treasury[0].amount, 250);
  assert.equal(f.$('kpiNetProfit').textContent, '50.00'); assert.equal(f.$('kpiCash').textContent, '250.00');
  assert.equal(db.invoices[0].items[0].buyCost, 100);
  f.window.printInvoiceById(1); assert.match(f.prints.at(-1), /250.00/); assert.match(f.prints.at(-1), /الخصم الإضافي/);
});

test('negative stock and below-minimum sale are rejected without partial mutation', async t => {
  const f = await ready(t, { db: seedDatabase() }); const before = f.saved();
  addLine(f, '1001', 11); f.window.saveInvoice(false); assert.deepEqual(f.saved(), before); assert.match(f.alerts.at(-1), /غير كاف/);
  f.window.clearInvCart(); addLine(f, '1001', 1); f.window.updateCartRow(0, 'price', 20);
  assert.match(f.alerts.at(-1), /الحد الأدنى/); assert.equal(f.$('invCartTbody').querySelector('input[aria-label^="سعر"]').value, '150');
  f.fill('invDiscAmount', 299); f.window.calcInvoiceTotals(); f.window.saveInvoice(false); assert.deepEqual(f.saved(), before);
});

test('credit sale requires an account, updates statement and customer voucher reconciles', async t => {
  const f = await ready(t, { db: seedDatabase() });
  addLine(f); f.fill('invPayType', 'credit'); f.window.calcInvoiceTotals(); f.window.saveInvoice(false);
  assert.equal(f.saved().invoices.length, 0); assert.match(f.alerts.at(-1), /اختر عميلاً/);
  f.fill('invPartySelect', 2); f.window.saveInvoice(false);
  assert.equal(f.saved().parties.find(p => p.id === 2).balance, 250); assert.equal(f.saved().treasury.length, 0);
  f.window.openPartySec('customer'); f.window.showStatementFor(2);
  assert.match(f.$('statementTbody').textContent, /رصيد افتتاحي/); assert.equal(f.$('statementTbody').querySelectorAll('tr').length, 2);
  assert.match(f.$('statementTbody').lastElementChild.textContent, /250.00/);
  f.fill('voucherPartyId', 2); f.fill('voucherAmount', 100); f.window.savePartyVoucher();
  assert.equal(f.saved().parties.find(p => p.id === 2).balance, 150); assert.equal(f.saved().treasury[0].type, 'in');
  f.window.showStatementFor(2); assert.match(f.$('statementTbody').lastElementChild.textContent, /150.00/);
});

test('partial payments and overpayments are validated', async t => {
  const f = await ready(t, { db: seedDatabase() }); addLine(f); f.fill('invPartySelect', 2);
  f.fill('invPayType', 'partial'); f.window.calcInvoiceTotals(); f.fill('invPaidAmount', 200); f.window.saveInvoice(false);
  assert.equal(f.saved().invoices.length, 0);
  f.fill('invPaidAmount', 50); f.window.saveInvoice(false);
  assert.equal(f.saved().invoices[0].remainAmount, 100); assert.equal(f.saved().treasury[0].amount, 50);
  assert.equal(f.saved().parties.find(p => p.id === 2).balance, 200);
});

test('purchase prices survive sale mode, discounts use weighted cost and purchase return preserves cost', async t => {
  const f = await ready(t, { db: seedDatabase() }); f.window.openInvoiceSec('purchase'); f.fill('invPartySelect', 3); addLine(f, '1001', 10);
  assert.equal(f.$('invCartTbody').querySelector('input[aria-label^="سعر"]').value, '100');
  f.window.updateCartRow(0, 'price', 80); f.fill('invDiscAmount', 100); f.window.calcInvoiceTotals(); f.window.saveInvoice(false);
  assert.equal(f.saved().items[0].buy, 85); assert.equal(f.saved().items[0].qty, 20); assert.equal(f.saved().parties[2].balance, 500);
  f.window.openInvoiceSec('purchase_return'); f.fill('invReturnSource', 1); f.window.loadReturnSource(); f.window.updateCartRow(0, 'qty', 2); f.window.saveInvoice(false);
  assert.equal(f.saved().items[0].qty, 18); assert.equal(f.saved().items[0].buy, 85); assert.equal(f.saved().parties[2].balance, 500);
  assert.equal(f.saved().treasury.at(-1).type, 'in'); assert.equal(f.saved().invoices.at(-1).items[0].buyCost, 100);
});

test('sales returns use historical cost and cannot exceed original quantity across multiple returns', async t => {
  const f = await ready(t, { db: seedDatabase() }); addLine(f, '1001', 3); f.fill('invPartySelect', 2); f.fill('invDiscAmount', 30); f.window.calcInvoiceTotals(); f.window.saveInvoice(false);
  f.window.editItem(1); f.fill('itemBuyPrice', 200); f.window.saveItem();
  f.window.openInvoiceSec('sale_return'); f.fill('invReturnSource', 1); f.window.loadReturnSource(); f.window.updateCartRow(0, 'qty', 1); f.window.saveInvoice(false);
  assert.equal(f.saved().invoices[1].netTotal, 140); assert.equal(f.saved().invoices[1].items[0].buyCost, 100); assert.equal(f.saved().parties.find(p => p.id === 2).balance, 100);
  assert.equal(f.$('kpiNetProfit').textContent, '80.00');
  f.fill('invReturnSource', 1); f.window.loadReturnSource(); f.window.updateCartRow(0, 'qty', 2); f.window.saveInvoice(false);
  assert.equal(f.saved().invoices[2].netTotal, 280);
  f.fill('invReturnSource', 1); f.window.loadReturnSource(); assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
  f.window.saveInvoice(false); assert.equal(f.saved().invoices.length, 3);
});

test('quote has no financial side effects and saved quote converts only once', async t => {
  const f = await ready(t, { db: seedDatabase() }); const before = f.saved();
  f.window.openInvoiceSec('quote'); addLine(f); f.window.saveInvoice(false);
  let db = f.saved(); assert.equal(db.invoices.length, 1, f.alerts.join('\n') + f.$('appNotice').textContent); assert.equal(db.items[0].qty, 10); assert.equal(db.treasury.length, 0); assert.equal(db.invoices[0].paidAmount, 0); assert.equal(db.invoices[0].remainAmount, 0);
  f.window.loadQuoteForSale(1); f.window.saveInvoice(false); db = f.saved();
  assert.equal(db.invoices.length, 2); assert.equal(db.invoices[0].convertedToId, 2); assert.equal(db.items[0].qty, 9);
  f.window.loadQuoteForSale(1); assert.equal(f.$('invCartTbody').dataset.quoteId, undefined); assert.match(f.alerts.at(-1), /بالفعل/);
});

test('expenses affect overall profit, not a single-item profit', async t => {
  const f = await ready(t, { db: seedDatabase() }); addLine(f); f.window.saveInvoice(false);
  f.window.openTreasury('expense'); f.fill('trAmount', 20); f.fill('trNote', 'إيجار'); f.window.addTreasuryMove();
  f.window.openProfitSec(); assert.equal(f.$('profNet').textContent, '30.00');
  f.fill('profItemFilter', '1'); f.window.renderProfits(); assert.equal(f.$('profExpenses').textContent, '0.00'); assert.equal(f.$('profNet').textContent, '50.00');
  f.fill('profDateFrom', '2026-12-01'); f.fill('profDateTo', '2026-01-01'); f.window.renderProfits(); assert.match(f.$('profitScopeNote').textContent, /البداية/); assert.equal(f.$('profNet').textContent, '—');
});

test('user text is escaped in tables and print, and CSV neutralizes formulas', async t => {
  const db = seedDatabase(); db.items[0].name = '<img src=x onerror=alert(1)>"&'; db.items[1].name = '=HYPERLINK("x")';
  const f = await ready(t, { db }); assert.equal(f.$('itemsTbody').querySelector('img'), null); assert.match(f.$('itemsTbody').textContent, /<img/);
  f.window.printItemsReportA5(); assert.match(f.prints.at(-1), /&lt;img/); assert.equal(f.$('printAreaA5').querySelector('img'), null);
  f.window.exportItemsCSV(); const csv = await blobText(f, f.downloads.at(-1)); assert.match(csv, /"'=HYPERLINK/); assert.match(csv, /""&/);
});

test('screen printing reflects edited input values and omits action buttons', async t => {
  const f = await ready(t, { db: seedDatabase() }); f.window.toggleQuickEditItems();
  f.$('itemsTbody').querySelector('input[type="number"]').value = 7;
  f.window.printCurrentScreenA5(); assert.match(f.prints.at(-1), />7</); assert.doesNotMatch(f.prints.at(-1), /<button/); assert.doesNotMatch(f.prints.at(-1), /<input/);
});

test('valid backup restores locally without auto push; invalid backup does not replace data', async t => {
  let posts = 0;
  const f = await ready(t, { db: seedDatabase(), token: 'a'.repeat(40), fetch: async () => { posts++; return { ok: true, json: async () => ({ ok: true }) }; } });
  const backup = await backupObject(f); backup.settings.name = 'مكتبة مستعادة';
  await f.window.importFullBackup({ target: { files: [new NodeFile([JSON.stringify(backup)], 'backup.json')], value: 'x' } });
  assert.equal(f.saved().settings.name, 'مكتبة مستعادة', f.alerts.join('\n')); assert.equal(posts, 0); assert.equal(JSON.parse(f.window.localStorage.getItem(META_KEY)).revision, null);
  const before = f.saved();
  await f.window.importFullBackup({ target: { files: [new NodeFile(['{"items":[]}'], 'bad.json')], value: 'x' } });
  assert.deepEqual(f.saved(), before); assert.match(f.alerts.at(-1), /لم تُستعد/);
});

test('corrupt local data is preserved and blocks writes until explicit restore', async t => {
  const f = fixture(t); f.window.localStorage.setItem(DB_KEY, '{broken'); await f.load();
  assert.equal(f.window.localStorage.getItem(DB_KEY), '{broken');
  f.window.openTreasury('in'); f.fill('trAmount', 10); f.fill('trNote', 'test'); f.window.addTreasuryMove();
  assert.equal(f.window.localStorage.getItem(DB_KEY), '{broken'); assert.match(f.$('appNotice').textContent, /غير صالحة/);
});

test('manual pull confirms replacement; cloud failure never clears local data', async t => {
  const remote = seedDatabase(); remote.settings.name = 'السحابة';
  let fail = false;
  const f = await ready(t, { db: seedDatabase(), meta: { revision: 3, dirty: true }, token: 'a'.repeat(40), fetch: async () => fail
    ? { ok: false, status: 500, json: async () => ({ error: 'Server unavailable' }) }
    : { ok: true, json: async () => ({ payload: remote, revision: 4 }) } });
  f.setConfirm(false); await f.window.syncToCloud('pull'); assert.notEqual(f.saved().settings.name, 'السحابة');
  f.setConfirm(true); await f.window.syncToCloud('pull'); assert.equal(f.saved().settings.name, 'السحابة'); assert.equal(JSON.parse(f.window.localStorage.getItem(META_KEY)).revision, 4);
  const before = f.saved(); fail = true; await f.window.syncToCloud('pull'); assert.deepEqual(f.saved(), before);
});

test('push uses revision and concurrent requests are serialized', async t => {
  const calls = []; let release;
  const f = await ready(t, { db: seedDatabase(), meta: { revision: 7, dirty: true }, token: 'a'.repeat(40), fetch: async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (calls.length === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ ok: true, revision: 7 + calls.length }) };
  } });
  const first = f.window.syncToCloud('push'), second = f.window.syncToCloud('push');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 1); release();
  await Promise.all([first, second]); assert.deepEqual(calls.map(c => c.baseRevision), [7, 8]);
  assert.equal(JSON.parse(f.window.localStorage.getItem(META_KEY)).revision, 9);
  assert.equal(f.window.localStorage.getItem(DB_KEY).includes('a'.repeat(40)), false);
});

test('conflict response does not overwrite local or advance revision', async t => {
  const f = await ready(t, { db: seedDatabase(), meta: { revision: 7, dirty: true }, token: 'a'.repeat(40), fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'conflict' }) }) });
  const before = f.saved(); await f.window.syncToCloud('push'); assert.deepEqual(f.saved(), before);
  assert.equal(JSON.parse(f.window.localStorage.getItem(META_KEY)).revision, 7); assert.match(f.$('syncStatusBadge').textContent, /تعارض/);
});

test('sections open as floating windows and Windows-inspired themes persist', async t => {
  const f = await ready(t);
  f.window.openSec('sec-items', 'الأصناف');
  assert.equal(f.$('windowLayer').classList.contains('open'), true);
  assert.equal(f.$('sec-items').classList.contains('active'), true);
  f.window.selectTheme('vista-emerald');
  assert.equal(f.window.document.body.dataset.theme, 'vista-emerald');
  assert.equal(JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_APPEARANCE`)).theme, 'vista-emerald');
  f.window.closeWorkspace();
  assert.equal(f.$('windowLayer').classList.contains('open'), false);
});

test('settings secret stays in session, blank PIN preserves existing and backup excludes token', async t => {
  const f = await ready(t, { db: seedDatabase() }); f.window.openSec('sec-settings'); f.fill('setSyncKey', 'secret-session-value'); f.fill('setPinCode', ''); f.window.saveSettings();
  assert.equal(f.saved().settings.pin, '1234'); assert.equal(f.window.sessionStorage.getItem(TOKEN_KEY), 'secret-session-value');
  assert.equal(f.window.localStorage.getItem(`${DB_KEY}_REMEMBERED_TOKEN`), 'secret-session-value');
  const backup = await backupObject(f); assert.equal(JSON.stringify(backup).includes('secret-session-value'), false); assert.equal(f.$('setSyncKey').value, '');
  assert.equal(localDate().length, 10);
});

test('first push never silently replaces an existing cloud database', async t => {
  let posts = 0;
  const f = await ready(t, { db: seedDatabase(), token: 'a'.repeat(40), fetch: async (url, options) => {
    if (options.method === 'POST') posts++;
    return { ok: true, json: async () => ({ payload: seedDatabase(), revision: 5 }) };
  } });
  f.setConfirm(false); await f.window.syncToCloud('push'); assert.equal(posts, 0);
  assert.equal(f.window.localStorage.getItem(META_KEY), null);
  assert.match(f.$('syncStatusBadge').textContent, /تعارض/);
});

test('edits during a push remain dirty and are pushed with the new revision', async t => {
  let release, calls = 0;
  const f = await ready(t, { db: seedDatabase(), meta: { revision: 1, dirty: true }, token: 'a'.repeat(40), fetch: async (url, options) => {
    calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ ok: true, revision: calls + 1 }) };
  } });
  const pushing = f.window.syncToCloud('push');
  await new Promise(resolve => setImmediate(resolve));
  f.window.openTreasury('in'); f.fill('trAmount', 25); f.fill('trNote', 'إيداع أثناء المزامنة'); f.window.addTreasuryMove();
  release(); await pushing;
  const meta = JSON.parse(f.window.localStorage.getItem(META_KEY)); assert.equal(meta.revision, 2); assert.equal(meta.dirty, true);
  await f.window.syncToCloud('push'); assert.equal(calls, 2);
  assert.equal(JSON.parse(f.window.localStorage.getItem(META_KEY)).dirty, false);
});

test('old API response is rejected before any upload', async t => {
  let posts = 0;
  const f = await ready(t, { db: seedDatabase(), token: 'a'.repeat(40), fetch: async (url, options) => {
    if (options.method === 'POST') posts++;
    return { ok: true, json: async () => seedDatabase() };
  } });
  await f.window.syncToCloud('push'); assert.equal(posts, 0); assert.match(f.alerts.at(-1), /خادم المزامنة قديم/);
});

test('return quantity entered by barcode also updates its refund value', async t => {
  const f = await ready(t, { db: seedDatabase() }); addLine(f, '1001', 3); f.window.saveInvoice(false);
  f.window.openInvoiceSec('sale_return'); f.fill('invReturnSource', 1); f.window.loadReturnSource();
  addLine(f, '1001', 1); assert.equal(f.$('invNetTotal').value, '150.00'); f.window.saveInvoice(false);
  assert.equal(f.saved().invoices[1].netTotal, 150); assert.equal(f.saved().treasury[1].amount, 150);
});

test('clearing a quote draft removes its conversion link', async t => {
  const f = await ready(t, { db: seedDatabase() }); f.window.openInvoiceSec('quote'); addLine(f); f.window.saveInvoice(false);
  f.window.loadQuoteForSale(1); f.window.clearInvCart(); assert.equal(f.$('invCartTbody').dataset.quoteId, undefined);
  addLine(f); f.window.saveInvoice(false); assert.equal(f.saved().invoices[0].convertedToId, undefined);
});
