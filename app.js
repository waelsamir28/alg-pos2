import { INVOICE_MODES, MODE_LABELS, roundMoney, roundQuantity, lineGross, calculateTotals, invoiceLines, weightedAverageCost, localDate, nextId } from './lib/finance.js';
import { emptyDatabase, normalizeDatabase, returnedQuantity } from './lib/data.js';
import { code39Svg } from './lib/barcode.js';

const DB_KEY = 'BOOKSTORE_POS_COMPLETE_DB_V2';
const META_KEY = `${DB_KEY}_SYNC_META`;
const TOKEN_KEY = `${DB_KEY}_SESSION_TOKEN`;
const REMEMBERED_TOKEN_KEY = `${DB_KEY}_REMEMBERED_TOKEN`;
const APPEARANCE_KEY = `${DB_KEY}_APPEARANCE`;
const STAFF_KEY = `${DB_KEY}_STAFF`;
const AUDIT_KEY = `${DB_KEY}_AUDIT`;
const HELD_CARTS_KEY = `${DB_KEY}_HELD_CARTS`;
const ACTIVE_STAFF_KEY = `${DB_KEY}_ACTIVE_STAFF`;
const $ = id => document.getElementById(id);
const clone = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => roundMoney(Number(value) || 0).toFixed(2);
const num = id => $(id).value.trim() === '' ? NaN : Number($(id).value);
const options = (list, label) => list.map(p => `<option value="${esc(p.id)}">${esc(label(p))}</option>`).join('');
let db = emptyDatabase();
let invCart = [];
let quickEditMode = false;
let storageBlocked = false;
let recoveryRaw = null;
let localVersion = 0;
let syncMeta = { revision: null, dirty: true };
let syncTimer = null;
let syncQueue = Promise.resolve();
let syncBusy = false;
let lastInvoiceMode = 'sale';
let beforeLockFocus = null;
let clockTimer;
let activeStaffId = 'owner';
let staffSession = null;

