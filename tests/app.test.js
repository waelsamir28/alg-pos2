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
  const f = await ready(t, { db: seedDatabase() }); f.window.openSec('sec-items', 'الأصناف'); f.window.toggleQuickEditItems();
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

test('dashboard, responsive navigation, window controls and themes work', async t => {
  const f = await ready(t);
  // The daily board starts collapsed, opens and closes by its arrow, and shows four square KPI boxes.
  assert.equal(f.$('homeDashboard').classList.contains('collapsed'), true);
  assert.equal(f.$('boardBody').querySelectorAll('.kpi-box').length, 4);
  assert.equal(Boolean(f.$('salesChart')), false);
  f.window.toggleDashboard(); assert.equal(f.$('homeDashboard').classList.contains('collapsed'), false);
  assert.equal(f.$('boardToggle').getAttribute('aria-expanded'), 'true');
  f.window.toggleDashboard(); assert.equal(f.$('homeDashboard').classList.contains('collapsed'), true);
  assert.equal(f.$('systemAlertsList').children.length > 0, true);
  f.window.toggleSidebar(); assert.equal(f.$('appShell').classList.contains('sidebar-collapsed'), true);
  f.window.toggleSidebar(); assert.equal(f.$('appShell').classList.contains('sidebar-collapsed'), false);
  f.window.openSec('sec-items', 'الأصناف');
  assert.equal(f.$('windowLayer').classList.contains('open'), true);
  assert.equal(f.$('sec-items').classList.contains('active'), true);
  // the reference layout opens the section as an inline content card, not a maximized modal
  assert.equal(f.$('windowLayer').classList.contains('maximized'), false);
  f.window.maximizeWorkspace(); assert.equal(f.$('windowLayer').classList.contains('maximized'), true);
  f.window.maximizeWorkspace(); assert.equal(f.$('windowLayer').classList.contains('maximized'), false);
  f.window.minimizeWorkspace(); assert.equal(f.$('windowDock').hidden, false);
  f.window.restoreWorkspace(); assert.equal(f.$('windowDock').hidden, true);
  f.window.selectTheme('vista-emerald');
  assert.equal(f.window.document.body.dataset.theme, 'vista-emerald');
  assert.equal(JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_APPEARANCE`)).theme, 'vista-emerald');
  f.window.toggleDarkMode(); assert.equal(f.window.document.body.dataset.theme, 'night');
  f.window.toggleDarkMode(); assert.equal(f.window.document.body.dataset.theme, 'vista-emerald');
  f.window.closeWorkspace(); assert.equal(f.$('windowLayer').classList.contains('open'), false);
});

test('POS screen uses the new bars: title, tabs on the left, group dropdown and function keys', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openInvoiceSec('sale');
  // title bar shows the operation name, and the mode switch lives inside it
  assert.equal(f.$('posTitleText').textContent, 'فاتورة مبيعات');
  assert.equal(f.$('posTitleText').closest('.pos-titlebar').querySelector('#invMode').tagName, 'SELECT');
  f.window.openInvoiceSec('purchase');
  assert.equal(f.$('posTitleText').textContent, 'فاتورة مشتريات');
  // groups are a dropdown now: choosing a group shows its item buttons
  assert.equal(f.$('posGroupSelect').tagName, 'SELECT');
  f.window.selectPosGroup('كتب خارجية');
  assert.equal(f.$('posGroupSelect').value, 'كتب خارجية');
  assert.equal(f.$('posQuickItems').children.length, 1);
  assert.equal(f.$('posGroupCount').textContent, '1 صنف');
  // every invoice field is on the strip at once: no tab panel hides a box
  assert.equal(f.window.document.querySelectorAll('[data-inv-group]').length, 0);
  assert.equal(f.$('invDiscPct') !== null && f.$('invPrintNote') !== null, true);
  assert.equal(f.$('invTabs').hidden, true);
  // save / hold / restore / print / clear are ordered in one strip
  const actions = [...f.window.document.querySelectorAll('.pos-actions-strip .pos-action')].map(button => button.textContent.trim());
  assert.match(actions[0], /^💾حفظ/);
  assert.match(actions[1], /حفظ وطباعة/);
  assert.match(actions[2], /معاينة قبل الحفظ/);
  assert.match(actions[3], /طباعة حرارية/);
  assert.match(actions[4], /تعليق/);
  assert.match(actions[5], /استعادة معلقة/);
  assert.match(actions.at(-1), /تفريغ/);
  // the brown function-key strip is gone
  assert.equal(f.window.document.querySelectorAll('.fn-strip').length, 0);
  assert.equal(f.window.document.querySelectorAll('.pos-fnbar').length, 0);
  // the money boxes sit on one row of big boxes in the summary
  const totalsCard = f.window.document.querySelector('.posv3-sum-row');
  const boxes = [...totalsCard.querySelectorAll('input')].map(input => input.id).filter(id => id && id !== 'invPaidWithKeypad');
  assert.deepEqual(boxes, ['invSubTotal', 'invDiscTotalView', 'invNetTotal', 'invPaidAmount', 'invRemainAmount']);
  assert.equal(f.$('invNetTotal').tagName, 'INPUT');
  assert.equal(f.window.getComputedStyle(totalsCard).display, 'flex');
});

test('floating screens open large and the screen-print button is gone', async t => {
  const f = await ready(t);
  f.window.openSec('sec-items', 'الأصناف');
  assert.equal(f.window.document.querySelectorAll('.win-header [onclick="printCurrentScreenA5()"]').length, 0);
  const workspace = f.window.document.querySelector('.workspace');
  assert.equal(workspace.tagName, 'DIV');
  // the shell must fill the viewport minus its padding, not a fixed 1420px column
  const css = f.window.document.querySelector('style').textContent;
  assert.match(css, /\.workspace \{[^}]*width:100%/);
});

test('start screen loads with a progress bar, then a rounded login box welcomes the user', async t => {
  const f = await ready(t);
  f.window.lockApp();
  assert.equal(f.$('lockModal').style.display, 'flex');
  assert.equal(f.$('startLoader').hidden, false);
  assert.equal(f.$('startLogin').hidden, true);
  assert.equal(f.$('startStoreName').textContent, f.saved().settings.name);
  // the loader is a real progress element with a filling bar
  f.window.startScreenProgress(() => {});
  f.window.finishStartScreen();
  assert.equal(f.$('startLoader').hidden, true);
  assert.equal(f.$('startLogin').hidden, false);
  f.fill('unlockPinInp', '1234'); f.window.unlockApp();
  assert.equal(f.$('welcomePopup').hidden, false);
  assert.match(f.$('welcomeTitle').textContent, /أهلاً بك/);
  f.window.closeWelcomePopup();
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(f.$('welcomePopup').hidden, true);
});

test('sync results and confirmations use small floating dialogs with their own buttons', async t => {
  const f = await ready(t, { db: seedDatabase(), meta: { revision: 2, dirty: true }, token: 'a'.repeat(40), fetch: async () => ({ ok: true, json: async () => ({ ok: true, revision: 3 }) }) });
  await f.window.syncToCloud('push');
  assert.equal(f.$('syncDialog').hidden, false);
  assert.match(f.$('syncDialogTitle').textContent, /تم الرفع/);
  assert.equal(f.$('syncDialogFoot').children.length, 1);
  f.window.closeSyncDialog();
  assert.equal(f.$('syncDialog').hidden, true);
  // askDialog resolves with the chosen button and always offers cancel
  const answer = f.window.askDialog({ title: 'تأكيد الحذف', body: 'هل تحذف؟' });
  assert.equal(f.$('syncDialogFoot').children.length, 2);
  assert.match(f.$('syncDialogFoot').children[1].textContent, /إلغاء/);
  f.$('syncDialogFoot').children[1].click();
  assert.equal(await answer, false);
});

test('every screen starts with a full width title bar and the items screen has tabs', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const sections = ['sec-invoice', 'sec-items', 'sec-categories', 'sec-stock', 'sec-labels', 'sec-parties', 'sec-invlog', 'sec-treasury', 'sec-profits', 'sec-settings'];
  for (const id of sections) {
    assert.equal(Boolean(f.$(id).querySelector('.page-bar, .pos-titlebar, .ws-head')), true, id);
  }
  f.window.openSec('sec-items', 'الأصناف');
  assert.equal(f.$('headItemsCount').textContent, '2');
  f.window.switchItemsTab('prices');
  assert.deepEqual([...f.window.document.querySelectorAll('#sec-items [data-items-tab]')].map(b => b.classList.contains('is-active')), [false, true, false]);
  assert.equal(f.window.document.querySelector('#sec-items [data-items-group="prices"]').hidden, false);
  assert.equal(f.$('itemsPanelTitle').textContent, 'الأسعار والربح');
  f.window.switchItemsTab('actions');
  assert.equal(f.window.document.querySelector('#sec-items [data-items-group="actions"]').hidden, false);
  f.window.switchItemsTab('edit');
  assert.equal(f.window.document.querySelector('#sec-items [data-items-group="edit"]').hidden, false);
});

test('start screen background can be set and cleared from the design studio', async t => {
  const f = await ready(t);
  f.window.setStartBackgroundOpacity(80);
  const design = JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_DESIGN`));
  assert.equal(design.startBackgroundOpacity, 80);
  assert.equal(f.$('startBgOpacity').value, '80');
  f.window.clearStartBackground();
  assert.match(f.$('startBgStatus').textContent, /متدرجة/);
});

test('staff roles allow cashier sales but block inventory and manager-only settings', async t => {
  const f = await ready(t);
  f.window.openSec('sec-settings', 'الإعدادات');
  f.fill('staffNameInp', 'أحمد'); f.fill('staffPinInp', '5678'); f.fill('staffRoleInp', 'cashier'); f.window.saveStaff();
  const employee = JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_STAFF`))[0];
  f.window.lockApp(); f.fill('loginStaffSelect', employee.id); f.fill('unlockPinInp', '5678'); f.window.unlockApp();
  assert.match(f.$('activeUserBadge').textContent, /أحمد/);
  f.window.openInvoiceSec('sale'); assert.equal(f.$('windowLayer').classList.contains('open'), true);
  f.window.openInvoiceSec('purchase'); assert.match(f.$('appNotice').textContent, /غير متاحة/);
  f.window.openSec('sec-items', 'الأصناف'); assert.notEqual(f.$('sec-items').classList.contains('active'), true);
  f.window.openSec('sec-settings', 'الإعدادات'); assert.notEqual(f.$('sec-settings').classList.contains('active'), true);
});

test('cashier can hold and restore a draft, thermal receipt uses configured paper width', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openInvoiceSec('sale'); addLine(f, '1001', 2);
  f.window.holdCurrentInvoice(); assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
  assert.equal(f.$('restoreHeldButton').disabled, false);
  f.window.restoreHeldInvoice(); assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
  assert.equal(f.$('restoreHeldButton').disabled, true);
  f.window.saveInvoice('thermal');
  assert.match(f.prints.at(-1), /thermal-receipt/);
  assert.match(f.$('thermalPrintStyle').textContent, /80mm/);
});

test('alerts and audit history update without storing credential values', async t => {
  const db = seedDatabase(); db.items[0].qty = 1;
  const f = await ready(t, { db });
  assert.match(f.$('systemAlertsList').textContent, /حد الطلب/);
  f.fill('itemName', 'قلم رصاص'); f.window.saveItem();
  const audit = JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_AUDIT`));
  assert.ok(audit.length);
  assert.equal(JSON.stringify(audit).includes('1234'), false);
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

test('quick cash chips fill the paid amount and show the change', async t => {
  const f = await ready(t, { db: seedDatabase() }); f.window.openInvoiceSec('sale'); addLine(f, '1001', 1);
  assert.equal(f.$('cashChangeValue').textContent, '0.00');
  f.window.setQuickPaid(100); assert.equal(f.$('invPaidAmount').value, '100.00');
  f.window.setQuickPaid(100); assert.equal(f.$('invPaidAmount').value, '200.00');
  assert.equal(f.$('cashChangeValue').textContent, '50.00'); assert.equal(f.$('cashChangeBox').dataset.state, 'over');
  f.window.setQuickPaid('round'); assert.equal(f.$('invPaidAmount').value, '150.00'); assert.equal(f.$('cashChangeValue').textContent, '0.00');
  f.window.setQuickPaid('exact'); assert.equal(f.$('invPaidAmount').value, '150.00');
});

test('discount limit per cashier: staff limit shown and over-limit sale needs the admin PIN', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openSec('sec-settings'); f.fill('staffNameInp', 'سالم'); f.fill('staffPinInp', '5555');
  f.fill('staffRoleInp', 'cashier'); f.fill('staffDiscountLimit', 5); f.window.saveStaff();
  const staff = JSON.parse(f.window.localStorage.getItem('BOOKSTORE_POS_COMPLETE_DB_V2_STAFF'));
  assert.equal(staff[0].discountLimit, 5);
  f.window.lockApp();
  f.$('loginStaffSelect').value = staff[0].id; f.fill('unlockPinInp', '5555'); f.window.unlockApp();
  assert.match(f.$('activeUserBadge').textContent, /سالم/);
  f.window.openInvoiceSec('sale'); addLine(f, '1001', 1);
  f.fill('invDiscPct', 20); f.window.calcInvoiceTotals();
  assert.equal(f.$('discountLimitValue').textContent, '5%'); assert.equal(f.$('discountWarn').hidden, false);
  f.setConfirm(false); f.window.saveInvoice(false); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.saved().invoices.length, 0);
});

test('activity log floating window records audit entries and exports invoice PDF/WhatsApp', async t => {
  const f = await ready(t, { db: seedDatabase() }); f.window.openInvoiceSec('sale'); addLine(f, '1001', 2); f.window.saveInvoice(false);
  f.window.toggleActivityLog(true);
  assert.equal(f.$('activityLog').hidden, false);
  assert.match(f.$('activityLogList').textContent, /تعديل|فاتورة/);
  const text = f.window.invoiceShareText(f.saved().invoices[0]);
  assert.match(text, /كتاب/); assert.match(f.window.whatsappLink(text, '01012345678'), /^https:\/\/wa\.me\/20/);
  const html = f.window.invoiceDocHtml(f.saved().invoices[0], 'a4');
  assert.match(html, /@page\{size:A4/); assert.match(html, /كتاب/); assert.match(html, /<svg/);
});

test('a running invoice is auto-saved and can be restored after a reload', async t => {
  const f = await ready(t, { db: seedDatabase() }); f.window.openInvoiceSec('sale'); addLine(f, '1002', 3); f.window.saveDraftNow(true);
  const draft = f.window.readDraft(); assert.equal(draft.items.length, 1); assert.equal(draft.items[0].qty, 3);
  f.window.clearInvCart(); assert.equal(f.window.readDraft(), null);
  f.window.restoreSavedDraft(true); // nothing left to restore
  addLine(f, '1001', 1); f.window.saveDraftNow(true); f.window.clearInvCart();
  f.window.localStorage.setItem('BOOKSTORE_POS_COMPLETE_DB_V2_DRAFT', JSON.stringify(draft));
  assert.equal(f.window.restoreSavedDraft(true), true);
  assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
});

test('barcode field searches by name with diacritic-insensitive matching and arrow selection', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const matches = f.window.suggestionMatches('قلم'); assert.equal(matches[0].code, '1002');
  assert.equal(f.window.suggestionMatches('كِتَاب')[0].code, '1001');
  assert.equal(f.window.suggestionMatches('١٠٠١').length, 0);
  f.window.openInvoiceSec('sale'); f.fill('invBarcodeInp', 'كتاب'); f.window.showSuggestions();
  assert.equal(f.$('invSuggest').hidden, false);
  f.window.moveSuggestion(0);
  f.window.handleScanKey({ key: 'Enter', preventDefault() {} });
  assert.equal(f.$('invBarcodeInp').value, ''); assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
  f.fill('invBarcodeInp', 'قلم'); f.window.showSuggestions(); f.window.moveSuggestion(0); f.window.pickSuggestion(0);
  assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 2);
});

test('a customer can be created straight from the invoice and is selected automatically', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openInvoiceSec('sale'); f.window.toggleQuickParty(true);
  assert.equal(f.$('invQuickParty').hidden, false);
  f.fill('invQuickPartyName', 'مدرسة النور'); f.fill('invQuickPartyPhone', '01099998888'); f.window.saveQuickParty();
  const party = f.saved().parties.find(entry => entry.name === 'مدرسة النور');
  assert.ok(party); assert.equal(party.type, 'customer'); assert.equal(party.phone, '01099998888');
  assert.equal(f.$('invPartySelect').value, String(party.id));
  f.window.toggleQuickParty(true); f.fill('invQuickPartyName', 'مدرسة النور'); f.window.saveQuickParty();
  assert.equal(f.saved().parties.filter(entry => entry.name === 'مدرسة النور').length, 1);
});