function safeReadArray(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function staffList() {
  const employees = safeReadArray(STAFF_KEY).filter(user => user && user.id && user.role !== 'admin');
  return [{ id: 'owner', name: db.settings.name || 'المدير', role: 'admin', pin: db.settings.pin || '1234' }, ...employees];
}
function activeStaff() { return staffList().find(user => user.id === activeStaffId) || staffList()[0]; }
function isAdmin() { return activeStaff().role === 'admin'; }
function can(permission) {
  if (isAdmin()) return true;
  const roles = {
    cashier: ['sale', 'sale-return', 'quote', 'customer', 'sales-log', 'cash'],
    inventory: ['inventory', 'purchase', 'supplier', 'purchase-log', 'stock']
  };
  return (roles[activeStaff().role] || []).includes(permission);
}
function ensurePermission(permission) {
  if (can(permission)) return true;
  notify(`هذه العملية غير متاحة لحساب «${activeStaff().name}». اطلب من المدير تغيير الصلاحية.`);
  return false;
}
function updateActiveUserBadge() {
  const badge = $('activeUserBadge'); if (badge) badge.textContent = `${activeStaff().name} · ${roleLabel(activeStaff().role)}`;
}
function roleLabel(role) { return ({ admin: 'مدير', cashier: 'كاشير', inventory: 'مخزن' })[role] || 'موظف'; }
function recordAudit(action) {
  try {
    const entries = safeReadArray(AUDIT_KEY);
    entries.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: new Date().toLocaleString('ar-EG'), user: activeStaff().name, role: activeStaff().role, action: String(action).slice(0, 180) });
    localStorage.setItem(AUDIT_KEY, JSON.stringify(entries.slice(0, 500)));
  } catch { /* Audit storage must never prevent a business transaction from saving. */ }
}
function recordDBAudit(previous, next) {
  const changed = [];
  for (const [key, label] of [['items','الأصناف والمخزون'], ['invoices','الفواتير'], ['parties','حسابات العملاء والموردين'], ['treasury','حركات الخزنة'], ['categories','المجموعات'], ['settings','الإعدادات']]) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changed.push(label);
  }
  if (changed.length) recordAudit(`تعديل: ${changed.join('، ')}`);
}
function renderStaffTable() {
  const body = $('staffTbody'); if (!body) return;
  const employees = safeReadArray(STAFF_KEY);
  body.innerHTML = `<tr><td>1</td><td>${esc(db.settings.name || 'المدير')}</td><td>مدير</td><td>حساب المالك</td><td>—</td></tr>` + employees.map((user, index) => `<tr><td>${index + 2}</td><td>${esc(user.name)}</td><td>${roleLabel(user.role)}</td><td>مستخدم محلي</td><td><button type="button" class="act-btn bg-red" onclick="deleteStaff('${encodeURIComponent(user.id)}')">حذف</button></td></tr>`).join('');
}
function renderAuditTable() {
  const body = $('auditTbody'); if (!body) return;
  body.innerHTML = safeReadArray(AUDIT_KEY).slice(0, 50).map(entry => `<tr><td>${esc(entry.time)}</td><td>${esc(entry.user)} (${roleLabel(entry.role)})</td><td>${esc(entry.action)}</td></tr>`).join('') || '<tr><td colspan="3">لا توجد حركات مسجلة بعد.</td></tr>';
}
function saveStaff() {
  if (!ensurePermission('admin')) return;
  const name = $('staffNameInp').value.trim(), pin = $('staffPinInp').value.trim(), role = $('staffRoleInp').value;
  if (name.length < 2 || pin.length < 4) return alert('أدخل اسم الموظف ورقماً سرياً من 4 أحرف/أرقام على الأقل.');
  if (!['cashier', 'inventory'].includes(role)) return alert('اختر صلاحية موظف صحيحة.');
  const users = safeReadArray(STAFF_KEY), id = `staff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  users.push({ id, name, pin, role });
  try { localStorage.setItem(STAFF_KEY, JSON.stringify(users)); }
  catch { return alert('تعذر حفظ بيانات الموظف في المتصفح.'); }
  $('staffNameInp').value = ''; $('staffPinInp').value = ''; renderStaffTable(); recordAudit(`إضافة مستخدم موظف بصلاحية ${roleLabel(role)}`);
}
function deleteStaff(id) {
  if (!ensurePermission('admin')) return;
  try { id = decodeURIComponent(id); } catch { return; }
  if (!confirm('حذف حساب الموظف؟')) return;
  const users = safeReadArray(STAFF_KEY).filter(user => user.id !== id);
  localStorage.setItem(STAFF_KEY, JSON.stringify(users));
  if (activeStaffId === id) { activeStaffId = 'owner'; try { sessionStorage.setItem(ACTIVE_STAFF_KEY, 'owner'); } catch { /* Keep the local active manager session. */ } }
  updateActiveUserBadge(); renderStaffTable(); recordAudit('حذف حساب موظف');
}
function renderHeldCount() {
  const button = $('restoreHeldButton'); if (button) { const count = safeReadArray(HELD_CARTS_KEY).length; button.textContent = `↩ استعادة فاتورة معلقة (${count})`; button.disabled = !count; }
}
function notify(message) {
  const box = $('appNotice');
  box.innerHTML = `<button type="button" aria-label="إغلاق التنبيه" onclick="this.parentElement.hidden=true">×</button>${esc(message)}`;
  box.hidden = false;
}
function sessionToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(REMEMBERED_TOKEN_KEY) || ''; } catch { return ''; }
}
function setSyncStatus(message) {
  const badge = $('syncStatusBadge'); badge.textContent = message;
  const state = /متزامن مع/.test(message) ? 'synced' : /غير متاحة|تعارض|يحتاج إصلاح|لم تكتمل/.test(message) ? 'error' : 'local';
  badge.dataset.state = state;
  const navStatus = document.querySelector('.side-nav-foot .nav-label');
  if (navStatus) navStatus.textContent = state === 'synced' ? 'متصل ومتزامن' : state === 'error' ? 'يحتاج مراجعة' : 'محفوظ على هذا الجهاز';
  renderSystemAlerts();
}
function readMeta() {
  try {
    const meta = JSON.parse(localStorage.getItem(META_KEY) || 'null');
    if (meta && Number.isSafeInteger(meta.revision) && meta.revision >= 0) return { revision: meta.revision, dirty: Boolean(meta.dirty) };
  } catch { /* Unsynced local data must never be overwritten automatically. */ }
  return { revision: null, dirty: true };
}
function writeMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify(meta));
  syncMeta = meta;
}
function loadDB() {
  let raw;
  try { raw = localStorage.getItem(DB_KEY); }
  catch { storageBlocked = true; notify('المتصفح يمنع التخزين المحلي. لن تُحفظ تعديلات جديدة حتى تسمح بالتخزين؛ صدّر نسخة احتياطية قبل الإغلاق.'); return; }
  if (raw) {
    try { db = normalizeDatabase(JSON.parse(raw), { strict: false }); storageBlocked = false; }
    catch {
      recoveryRaw = raw; storageBlocked = true; db = emptyDatabase();
      notify('البيانات المحلية غير صالحة. لم نستبدل النسخة الأصلية. يمكنك تنزيلها للاستعادة قبل إدخال بيانات جديدة.');
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = 'تنزيل البيانات الأصلية'; button.onclick = exportRecovery;
      $('appNotice').append(button);
    }
  } else { db = emptyDatabase(); storageBlocked = false; }
  syncMeta = readMeta();
  applySettingsUI(); updateDashboardKPIs();
  setSyncStatus(storageBlocked ? 'التخزين المحلي يحتاج إصلاحاً' : (syncMeta.dirty ? 'محفوظ محلياً — غير متزامن' : 'متزامن مع Neon ✅'));
}
// Commit a complete candidate only after storage succeeds. A failed write never changes stock or balances.
function persistDB(candidate, { sync = true } = {}) {
  if (storageBlocked) { alert('التخزين المحلي غير متاح. أصلح إذن التخزين أو استعد نسخة صالحة أولاً.'); return false; }
  try {
    const next = normalizeDatabase(candidate, { strict: false });
    const meta = { ...syncMeta, dirty: true };
    writeLocalState(next, meta);
    const previousDB = db;
    db = next; localVersion += 1; syncMeta = meta;
    recordDBAudit(previousDB, next);
    updateDashboardKPIs();
    setSyncStatus(sessionToken() ? 'محفوظ محلياً — في انتظار المزامنة' : 'محفوظ محلياً — المزامنة غير مفعلة');
    if (sync) scheduleAutoSync();
    return true;
  } catch (error) {
    notify(`لم يُحفظ التعديل: ${error.message}. قد تكون مساحة المتصفح ممتلئة؛ صدّر نسخة احتياطية.`);
    return false;
  }
}
function writeLocalState(next, meta) {
  const previousMeta = localStorage.getItem(META_KEY);
  // Write the small metadata first, then roll it back if the payload cannot be stored.
  localStorage.setItem(META_KEY, JSON.stringify(meta));
  try { localStorage.setItem(DB_KEY, JSON.stringify(next)); }
  catch (error) {
    try { if (previousMeta === null) localStorage.removeItem(META_KEY); else localStorage.setItem(META_KEY, previousMeta); }
    catch { storageBlocked = true; }
    throw error;
  }
}
function commitDB(change) {
  const candidate = clone(db);
  try { change(candidate); return persistDB(candidate); }
  catch (error) { alert(error.message); return false; }
}
function scheduleAutoSync() {
  window.clearTimeout(syncTimer);
  if (sessionToken() && syncMeta.revision !== null && !storageBlocked) syncTimer = window.setTimeout(() => syncToCloud('auto_push'), 1200);
}
function updateClock() {
  const now = new Date();
  $('liveDate').textContent = localDate(now).replaceAll('-', '/');
  $('liveTime').textContent = now.toTimeString().slice(0, 8);
}
function initializeApp() {
  applyAppearance(); applySidebarPreference(); decorateActionButtons(); loadDB(); updateClock(); populateCategoriesSelect(); renderItemsTable(); generateNewCode(); updateInvoiceUI(); updateActiveUserBadge(); renderHeldCount(); renderSystemAlerts();
  window.clearInterval(clockTimer);
  clockTimer = window.setInterval(updateClock, 1000);
  window.addEventListener('online', scheduleAutoSync);
  $('sideNav').addEventListener('click', event => {
    const link = event.target.closest('.nav-link'); if (!link) return;
    document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('selected', item === link));
    if (window.innerWidth <= 720) toggleSidebar(false);
  });
  $('windowLayer').addEventListener('click', event => { if (event.target === $('windowLayer')) closeWorkspace(); });
  window.addEventListener('keydown', event => {
    if ($('lockModal').style.display === 'flex') return;
    if (event.key === 'Escape' && $('windowLayer').classList.contains('open')) { closeWorkspace(); return; }
    if (event.key === 'F2') { event.preventDefault(); openInvoiceSec('sale'); $('invBarcodeInp').focus(); return; }
    if (event.key === 'F4' && $('windowLayer').classList.contains('open') && $('sec-invoice').classList.contains('active')) { event.preventDefault(); saveInvoice(false); return; }
    if (event.key === 'F6' && $('windowLayer').classList.contains('open') && $('sec-invoice').classList.contains('active')) { event.preventDefault(); holdCurrentInvoice(); return; }
    if (event.key === 'F8') { event.preventDefault(); restoreHeldInvoice(); return; }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && $('sec-invoice').classList.contains('active')) { event.preventDefault(); saveInvoice('thermal'); }
  });
  let rememberedStaff = '';
  try { rememberedStaff = sessionStorage.getItem(ACTIVE_STAFF_KEY) || ''; } catch { /* Session storage may be disabled. */ }
  if (staffList().some(user => user.id === rememberedStaff)) { activeStaffId = rememberedStaff; updateActiveUserBadge(); }
  else { activeStaffId = 'owner'; lockApp(); }
}
function openSec(secId, titleText) {
  const permission = ({ 'sec-items': 'inventory', 'sec-categories': 'inventory', 'sec-stock': 'stock', 'sec-settings': 'admin', 'sec-profits': 'admin', 'sec-treasury': 'cash' })[secId];
  if (permission && !ensurePermission(permission)) return;
  if (secId === 'sec-parties' && !ensurePermission($('partyType').value === 'supplier' ? 'supplier' : 'customer')) return;
  document.querySelectorAll('.sec-view').forEach(el => el.classList.remove('active'));
  $(secId)?.classList.add('active');
  $('windowLayer').classList.add('open');
  $('windowLayer').classList.remove('minimized'); $('windowDock').hidden = true;
  document.body.style.overflow = 'hidden';
  if (titleText) $('winTitle').textContent = titleText;
  if (secId === 'sec-items') { populateCategoriesSelect(); renderItemsTable(); }
  if (secId === 'sec-categories') renderCategoriesTable();
  if (secId === 'sec-parties') renderPartiesTable();
  if (secId === 'sec-settings') loadSettingsForm();
  if (secId === 'sec-invlog') renderInvLog();
  if (secId === 'sec-treasury') renderTreasury();
  if (secId === 'sec-profits') renderProfits();
}
function closeWorkspace() {
  $('windowLayer').classList.remove('open', 'minimized', 'maximized'); $('windowDock').hidden = true;
  $('maximizeWindowButton').setAttribute('aria-label', 'تكبير النافذة'); $('maximizeWindowButton').textContent = '□';
  document.body.style.overflow = '';
}
function minimizeWorkspace() {
  if (!$('windowLayer').classList.contains('open')) return;
  $('windowLayer').classList.add('minimized'); $('windowDock').hidden = false; document.body.style.overflow = '';
}
function restoreWorkspace() {
  $('windowLayer').classList.remove('minimized'); $('windowDock').hidden = true;
  document.body.style.overflow = 'hidden';
}
function maximizeWorkspace() {
  const maximized = $('windowLayer').classList.toggle('maximized');
  $('maximizeWindowButton').setAttribute('aria-label', maximized ? 'استعادة حجم النافذة' : 'تكبير النافذة');
  $('maximizeWindowButton').textContent = maximized ? '❐' : '□';
}
function getAppearance() {
  try { return JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveAppearance(settings) {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(settings)); } catch { notify('تعذر حفظ تفضيلات المظهر في المتصفح.'); }
}
function applyAppearance() {
  const appearance = getAppearance();
  const theme = ['vista-blue','vista-emerald','vista-rose','win11-indigo','win11-mint','win11-sunset','night'].includes(appearance.theme) ? appearance.theme : 'win11-indigo';
  document.body.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
  if ($('darkModeButton')) $('darkModeButton').textContent = theme === 'night' ? '☀️ إيقاف الوضع الليلي' : '🌙 الوضع الليلي';
  if (appearance.accent && /^#[0-9a-f]{6}$/i.test(appearance.accent)) {
    document.body.style.setProperty('--accent', appearance.accent);
    document.body.style.setProperty('--blue-win', appearance.accent);
    if ($('customAccent')) $('customAccent').value = appearance.accent;
  } else if ($('customAccent')) {
    const defaults = { 'vista-blue': '#1687bd', 'vista-emerald': '#27865c', 'vista-rose': '#a34f78', 'win11-indigo': '#5b5bd6', 'win11-mint': '#188b7a', 'win11-sunset': '#d0644e', night: '#818cf8' };
    $('customAccent').value = defaults[theme];
  }
}
function selectTheme(theme) {
  const appearance = getAppearance(); appearance.theme = theme; saveAppearance(appearance); applyAppearance();
}
function setCustomAccent(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  const appearance = getAppearance(); appearance.accent = color; saveAppearance(appearance); applyAppearance();
}
function setReceiptWidth(width) {
  if (!['58', '80'].includes(String(width))) return;
  const appearance = getAppearance(); appearance.receiptWidth = String(width); saveAppearance(appearance);
}
function toggleClassicGrid() { const p = $('classicPanel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; }
function applySidebarPreference() {
  const appearance = getAppearance();
  $('appShell').classList.toggle('sidebar-collapsed', Boolean(appearance.sidebarCollapsed));
}
function toggleSidebar(force) {
  const shell = $('appShell'), isMobile = window.matchMedia ? window.matchMedia('(max-width: 720px)').matches : window.innerWidth <= 720;
  if (isMobile) {
    const opening = force === undefined ? !shell.classList.contains('sidebar-open') : Boolean(force);
    shell.classList.toggle('sidebar-open', opening); $('navScrim').hidden = !opening;
    return;
  }
  const collapsed = force === undefined ? !shell.classList.contains('sidebar-collapsed') : Boolean(force);
  shell.classList.toggle('sidebar-collapsed', collapsed);
  const appearance = getAppearance(); appearance.sidebarCollapsed = collapsed; saveAppearance(appearance);
}
function showHome() {
  closeWorkspace(); $('appShell').classList.remove('sidebar-open'); $('navScrim').hidden = true;
  document.querySelectorAll('.nav-link').forEach(link => link.classList.toggle('selected', link.textContent.includes('الرئيسية')));
  $('homeDashboard').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}
function decorateActionButtons() {
  document.querySelectorAll('.c-btn').forEach(button => {
    const label = button.textContent.trim();
    if (!label || button.querySelector('.button-icon')) return;
    const handler = button.getAttribute('onclick') || '';
    const icon = label.match(/^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u)?.[0] ||
      (handler.includes('openProfit') ? '📈' : handler.includes('openTreasury') ? '💰' : handler.includes('openParty') ? '👥' : handler.includes('openInvoice') || handler.includes('openInvLog') ? '🧾' : handler.includes('openStock') || label.includes('أصناف') ? '📦' : handler.includes('lockApp') ? '🔐' : '◈');
    const cleanLabel = label.replace(/^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*/u, '').trim() || label;
    const iconEl = document.createElement('span'); iconEl.className = 'button-icon'; iconEl.setAttribute('aria-hidden', 'true'); iconEl.textContent = icon;
    const labelEl = document.createElement('span'); labelEl.className = 'button-label'; labelEl.textContent = cleanLabel;
    button.replaceChildren(iconEl, labelEl);
  });
}
function toggleDarkMode() {
  const appearance = getAppearance();
  if (appearance.theme === 'night') appearance.theme = appearance.previousTheme || 'win11-indigo';
  else { appearance.previousTheme = appearance.theme || 'win11-indigo'; appearance.theme = 'night'; }
  saveAppearance(appearance); applyAppearance();
}
function calculateTotalProfits(dFrom, dTo, itemFilter) {
  if (dFrom && dTo && dFrom > dTo) throw new Error('تاريخ البداية يجب ألا يتجاوز تاريخ النهاية.');
  let sales = 0, cost = 0, expenses = 0;
  const itemMap = new Map();
  const filtered = itemFilter && itemFilter !== 'all';
  db.invoices.forEach(inv => {
    if ((dFrom && inv.date < dFrom) || (dTo && inv.date > dTo) || !['sale', 'sale_return'].includes(inv.mode)) return;
    const sign = inv.mode === 'sale' ? 1 : -1;
    invoiceLines(inv).forEach(c => {
      if (filtered && String(c.id) !== String(itemFilter)) return;
      const rev = c.netTotal * sign, cst = c.qty * c.buyCost * sign;
      sales += rev; cost += cst;
      if (!itemMap.has(c.id)) itemMap.set(c.id, { code: c.code, name: c.name, qty: 0, rev: 0, cst: 0 });
      const row = itemMap.get(c.id); row.qty += c.qty * sign; row.rev += rev; row.cst += cst;
    });
  });
  if (!filtered) db.treasury.forEach(t => {
    if (t.type === 'expense' && (!dFrom || t.date >= dFrom) && (!dTo || t.date <= dTo)) expenses += Number(t.amount);
  });
  sales = roundMoney(sales); cost = roundMoney(cost);
  const gross = roundMoney(sales - cost);
  return { sales, cost, gross, expenses, net: roundMoney(gross - expenses), itemRows: [...itemMap.values()] };
}
function renderSalesChart() {
  const chart = $('salesChart'); if (!chart) return;
  const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - (6 - index)); return date; });
  const totals = days.map(date => {
    const key = localDate(date);
    return roundMoney(db.invoices.reduce((sum, invoice) => sum + (invoice.date === key ? (invoice.mode === 'sale' ? invoice.netTotal : invoice.mode === 'sale_return' ? -invoice.netTotal : 0) : 0), 0));
  });
  const scale = Math.max(1, ...totals.map(Math.abs));
  chart.innerHTML = days.map((date, index) => {
    const amount = totals[index], height = amount > 0 ? Math.max(7, Math.round((amount / scale) * 100)) : 3;
    const label = new Intl.DateTimeFormat('ar-EG', { weekday: 'short' }).format(date);
    return `<div class="chart-day" title="${esc(localDate(date))}: ${money(amount)} ج.م"><span class="chart-value">${money(amount)}</span><div class="chart-track"><i class="chart-bar" style="height:${height}%" aria-hidden="true"></i></div><span class="chart-label">${esc(label)}</span></div>`;
  }).join('');
}
function renderSystemAlerts() {
  const list = $('systemAlertsList'); if (!list) return;
  const low = db.items.filter(item => item.qty <= item.minQty).length;
  const customers = db.parties.filter(party => party.type === 'customer' && party.balance > 0).length;
  const suppliers = db.parties.filter(party => party.type === 'supplier' && party.balance > 0).length;
  const status = $('syncStatusBadge')?.dataset.state;
  const alerts = [];
  if (low) alerts.push(`<li class="alert-danger"><button type="button" onclick="openStockFilter('low')">⚠️ ${low} صنف عند حد الطلب أو أقل</button></li>`);
  if (customers) alerts.push(`<li class="alert-danger"><button type="button" onclick="openPartyReport('customer','balances')">👥 أرصدة مستحقة على ${customers} عميل</button></li>`);
  if (suppliers) alerts.push(`<li><button type="button" onclick="openPartyReport('supplier','balances')">🚚 أرصدة ${suppliers} مورد</button></li>`);
  if (status === 'error') alerts.push('<li class="alert-danger"><button type="button" onclick="openSec(\'sec-settings\',\'⚙️ إعدادات المزامنة\')">☁️ فشل/تعارض مزامنة — راجع الإعدادات</button></li>');
  if (!alerts.length) alerts.push('<li class="alert-good">لا توجد تنبيهات عاجلة حالياً ✅</li>');
  list.innerHTML = alerts.join('');
}
function updateDashboardKPIs() {
  const today = localDate();
  const cash = roundMoney(db.treasury.reduce((sum, t) => sum + (t.type === 'in' ? t.amount : -t.amount), 0));
  const salesToday = roundMoney(db.invoices.reduce((sum, inv) => sum + (inv.date === today ? (inv.mode === 'sale' ? inv.netTotal : inv.mode === 'sale_return' ? -inv.netTotal : 0) : 0), 0));
  $('kpiCash').textContent = money(cash); $('kpiSalesToday').textContent = money(salesToday);
  $('kpiNetProfit').textContent = money(calculateTotalProfits().net);
  $('kpiLowStock').textContent = db.items.filter(i => i.qty <= i.minQty).length;
  renderSalesChart();
}
function populateCategoriesSelect() {
  const previous = $('itemCategory').value;
  $('itemCategory').innerHTML = db.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (db.categories.includes(previous)) $('itemCategory').value = previous;
}
function quickAddCategory() {
  if (!ensurePermission('inventory')) return;
  const name = prompt('أدخل اسم المجموعة الجديدة:')?.trim();
  if (!name) return;
  if (db.categories.some(c => c.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert('المجموعة موجودة بالفعل.');
  if (commitDB(draft => { draft.categories.push(name); })) { populateCategoriesSelect(); $('itemCategory').value = name; }
}
function generateNewCode() {
  let code = db.items.reduce((max, i) => /^\d+$/.test(i.code) ? Math.max(max, Number(i.code)) : max, 1000) + 1;
  while (db.items.some(i => i.code === String(code))) code += 1;
  $('itemCode').value = String(code);
}
function calcPriceFromProfit() {
  const buy = num('itemBuyPrice'), pct = num('itemProfitPct');
  if (!Number.isFinite(buy) || buy < 0 || !Number.isFinite(pct)) return;
  const sell = roundMoney(buy * (1 + pct / 100));
  $('itemSellPrice').value = sell.toFixed(2);
  if (!num('itemWholesale')) $('itemWholesale').value = sell.toFixed(2);
  if (!num('itemMinSell')) $('itemMinSell').value = buy.toFixed(2);
}
function calcProfitFromPrice() {
  const buy = num('itemBuyPrice'), sell = num('itemSellPrice');
  if (buy > 0 && Number.isFinite(sell)) $('itemProfitPct').value = (((sell - buy) / buy) * 100).toFixed(2);
}
function readItemForm() {
  const editId = $('itemEditId').value;
  const numericFields = { qty: 'itemQty', minQty: 'itemMinQty', buy: 'itemBuyPrice', profitPct: 'itemProfitPct', sell: 'itemSellPrice', wholesale: 'itemWholesale', minSell: 'itemMinSell' };
  const item = { id: editId ? Number(editId) : nextId(db.items), code: $('itemCode').value.trim(), name: $('itemName').value.trim(),
    cat: $('itemCategory').value, type: $('itemType').value, warehouse: $('itemWarehouse').value, unit: $('itemUnit').value, notes: $('itemNotes').value.trim() };
  for (const [field, element] of Object.entries(numericFields)) {
    item[field] = num(element);
    if (!Number.isFinite(item[field]) || (field !== 'profitPct' && item[field] < 0)) throw new Error('أدخل قيماً رقمية صالحة؛ الكميات والأسعار لا يمكن أن تكون سالبة.');
  }
  if (!item.name || !item.code || !item.cat) throw new Error('كود الصنف واسمه والمجموعة مطلوبة.');
  if (db.items.some(i => i.code.toLocaleLowerCase() === item.code.toLocaleLowerCase() && i.id !== item.id)) throw new Error('كود الصنف مستخدم بالفعل. اختر كوداً مختلفاً.');
  if (editId && !db.items.some(i => i.id === item.id)) throw new Error('الصنف المطلوب تعديله لم يعد موجوداً.');
  return item;
}
function saveItem() {
  if (!ensurePermission('inventory')) return;
  try {
    const item = readItemForm();
    if (commitDB(draft => { const index = draft.items.findIndex(i => i.id === item.id); if (index < 0) draft.items.push(item); else draft.items[index] = item; })) {
      resetItemForm(); renderItemsTable();
    }
  } catch (error) { alert(error.message); }
}
function resetItemForm() {
  $('itemEditId').value = ''; $('itemName').value = ''; $('itemQty').value = 10; $('itemMinQty').value = 3;
  $('itemBuyPrice').value = 0; $('itemProfitPct').value = 20; $('itemSellPrice').value = 0;
  $('itemWholesale').value = 0; $('itemMinSell').value = 0; $('itemNotes').value = ''; generateNewCode();
}
function renderItemsTable() {
  const q = $('itemSearchInp').value.trim().toLocaleLowerCase();
  const list = db.items.filter(i => [i.name, i.code, i.cat].some(v => String(v).toLocaleLowerCase().includes(q)));
  let totBuy = 0, totSell = 0;
  $('itemsTbody').innerHTML = list.map(i => {
    totBuy += i.buy * i.qty; totSell += i.sell * i.qty;
    const input = (field, width) => `<input aria-label="${esc(i.name)}: ${field}" type="${field === 'name' ? 'text' : 'number'}" ${field === 'name' ? '' : 'min="0" step="any"'} value="${esc(i[field])}" style="width:${width}px;max-width:100%" onchange="inlineUpdateItem(${i.id},'${field}',this.value)">`;
    return `<tr><td><strong>${esc(i.code)}</strong></td><td style="text-align:right;font-weight:bold;">${quickEditMode ? input('name', 180) : esc(i.name)}</td>
      <td>${esc(i.cat)}</td><td style="font-weight:bold;color:${i.qty <= i.minQty ? 'red' : '#0f172a'}">${quickEditMode ? input('qty', 70) : esc(i.qty)}</td><td>${esc(i.unit)}</td>
      <td>${quickEditMode ? input('buy', 75) : money(i.buy)}</td><td>${quickEditMode ? input('sell', 75) : money(i.sell)}</td><td>${quickEditMode ? input('wholesale', 75) : money(i.wholesale)}</td>
      <td>${money(i.minSell)}</td><td>${esc(i.notes || '-')}</td>
      ${quickEditMode ? '<td colspan="3"><span class="badge bg-green">حفظ تلقائي</span></td>' : `<td class="no-print"><button type="button" class="act-btn bg-orange" onclick="editItem(${i.id})">✏️ تعديل</button></td><td class="no-print"><button type="button" class="act-btn bg-red" onclick="deleteItem(${i.id})">🗑️ حذف</button></td><td class="no-print"><button type="button" class="act-btn bg-blue" onclick="printBarcodeLabel(${i.id})">باركود</button></td>`}</tr>`;
  }).join('') || '<tr><td colspan="13" class="empty-row">لا توجد أصناف مطابقة. أضف صنفاً من النموذج بالأعلى.</td></tr>';
  document.querySelectorAll('#sec-items thead th').forEach((th, index) => th.classList.toggle('no-print', index >= 10));
  $('totItemsCount').textContent = list.length; $('totItemsBuy').textContent = money(totBuy); $('totItemsSell').textContent = money(totSell);
}
function inlineUpdateItem(id, field, value) {
  if (!ensurePermission('inventory') || !['name', 'qty', 'buy', 'sell', 'wholesale'].includes(field)) return;
  const item = db.items.find(i => i.id === id);
  if (!item) return;
  if (field !== 'name' && value.trim() === '') { alert('لا تترك القيمة الرقمية فارغة.'); renderItemsTable(); return; }
  const updated = { ...item, [field]: field === 'name' ? value.trim() : Number(value) };
  if (!updated.name || (field !== 'name' && (!Number.isFinite(updated[field]) || updated[field] < 0))) { alert('القيمة غير صالحة؛ لم يُحفظ التعديل.'); renderItemsTable(); return; }
  if (field === 'buy' || field === 'sell') updated.profitPct = updated.buy > 0 ? roundMoney((updated.sell - updated.buy) / updated.buy * 100) : 0;
  if (commitDB(draft => { draft.items[draft.items.findIndex(i => i.id === id)] = updated; })) renderItemsTable();
  else renderItemsTable();
}
function toggleQuickEditItems() { quickEditMode = !quickEditMode; renderItemsTable(); }
function editItem(id) {
  const i = db.items.find(x => x.id === id); if (!i) return;
  const fields = { itemEditId: 'id', itemCode: 'code', itemName: 'name', itemCategory: 'cat', itemType: 'type', itemWarehouse: 'warehouse', itemUnit: 'unit', itemQty: 'qty', itemMinQty: 'minQty', itemBuyPrice: 'buy', itemProfitPct: 'profitPct', itemSellPrice: 'sell', itemWholesale: 'wholesale', itemMinSell: 'minSell', itemNotes: 'notes' };
  for (const [element, field] of Object.entries(fields)) $(element).value = i[field];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function deleteItem(id) {
  if (!ensurePermission('inventory')) return;
  if (db.invoices.some(inv => inv.items.some(c => c.id === id))) return alert('لا يمكن حذف صنف له فواتير؛ حفاظاً على سجل المبيعات والتكلفة. يمكنك تعديل بياناته بدلاً من حذفه.');
  if (invCart.some(c => c.id === id)) return alert('احذف الصنف من الفاتورة المفتوحة أولاً.');
  if (confirm('هل تريد حذف هذا الصنف نهائياً؟') && commitDB(draft => { draft.items = draft.items.filter(i => i.id !== id); })) {
    if (Number($('itemEditId').value) === id) resetItemForm(); renderItemsTable();
  }
}
function showSingleItemProfit() { openProfitSec('item'); }
function printBarcodeLabel(id) {
  const item = db.items.find(i => i.id === id); if (!item) return;
  try {
    triggerA5Print(`<div style="text-align:center;border:1px solid #000;padding:12px;max-width:100%;margin:auto;"><strong>${esc(db.settings.name)}</strong><p>${esc(item.name)}</p>${code39Svg(item.code)}<div>السعر: ${money(item.sell)} ج.م</div></div>`);
  } catch (error) { alert(error.message); }
}
function renderCategoriesTable() {
  $('catsTbody').innerHTML = db.categories.map((c, index) => `<tr><td>${index + 1}</td><td>${esc(c)}</td><td>${db.items.filter(i => i.cat === c).length}</td><td class="no-print"><button type="button" class="act-btn bg-red" onclick="deleteCategory(${index})">حذف</button></td></tr>`).join('') || '<tr><td colspan="4">لا توجد مجموعات.</td></tr>';
  document.querySelector('#sec-categories th:last-child').classList.add('no-print');
}
function addCategory() {
  if (!ensurePermission('inventory')) return;
  const name = $('catNameInp').value.trim(); if (!name) return alert('أدخل اسم المجموعة.');
  if (db.categories.some(c => c.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert('المجموعة موجودة بالفعل.');
  if (commitDB(draft => { draft.categories.push(name); })) { $('catNameInp').value = ''; renderCategoriesTable(); populateCategoriesSelect(); }
}
function deleteCategory(index) {
  if (!ensurePermission('inventory')) return;
  const category = db.categories[index]; if (!category) return;
  if (db.items.some(i => i.cat === category)) return alert('لا يمكن حذف مجموعة مرتبطة بأصناف. انقل الأصناف إلى مجموعة أخرى أولاً.');
  if (confirm(`حذف المجموعة «${category}»؟`) && commitDB(draft => { draft.categories.splice(index, 1); })) { renderCategoriesTable(); populateCategoriesSelect(); }
}
function openStockFilter(filter) {
  openSec('sec-stock', filter === 'zero' ? '🚨 كشف النواقص' : filter === 'low' ? '⚠️ أصناف وصلت لحد الطلب' : '🏢 جرد المخزن العام');
  const list = db.items.filter(i => filter === 'zero' ? i.qty <= 0 : filter === 'low' ? i.qty <= i.minQty : true);
  $('stockTbody').innerHTML = list.map(i => `<tr><td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(i.cat)}</td><td>${esc(i.warehouse)}</td><td style="color:${i.qty <= i.minQty ? 'red' : 'green'}">${esc(i.qty)} ${esc(i.unit)}</td><td>${esc(i.minQty)}</td><td>${money(i.buy)}</td><td>${money(i.qty * i.buy)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">لا توجد أصناف مطابقة.</td></tr>';
}