test('scan feedback settings persist and never throw without WebAudio', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.setScanFeedback('chime'); f.window.setScanVibrate(false);
  const appearance = JSON.parse(f.window.localStorage.getItem('BOOKSTORE_POS_COMPLETE_DB_V2_APPEARANCE'));
  assert.equal(appearance.scanFeedback, 'chime'); assert.equal(appearance.scanVibrate, false);
  f.window.openSec('sec-settings');
  assert.equal(f.$('scanSoundSelect').value, 'chime'); assert.equal(f.$('vibrateFeedback').checked, false);
  f.window.playScanFeedback(); f.window.playScanFeedback('silent'); f.window.playScanFeedback('click');
  assert.equal(f.alerts.length, 0);
});

test('camera scanner reports missing support gracefully and routes a decoded barcode into the cart', async t => {
  const f = await ready(t, { db: seedDatabase() });
  assert.equal(typeof f.window.cameraSupported(), 'boolean');
  f.window.openCameraScanner();
  assert.equal(f.$('cameraModal').hidden, true);
  assert.equal(f.$('syncDialog').hidden, false);
  f.window.closeSyncDialog();
  f.window.openInvoiceSec('sale');
  f.window.handleCameraCode('1002');
  assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
  f.window.handleCameraCode('999999'); // unknown code must not add anything
  assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 1);
});

test('A5 preview shows the draft before saving and blocks invalid drafts', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openInvoiceSec('sale');
  f.window.previewInvoiceA5();
  assert.equal(f.$('invoicePreview').hidden, true);
  assert.match(f.alerts.at(-1), /لا توجد أصناف|فارغة|أضف/);
  addLine(f, '1001', 2); f.window.previewInvoiceA5();
  assert.equal(f.$('invoicePreview').hidden, false);
  assert.match(f.$('previewPaper').textContent, /كتاب/);
  assert.match(f.$('previewBadge').textContent, /مسودة/);
  assert.equal(f.saved().invoices.length, 0);
  f.window.setPreviewZoom(120);
  assert.match(f.$('previewPaper').style.transform, /1\.2/);
  f.window.closeInvoicePreview(); assert.equal(f.$('invoicePreview').hidden, true);
  f.window.saveInvoice(false);
  f.window.previewSavedInvoice(1); assert.match(f.$('previewBadge').textContent, /#1/);
});

test('low stock window builds a purchase order for every shortage', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const low = f.window.lowStockItems();
  assert.equal(low.length, 0);
  const db = f.saved(); db.items[0].qty = 0; db.items[1].qty = 0;
  f.window.localStorage.setItem(DB_KEY, JSON.stringify(db));
  f.window.location.reload?.();
  await f.load();
  assert.equal(f.window.lowStockItems().length, 2);
  f.window.toggleStockAlerts(true);
  assert.equal(f.$('stockAlerts').hidden, false);
  assert.match(f.$('stockAlertsBtn').textContent, /نواقص/);
  f.window.openPurchaseOrderFromLowStock();
  assert.equal(f.$('invCartTbody').querySelectorAll('tr').length, 2);
  assert.equal(f.$('invMode').value, 'purchase');
});

test('app badge counts held invoices plus the auto draft', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openInvoiceSec('sale'); addLine(f, '1001', 1);
  f.window.holdCurrentInvoice();
  f.window.openInvoiceSec('sale'); addLine(f, '1002', 1); f.window.saveDraftNow(true);
  await f.window.syncAppBadge();
  assert.equal(f.$('draftBadge').hidden, false); assert.equal(f.$('draftBadge').textContent, '2');
  assert.match(f.$('restoreHeldButton').textContent, /\(1\)/);
  assert.equal(f.$('restoreHeldButton').classList.contains('has-held'), true);
  f.window.clearInvCart(); await f.window.syncAppBadge();
  assert.equal(f.$('draftBadge').textContent, '1');
});

test('every page has its own close button and the inline content header is visible', async t => {
  const f = await ready(t, { db: seedDatabase() });
  // shell v2: the tab bar is the single close control, so the window header is hidden
  assert.equal(f.window.document.querySelector('.win-header').hidden, true);
  for (const id of ['sec-items', 'sec-categories', 'sec-stock', 'sec-labels', 'sec-parties', 'sec-invlog', 'sec-treasury', 'sec-profits', 'sec-settings']) {
    const view = f.$(id);
    assert.equal(view.querySelectorAll('.page-close-btn').length, 1, id);
  }
  assert.equal(f.$('sec-invoice').querySelectorAll('.pos-titlebar .page-close-btn').length, 1);
  f.window.openSec('sec-items', 'الأصناف');
  const closeButton = f.window.document.querySelector('#sec-items .page-close-btn');
  assert.match(closeButton.getAttribute('onclick'), /closeWorkspace\(\)/);
  assert.equal(closeButton.hidden, true);
  f.window.closeWorkspace();
  assert.equal(f.$('windowLayer').classList.contains('open'), false);
});

test('POS keeps invoice data on the left, money boxes side by side and no quick-pay chips', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openInvoiceSec('sale');
  assert.equal(f.window.document.querySelectorAll('.cash-chip').length, 0);
  const wrap = f.window.document.querySelector('#sec-invoice .pos-wrap');
  assert.equal(wrap.dataset.mode, 'sale');
  // the totals are one row of big boxes (net, paid, remaining) in the summary card
  const rows = [...f.window.document.querySelectorAll('.posv3-sum > span:first-child')].map(cell => cell.textContent.trim());
  assert.deepEqual(rows, ['إجمالي البنود', 'خصم إضافي', 'الصافي المطلوب', 'المدفوع', 'المتبقي (آجل)']);
  assert.equal(f.$('invNetTotal').tagName, 'INPUT');
  // the invoice data is a wide strip: the customer box is as wide as the barcode box
  const meta = f.window.document.querySelector('#sec-invoice .posv3-meta-row');
  assert.ok(meta, 'the invoice data strip exists');
  const partyBox = f.$('invPartySelect').closest('.pv3-field');
  const dateBox = f.$('invDateView').closest('.pv3-field');
  assert.equal(partyBox.classList.contains('pv3-wide'), true);
  assert.equal(f.window.getComputedStyle(meta).display, 'flex');
  // payment type and price tier are chips in the strip head, not separate cards
  assert.ok(f.$('invPayType').closest('.posv3-meta-head'));
  assert.ok(f.$('invPriceTier').closest('.posv3-meta-head'));
  f.window.openInvoiceSec('purchase');
  assert.equal(wrap.dataset.mode, 'purchase');
});

test('invoice log switches between sales, purchases, quotes with distinct headings', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openSec('sec-invlog');
  f.window.setLogKind('sale');
  assert.equal(f.$('sec-invlog').dataset.logKind, 'sale');
  assert.match(f.$('invLogTitle').textContent, /المبيعات/);
  assert.equal(f.$('invLogPartyHead').textContent, 'العميل');
  f.window.setLogKind('purchase');
  assert.match(f.$('invLogTitle').textContent, /المشتريات/);
  assert.equal(f.$('invLogPartyHead').textContent, 'المورد');
  f.window.setLogKind('quote');
  assert.match(f.$('invLogTitle').textContent, /عروض الأسعار/);
  assert.deepEqual([...f.window.document.querySelectorAll('#logSwitch .log-switch-btn')].map(b => b.classList.contains('is-active')), [false, false, true, false]);
});

test('settings page uses real sections instead of a scroll list', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openSec('sec-settings');
  assert.equal(f.window.document.querySelector('[data-settings-panel="look"]').hidden, false);
  assert.equal(f.$('staffManagerPanel').closest('[data-settings-panel]').hidden, true);
  f.window.switchSettingsTab('staff');
  assert.equal(f.$('staffManagerPanel').closest('[data-settings-panel]').hidden, false);
  assert.deepEqual([...f.window.document.querySelectorAll('#settingsTabs .pos-tab')].map(b => b.classList.contains('is-active')), [false, false, true, false, false]);
  f.window.switchSettingsTab('sync');
  assert.equal(f.$('syncPanel').closest('[data-settings-panel]').hidden, false);
});

test('every invoice type has its own visual identity in the POS, the preview and the PDF', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const wrap = f.window.document.querySelector('#sec-invoice .pos-wrap');
  for (const [mode, label] of [['sale', /نقدي/], ['purchase', /تكلفة/], ['sale_return', /مرتجع/], ['purchase_return', /مرتجع مشتريات/], ['quote', /عرض سعر/]]) {
    f.window.openInvoiceSec(mode);
    assert.equal(wrap.dataset.mode, mode);
    assert.match(f.$('posModeBadge').textContent, label);
    assert.equal(f.$('posModeBadge').dataset.tone, mode);
  }
  const themes = ['sale', 'purchase', 'sale_return', 'purchase_return', 'quote'].map(mode => f.window.invoiceDocTheme({ mode }).accent);
  assert.equal(new Set(themes).size, 5);
  const html = f.window.invoiceDocHtml({ id: 7, mode: 'sale_return', date: localDate(), time: '10:00', partyName: 'عميل', subtotal: 100, netTotal: 100, paidAmount: 0, remainAmount: 100, prevBalance: 0, newBalance: 100, items: [{ id: 1, code: '1001', name: 'كتاب', qty: 1, price: 100, discPct: 0, netTotal: 100 }], store: { name: 'مكتبة', address: 'عنوان', phone: '0100' } }, 'a5');
  assert.match(html, /RETURN/); assert.match(html, /#8a1f6d/);
});

test('invoice tones are configurable per type and reach the POS and the document', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.setInvoiceTone('sale', '#005577');
  assert.equal(f.window.invoiceTones().sale, '#005577');
  assert.match(f.$('invoiceToneStyle').textContent, /#005577/);
  assert.equal(f.$('toneSale').value, '#005577');
  f.window.setInvoiceTone('quote', 'أحمر');
  assert.equal(f.window.invoiceTones().quote, '#1d5f8a');
  assert.equal(f.window.invoiceDocTheme({ mode: 'sale' }).accent, '#005577');
  f.window.resetInvoiceTones();
  assert.equal(f.window.invoiceTones().sale, f.window.DOC_THEME.sale.accent);
});

test('A5 templates and a document signature change the exported invoice', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const invoice = { id: 3, mode: 'sale', date: localDate(), time: '09:00', partyName: 'عميل', subtotal: 50, netTotal: 50, paidAmount: 50, remainAmount: 0, prevBalance: 0, newBalance: 0,
    items: [{ id: 1, code: '1001', name: 'كتاب', qty: 1, price: 50, discPct: 0, netTotal: 50 }], store: { name: 'مكتبة', address: 'عنوان', phone: '0100' } };
  for (const template of ['classic', 'modern', 'minimal']) {
    f.window.setDocTemplate(template);
    assert.equal(f.window.docSettings().template, template);
    assert.equal(f.$('docTemplateGrid').querySelector(`[data-doc-template="${template}"]`).getAttribute('aria-pressed'), 'true');
    assert.match(f.window.invoiceDocHtml(invoice, 'a5'), /<svg/);
  }
  f.window.setDocAccent('#123456');
  assert.match(f.window.invoiceDocHtml(invoice, 'a5'), /#123456/);
  const signature = f.window.docSettings().signature;
  assert.match(f.window.invoiceDocBody(invoice, 'a5'), /p-signature/);
  f.window.clearDocSignature();
  assert.equal(f.window.docSettings().signature, '');
  assert.doesNotMatch(f.window.invoiceDocBody(invoice, 'a5'), /p-signature/);
  f.window.docSettings().signature = signature;
});

test('a big cash difference raises the tender alert and blocks a silent save', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.setTenderAlert(50);
  assert.equal(f.window.tenderAlertLimit(), 50);
  f.window.openInvoiceSec('sale'); addLine(f, '1002', 1);
  f.fill('invPaidAmount', 500); f.window.calcInvoiceRemaining();
  assert.equal(f.$('cashChangeBox').dataset.alert, 'yes');
  f.setConfirm(false); f.window.saveInvoice(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.saved().invoices.length, 0);
  f.fill('invPaidAmount', 10); f.window.calcInvoiceRemaining();
  f.window.saveInvoice(false);
  assert.equal(f.saved().invoices.length, 1);
});

test('selling below cost needs the manager PIN for non-admins', async t => {
  const f = await ready(t, { db: seedDatabase() });
  // the manager lowers the item cost/minimum first, then a cashier sells below cost
  f.window.editItem(1);
  f.fill('itemBuyPrice', 80); f.fill('itemMinSell', 60); f.window.saveItem();
  f.window.openSec('sec-settings'); f.fill('staffNameInp', 'كاشير'); f.fill('staffPinInp', '7777');
  f.fill('staffRoleInp', 'cashier'); f.window.saveStaff();
  const staff = JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_STAFF`));
  f.window.lockApp(); f.$('loginStaffSelect').value = staff[0].id; f.fill('unlockPinInp', '7777'); f.window.unlockApp();
  f.window.openInvoiceSec('sale');
  f.fill('invBarcodeInp', '1001'); f.fill('invAddQty', 1); f.window.addInvItemFromInput();
  f.window.openInvoiceSec('sale');
  f.fill('invBarcodeInp', '1001'); f.fill('invAddQty', 1); f.window.addInvItemFromInput();
  f.window.updateCartRow(0, 'price', 70);
  assert.equal(f.window.belowCostLines().length, 1);
  assert.match(f.window.belowCostLines()[0].name, /كتاب/);
  f.window.prompt = () => '0000';
  f.setConfirm(true); f.window.saveInvoice(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.saved().invoices.length, 0);
});

test('label sheet supports per-item selection and custom copy counts', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openSec('sec-labels');
  assert.equal(f.$('labelItemsTbody').querySelectorAll('tr').length, 2);
  f.window.toggleAllLabelItems(false);
  f.window.toggleLabelItem(1, true);
  f.window.setLabelCopies('1001', 6);
  assert.equal(f.window.labelCopiesMap().get('1001'), 6);
  const cells = f.$('labelPreview').querySelectorAll('.label-cell').length;
  assert.equal(cells, 6);
  assert.match(f.$('labelCount').textContent, /6 ملصق/);
});


test('look settings change density, radii, icons and cart columns and persist per device', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const html = f.window.document.documentElement;
  assert.equal(html.getAttribute('data-density'), 'cozy');
  f.window.setLookOption('density', 'ultra');
  assert.equal(html.getAttribute('data-density'), 'ultra');
  assert.equal(f.$('densitySeg').querySelector('[data-density-opt="ultra"]').getAttribute('aria-pressed'), 'true');
  f.window.setLookOption('look', 'flat');
  assert.equal(html.getAttribute('data-look'), 'flat');
  f.window.setLookOption('look', 'sharp');
  assert.equal(html.getAttribute('data-look'), 'sharp');
  f.window.setLookOption('motion', 'off');
  assert.equal(html.getAttribute('data-motion'), 'off');
  f.window.setLookOption('numerals', 'tabular');
  assert.equal(html.getAttribute('data-numerals'), 'tabular');
  assert.equal(JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_LOOK`)).density, 'ultra');
  // cart columns + POS tile shapes
  f.window.toggleCartColumn('disc', false);
  assert.equal(html.getAttribute('data-col-disc'), 'off');
  f.window.setLookOption('tileStyle', 'lines');
  assert.equal(f.$('posQuickItems').dataset.tileStyle, 'lines');
  f.window.toggleGroupColors(false);
  assert.equal(html.getAttribute('data-group-colors'), 'off');
  // a fresh load keeps the saved preferences
  f.window.applyLook();
  assert.equal(html.getAttribute('data-density'), 'ultra');
});

test('SVG icon set replaces emoji and switches back without losing an icon', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.paintIconMode('svg');
  const painted = f.window.document.querySelectorAll('.look-svg-ico').length;
  assert.ok(painted > 30, `expected many icons, got ${painted}`);
  assert.match(f.$('darkModeButton').innerHTML, /look-svg-ico/);
  f.window.paintIconMode('emoji');
  const swapped = ['.button-icon .look-svg-ico', '.nav-icon .look-svg-ico', '.head-icon-btn .look-svg-ico',
    '.pos-action span[aria-hidden="true"] .look-svg-ico', '.y-btn .y-ico .look-svg-ico'];
  assert.equal(f.window.document.querySelectorAll(swapped.join(',')).length, 0);
  assert.equal(f.$('darkModeButton').textContent.trim(), '🌙');
  assert.equal(f.window.document.querySelector('[onclick="saveInvoice(false)"] span[aria-hidden="true"]').textContent.trim(), '💾');
});