function openInvoiceSec(mode) {
  const permission = mode.startsWith('purchase') ? 'purchase' : mode === 'quote' ? 'quote' : mode === 'sale_return' ? 'sale-return' : 'sale';
  if (!ensurePermission(permission)) return;
  if (mode !== $('invMode').value && invCart.length && !confirm('تغيير نوع العملية سيفرغ الفاتورة غير المحفوظة. هل تريد المتابعة؟')) return;
  openSec('sec-invoice', '🧾 شاشة الفواتير وعروض الأسعار');
  if (mode !== $('invMode').value) clearInvCart();
  $('invMode').value = mode; updateInvoiceUI();
  window.setTimeout(() => { if ($('windowLayer').classList.contains('open')) $('invBarcodeInp').focus(); }, 0);
}
function changeInvoiceMode(mode) {
  const permission = mode.startsWith('purchase') ? 'purchase' : mode === 'quote' ? 'quote' : mode === 'sale_return' ? 'sale-return' : 'sale';
  if (!ensurePermission(permission)) { $('invMode').value = lastInvoiceMode; return; }
  if (mode !== lastInvoiceMode && invCart.length && !confirm('تغيير نوع العملية سيفرغ الفاتورة غير المحفوظة. هل تريد المتابعة؟')) { $('invMode').value = lastInvoiceMode; return; }
  if (mode !== lastInvoiceMode) clearInvCart();
  updateInvoiceUI();
}
function updateInvoiceUI() {
  const mode = $('invMode').value; lastInvoiceMode = mode;
  const supplier = mode.startsWith('purchase'), isReturn = mode.endsWith('_return'), quote = mode === 'quote';
  $('invPanelTitle').textContent = MODE_LABELS[mode]; $('lblInvParty').textContent = supplier ? 'المورد:' : 'العميل:';
  $('btnConvertQuote').style.display = quote ? 'inline-flex' : 'none';
  const previousParty = $('invPartySelect').value;
  const parties = db.parties.filter(p => p.type === (supplier ? 'supplier' : 'customer'));
  $('invPartySelect').innerHTML = (!supplier ? '<option value="0">عميل نقدي</option>' : '<option value="">اختر المورد</option>') + options(parties, p => `${p.name} (الرصيد: ${money(p.balance)})`);
  if (parties.some(p => String(p.id) === previousParty)) $('invPartySelect').value = previousParty;
  $('itemsDatalist').innerHTML = db.items.map(i => `<option value="${esc(i.code)}">${esc(i.name)} — ${money(i.sell)}</option>`).join('');
  $('invReturnSourceRow').style.display = isReturn ? 'flex' : 'none';
  if (isReturn) {
    const previousSource = $('invReturnSource').value;
    const sources = db.invoices.filter(inv => inv.mode === (mode === 'sale_return' ? 'sale' : 'purchase') && inv.items.some(c => c.qty > returnedQuantity(db.invoices, inv.id, c.id)));
    $('invReturnSource').innerHTML = '<option value="">اختر الفاتورة الأصلية</option>' + options(sources, inv => `#${inv.id} — ${inv.date} — ${inv.partyName} — ${money(inv.netTotal)}`);
    if (sources.some(inv => String(inv.id) === previousSource)) $('invReturnSource').value = previousSource;
  }
  $('invPartySelect').disabled = isReturn;
  $('invPriceTier').disabled = mode !== 'sale' && !quote;
  for (const id of ['invDiscAmount', 'invDiscPct']) $(id).disabled = isReturn || quote;
  if (isReturn || quote) { $('invDiscAmount').value = 0; $('invDiscPct').value = 0; }
  if (!supplier && !db.parties.some(p => String(p.id) === $('invPartySelect').value)) $('invPartySelect').value = '0';
  if (quote) $('invPayType').value = 'credit';
  $('invPayType').disabled = quote;
  $('invPaidAmount').disabled = quote || $('invPayType').value !== 'partial';
  renderInvCart();
}
function loadReturnSource() {
  invCart = [];
  const source = db.invoices.find(inv => inv.id === Number($('invReturnSource').value));
  if (source) {
    $('invPartySelect').value = String(source.partyId);
    invoiceLines(source).forEach(line => {
      const qty = roundQuantity(line.qty - returnedQuantity(db.invoices, source.id, line.id));
      if (qty > 0) {
        const returnedNet = roundMoney(db.invoices.filter(inv => inv.sourceId === source.id).flatMap(inv => invoiceLines(inv)).filter(c => c.id === line.id).reduce((sum, c) => sum + c.netTotal, 0));
        const remainingNet = roundMoney(line.netTotal - returnedNet);
        invCart.push({ id: line.id, code: line.code, name: line.name, qty, maxQty: qty, sourceNetRemaining: remainingNet, returnNetTotal: remainingNet,
          price: remainingNet / qty, discPct: 0, buyCost: line.buyCost, minSell: 0 });
      }
    });
  }
  renderInvCart();
}
function addInvItemFromInput() {
  const modePermission = $('invMode').value.startsWith('purchase') ? 'purchase' : $('invMode').value === 'quote' ? 'quote' : $('invMode').value === 'sale_return' ? 'sale-return' : 'sale';
  if (!ensurePermission(modePermission)) return;
  const value = $('invBarcodeInp').value.trim(), qty = num('invAddQty'), mode = $('invMode').value;
  if (!value) return alert('اختر الصنف أو اكتب كود الصنف أولاً.');
  if (!Number.isFinite(qty) || qty <= 0) return alert('الكمية يجب أن تكون أكبر من صفر.');
  const item = db.items.find(i => i.code.toLocaleLowerCase() === value.toLocaleLowerCase() || i.name === value);
  if (!item) return alert('لم يتم العثور على كود أو اسم مطابق تماماً. اختر الصنف من القائمة.');
  const existing = invCart.find(c => c.id === item.id);
  if (mode.endsWith('_return')) {
    if (!existing) return alert('هذا الصنف غير موجود في الفاتورة الأصلية المتاحة للإرجاع.');
    if (qty > existing.maxQty) return alert(`أقصى كمية متاحة للإرجاع هي ${existing.maxQty}.`);
    existing.qty = qty;
    existing.returnNetTotal = qty === existing.maxQty ? existing.sourceNetRemaining : roundMoney(existing.sourceNetRemaining * qty / existing.maxQty);
  } else {
    const price = mode.startsWith('purchase') ? item.buy : $('invPriceTier').value === 'wholesale' ? item.wholesale : item.sell;
    if (existing) existing.qty = roundQuantity(existing.qty + qty);
    else invCart.push({ id: item.id, code: item.code, name: item.name, qty, price, discPct: 0, buyCost: item.buy, minSell: item.minSell });
  }
  $('invBarcodeInp').value = ''; $('invAddQty').value = 1; renderInvCart(); $('invBarcodeInp').focus();
}
function updateCartPricesByTier() {
  if (!['sale', 'quote'].includes($('invMode').value)) return;
  invCart.forEach(c => { const item = db.items.find(i => i.id === c.id); if (item) c.price = $('invPriceTier').value === 'wholesale' ? item.wholesale : item.sell; });
  renderInvCart();
}
function renderInvCart() {
  const mode = $('invMode').value, isReturn = mode.endsWith('_return');
  $('invCartTbody').innerHTML = invCart.map((c, index) => `<tr><td>${index + 1}</td><td>${esc(c.code)}</td><td>${esc(c.name)}</td>
    <td><input aria-label="كمية ${esc(c.name)}" type="number" min="0.001" ${isReturn ? `max="${c.maxQty}"` : ''} step="any" value="${esc(c.qty)}" style="width:75px" onchange="updateCartRow(${index},'qty',this.value)"></td>
    <td><input aria-label="سعر ${esc(c.name)}" type="number" min="0" step="any" value="${esc(c.price)}" ${isReturn ? 'disabled' : ''} style="width:80px" onchange="updateCartRow(${index},'price',this.value)"></td>
    <td><input aria-label="خصم ${esc(c.name)}" type="number" min="0" max="100" step="any" value="${esc(c.discPct)}" ${isReturn ? 'disabled' : ''} style="width:65px" onchange="updateCartRow(${index},'discPct',this.value)"></td>
    <td>${money(lineGross(c))}</td><td class="no-print"><button type="button" class="act-btn bg-red" onclick="removeCartRow(${index})">حذف</button></td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">الفاتورة فارغة. أضف صنفاً بالأعلى.</td></tr>';
  document.querySelector('#sec-invoice table th:last-child').classList.add('no-print');
  calcInvoiceTotals();
}
function removeCartRow(index) { invCart.splice(index, 1); renderInvCart(); }
function updateCartRow(index, field, value) {
  const row = invCart[index]; if (!row || !['qty', 'price', 'discPct'].includes(field)) return;
  const raw = String(value), number = raw.trim() === '' ? NaN : Number(raw), mode = $('invMode').value;
  if (!Number.isFinite(number) || (field === 'qty' && number <= 0) || (field !== 'qty' && number < 0) || (field === 'discPct' && number > 100) || (mode.endsWith('_return') && (field !== 'qty' || number > row.maxQty))) {
    alert('قيمة غير صالحة. الكمية موجبة، والخصم بين 0 و100، والمرتجع لا يتجاوز الكمية الأصلية.'); renderInvCart(); return;
  }
  const updated = { ...row, [field]: number };
  if (['sale', 'quote'].includes(mode) && updated.price * (1 - updated.discPct / 100) < updated.minSell) { alert(`السعر بعد خصم الصنف أقل من الحد الأدنى للبيع (${money(updated.minSell)}). لم يُعتمد السعر.`); renderInvCart(); return; }
  if (mode.endsWith('_return')) updated.returnNetTotal = updated.qty === updated.maxQty ? updated.sourceNetRemaining : roundMoney(updated.sourceNetRemaining * updated.qty / updated.maxQty);
  invCart[index] = updated;
  renderInvCart();
}
function calcInvoiceTotals() {
  const quote = $('invMode').value === 'quote';
  $('invPaidAmount').disabled = quote || $('invPayType').value !== 'partial';
  if (!invCart.length) { $('invSubTotal').value = '0.00'; $('invNetTotal').value = '0.00'; }
  else try {
    const totals = calculateTotals(invCart, Number($('invDiscAmount').value) || 0, Number($('invDiscPct').value) || 0);
    $('invSubTotal').value = money(totals.subtotal); $('invNetTotal').value = money(totals.netTotal);
  } catch { $('invSubTotal').value = money(invCart.reduce((sum, c) => sum + lineGross(c), 0)); $('invNetTotal').value = '0.00'; }
  const net = Number($('invNetTotal').value);
  if (quote || $('invPayType').value === 'credit') $('invPaidAmount').value = '0.00';
  else if ($('invPayType').value === 'cash') $('invPaidAmount').value = money(net);
  calcInvoiceRemaining();
}
function calcInvoiceRemaining() { $('invRemainAmount').value = money(Number($('invNetTotal').value) - (Number($('invPaidAmount').value) || 0)); }
function clearInvCart() {
  invCart = []; delete $('invCartTbody').dataset.quoteId; $('invDiscAmount').value = 0; $('invDiscPct').value = 0; $('invReturnSource').value = ''; $('invBarcodeInp').value = ''; $('invAddQty').value = 1; renderInvCart();
}
function holdCurrentInvoice() {
  if (!invCart.length) return alert('لا توجد أصناف لتعليقها.');
  if ($('invMode').value.endsWith('_return')) return alert('تعليق فواتير المرتجعات غير متاح حالياً.');
  const held = safeReadArray(HELD_CARTS_KEY);
  held.unshift({ id: `held-${Date.now()}`, time: new Date().toLocaleString('ar-EG'), user: activeStaff().name, mode: $('invMode').value,
    items: clone(invCart), partyId: $('invPartySelect').value, priceTier: $('invPriceTier').value, payType: $('invPayType').value,
    paid: $('invPaidAmount').value, discountAmount: $('invDiscAmount').value, discountPct: $('invDiscPct').value,
    quoteId: $('invCartTbody').dataset.quoteId || '' });
  try { localStorage.setItem(HELD_CARTS_KEY, JSON.stringify(held.slice(0, 50))); }
  catch { return alert('تعذر تعليق الفاتورة في تخزين المتصفح.'); }
  recordAudit(`تعليق فاتورة مؤقتة (${invCart.length} صنف)`);
  clearInvCart(); renderHeldCount(); alert('تم تعليق الفاتورة مؤقتاً على هذا الجهاز.');
}
function restoreHeldInvoice(index = 0) {
  const held = safeReadArray(HELD_CARTS_KEY), draft = held[index];
  if (!draft) return alert('لا توجد فواتير معلقة لاستعادتها.');
  const permission = String(draft.mode).startsWith('purchase') ? 'purchase' : draft.mode === 'quote' ? 'quote' : 'sale';
  if (!ensurePermission(permission)) return;
  if (invCart.length && !confirm('استعادة الفاتورة المعلقة ستستبدل المسودة الحالية. هل تريد المتابعة؟')) return;
  if (!Array.isArray(draft.items) || !draft.items.every(line => db.items.some(item => item.id === line.id) && Number.isFinite(Number(line.qty)) && line.qty > 0)) return alert('الفاتورة المعلقة غير صالحة أو تحتوي أصنافاً لم تعد موجودة.');
  openSec('sec-invoice', '🧾 استعادة فاتورة معلقة');
  $('invMode').value = draft.mode; updateInvoiceUI();
  invCart = clone(draft.items);
  if ([...$('invPartySelect').options].some(option => option.value === String(draft.partyId))) $('invPartySelect').value = String(draft.partyId);
  $('invPriceTier').value = draft.priceTier || 'retail'; $('invPayType').value = draft.payType || 'cash';
  $('invPaidAmount').value = draft.paid || '0'; $('invDiscAmount').value = draft.discountAmount || '0'; $('invDiscPct').value = draft.discountPct || '0';
  if (draft.quoteId) $('invCartTbody').dataset.quoteId = String(draft.quoteId);
  renderInvCart();
  held.splice(index, 1); localStorage.setItem(HELD_CARTS_KEY, JSON.stringify(held)); renderHeldCount();
  recordAudit('استعادة فاتورة معلقة'); $('invBarcodeInp').focus();
}
function convertQuoteToSale() {
  if (!ensurePermission('sale')) return;
  if (!invCart.length) return alert('أضف أصناف عرض السعر أولاً.');
  $('invMode').value = 'sale'; $('invPayType').value = 'cash'; updateInvoiceUI();
  alert('تم تجهيز الفاتورة للبيع. لم يتم حفظ البيع أو خصم المخزون بعد؛ راجع البيانات واضغط حفظ.');
}
function loadQuoteForSale(id) {
  if (!ensurePermission('sale')) return;
  const quote = db.invoices.find(inv => inv.id === id && inv.mode === 'quote');
  if (!quote || quote.convertedToId) return alert('عرض السعر غير متاح أو تم تحويله بالفعل.');
  if (invCart.length && !confirm('استبدال الفاتورة غير المحفوظة بعرض السعر؟')) return;
  openSec('sec-invoice', '🧾 تحويل عرض سعر إلى مبيعات'); $('invMode').value = 'sale'; updateInvoiceUI();
  invCart = invoiceLines(quote).map(c => { const item = db.items.find(i => i.id === c.id); return { ...c, price: c.netTotal / c.qty, discPct: 0, buyCost: item?.buy ?? c.buyCost, minSell: item?.minSell ?? c.minSell }; });
  $('invPartySelect').value = String(quote.partyId); $('invPayType').value = 'cash'; $('invDiscAmount').value = 0; $('invDiscPct').value = 0;
  $('invCartTbody').dataset.quoteId = String(id); renderInvCart();
}
function validateInvoice(mode, partyId, paidAmount) {
  if (!INVOICE_MODES.includes(mode)) throw new Error('نوع العملية غير صالح.');
  const sourceId = mode.endsWith('_return') ? Number($('invReturnSource').value) : 0;
  const source = db.invoices.find(inv => inv.id === sourceId);
  if (mode.endsWith('_return') && (!source || source.mode !== (mode === 'sale_return' ? 'sale' : 'purchase') || source.partyId !== partyId)) throw new Error('اختر الفاتورة الأصلية الصحيحة للمرتجع.');
  const totals = calculateTotals(invCart, Number($('invDiscAmount').value) || 0, Number($('invDiscPct').value) || 0);
  const quantities = new Map();
  for (const row of totals.items) {
    const item = db.items.find(i => i.id === row.id);
    if (!item) throw new Error(`الصنف «${row.name}» لم يعد موجوداً.`);
    quantities.set(item.id, roundQuantity((quantities.get(item.id) || 0) + row.qty));
    if (['sale', 'purchase_return'].includes(mode) && quantities.get(item.id) > item.qty) throw new Error(`الرصيد غير كافٍ للصنف «${item.name}». المتاح: ${item.qty}.`);
    if (['sale', 'quote'].includes(mode) && roundMoney(row.netTotal) + 0.000001 < roundMoney(row.qty * item.minSell)) throw new Error(`صافي سعر «${item.name}» بعد كل الخصومات أقل من الحد الأدنى للبيع.`);
    if (source) {
      const original = source.items.find(c => c.id === item.id);
      const available = original ? original.qty - returnedQuantity(db.invoices, source.id, item.id) : 0;
      if (row.qty > available + 0.000001) throw new Error(`كمية مرتجع «${item.name}» أكبر من المتبقي في الفاتورة الأصلية (${available}).`);
    }
  }
  const party = db.parties.find(p => p.id === partyId);
  if (mode.startsWith('purchase') && (!party || party.type !== 'supplier')) throw new Error('اختر المورد الصحيح للعملية.');
  if (partyId && (!party || party.type !== (mode.startsWith('purchase') ? 'supplier' : 'customer'))) throw new Error('نوع الحساب لا يطابق العملية.');
  const quote = mode === 'quote';
  const paid = quote ? 0 : paidAmount;
  if (!Number.isFinite(paid) || paid < 0 || paid > totals.netTotal) throw new Error('المدفوع يجب أن يكون بين صفر وصافي الفاتورة. لا يُقبل دفع زائد عن الفاتورة.');
  const remain = quote ? 0 : roundMoney(totals.netTotal - paid);
  if (remain > 0 && !party) throw new Error('اختر عميلاً أو مورداً مسجلاً للفاتورة الآجلة أو الدفع الجزئي.');
  return { totals, paid: roundMoney(paid), remain, source, party };
}
function saveInvoice(doPrint) {
  const activeMode = $('invMode').value;
  const permission = activeMode.startsWith('purchase') ? 'purchase' : activeMode === 'quote' ? 'quote' : activeMode === 'sale_return' ? 'sale-return' : 'sale';
  if (!ensurePermission(permission)) return;
  try {
    const mode = $('invMode').value, partyId = Number($('invPartySelect').value) || 0;
    const { totals, paid, remain, source, party } = validateInvoice(mode, partyId, num('invPaidAmount'));
    const quoteId = Number($('invCartTbody').dataset.quoteId) || undefined;
    if (quoteId && (mode !== 'sale' || db.invoices.find(i => i.id === quoteId)?.convertedToId)) throw new Error('عرض السعر لم يعد متاحاً للتحويل.');
    const invoice = { ...totals, id: nextId(db.invoices), date: localDate(), time: new Date().toTimeString().slice(0, 5), mode,
      partyId, partyName: party?.name || 'عميل نقدي', prevBalance: party?.balance || 0, paidAmount: paid, remainAmount: remain,
      newBalance: party?.balance || 0, store: { name: db.settings.name, address: db.settings.address, phone: db.settings.phone } };
    if (source) invoice.sourceId = source.id;
    if (quoteId) invoice.quoteId = quoteId;
    const saved = commitDB(draft => {
      if (mode !== 'quote') {
        const sign = ['sale', 'purchase_return'].includes(mode) ? -1 : 1;
        totals.items.forEach(c => {
          const item = draft.items.find(i => i.id === c.id); item.qty = roundQuantity(item.qty + sign * c.qty);
          if (mode === 'purchase') { item.buy = weightedAverageCost(item.qty - c.qty, item.buy, c.qty, c.netTotal / c.qty); item.profitPct = item.buy ? roundMoney((item.sell - item.buy) / item.buy * 100) : 0; }
        });
        if (party) {
          const balance = roundMoney(party.balance + (['sale', 'purchase'].includes(mode) ? remain : -remain));
          draft.parties.find(p => p.id === party.id).balance = balance; invoice.newBalance = balance;
        }
        if (paid > 0) draft.treasury.push({ id: nextId(draft.treasury), date: invoice.date, type: ['sale', 'purchase_return'].includes(mode) ? 'in' : 'out', amount: paid,
          ...(partyId ? { partyId } : {}), invoiceId: invoice.id, note: `${MODE_LABELS[mode]} #${invoice.id} - ${invoice.partyName}` });
      }
      draft.invoices.push(invoice);
      if (quoteId) draft.invoices.find(i => i.id === quoteId).convertedToId = invoice.id;
    });
    if (!saved) return;
    clearInvCart(); delete $('invCartTbody').dataset.quoteId; updateInvoiceUI(); renderItemsTable();
    if (doPrint === 'thermal') printInvoiceThermal(invoice); else if (doPrint) printInvoiceA5(invoice); else alert('✅ تم حفظ الفاتورة محلياً بنجاح.');
  } catch (error) { alert(error.message); }
}
function printInvoiceById(id) {
  const invoice = db.invoices.find(inv => inv.id === id); if (!invoice) return;
  const permission = invoice.mode.startsWith('purchase') ? 'purchase-log' : 'sales-log';
  if (!ensurePermission(permission)) return;
  printInvoiceA5(invoice);
}
function printInvoiceThermalById(id) {
  const invoice = db.invoices.find(inv => inv.id === id); if (!invoice) return;
  const permission = invoice.mode.startsWith('purchase') ? 'purchase-log' : 'sales-log';
  if (!ensurePermission(permission)) return;
  printInvoiceThermal(invoice);
}
function printInvoiceThermal(inv) {
  const store = inv.store || db.settings, width = getAppearance().receiptWidth === '58' ? 58 : 80;
  const rows = invoiceLines(inv).map(line => `<tr><td>${esc(line.name)}<br>${esc(line.qty)} × ${money(line.price)}</td><td>${money(line.netTotal)}</td></tr>`).join('');
  const header = `<div class="receipt-head"><h2>${esc(store.name)}</h2><p>${esc(store.address)}</p><p>${esc(store.phone)}</p><p>${esc(MODE_LABELS[inv.mode])} #${inv.id}</p><p>${esc(inv.date)} — ${esc(inv.time)}</p><p>${esc(inv.partyName)}</p></div>`;
  const receipt = `<div class="thermal-receipt">${header}<table><thead><tr><th>الصنف</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table><div class="receipt-totals"><p><span>الإجمالي</span><strong>${money(inv.subtotal ?? inv.netTotal)} ج.م</strong></p><p><span>الخصم</span><strong>${money(inv.discountTotal ?? 0)} ج.م</strong></p><p><span>الصافي</span><strong>${money(inv.netTotal)} ج.م</strong></p><p><span>المدفوع</span><strong>${money(inv.paidAmount)} ج.م</strong></p><p><span>المتبقي</span><strong>${money(inv.remainAmount)} ج.م</strong></p></div><p class="receipt-thanks">${inv.mode === 'quote' ? 'عرض سعر فقط — ليس إيصال دفع' : 'شكراً لتعاملكم معنا'}</p></div>`;
  const style = $('thermalPrintStyle');
  style.textContent = `@media print{@page{size:${width}mm auto;margin:2mm}body.thermal-print #printAreaA5{display:block!important;position:absolute!important;top:0!important;left:0!important;width:${width - 4}mm!important;max-width:${width - 4}mm!important;padding:0!important;margin:0!important;font-size:10px!important;color:#111!important}body.thermal-print #printAreaA5 table{width:100%;border-collapse:collapse}body.thermal-print #printAreaA5 th,body.thermal-print #printAreaA5 td{font-size:10px!important;padding:3px 1px!important;border-bottom:1px dashed #555!important;text-align:right!important}body.thermal-print #printAreaA5 .receipt-totals p{display:flex!important;justify-content:space-between!important;margin:3px 0!important}}`;
  $('printAreaA5').innerHTML = receipt; document.body.classList.add('thermal-print');
  const cleanup = () => { document.body.classList.remove('thermal-print'); style.textContent = ''; window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup, { once: true }); window.print(); window.setTimeout(cleanup, 3000);
}
function printInvoiceA5(inv) {
  const store = inv.store || db.settings;
  const rows = invoiceLines(inv).map((c, index) => `<tr><td>${index + 1}</td><td>${esc(c.name)}</td><td>${esc(c.qty)}</td><td>${money(c.price)}</td><td>${esc(c.discPct)}%</td><td>${money(c.netTotal)}</td></tr>`).join('');
  triggerA5Print(`<div class="p-header"><h2>${esc(store.name)}</h2><p>${esc(store.address)} | هاتف: ${esc(store.phone)}</p><h3>${esc(MODE_LABELS[inv.mode])} رقم #${inv.id}</h3></div>
    <div class="p-meta"><span>التاريخ: ${esc(inv.date)} (${esc(inv.time)})</span><span>${esc(inv.partyName)}</span></div>
    <table class="p-table"><thead><tr><th>م</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>خصم الصنف</th><th>بعد الخصومات</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="p-totals"><span>الإجمالي: ${money(inv.subtotal ?? inv.items.reduce((s, c) => s + lineGross(c), 0))}</span><span>الخصم الإضافي: ${money(inv.discountTotal ?? 0)}</span></div>
    <div class="p-totals"><span>الصافي: ${money(inv.netTotal)} ج.م</span><span>${inv.mode.startsWith('purchase') ? 'المسدّد للمورد' : 'المدفوع'}: ${money(inv.paidAmount)}</span><span>المتبقي: ${money(inv.remainAmount)}</span></div>
    ${inv.mode !== 'quote' ? `<div class="p-totals"><span>الرصيد السابق: ${money(inv.prevBalance)}</span><span>الرصيد الحالي: ${money(inv.newBalance)} ج.م</span></div>` : '<p>عرض أسعار فقط — ليس إيصال دفع ولا يغيّر المخزون.</p>'}
    <p style="text-align:center">شكراً لتعاملكم معنا</p>`);
}