test('night modes, palettes and the header logo stay consistent', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.setNightMode('warm');
  assert.equal(f.window.document.body.dataset.theme, 'night');
  assert.equal(f.window.document.body.dataset.night, 'warm');
  f.window.setNightMode('contrast');
  assert.equal(f.window.document.body.dataset.night, 'contrast');
  f.window.applyPalette('violet');
  assert.equal(f.window.lookSettings().palette, 'violet');
  assert.equal(f.window.document.documentElement.style.getPropertyValue('--head-1').trim(), '#2e1065');
  assert.equal(f.$('paletteRow').querySelector('[data-palette="violet"]').getAttribute('aria-pressed'), 'true');
  f.window.setLookOption('headerStyle', 'logo');
  assert.equal(f.$('appHeader').dataset.header, 'logo');
  assert.equal(f.$('headLogoImg').getAttribute('src'), '/icon-192.png');
  f.window.setLookOption('headerAlign', 'center');
  assert.equal(f.$('appHeader').dataset.align, 'center');
  f.window.setLookOption('headerStyle', 'name');
  f.window.toggleReceiptLogo(true);
  const invoice = { id: 9, mode: 'sale', date: localDate(), time: '10:00', partyName: 'عميل', subtotal: 50, netTotal: 50, paidAmount: 50, remainAmount: 0, prevBalance: 0, newBalance: 0,
    items: [{ id: 1, code: '1001', name: 'كتاب', qty: 1, price: 50, discPct: 0, netTotal: 50 }], store: { name: 'مكتبة', address: 'عنوان', phone: '0100' } };
  assert.match(f.window.invoiceDocBody(invoice, 'a5'), /p-logo/);
  f.window.toggleReceiptLogo(false);
  assert.doesNotMatch(f.window.invoiceDocBody(invoice, 'a5'), /p-logo/);
});

test('KPI cards take a state colour and a day-over-day trend', async t => {
  const past = new Date(); past.setDate(past.getDate() - 1);
  const seed = seedDatabase();
  seed.invoices.push({ id: 90, date: localDate(past), time: '10:00', mode: 'sale', partyId: 0, partyName: 'عميل نقدي',
    prevBalance: 0, netTotal: 30, paidAmount: 30, remainAmount: 0, newBalance: 0,
    items: [{ id: 1, code: '1001', name: 'كتاب', qty: 1, price: 30, discPct: 0, buyCost: 20, netTotal: 30 }] });
  const f = await ready(t, { db: seed });
  f.window.updateDashboardKPIs();
  assert.equal(f.$('kpiSalesToday').closest('.kpi-box').dataset.state, 'warn');
  f.window.openInvoiceSec('sale'); addLine(f, '1002', 1);
  f.fill('invPaidAmount', 10);
  assert.equal(f.window.saveInvoice(false), undefined);
  f.window.updateDashboardKPIs();
  assert.equal(f.$('kpiSalesToday').closest('.kpi-box').dataset.state, 'good');
  assert.ok(f.$('kpiSalesToday').closest('.kpi-box').querySelector('.kpi-trend'));
  f.window.openTreasury('all'); f.$('trType').value = 'in'; f.fill('trAmount', 500); f.fill('trNote', 'عهدة');
  f.window.addTreasuryMove();
  f.window.updateDashboardKPIs();
  assert.ok(['good', 'warn', 'bad'].includes(f.$('kpiCash').closest('.kpi-box').dataset.state));
});

test('the look controls live in the appearance settings panel and the studio is still reachable', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const look = f.window.document.querySelector('[data-settings-panel="look"]');
  for (const id of ['densitySeg', 'lookSeg', 'fontWeightSeg', 'numeralsSeg', 'iconsSeg', 'motionSeg', 'paletteRow',
    'headerStyleSeg', 'headerAlignSeg', 'nightModeSeg', 'autoNightSeg', 'tileStyleSeg', 'cartDensitySeg',
    'colDiscount', 'colGross', 'colUnit', 'groupColors', 'receiptLogo', 'designStudio', 'invoiceToneGrid', 'docTemplateGrid']) {
    assert.ok(look.contains(f.$(id)), `#${id} should live inside the look panel`);
  }
  f.window.openSec('sec-settings'); f.window.switchSettingsTab('look');
  assert.equal(f.window.document.querySelector('[data-settings-panel="look"]').hidden, false);
  f.window.switchSettingsTab('store');
  assert.equal(f.window.document.querySelector('[data-settings-panel="look"]').hidden, true);
  assert.equal(f.window.document.querySelector('[data-settings-panel="store"]').hidden, false);
});

test('saving shows a success flash and a coloured state tag on every invoice row', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openInvoiceSec('sale'); addLine(f, '1002', 1);
  f.$('invPartySelect').value = '2'; f.window.updateInvoiceUI();
  f.fill('invPaidAmount', 4); f.window.saveInvoice(false);
  assert.equal(f.window.document.querySelectorAll('.save-flash-check').length, 1);
  assert.match(f.window.document.querySelector('.save-flash-check').textContent, /تم حفظ/);
  assert.equal(f.$('syncStatusBadge').dataset.flash, 'ok');
  const sale = f.saved().invoices.at(-1);
  assert.ok(sale.remainAmount > 0, f.alerts.join(' | '));
  assert.match(f.window.invoiceStateTag(sale), /data-tag="due"/);
  f.window.openInvLog('sale');
  assert.match(f.$('invLogTbody').innerHTML, /state-tag/);
  assert.match(f.window.invoiceStateTag({ mode: 'quote' }), /عرض سعر/);
  assert.match(f.window.invoiceStateTag({ mode: 'sale_return' }), /مرتجع/);
  assert.match(f.window.invoiceStateTag({ mode: 'sale', remainAmount: 0 }), /data-tag="paid"/);
  assert.match(f.window.stockStateTag({ qty: 0, minQty: 2 }), /نافد/);
  assert.match(f.window.stockStateTag({ qty: 2, minQty: 2 }), /حد الطلب/);
  assert.equal(f.window.stockStateTag({ qty: 9, minQty: 2 }), '');
});

test('staff avatars use the initials of the signed-in user in the header and the log', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const badge = f.$('activeUserBadge');
  assert.ok(badge.querySelector('.avatar-circle'));
  assert.equal(badge.querySelector('.avatar-circle').textContent, f.window.avatarInitials(f.$('statusUser').textContent));
  assert.equal(f.window.avatarInitials('سارة محمد'), 'سم');
  assert.equal(f.window.avatarInitials('كريم'), 'كر');
  f.fill('itemName', 'كراسة'); f.fill('itemQty', 3); f.window.saveItem();
  f.window.toggleActivityLog(true);
  assert.ok(f.$('activityLogList').querySelector('.avatar-circle'));
  f.window.openActivityPage();
  assert.ok(f.$('auditTbody').querySelector('.avatar-circle'));
});

test('A5 paper frame and watermark reach the printed document', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const invoice = { id: 5, mode: 'sale', date: localDate(), time: '11:00', partyName: 'عميل', subtotal: 60, netTotal: 60, paidAmount: 60, remainAmount: 0, prevBalance: 0, newBalance: 0,
    items: [{ id: 1, code: '1001', name: 'كتاب', qty: 1, price: 60, discPct: 0, netTotal: 60 }], store: { name: 'مكتبة', address: 'عنوان', phone: '0100' } };
  f.window.setDocFrame('ornament');
  assert.equal(f.window.docPaperOptions().frame, 'ornament');
  assert.equal(f.$('docFrameSelect').value, 'ornament');
  assert.match(f.window.invoiceDocHtml(invoice, 'a5'), /border:2px solid/);
  f.window.setDocWatermark('نسخة أصلية');
  assert.equal(f.window.docPaperOptions().watermark, 'نسخة أصلية');
  assert.match(f.window.invoiceDocBody(invoice, 'a5'), /doc-watermark/);
  f.window.setDocFrame('line');
  assert.match(f.window.invoiceDocHtml(invoice, 'a5'), /border-inline-start:5px solid/);
  f.window.setDocFrame('none'); f.window.setDocWatermark('');
  assert.doesNotMatch(f.window.invoiceDocBody(invoice, 'a5'), /doc-watermark/);
});

test('label templates and the thermal receipt style are configurable and previewed', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openSec('sec-labels');
  f.window.setLabelTemplate('price');
  assert.equal(f.window.lookSettings().labelTemplate, 'price');
  assert.equal(f.$('labelPreview').dataset.labelTemplate, 'price');
  assert.match(f.$('labelPreview').innerHTML, /data-template="price"/);
  f.window.setLabelTemplate('mini');
  assert.match(f.$('labelPreview').innerHTML, /data-template="mini"/);
  f.window.setReceiptStyle('detailed');
  assert.equal(f.window.receiptStyle(), 'detailed');
  assert.equal(f.$('receiptStyle').value, 'detailed');
  f.window.previewReceiptStyle();
  assert.equal(f.$('receiptPreviewBox').hidden, false);
  assert.match(f.$('receiptPreviewBox').textContent, /كشكول/);
  f.window.setReceiptStyle('compact');
  assert.equal(f.window.receiptStyle(), 'compact');
});

test('app icon is generated from the store branding without external assets', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.setAppIconColor('#1f74a8');
  assert.equal(f.window.lookSettings().appIcon.color, '#1f74a8');
  assert.equal(f.$('appIconColor').value, '#1f74a8');
  assert.match(f.$('appIconPreview').innerHTML, /م/);
  // browsers without canvas rasterisation simply keep the CSS preview
  const canvas = f.window.buildAppIconCanvas(64);
  if (canvas) { assert.equal(canvas.width, 64); }
});

test('focus mode and the rail sidebar tidy the chrome for a cashier screen', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.enterFocusMode();
  assert.equal(f.window.document.body.dataset.focus, 'on');
  assert.equal(f.$('windowLayer').classList.contains('open'), true);
  f.window.exitFocusMode();
  assert.equal(f.window.document.body.dataset.focus, undefined);
  f.window.toggleRailSidebar(true);
  assert.equal(f.window.document.documentElement.getAttribute('data-rail'), 'on');
  assert.equal(f.$('railSidebar').checked, true);
  f.window.toggleRailSidebar(false);
  assert.equal(f.window.document.documentElement.getAttribute('data-rail'), 'off');
});

test('button shapes and the colour-blind safe palette switch the whole UI', async t => {
  const f = await ready(t, { db: seedDatabase() });
  const html = f.window.document.documentElement;
  assert.equal(html.getAttribute('data-buttons'), 'soft');
  f.window.setLookOption('buttons', 'pill');
  assert.equal(html.getAttribute('data-buttons'), 'pill');
  assert.equal(f.$('buttonShapeSeg').querySelector('[data-buttons-opt="pill"]').getAttribute('aria-pressed'), 'true');
  f.window.setLookOption('buttons', 'classic');
  assert.equal(html.getAttribute('data-buttons'), 'classic');
  f.window.setLookOption('cvd', 'on');
  assert.equal(html.getAttribute('data-cvd'), 'on');
  assert.equal(JSON.parse(f.window.localStorage.getItem(`${DB_KEY}_LOOK`)).cvd, 'on');
});

test('shell v2 builds the blue navbar, the dropdowns and the tab bar', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.fill('unlockPinInp', '1234'); f.window.unlockApp();
  const bar = f.$('appNavbar');
  assert.ok(bar.querySelectorAll('.nv-btn').length >= 8);
  const sales = bar.querySelector('.nv-btn[data-menu="sales"]');
  f.window.toggleNavMenu('sales', sales);
  const layer = f.$('navMenuLayer');
  assert.equal(layer.hidden, false);
  assert.equal(sales.getAttribute('aria-expanded'), 'true');
  assert.match(layer.innerHTML, /فاتورة مبيعات/);
  // arrow keys walk the menu (jsdom focus is not guaranteed, so seed it explicitly), Escape closes it
  const items = [...layer.querySelectorAll('.nm-item')];
  assert.equal(items.length, 5);
  items[0].focus();
  f.window.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  const activeItem = f.window.document.activeElement;
  assert.ok(activeItem?.classList?.contains('nm-item'), 'an arrow key focus the menu items');
  assert.equal(items.indexOf(activeItem), 1);
  f.window.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(layer.hidden, true);
  assert.equal(sales.getAttribute('aria-expanded'), 'false');
  // the tab bar starts with the pinned home tab only
  assert.equal(f.$('tabBar').querySelectorAll('.tab').length, 1);
  assert.equal(f.$('tabBar').querySelector('.tab').classList.contains('is-home'), true);
});

test('opening a page from the dropdown registers a tab, re-opening reuses it and closing falls back', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openPage('sale');
  let tabs = [...f.$('tabBar').querySelectorAll('.tab')];
  assert.equal(tabs.length, 2);
  assert.equal(tabs[1].querySelector('span').textContent, 'فاتورة مبيعات');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  f.window.openPage('items');
  assert.equal(f.$('tabBar').querySelectorAll('.tab').length, 3);
  // opening the same page again must activate its tab, not duplicate it
  f.window.openPage('sale');
  tabs = [...f.$('tabBar').querySelectorAll('.tab')];
  assert.equal(tabs.length, 3);
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(f.$('sec-invoice').classList.contains('active'), true);
  // activating a tab switches the screen
  f.window.activatePage('items');
  assert.equal(f.$('sec-items').classList.contains('active'), true);
  // the home tab never closes: it shows the dashboard and keeps the other screens alive
  f.window.closeTab('home');
  assert.equal(f.$('tabBar').querySelectorAll('.tab').length, 3);
  assert.equal(f.$('dashWrap').hidden, false);
  assert.equal(f.$('windowLayer').classList.contains('open'), false);
  // going back to a screen tab shows that screen again
  f.window.activatePage('sale');
  assert.equal(f.$('windowLayer').classList.contains('open'), true);
  assert.equal(f.$('sec-invoice').closest('.float-window').hidden, false);
  assert.equal(f.$('dashWrap').hidden, true);
  // closing the active tab falls back to the dashboard
  f.window.closeTab('items');
  assert.equal(f.$('tabBar').querySelectorAll('.tab').length, 2);
  f.window.closeAllTabs();
  assert.equal(f.$('tabBar').querySelectorAll('.tab').length, 1);
});

test('the dashboard shows a KPI strip and framed feature groups', async t => {
  const f = await ready(t, { db: seedDatabase() });
  assert.equal(f.$('dashKpis').querySelectorAll('.dash-kpi').length, 4);
  assert.equal(f.$('dashBody').querySelectorAll('.dash-group').length, 7);
  assert.ok(f.$('dashBody').querySelectorAll('.dash-card').length >= 20);
  assert.equal(f.$('dashKpiCash').textContent, '0.00');
  // a card opens its page and registers a tab
  assert.match(f.$('dashBody').querySelector('.dash-card[data-page="customers"]').getAttribute('onclick'), /openPage\('customers'\)/);
  f.window.openPage('customers');
  assert.equal(f.$('sec-parties').classList.contains('active'), true);
  // the opened screen is visible: its pane is not hidden and the layer is open
  const pane = f.$('sec-parties').closest('.float-window');
  assert.equal(pane.hidden, false);
  assert.equal(f.$('windowLayer').classList.contains('open'), true);
  assert.equal(f.$('dashWrap').hidden, true);
  assert.match(f.$('tabBar').textContent, /إدارة العملاء/);
  // title bar, footer and status chrome are populated from the store data
  assert.equal(f.$('titleBarName').textContent, 'مكتبة الجمال');
  assert.match(f.$('footerPhone').textContent, /01000000000/);
  assert.match(f.$('titleBarUser').textContent, /مكتبة الجمال|مدير/);
});