function openPartySec(type) {
  if (!ensurePermission(type === 'supplier' ? 'supplier' : 'customer')) return;
  if ($('partyType').value !== type) resetPartyForm();
  $('partyType').value = type;
  openSec('sec-parties', type === 'supplier' ? '🚚 إدارة الموردين ودور النشر' : '👥 إدارة العملاء والمدارس'); $('partyFormTitle').textContent = type === 'supplier' ? 'بيانات المورد' : 'بيانات العميل'; renderPartiesTable();
}
function openPartyReport(type, report) {
  openPartySec(type); $('partyStatementBox').style.display = report === 'balances' ? 'none' : 'block';
  if (report !== 'balances') renderPartyStatement();
}
function resetPartyForm() {
  $('partyEditId').value = ''; $('partyName').value = ''; $('partyPhone').value = ''; $('partyBalance').value = 0; $('partyBalance').disabled = false; $('partyNotes').value = '';
}
function saveParty() {
  if (!ensurePermission($('partyType').value === 'supplier' ? 'supplier' : 'customer')) return;
  const type = $('partyType').value, name = $('partyName').value.trim(), editId = Number($('partyEditId').value), balance = roundMoney(num('partyBalance'));
  if (!name) return alert('أدخل الاسم.');
  if (!editId && (!Number.isFinite(balance))) return alert('الرصيد الافتتاحي يجب أن يكون رقماً صالحاً.');
  if (db.parties.some(p => p.id !== editId && p.type === type && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert('يوجد حساب بنفس الاسم بالفعل.');
  const saved = commitDB(draft => {
    if (editId) { const party = draft.parties.find(p => p.id === editId); if (!party) throw new Error('الحساب غير موجود.'); Object.assign(party, { name, phone: $('partyPhone').value.trim(), notes: $('partyNotes').value.trim() }); }
    else draft.parties.push({ id: nextId(draft.parties), type, name, phone: $('partyPhone').value.trim(), balance, notes: $('partyNotes').value.trim() });
  });
  if (saved) { resetPartyForm(); renderPartiesTable(); }
}
function editParty(id) {
  const party = db.parties.find(p => p.id === id); if (!party || !ensurePermission(party.type === 'supplier' ? 'supplier' : 'customer')) return;
  $('partyEditId').value = id; $('partyType').value = party.type; $('partyName').value = party.name; $('partyPhone').value = party.phone;
  $('partyBalance').value = party.balance; $('partyBalance').disabled = true; $('partyNotes').value = party.notes;
  $('partyFormTitle').textContent = 'تعديل بيانات الحساب — الرصيد يُعدّل بالفواتير والسندات'; window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderPartiesTable() {
  const list = db.parties.filter(p => p.type === $('partyType').value);
  const previousVoucher = $('voucherPartyId').value, previousStatement = $('statementPartySelect').value;
  $('voucherPartyId').innerHTML = options(list, p => `${p.name} (${money(p.balance)})`);
  $('statementPartySelect').innerHTML = options(list, p => p.name);
  if (list.some(p => String(p.id) === previousVoucher)) $('voucherPartyId').value = previousVoucher;
  if (list.some(p => String(p.id) === previousStatement)) $('statementPartySelect').value = previousStatement;
  $('partiesTbody').innerHTML = list.map((p, index) => `<tr><td>${index + 1}</td><td>${esc(p.name)}</td><td>${esc(p.phone || '-')}</td><td>${esc(p.notes || '-')}</td><td>${money(p.balance)}</td>
    <td class="no-print"><button type="button" class="act-btn bg-blue" onclick="showStatementFor(${p.id})">كشف حساب</button></td><td class="no-print"><button type="button" class="act-btn bg-orange" onclick="editParty(${p.id})">تعديل</button></td><td class="no-print"><button type="button" class="act-btn bg-red" onclick="deleteParty(${p.id})">حذف</button></td></tr>`).join('') || '<tr><td colspan="8">لا توجد حسابات مسجلة.</td></tr>';
  $('partiesTbody').closest('table').querySelectorAll('thead th').forEach((th, i) => th.classList.toggle('no-print', i >= 5));
  if ($('partyStatementBox').style.display !== 'none') renderPartyStatement();
}
function deleteParty(id) {
  if (!ensurePermission('admin')) return;
  const party = db.parties.find(p => p.id === id); if (!party) return;
  if (db.invoices.some(i => i.partyId === id) || db.treasury.some(t => t.partyId === id) || party.balance !== 0) return alert('لا يمكن حذف حساب له رصيد أو حركات مالية. احتفظ بالحساب للحفاظ على كشوف الحساب.');
  if (confirm('حذف هذا الحساب؟') && commitDB(draft => { draft.parties = draft.parties.filter(p => p.id !== id); })) { resetPartyForm(); renderPartiesTable(); }
}
function savePartyVoucher() {
  const partyType = db.parties.find(p => p.id === Number($('voucherPartyId').value))?.type;
  if (!ensurePermission(partyType === 'supplier' ? 'purchase' : 'cash')) return;
  const id = Number($('voucherPartyId').value), amount = roundMoney(num('voucherAmount')), note = $('voucherNote').value.trim() || 'دفعة نقدية على الحساب';
  const party = db.parties.find(p => p.id === id);
  if (!party) return alert('اختر الحساب أولاً.');
  if (!Number.isFinite(amount) || amount <= 0) return alert('أدخل مبلغاً موجباً وصحيحاً.');
  if (amount > Math.max(0, party.balance) && !confirm('المبلغ أكبر من الرصيد المستحق. سيُسجل الفرق كرصيد دائن/دفعة مقدمة. هل تريد المتابعة؟')) return;
  let movement;
  if (commitDB(draft => {
    const p = draft.parties.find(p => p.id === id); p.balance = roundMoney(p.balance - amount);
    movement = { id: nextId(draft.treasury), date: localDate(), type: p.type === 'customer' ? 'in' : 'out', amount, partyId: p.id, note: `سند ${p.type === 'customer' ? 'قبض من عميل' : 'صرف لمورد'}: ${p.name} - ${note}` };
    draft.treasury.push(movement);
  })) {
    $('voucherAmount').value = 0; $('voucherNote').value = ''; renderPartiesTable();
    triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><h3>سند ${party.type === 'customer' ? 'قبض' : 'صرف'} نقدية</h3></div><div class="p-meta"><span>${localDate()}</span><span>${esc(party.name)}</span></div><div class="p-totals"><span>المبلغ: ${money(amount)} ج.م</span><span>الرصيد بعد السداد: ${money(party.balance)}</span></div><p>${esc(note)}</p>`);
  }
}
function showStatementFor(id) { $('statementPartySelect').value = id; $('partyStatementBox').style.display = 'block'; renderPartyStatement(); }
function statementMoves(party) {
  const moves = db.invoices.filter(i => i.partyId === party.id && i.mode !== 'quote').map(i => ({ date: i.date, id: i.id, type: MODE_LABELS[i.mode], note: `فاتورة #${i.id}${i.sourceId ? ` (أصل #${i.sourceId})` : ''}`, total: i.netTotal, paid: i.paidAmount, diff: ['sale', 'purchase'].includes(i.mode) ? i.remainAmount : -i.remainAmount }));
  db.treasury.filter(t => t.partyId === party.id).forEach(t => moves.push({ date: t.date, id: t.id, type: 'سند نقدية', note: t.note, total: 0, paid: t.amount, diff: -t.amount }));
  return moves.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
}
function renderPartyStatement() {
  const party = db.parties.find(p => p.id === Number($('statementPartySelect').value));
  if (!party) { $('statementTitle').textContent = 'اختر حساباً لعرض كشف الحساب'; $('statementTbody').innerHTML = ''; return; }
  const moves = statementMoves(party);
  let balance = roundMoney(party.balance - moves.reduce((sum, m) => sum + m.diff, 0));
  const opening = balance;
  $('statementTitle').textContent = `كشف حساب: ${party.name} — الرصيد الحالي: ${money(party.balance)} ج.م`;
  $('statementTbody').innerHTML = `<tr><td>—</td><td>رصيد افتتاحي</td><td>قبل الحركات المسجلة</td><td>—</td><td>—</td><td>${money(opening)}</td><td>${money(balance)}</td></tr>` + moves.map(m => {
    balance = roundMoney(balance + m.diff);
    return `<tr><td>${esc(m.date)}</td><td>${esc(m.type)}</td><td>${esc(m.note)}</td><td>${money(m.total)}</td><td>${money(m.paid)}</td><td>${money(m.diff)}</td><td>${money(balance)}</td></tr>`;
  }).join('');
}
function printPartyStatementA5() {
  if (!db.parties.some(p => p.id === Number($('statementPartySelect').value))) return alert('اختر حساباً أولاً.');
  renderPartyStatement(); $('partyStatementBox').style.display = 'block';
  triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><h3>${esc($('statementTitle').textContent)}</h3></div>${$('partyStatementBox').querySelector('table').outerHTML}`);
}
function openInvLog(type, period = false) {
  const permission = String(type).startsWith('purchase') ? 'purchase-log' : 'sales-log';
  if (type === 'all' && !ensurePermission('admin')) return;
  if (!ensurePermission(permission)) return;
  openSec('sec-invlog', period ? '📑 فواتير الفترة — حدد من وإلى التاريخ' : '📑 سجل الفواتير'); $('logTypeFilter').value = type; renderInvLog();
  if (period) $('logDateFrom').focus();
}
function renderInvLog() {
  let filter = $('logTypeFilter').value;
  if (!isAdmin()) {
    const allowed = can('sales-log') ? ['sale', 'sale_return', 'quote'] : ['purchase', 'purchase_return'];
    if (!allowed.includes(filter)) { filter = allowed[0]; $('logTypeFilter').value = filter; }
    [...$('logTypeFilter').options].forEach(option => { option.disabled = option.value !== 'all' && !allowed.includes(option.value); });
    const allOption = $('logTypeFilter').querySelector('option[value="all"]'); if (allOption) allOption.disabled = true;
  }
  const from = $('logDateFrom').value, to = $('logDateTo').value;
  if (from && to && from > to) { $('invLogTbody').innerHTML = '<tr><td colspan="8">تاريخ البداية بعد تاريخ النهاية. صحّح الفترة.</td></tr>'; return; }
  const list = db.invoices.filter(i => (filter === 'all' || i.mode === filter) && (!from || i.date >= from) && (!to || i.date <= to)).slice().reverse();
  $('invLogTbody').innerHTML = list.map(i => `<tr><td>#${i.id}</td><td>${esc(i.date)}</td><td>${esc(MODE_LABELS[i.mode])}</td><td>${esc(i.partyName)}</td><td>${money(i.netTotal)}</td><td>${money(i.paidAmount)}</td><td>${money(i.remainAmount)}</td><td class="no-print"><button type="button" class="act-btn bg-teal" onclick="printInvoiceById(${i.id})">طباعة A5</button><button type="button" class="act-btn bg-blue" onclick="printInvoiceThermalById(${i.id})">طباعة حرارية</button>${i.mode === 'quote' && !i.convertedToId ? `<button type="button" class="act-btn bg-green" onclick="loadQuoteForSale(${i.id})">تحويل للبيع</button>` : ''}${i.convertedToId ? ` تم التحويل إلى #${i.convertedToId}` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">لا توجد فواتير في هذه الفترة.</td></tr>';
  document.querySelector('#sec-invlog th:last-child').classList.add('no-print');
}
function openTreasury(filter) {
  if (!ensurePermission('cash') || (filter === 'expense' && !ensurePermission('admin'))) return;
  openSec('sec-treasury', '💰 إدارة الخزينة'); if (filter !== 'all') $('trType').value = filter; renderTreasury();
}
function addTreasuryMove() {
  const type = $('trType').value;
  if (type === 'expense' ? !ensurePermission('admin') : !ensurePermission('cash')) return;
  const amount = roundMoney(num('trAmount')), note = $('trNote').value.trim();
  if (!['in', 'out', 'expense'].includes(type) || !Number.isFinite(amount) || amount <= 0 || !note) return alert('أدخل مبلغاً موجباً وبيان الحركة.');
  if (commitDB(draft => { draft.treasury.push({ id: nextId(draft.treasury), date: localDate(), type, amount: roundMoney(amount), note }); })) { $('trAmount').value = 0; $('trNote').value = ''; renderTreasury(); }
}
function renderTreasury() {
  $('treasuryTbody').innerHTML = db.treasury.slice().reverse().map(t => `<tr><td>${esc(t.date)}</td><td>${t.type === 'in' ? 'وارد خزنة' : t.type === 'expense' ? 'مصروفات' : 'منصرف خزنة'}</td><td>${esc(t.note)}</td><td>${t.type === 'in' ? money(t.amount) : '-'}</td><td>${t.type !== 'in' ? money(t.amount) : '-'}</td></tr>`).join('') || '<tr><td colspan="5">لا توجد حركات خزنة.</td></tr>';
}
function openProfitSec(mode = 'general') {
  if (!ensurePermission('admin')) return;
  const selected = $('profItemFilter').value;
  const items = new Map(db.items.map(i => [String(i.id), i.name]));
  db.invoices.filter(i => ['sale', 'sale_return'].includes(i.mode)).flatMap(i => i.items).forEach(i => { if (!items.has(String(i.id))) items.set(String(i.id), `${i.name} (محذوف من المخزن)`); });
  $('profItemFilter').innerHTML = '<option value="all">كل الأصناف</option>' + [...items].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  if ([...items.keys()].includes(selected)) $('profItemFilter').value = selected;
  if (mode === 'item') { const itemId = $('itemEditId').value; if (itemId && items.has(itemId)) $('profItemFilter').value = itemId; }
  openSec('sec-profits', mode === 'item' ? '📈 أرباح صنف محدد' : mode === 'period' ? '📈 أرباح فترة محددة' : '📈 تقرير الأرباح');
  if (mode === 'item') $('profItemFilter').focus(); if (mode === 'period') $('profDateFrom').focus();
}
function renderProfits() {
  try {
    const filter = $('profItemFilter').value, result = calculateTotalProfits($('profDateFrom').value, $('profDateTo').value, filter);
    for (const [id, value] of Object.entries({ profTotSales: result.sales, profTotCost: result.cost, profGross: result.gross, profExpenses: result.expenses, profNet: result.net })) $(id).textContent = money(value);
    $('profitScopeNote').textContent = filter !== 'all' ? 'ربح الصنف بعد الخصومات والمرتجعات. المصروفات العامة لا تُخصم من صنف منفرد؛ تظهر في تقرير كل الأصناف.' : 'الأرباح بعد خصومات الفواتير ومرتجع المبيعات وتكلفة البيع التاريخية، وخصم المصروفات العامة للفترة.';
    $('profitsTbody').innerHTML = result.itemRows.map(r => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(roundQuantity(r.qty))}</td><td>${money(r.rev)}</td><td>${money(r.cst)}</td><td>${money(r.rev - r.cst)}</td></tr>`).join('') || '<tr><td colspan="6">لا توجد مبيعات مطابقة للفترة المحددة.</td></tr>';
  } catch (error) { $('profitScopeNote').textContent = error.message; $('profitsTbody').innerHTML = ''; for (const id of ['profTotSales', 'profTotCost', 'profGross', 'profExpenses', 'profNet']) $(id).textContent = '—'; }
}
function applySettingsUI() {
  $('lblStoreName').textContent = db.settings.name;
  $('lblStoreAddress').textContent = '📍 ' + db.settings.address;
  $('lblStorePhone').textContent = '☎️ ' + db.settings.phone;
}
function loadSettingsForm() {
  $('setStoreName').value = db.settings.name; $('setStoreAddress').value = db.settings.address; $('setStorePhone').value = db.settings.phone;
  $('setPinCode').value = ''; $('setSyncKey').value = sessionToken();
  $('rememberSyncKey').checked = Boolean(localStorage.getItem(REMEMBERED_TOKEN_KEY)) || !sessionToken();
  $('receiptWidth').value = getAppearance().receiptWidth === '58' ? '58' : '80';
  $('staffManagerPanel').hidden = !isAdmin();
  renderStaffTable(); renderAuditTable(); applyAppearance();
}
function saveSettings() {
  if (!ensurePermission('admin')) return;
  const name = $('setStoreName').value.trim(), pin = $('setPinCode').value.trim(), token = $('setSyncKey').value.trim();
  if (!name) return alert('اسم المكتبة مطلوب.');
  if (pin && pin.length < 4) return alert('رقم قفل الشاشة يجب أن يكون أربعة أحرف على الأقل.');
  if (!commitDB(draft => { Object.assign(draft.settings, { name, address: $('setStoreAddress').value.trim(), phone: $('setStorePhone').value.trim(), ...(pin ? { pin } : {}) }); })) return;
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY);
    if (token && $('rememberSyncKey').checked) localStorage.setItem(REMEMBERED_TOKEN_KEY, token);
    else localStorage.removeItem(REMEMBERED_TOKEN_KEY);
  } catch { notify('تعذر حفظ مفتاح المزامنة. اسمح بتخزين بيانات الموقع أو أوقف خيار التذكر.'); return; }
  $('setSyncKey').value = ''; $('setPinCode').value = ''; applySettingsUI(); applyAppearance(); updateActiveUserBadge(); renderStaffTable(); scheduleAutoSync();
  alert(token && $('rememberSyncKey').checked ? 'تم حفظ الإعدادات، وسيظل مفتاح المزامنة محفوظاً على هذا الجهاز.' : 'تم حفظ الإعدادات. سيبقى مفتاح المزامنة لهذه الجلسة فقط.');
}

async function apiRequest(method, body, token) {
  const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/sync', { method, headers: { 'Authorization': `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || `تعذر الاتصال بالخادم (${response.status}).`); error.status = response.status; throw error; }
    return data;
  } finally { window.clearTimeout(timeout); }
}
function syncToCloud(direction) {
  if (!ensurePermission('admin')) return Promise.resolve(false);
  window.clearTimeout(syncTimer);
  const task = syncQueue.then(() => performSync(direction));
  syncQueue = task.catch(() => false);
  return task;
}
async function performSync(direction) {
  const token = sessionToken(), automatic = direction === 'auto_push';
  if (!token) { if (!automatic) { openSec('sec-settings', '⚙️ إعدادات المزامنة'); alert('أدخل مفتاح المزامنة في الإعدادات أولاً. بياناتك المحلية لم تتغير.'); } return false; }
  if (storageBlocked) { if (!automatic) alert('أصلح التخزين المحلي قبل المزامنة.'); return false; }
  if (automatic && (!syncMeta.dirty || syncMeta.revision === null || syncBusy)) return false;
  const previousStatus = $('syncStatusBadge').textContent;
  syncBusy = true; setSyncStatus('جاري المزامنة…');
  const startVersion = localVersion;
  try {
    if (direction === 'pull') {
      if (!automatic && !confirm('السحب سيستبدل البيانات المحلية والفاتورة غير المحفوظة. صدّر نسخة احتياطية إذا أردت الاحتفاظ بها. هل تريد المتابعة؟')) { setSyncStatus(previousStatus); return false; }
      const remote = await apiRequest('GET', null, token);
      if (!Number.isSafeInteger(remote.revision) || remote.revision < 0) throw new Error('إصدار خادم المزامنة قديم. انشر api/sync.js المحدث مع الواجهة أولاً.');
      if (localVersion !== startVersion) { setSyncStatus(previousStatus); alert('تغيرت البيانات المحلية أثناء السحب؛ لم نستبدلها. أعد المحاولة بعد انتهاء الحفظ.'); return false; }
      if (remote.empty) { setSyncStatus(previousStatus); alert('قاعدة البيانات فارغة. ارفع بياناتك أولاً.'); return false; }
      const next = normalizeDatabase(remote.payload);
      writeLocalState(next, { revision: remote.revision, dirty: false });
      db = next; localVersion += 1; syncMeta = { revision: remote.revision, dirty: false }; refreshAfterReplace();
      setSyncStatus('متزامن مع Neon ✅'); if (!automatic) alert('تم سحب البيانات والتحقق منها بنجاح.');
    } else {
      let baseRevision = syncMeta.revision;
      if (baseRevision === null) {
        const remote = await apiRequest('GET', null, token);
        if (!Number.isSafeInteger(remote.revision) || remote.revision < 0) throw new Error('إصدار خادم المزامنة قديم. انشر api/sync.js المحدث مع الواجهة قبل الرفع.');
        if (!remote.empty) {
          if (automatic || !confirm('توجد بيانات سحابية لم تُربط بهذه النسخة المحلية. الأفضل سحبها أولاً. يمكنك بدلاً من ذلك استبدالها بعد تأمين نسخة احتياطية. هل تريد استبدال النسخة السحابية؟')) {
            setSyncStatus('تعارض نسخ — السحب أو التصدير أولاً'); if (!automatic) alert('لم تُستبدل أي بيانات. صدّر النسخة المحلية ثم اسحب النسخة السحابية للمقارنة.'); return false;
          }
        }
        baseRevision = remote.revision;
      }
      if (localVersion !== startVersion) { setSyncStatus('محفوظ محلياً — في انتظار المزامنة'); scheduleAutoSync(); return false; }
      const result = await apiRequest('POST', { payload: db, baseRevision }, token);
      if (!Number.isSafeInteger(result.revision)) throw new Error('رد المزامنة غير صالح.');
      const dirty = localVersion !== startVersion;
      writeMeta({ revision: result.revision, dirty });
      setSyncStatus(dirty ? 'توجد تعديلات محلية أحدث للمزامنة' : 'متزامن مع Neon ✅');
      if (dirty) scheduleAutoSync(); else if (!automatic) alert('تم رفع بيانات المكتبة إلى Neon بنجاح.');
    }
    return true;
  } catch (error) {
    const message = error.name === 'AbortError' ? 'انتهت مهلة الاتصال. البيانات المحلية محفوظة.' : error.status === 409 ? 'يوجد تعديل أحدث على جهاز آخر. صدّر نسخة محلية ثم اسحب النسخة السحابية قبل إعادة الرفع.' : error.message;
    setSyncStatus(error.status === 409 ? 'تعارض نسخ — لم تُستبدل البيانات' : 'محفوظ محلياً — المزامنة غير متاحة');
    if (!automatic) alert(message); else notify(`المزامنة لم تكتمل: ${message}`);
    return false;
  } finally { syncBusy = false; }
}
function refreshAfterReplace() {
  invCart = []; quickEditMode = false; delete $('invCartTbody').dataset.quoteId;
  resetItemForm(); resetPartyForm(); clearInvCart(); applySettingsUI(); updateDashboardKPIs(); populateCategoriesSelect(); renderItemsTable(); updateInvoiceUI();
  const active = document.querySelector('.sec-view.active')?.id;
  if (active === 'sec-stock') openStockFilter('all');
  if (active === 'sec-categories') renderCategoriesTable(); if (active === 'sec-parties') renderPartiesTable();
  if (active === 'sec-invlog') renderInvLog(); if (active === 'sec-treasury') renderTreasury(); if (active === 'sec-profits') openProfitSec(); if (active === 'sec-settings') loadSettingsForm();
}
function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportFullBackup() { if (!ensurePermission('admin')) return; download(JSON.stringify(db, null, 2), 'application/json', `Bookstore_Backup_${localDate()}.json`); recordAudit('تصدير نسخة احتياطية'); }
function exportRecovery() { if (recoveryRaw !== null) download(recoveryRaw, 'application/json', `Bookstore_Recovery_${localDate()}.json`); }
async function importFullBackup(event) {
  if (!ensurePermission('admin')) { event.target.value = ''; return; }
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('الملف أكبر من الحد المسموح (4 ميجابايت).');
    const next = normalizeDatabase(JSON.parse(await file.text()));
    if (!confirm('الاستعادة ستستبدل بيانات هذا الجهاز، ولن ترفع تلقائياً إلى Neon. هل تريد المتابعة؟')) return;
    if (recoveryRaw !== null && !confirm('لديك بيانات محلية تالفة لم تُصلح بعد. نزّلها أولاً إذا كنت تحتاجها. هل تريد استبدالها بالنسخة المستعادة؟')) return;
    // Restoring an old backup must not make it eligible to overwrite a newer cloud revision.
    writeLocalState(next, { revision: null, dirty: true });
    db = next; syncMeta = { revision: null, dirty: true }; storageBlocked = false; recoveryRaw = null; localVersion += 1;
    refreshAfterReplace(); recordAudit('استعادة نسخة احتياطية'); setSyncStatus('تمت الاستعادة محلياً — راجع البيانات قبل الرفع'); alert('تمت الاستعادة محلياً. لم تُرفع البيانات إلى السحابة تلقائياً.');
  } catch (error) { alert(`لم تُستعد النسخة: ${error.message}`); }
  finally { event.target.value = ''; }
}
function exportItemsCSV() {
  const cell = value => { let string = String(value ?? ''); if (typeof value !== 'number' && /^[\s]*[=+\-@]|[\t\r]/.test(string)) string = `'${string}`; return `"${string.replaceAll('"', '""')}"`; };
  const rows = [['الكود', 'اسم الصنف', 'المجموعة', 'الكمية', 'الوحدة', 'سعر الشراء', 'سعر البيع', 'سعر الجملة'], ...db.items.map(i => [i.code, i.name, i.cat, i.qty, i.unit, i.buy, i.sell, i.wholesale])];
  download('\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8;', 'Bookstore_Items.csv');
}
function printableTable(table) {
  const copy = table.cloneNode(true);
  const originals = table.querySelectorAll('input, select, textarea'), copies = copy.querySelectorAll('input, select, textarea');
  copies.forEach((input, index) => { const original = originals[index]; const value = original.tagName === 'SELECT' ? original.selectedOptions[0]?.textContent || '' : original.value; input.replaceWith(document.createTextNode(value)); });
  copy.querySelectorAll('button, .no-print').forEach(el => el.remove());
  copy.querySelectorAll('tr').forEach(row => { [...row.children].forEach((cell, index) => { if (table.querySelector('thead tr')?.children[index]?.classList.contains('no-print')) cell.remove(); }); });
  return copy.outerHTML;
}
function triggerA5Print(html) { $('printAreaA5').innerHTML = html; window.print(); }
function printItemsReportA5() {
  const rows = db.items.map(i => `<tr><td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${esc(i.qty)}</td><td>${money(i.buy)}</td><td>${money(i.sell)}</td></tr>`).join('');
  triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><h3>تقرير جرد وأسعار الأصناف (A5)</h3></div><table class="p-table"><thead><tr><th>الكود</th><th>الصنف</th><th>الكمية</th><th>شراء</th><th>بيع</th></tr></thead><tbody>${rows}</tbody></table>`);
}
function printCurrentScreenA5() {
  const active = document.querySelector('.sec-view.active'), table = active?.querySelector('table');
  if (!table) return alert('لا يوجد تقرير جدولي في هذه الشاشة. افتح الأصناف أو المخزن أو الفواتير أو التقارير للطباعة.');
  const summary = active.querySelector('.t-foot-bar')?.textContent || '';
  triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><h3>${esc($('winTitle').textContent)}</h3></div>${printableTable(table)}<p>${esc(summary)}</p>`);
}
function lockApp() {
  closeWorkspace();
  beforeLockFocus = document.activeElement;
  $('loginStaffSelect').innerHTML = staffList().map(user => `<option value="${esc(user.id)}">${esc(user.name)} — ${roleLabel(user.role)}</option>`).join('');
  $('loginStaffSelect').value = activeStaffId; $('lockModal').style.display = 'flex'; $('unlockPinInp').value = ''; $('unlockPinInp').focus();
  document.querySelectorAll('body > :not(#lockModal):not(#printAreaA5):not(script)').forEach(el => { el.inert = true; });
}
function unlockApp() {
  const user = staffList().find(entry => entry.id === $('loginStaffSelect').value);
  if (!user || $('unlockPinInp').value !== user.pin) return alert('الرقم السري غير صحيح.');
  activeStaffId = user.id; staffSession = true;
  try { sessionStorage.setItem(ACTIVE_STAFF_KEY, activeStaffId); } catch { notify('تعذر حفظ جلسة المستخدم؛ سيطلب النظام تسجيل الدخول مرة أخرى عند تحديث الصفحة.'); }
  $('lockModal').style.display = 'none'; $('unlockPinInp').value = '';
  document.querySelectorAll('[inert]').forEach(el => { el.inert = false; });
  updateActiveUserBadge(); recordAudit(`تسجيل دخول (${roleLabel(user.role)})`); beforeLockFocus?.focus();
}