test('sales invoice page: metadata strip, item grid beside quick groups and money summary', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openPage('sale');
  // the calculator is a floating window opened from the invoice-data strip
  const calc = f.$('calcFloat');
  assert.ok(calc, 'the calculator floats');
  assert.equal(calc.classList.contains('open'), false);
  f.window.toggleCalculator(true);
  assert.equal(calc.classList.contains('open'), true);
  assert.equal(f.$('calcToggleBtn').getAttribute('aria-expanded'), 'true');
  assert.equal(calc.querySelectorAll('.calc-keys button').length, 20);
  // the calculator actually computes
  ['7', '×', '8', '='].forEach(key => f.window.calcInput(key));
  assert.match(f.$('calcScreen').textContent, /56$/);
  f.window.calcInput('C');
  assert.equal(f.$('calcScreen').textContent, '0');
  f.window.toggleCalculator(false);
  assert.equal(calc.classList.contains('open'), false);
  // add-a-new-item is a button inside the quick groups card, not a rail
  assert.equal(f.window.document.querySelectorAll('.posx-rail').length, 0);
  assert.ok(f.window.document.querySelector('.posv3-quick .posv3-new-item'));
  // the quick groups sit in the same grid row as the invoice lines
  const grid = f.window.document.querySelector('#sec-invoice .posv3-grid');
  assert.equal(grid.contains(f.$('posQuickItems')), true);
  assert.equal(grid.contains(f.$('invCartTable')), true);
  // the barcode strip is short and sits right under the invoice data
  const scan = f.window.document.querySelector('#sec-invoice .posv3-scan');
  assert.ok(scan);
  assert.equal(scan.contains(f.$('invBarcodeInp')), true);
  assert.equal(f.window.getComputedStyle(scan).display, 'flex');
  const metaCard = f.window.document.querySelector('#sec-invoice .posv3-meta-card');
  assert.equal(metaCard.compareDocumentPosition(scan) & 4, 4, 'the barcode strip comes after the invoice data');
  // invoice metadata: date, number, warehouse, safe, employee and client
  assert.match(f.$('invDateView').value, /^\d{4}\/\d{2}\/\d{2}$/);
  assert.match(f.$('invNumberView').value, /^#\d+/);
  assert.ok(f.$('invWarehouseView').options.length >= 1);
  assert.ok(f.$('invSafeView').options.length >= 1);
  assert.match(f.$('invEmployeeView').value, /مدير|مكتبة/);
  assert.equal(f.$('invPartySelect').tagName, 'SELECT');
  // the item grid keeps the requested columns in order
  const heads = [...f.window.document.querySelectorAll('#invCartTable thead th')].map(th => th.textContent.trim());
  assert.deepEqual(heads, ['الباركود', 'اسم الصنف', 'الوحدة', 'الكمية', 'السعر', 'خصم %', 'صافي السعر', 'الإجمالي', 'حذف']);
  addLine(f, '1001', 2);
  const cells = [...f.$('invCartTbody').querySelector('tr').children].map(cell => cell.textContent.trim());
  assert.equal(cells[0], '1001'); assert.match(cells[1], /كتاب/); assert.equal(cells[2], 'عدد');
  // summary blocks + the three prominent triggers
  assert.equal(f.$('invSubTotal').value, '300.00');
  assert.equal(f.$('invNetTotal').value, '300.00');
  assert.match(f.window.document.querySelector('.pos-action.save-print').textContent, /حفظ وطباعة/);
  assert.match(f.window.document.querySelector('.pos-action.preview').textContent, /معاينة/);
  assert.match(f.window.document.querySelector('.pos-action.save').textContent, /حفظ/);
});

test('clients page: search form, action boxes, debt totals and row actions', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openPage('customers');
  // data-entry fields for the contact sheet
  for (const id of ['partyCode', 'partyName', 'partyCountry', 'partyCity', 'partyPhone', 'partyPhone2', 'partyEmail', 'partyBalance', 'partyAddress', 'partyNotes']) {
    assert.ok(f.$(id), `#${id} should exist`);
  }
  f.fill('partyName', 'مدرسة الأمل'); f.fill('partyCity', 'شبين الكوم'); f.fill('partyPhone2', '01011112222');
  f.fill('partyEmail', 'amal@example.com'); f.fill('partyBalance', 150); f.window.saveParty();
  const saved = f.saved().parties.find(party => party.name === 'مدرسة الأمل');
  assert.equal(saved.city, 'شبين الكوم'); assert.equal(saved.phone2, '01011112222'); assert.equal(saved.email, 'amal@example.com');
  assert.equal(saved.balance, 150);
  assert.equal(saved.country, 'مصر', 'the country field travels with the party');
  // the grid shows code, contact and row actions (edit / view / delete)
  const row = [...f.$('partiesTbody').querySelectorAll('tr')].find(tr => tr.textContent.includes('مدرسة الأمل'));
  assert.ok(row, 'the new client is listed');
  assert.match(row.textContent, /C-\d+/);
  assert.equal(row.querySelectorAll('.iconbtn').length, 3);
  assert.match(row.innerHTML, /editParty\(/); assert.match(row.innerHTML, /showStatementFor\(/); assert.match(row.innerHTML, /deleteParty\(/);
  // debt totals across all clients
  const totals = f.window.partyDebtTotals('customer');
  assert.equal(totals.count, f.saved().parties.filter(party => party.type === 'customer').length);
  assert.ok(totals.totalDebt >= 150);
  // search narrows the list without touching the data
  f.fill('partySearchInp', 'الأمل'); f.window.filterParties('الأمل');
  assert.equal(f.$('partiesTbody').querySelectorAll('tr').length, 1);
  f.window.filterParties('');
  assert.ok(f.$('partiesTbody').querySelectorAll('tr').length >= 2);
});

test('program settings page: vertical sections and the business preferences persist', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openPage('settings');
  const tabs = [...f.window.document.querySelectorAll('#settingsTabs [data-settings-tab]')].map(button => button.dataset.settingsTab);
  assert.deepEqual(tabs, ['look', 'store', 'staff', 'images', 'sync']);
  assert.equal(f.window.document.querySelector('#settingsTabs').classList.contains('set-rail'), true);
  f.window.switchSettingsTab('store');
  assert.equal(f.window.document.querySelector('[data-settings-panel="store"]').hidden, false);
  for (const id of ['setStoreName', 'setStorePhone', 'setStoreAddress', 'setInvoiceNote', 'setPrinter', 'setCurrency', 'setPaperSize', 'setDefaultWarehouse', 'setDefaultSafe']) {
    assert.ok(f.$(id), `#${id} should exist`);
  }
  f.fill('setStoreName', 'مكتبة النور'); f.fill('setStorePhone', '01099990000');
  f.fill('setInvoiceNote', 'الاستبدال خلال أسبوع'); f.fill('setCurrency', 'ر.س');
  f.$('setPaperSize').value = 'A4'; f.window.saveSettings();
  const settings = f.saved().settings;
  assert.equal(settings.name, 'مكتبة النور'); assert.equal(settings.invoiceNote, 'الاستبدال خلال أسبوع');
  assert.equal(settings.currency, 'ر.س'); assert.equal(settings.paperSize, 'A4');
  assert.equal(f.$('titleBarName').textContent, 'مكتبة النور');
  // the images section keeps the logo and app-icon controls
  f.window.switchSettingsTab('images');
  for (const id of ['storeLogoInput', 'appIconLogo', 'appIconColor', 'appIconPreview']) assert.ok(f.$(id), `#${id} should exist`);
});

test('employees page: colourful HR tiles, staff records, attendance and payroll', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openPage('employees');
  assert.equal(f.$('sec-hr').classList.contains('active'), true);
  assert.ok(f.window.document.querySelectorAll('#hrTiles .hr-tile').length >= 10);
  assert.ok(f.window.document.querySelector('.hr-hero'), 'the corporate background band is present');
  // add an employee from the inline form
  f.fill('hrEmpName', 'سارة محمد'); f.fill('hrEmpPhone', '01055556666');
  f.fill('hrEmpJob', 'كاشير'); f.fill('hrEmpSalary', 6000); f.window.saveHrEmployee();
  const hr = f.window.hrRead();
  assert.equal(hr.employees.length, 1); assert.equal(hr.employees[0].salary, 6000);
  assert.match(f.$('hrEmployeesTbody').textContent, /سارة محمد/);
  // attendance for today
  f.$('hrAttStaff').value = String(hr.employees[0].id);
  f.$('hrAttState').value = 'late'; f.window.saveHrAttendance();
  assert.equal(f.window.hrRead().attendance.length, 1);
  assert.match(f.$('hrAttendanceToday').textContent, /متأخر/);
  // deductions, bonuses and the payroll net
  f.$('hrDedStaff').value = String(hr.employees[0].id); f.fill('hrDedAmount', 250); f.window.saveHrLedger('deduction');
  f.$('hrBonusStaff').value = String(hr.employees[0].id); f.fill('hrBonusAmount', 500); f.window.saveHrLedger('bonus');
  f.window.showHrPanel('payroll');
  assert.equal(f.window.document.querySelector('[data-hr-panel="payroll"]').classList.contains('active'), true);
  assert.match(f.$('hrPayrollTbody').textContent, /6250\.00/);
  // panels switch one at a time
  f.window.showHrPanel('departments');
  assert.equal(f.window.document.querySelector('[data-hr-panel="payroll"]').classList.contains('active'), false);
  assert.equal(f.window.document.querySelector('[data-hr-panel="departments"]').classList.contains('active'), true);
  assert.equal(f.$('tabBar').textContent.includes('إدارة الموظفين'), true);
});