// Explicit public API for the existing HTML buttons; implementation details remain module-scoped.
Object.assign(window, {
  openSec, closeWorkspace, minimizeWorkspace, restoreWorkspace, maximizeWorkspace, selectTheme, setCustomAccent, setReceiptWidth, toggleSidebar, showHome, toggleDarkMode, toggleClassicGrid, quickAddCategory, generateNewCode, calcPriceFromProfit, calcProfitFromPrice, saveItem, resetItemForm, saveStaff, deleteStaff,
  renderItemsTable, inlineUpdateItem, toggleQuickEditItems, editItem, deleteItem, showSingleItemProfit, printBarcodeLabel,
  addCategory, deleteCategory, openStockFilter, openInvoiceSec, changeInvoiceMode, updateInvoiceUI, loadReturnSource,
  addInvItemFromInput, updateCartPricesByTier, updateCartRow, removeCartRow, calcInvoiceTotals, calcInvoiceRemaining, clearInvCart, holdCurrentInvoice, restoreHeldInvoice,
  convertQuoteToSale, loadQuoteForSale, saveInvoice, printInvoiceById, printInvoiceThermalById, openPartySec, openPartyReport, resetPartyForm, saveParty,
  editParty, deleteParty, savePartyVoucher, showStatementFor, renderPartyStatement, printPartyStatementA5, openInvLog, renderInvLog,
  openTreasury, addTreasuryMove, openProfitSec, renderProfits, saveSettings, syncToCloud, exportFullBackup, importFullBackup,
  exportItemsCSV, printItemsReportA5, printCurrentScreenA5, lockApp, unlockApp
});
export { initializeApp };
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initializeApp, { once: true });
else initializeApp();