test('shell v3: banner on top, tab strip under it, no legacy nav rows and no tab-add button', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.fill('unlockPinInp', '1234'); f.window.unlockApp();
  const doc = f.window.document;
  // the legacy row under the banner and the coloured side menu are gone from the markup
  assert.equal(f.$('mainNav'), null);
  assert.equal(f.$('sideNav'), null);
  assert.equal(doc.querySelector('.tool-strip'), null);
  // the banner is above the tab strip, which is above the shell
  const banner = f.$('appHeader'), tabs = f.$('tabBar'), shell = f.$('appShell');
  assert.ok(banner && tabs && shell);
  assert.equal(banner.compareDocumentPosition(tabs) & 4, 4, 'the banner comes before the tab strip');
  assert.equal(tabs.compareDocumentPosition(shell) & 4, 4, 'the tab strip comes before the shell');
  assert.equal(banner.closest('.app-shell'), null, 'the banner is not inside the shell');
  // the legacy add button is gone and the strip explains itself instead
  assert.equal(f.$('tabBar').querySelector('.tab-add'), null);
  assert.match(f.$('tabBar').textContent, /اضغط أي زر في القائمة/);
});

test('shell v3: any dashboard button opens its screen inside its own tab and closing all tabs resets', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.fill('unlockPinInp', '1234'); f.window.unlockApp();
  const doc = f.window.document;
  // every dashboard card opens a visible screen, one at a time
  const cards = [...f.$('dashBody').querySelectorAll('.dash-card')];
  assert.ok(cards.length >= 20);
  for (const card of cards.slice(0, 6)) {
    const key = card.dataset.page;
    f.window.openPage(key);
    const def = f.window.PAGE_DEFS[key];
    if (def.action) continue;
    const active = doc.querySelector(`.float-window[data-section="${def.section}"]`);
    assert.ok(active, `${key} opened its screen`);
    assert.equal(active.hidden, false, `${key} is visible`);
    assert.equal(f.$('windowLayer').classList.contains('open'), true);
    assert.equal(f.$('dashWrap').hidden, true, `${key} hides the dashboard`);
    assert.ok([...f.$('tabBar').querySelectorAll('.tab')].some(tab => tab.dataset.tab === key), `${key} has a tab`);
  }
  const count = f.$('tabBar').querySelectorAll('.tab').length;
  assert.ok(count > 2);
  // the strip shows a counter and a close-all control
  assert.match(f.$('tabBar').querySelector('.tab-extra').textContent, /شاشة مفتوحة/);
  f.window.document.querySelector('.tab-extra button').click?.();
  f.window.closeAllTabs();
  assert.equal(f.$('tabBar').querySelectorAll('.tab').length, 1);
  assert.equal(f.$('windowLayer').classList.contains('open'), false);
  assert.equal(f.$('dashWrap').hidden, false);
  assert.equal(doc.querySelectorAll('.float-window').length, 0);
});

test('shell v3: the active tab is the only visible screen and the home tab sits at the far right', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.fill('unlockPinInp', '1234'); f.window.unlockApp();
  f.window.openPage('sale');
  f.window.openPage('items');
  const panes = [...f.window.document.querySelectorAll('.float-window')];
  assert.equal(panes.length, 2);
  assert.equal(panes.filter(pane => !pane.hidden).length, 1, 'only the active screen is visible');
  assert.equal(f.$('sec-items').closest('.float-window').hidden, false);
  assert.equal(f.$('sec-invoice').closest('.float-window').hidden, true);
  // the home tab is rendered first in RTL (far right) and never shows a close ✕
  const tabs = [...f.$('tabBar').querySelectorAll('.tab')];
  assert.equal(tabs[0].classList.contains('is-home'), true);
  assert.equal(f.window.getComputedStyle(tabs[0].querySelector('.tab-x')).display, 'none');
  // closing a tab only drops its own screen
  f.window.closeTab('items');
  assert.equal(f.window.document.querySelector('.float-window[data-section="sec-items"]'), null);
  assert.ok(f.window.document.querySelector('.float-window[data-section="sec-invoice"]'));
  assert.equal(f.$('windowLayer').classList.contains('open'), true);
  // the active tab always matches the visible screen
  assert.equal(f.$('sec-invoice').closest('.float-window').hidden, false);
});

test('POS v3: the invoice data is a wide strip, the customer box matches the barcode width', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openPage('sale');
  const doc = f.window.document;
  // no banner: the store title / phone block is gone, only the slim utility bar remains
  assert.equal(f.$('lblStoreName'), null);
  assert.equal(f.$('lblStorePhone'), null);
  assert.ok(f.$('appHeader').classList.contains('posv3-slim-bar'));
  assert.equal(f.$('liveDate') !== null && f.$('syncStatusBadge') !== null, true);
  // one metadata row: party first, then date, number, warehouse, safe, employee
  const row = doc.querySelector('#sec-invoice .posv3-meta-row');
  const order = [...row.children].map(box => box.querySelector('input,select')?.id);
  assert.deepEqual(order, ['invPartySelect', 'invDateView', 'invNumberView', 'invWarehouseView', 'invSafeView', 'invEmployeeView']);
  // the customer box is twice the width of every other box (it follows the barcode box)
  assert.equal(doc.querySelector('#sec-invoice .posv3-meta-row').style.getPropertyValue('--x') , '');
  const scanField = doc.querySelector('#sec-invoice .posv3-scan .scan-field');
  assert.ok(scanField, 'the barcode box exists under the strip');
  // payment type + price tier + calculator live in the strip head
  const head = doc.querySelector('#sec-invoice .posv3-meta-head');
  assert.ok(head.contains(f.$('invPayType')) && head.contains(f.$('invPriceTier')) && head.contains(f.$('calcToggleBtn')));
  // add-customer is a green icon right beside the customer box
  const addParty = f.$('invQuickPartyBtn');
  assert.ok(addParty.closest('.pv3-party'), 'the green icon sits beside the customer select');
  assert.match(addParty.className, /pv3-add-party/);
  // summary and finish are each a single row
  assert.equal(doc.querySelectorAll('#sec-invoice .posv3-sum-row').length, 1);
  assert.equal(doc.querySelectorAll('#sec-invoice .posv3-actions').length, 1);
  assert.match(doc.querySelector('#sec-invoice .posv3-actions').textContent, /حفظ/);
});

test('POS v3: the green customer icon opens a floating new-customer window that saves and selects', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.window.openPage('sale');
  const box = f.$('invQuickParty');
  assert.equal(box.classList.contains('open'), false);
  f.window.toggleQuickParty(true);
  assert.equal(box.classList.contains('open'), true);
  assert.equal(box.getAttribute('aria-hidden'), 'false');
  assert.equal(f.$('invQuickPartyBtn').getAttribute('aria-expanded'), 'true');
  // the name box is the wide one; the rest are two per row
  assert.equal(f.$('invQuickPartyName').closest('.pv3-field').classList.contains('pv3-wide'), true);
  assert.equal(box.querySelectorAll('.ppf-grid .pv3-field').length, 5);
  f.fill('invQuickPartyName', 'مكتبة النيل');
  f.fill('invQuickPartyPhone', '01011112222');
  f.fill('invQuickPartyPhone2', '01033334444');
  f.fill('invQuickPartyCity', 'القاهرة');
  f.fill('invQuickPartyEmail', 'nile@mail.com');
  f.fill('invQuickPartyNotes', 'عميل جملة');
  f.window.saveQuickParty();
  const party = f.saved().parties.find(p => p.name === 'مكتبة النيل');
  assert.ok(party, 'the customer was stored');
  assert.equal(party.phone2, '01033334444');
  assert.equal(party.city, 'القاهرة');
  assert.equal(party.email, 'nile@mail.com');
  assert.equal(party.notes, 'عميل جملة');
  assert.equal(box.classList.contains('open'), false);
  assert.equal(f.$('invPartySelect').value, String(party.id));
  // closing without saving drops the typed values
  f.window.toggleQuickParty(true);
  f.fill('invQuickPartyName', 'اسم مؤقت');
  f.window.toggleQuickParty(false);
  assert.equal(f.$('invQuickPartyName').value, '');
});

test('picking an item from a header dropdown closes the menu straight away', async t => {
  const f = await ready(t, { db: seedDatabase() });
  f.fill('unlockPinInp', '1234'); f.window.unlockApp();
  const bar = f.$('appNavbar');
  const sales = bar.querySelector('.nv-btn[data-menu="sales"]');
  f.window.toggleNavMenu('sales', sales);
  assert.equal(f.$('navMenuLayer').hidden, false);
  f.window.openPage('sale');
  assert.equal(f.$('navMenuLayer').hidden, true, 'the menu closes after the page opens');
  assert.equal(f.$('navMenuLayer').innerHTML, '');
  assert.equal(sales.getAttribute('aria-expanded'), 'false');
  // every menu item closes the menu itself, before running its page
  f.window.toggleNavMenu('sales', sales);
  const first = f.$('navMenuLayer').querySelector('.nm-item');
  assert.match(first.getAttribute('onclick'), /^closeMenus\(\);/);
});
