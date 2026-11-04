import { INVOICE_MODES, MODE_LABELS, roundMoney, roundQuantity, lineGross, calculateTotals, invoiceLines, weightedAverageCost, localDate, nextId } from './lib/finance.js';
import { emptyDatabase, normalizeDatabase, returnedQuantity } from './lib/data.js';
import { code39Svg, qrCodeSvg } from './lib/barcode.js';

const DB_KEY = 'BOOKSTORE_POS_COMPLETE_DB_V2';
const META_KEY = `${DB_KEY}_SYNC_META`;
const TOKEN_KEY = `${DB_KEY}_SESSION_TOKEN`;
const REMEMBERED_TOKEN_KEY = `${DB_KEY}_REMEMBERED_TOKEN`;
const APPEARANCE_KEY = `${DB_KEY}_APPEARANCE`;
const STAFF_KEY = `${DB_KEY}_STAFF`;
const AUDIT_KEY = `${DB_KEY}_AUDIT`;
const HELD_CARTS_KEY = `${DB_KEY}_HELD_CARTS`;
const ACTIVE_STAFF_KEY = `${DB_KEY}_ACTIVE_STAFF`;
const THEMES = ['vista-classic', 'vista-blue', 'vista-emerald', 'vista-rose', 'win11-indigo', 'win11-mint', 'win11-sunset', 'night', 'custom'];
const ACCENT_DEFAULTS = { 'vista-classic': '#3b7323', 'vista-blue': '#1f74a8', 'vista-emerald': '#1f8a5c', 'vista-rose': '#b04a76', 'win11-indigo': '#5b5bd6', 'win11-mint': '#12857a', 'win11-sunset': '#c8603f', night: '#8fb4ff' };
const THEME_LABELS = { 'vista-classic': 'كلاسيكي أخضر', 'vista-blue': 'Vista أزرق', 'vista-emerald': 'Vista أخضر طبيعي', 'vista-rose': 'Vista وردي', 'win11-indigo': 'Windows 11 نيلي', 'win11-mint': 'Windows 11 نعناعي', 'win11-sunset': 'Windows 11 غروب', night: 'الوضع الليلي', custom: 'تخصيص كامل' };

const $ = id => document.getElementById(id);
const $$ = selector => [...document.querySelectorAll(selector)];
const clone = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = value => roundMoney(Number(value) || 0).toFixed(2);
const num = id => $(id).value.trim() === '' ? NaN : Number($(id).value);
const options = (list, label) => list.map(p => `<option value="${esc(p.id)}">${esc(label(p))}</option>`).join('');

let db = emptyDatabase();
let invCart = [];
let selectedCartIndex = -1;
let posGroup = 'all';
let posTiles = [];
let labelCache = [];
let keypad = { mode: 'cart', index: -1, field: 'qty' };
let quickEditMode = false;
let storageBlocked = false;
let recoveryRaw = null;
let localVersion = 0;
let syncMeta = { revision: null, dirty: true };
let syncTimer = null;
let syncQueue = Promise.resolve();
let syncBusy = false;
let lastInvoiceMode = 'sale';
let currentInvoiceTab = 'details';
const TAB_LABELS = { details: 'تفاصيل الفاتورة', discount: 'الخصم', party: 'العميل والحساب', notes: 'ملاحظات وطباعة' };
let beforeLockFocus = null;
let clockTimer;
const ACTIVITY_UNREAD_KEY = `${DB_KEY}_ACTIVITY_UNREAD`;
const DRAFT_KEY = `${DB_KEY}_DRAFT`;
const DRAFT_EVERY_MS = 4000;
let activeStaffId = 'owner';
let staffSession = null;

/* ------------------------------------------------------------------ */
/* Storage, staff and audit                                            */
/* ------------------------------------------------------------------ */
function safeReadArray(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function staffList() {
  const employees = safeReadArray(STAFF_KEY).filter(user => user && user.id && user.role !== 'admin');
  return [{ id: 'owner', name: db.settings.name || 'المدير', role: 'admin', pin: db.settings.pin || '1234' }, ...employees];
}
function loginName(user) { return user.role === 'admin' ? 'المدير' : user.name; }
const DISCOUNT_LIMIT_DEFAULT = 10;
function discountLimitFor(user = activeStaff()) {
  if (user.role === 'admin') return 100;
  const limit = Number(user.discountLimit);
  return Number.isFinite(limit) ? Math.min(100, Math.max(0, limit)) : DISCOUNT_LIMIT_DEFAULT;
}
function renderDiscountLimit() {
  if (!$('discountLimitValue')) return;
  const limit = discountLimitFor();
  const percent = invoiceDiscountPercent();
  $('discountLimitValue').textContent = `${limit}%`;
  const over = percent > limit + 0.0001 && !isAdmin();
  if ($('discountWarn')) $('discountWarn').hidden = !over;
  if ($('discountLimitBox')) $('discountLimitBox').dataset.state = over ? 'over' : 'none';
}
function invoiceDiscountPercent() {
  const subtotal = Number(String($('invSubTotal')?.value || '0').replace(/,/g, '')) || 0;
  const net = Number(String($('invNetTotal')?.value || '0').replace(/,/g, '')) || 0;
  if (subtotal <= 0) return 0;
  return roundMoney(Math.max(0, (subtotal - net) / subtotal * 100));
}
async function confirmOverLimitDiscount() {
  const percent = invoiceDiscountPercent();
  const limit = discountLimitFor();
  if (percent <= limit + 0.0001) return true;
  if (isAdmin()) return true;
  const approved = await appConfirm(`الخصم الحالي ${percent}% يتجاوز حد الكاشير المسموح (${limit}%). تحتاج موافقة المدير لإتمام الفاتورة.`,
    { title: 'تجاوز حد الخصم', icon: '🛡️', confirmText: 'طلب موافقة المدير', cancelText: 'إلغاء', tone: 'cancel' });
  if (!approved) return false;
  const pin = window.prompt('أدخل الرقم السري للمدير للموافقة على الخصم:') || '';
  if (pin !== (db.settings.pin || '1234')) { alert('الرقم السري للمدير غير صحيح؛ لم تُحفظ الفاتورة.'); return false; }
  recordAudit(`موافقة مدير على خصم ${percent}% (حد الكاشير ${limit}%)`);
  return true;
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
function roleLabel(role) { return ({ admin: 'مدير', cashier: 'كاشير', inventory: 'مخزن' })[role] || 'موظف'; }
function updateActiveUserBadge() {
  const badge = $('activeUserBadge');
  if (badge) badge.textContent = `${activeStaff().name} · ${roleLabel(activeStaff().role)}`;
  if ($('statusUser')) $('statusUser').textContent = activeStaff().name;
  if ($('statusRole')) $('statusRole').textContent = activeStaff().role === 'admin' ? 'مدير عام' : roleLabel(activeStaff().role);
}
function recordAudit(action) {
  try {
    const entries = safeReadArray(AUDIT_KEY);
    entries.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, time: new Date().toLocaleString('ar-EG'), user: activeStaff().name, role: activeStaff().role, action: String(action).slice(0, 180) });
    localStorage.setItem(AUDIT_KEY, JSON.stringify(entries.slice(0, 500)));
    refreshActivityLog(entries[0]);
  } catch { /* Audit storage must never prevent a business transaction from saving. */ }
}
/* ---- live activity log: a small floating window fed by recordAudit ---- */
function activityIcon(action) {
  const text = String(action || '');
  if (text.includes('فاتورة') || text.includes('مبيعات')) return '🧾';
  if (text.includes('خصم')) return '🛡️';
  if (text.includes('خزنة') || text.includes('خزينة') || text.includes('دفع')) return '💰';
  if (text.includes('صنف') || text.includes('مخزون') || text.includes('جرد')) return '📦';
  if (text.includes('عميل') || text.includes('مورد') || text.includes('حساب')) return '👥';
  if (text.includes('دخول') || text.includes('موظف') || text.includes('مستخدم')) return '👤';
  if (text.includes('قفل') || text.includes('تذكر')) return '🔐';
  if (text.includes('مزامنة') || text.includes('نسخة') || text.includes('رفع')) return '☁️';
  if (text.includes('إعداد') || text.includes('مظهر') || text.includes('ثيم')) return '⚙️';
  return '•';
}
function activityLogOpen() { const box = $('activityLog'); return Boolean(box && !box.hidden); }
function activityUnread() {
  const value = Number(localStorage.getItem(ACTIVITY_UNREAD_KEY) || '0');
  return Number.isFinite(value) && value > 0 ? value : 0;
}
function setActivityUnread(count) {
  try { localStorage.setItem(ACTIVITY_UNREAD_KEY, String(Math.max(0, count))); } catch { /* ignore quota errors */ }
  paintActivityBadge();
}
function paintActivityBadge() {
  const button = $('activityLogBtn');
  if (!button) return;
  const unread = activityLogOpen() ? 0 : activityUnread();
  button.textContent = unread ? `📜 سجل النشاط (${unread > 99 ? '99+' : unread})` : '📜 سجل النشاط';
  button.dataset.unread = unread ? 'yes' : 'no';
}
function refreshActivityLog(highlight) {
  const list = $('activityLogList');
  if (!activityLogOpen()) {
    setActivityUnread(activityUnread() + 1);
    if ($('activityLogMeta')) $('activityLogMeta').textContent = 'حركة جديدة — اضغط للسجل';
    return;
  }
  setActivityUnread(0);
  if (!list) return;
  const entries = safeReadArray(AUDIT_KEY).slice(0, 30);
  list.innerHTML = entries.map(entry => `<div class="activity-row${highlight && entry.id === highlight.id ? ' is-new' : ''}">
      <span class="a-ico" aria-hidden="true">${activityIcon(entry.action)}</span>
      <span class="a-body"><span class="a-text">${esc(entry.action)}</span><span class="a-meta">${esc(entry.time)} · ${esc(entry.user)} (${roleLabel(entry.role)})</span></span>
    </div>`).join('') || '<div class="activity-empty">لا توجد حركات مسجلة بعد.</div>';
  if ($('activityLogMeta')) $('activityLogMeta').textContent = entries.length ? `آخر ${entries.length} حركة · ${entries[0].time}` : 'لا توجد حركات';
}
function renderActivityLog() { if (activeStaffId) { setActivityUnread(0); refreshActivityLog(); } }
function toggleActivityLog(force) {
  const box = $('activityLog');
  if (!box) return;
  const opening = force === undefined ? box.hidden : Boolean(force);
  box.hidden = !opening;
  if ($('activityLogBtn')) $('activityLogBtn').setAttribute('aria-pressed', opening ? 'true' : 'false');
  if (opening) { setActivityUnread(0); refreshActivityLog(); }
  else paintActivityBadge();
}
function openActivityPage() {
  toggleActivityLog(false);
  if (!ensurePermission('admin')) return;
  openSec('sec-settings', '🧾 سجل النشاط');
  renderAuditTable();
  $('auditTbody')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function recordDBAudit(previous, next) {
  const changed = [];
  for (const [key, label] of [['items', 'الأصناف والمخزون'], ['invoices', 'الفواتير'], ['parties', 'حسابات العملاء والموردين'], ['treasury', 'حركات الخزنة'], ['categories', 'المجموعات'], ['settings', 'الإعدادات']]) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changed.push(label);
  }
  if (changed.length) recordAudit(`تعديل: ${changed.join('، ')}`);
}
function renderStaffTable() {
  const body = $('staffTbody'); if (!body) return;
  const employees = safeReadArray(STAFF_KEY);
  body.innerHTML = `<tr><td>1</td><td>${esc(db.settings.name || 'المدير')}</td><td>مدير</td><td>بلا حد (100%)</td><td>حساب المالك</td><td>—</td></tr>` + employees.map((user, index) => `<tr><td>${index + 2}</td><td>${esc(user.name)}</td><td>${roleLabel(user.role)}</td><td>${discountLimitFor(user)}%</td><td>مستخدم محلي</td><td><button type="button" class="act-btn bg-red" onclick="deleteStaff('${encodeURIComponent(user.id)}')">حذف</button></td></tr>`).join('');
}
function renderAuditTable() {
  const body = $('auditTbody'); if (!body) return;
  body.innerHTML = safeReadArray(AUDIT_KEY).slice(0, 50).map(entry => `<tr><td>${esc(entry.time)}</td><td>${esc(entry.user)} (${roleLabel(entry.role)})</td><td>${esc(entry.action)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-row">لا توجد حركات مسجلة بعد.</td></tr>';
}
function saveStaff() {
  if (!ensurePermission('admin')) return;
  const name = $('staffNameInp').value.trim(), pin = $('staffPinInp').value.trim(), role = $('staffRoleInp').value;
  if (name.length < 2 || pin.length < 4) return alert('أدخل اسم الموظف ورقماً سرياً من 4 أحرف/أرقام على الأقل.');
  if (!['cashier', 'inventory'].includes(role)) return alert('اختر صلاحية موظف صحيحة.');
  const rawLimit = Number($('staffDiscountLimit')?.value);
  const discountLimit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(0, rawLimit)) : DISCOUNT_LIMIT_DEFAULT;
  const users = safeReadArray(STAFF_KEY), id = `staff-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  users.push({ id, name, pin, role, discountLimit });
  try { localStorage.setItem(STAFF_KEY, JSON.stringify(users)); }
  catch { return alert('تعذر حفظ بيانات الموظف في المتصفح.'); }
  $('staffNameInp').value = ''; $('staffPinInp').value = ''; if ($('staffDiscountLimit')) $('staffDiscountLimit').value = String(DISCOUNT_LIMIT_DEFAULT);
  renderStaffTable(); recordAudit(`إضافة مستخدم موظف بصلاحية ${roleLabel(role)} بحد خصم ${discountLimit}%`);
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
  const button = $('restoreHeldButton');
  if (button) { const count = safeReadArray(HELD_CARTS_KEY).length; button.textContent = `↩️ استعادة معلقة (${count})`; button.disabled = !count; button.classList.toggle('has-held', count > 0); }
}
function notify(message) {
  const box = $('appNotice');
  if (box) {
    box.innerHTML = `<button type="button" aria-label="إغلاق التنبيه" onclick="this.parentElement.hidden=true">×</button>${esc(message)}`;
    box.hidden = false;
  }
  showNoticePopup(message);
}
let noticePopupTimer = 0;
function showNoticePopup(message) {
  const popup = $('noticePopup'); if (!popup) return;
  $('noticePopupText').textContent = String(message);
  popup.hidden = false; popup.classList.remove('out');
  window.clearTimeout(noticePopupTimer);
  noticePopupTimer = window.setTimeout(closeNoticePopup, 4200);
}
function closeNoticePopup() {
  const popup = $('noticePopup'); if (!popup || popup.hidden) return;
  window.clearTimeout(noticePopupTimer);
  popup.classList.add('out');
  window.setTimeout(() => { popup.hidden = true; popup.classList.remove('out'); }, 240);
}
function sessionToken() {
  try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(REMEMBERED_TOKEN_KEY) || ''; } catch { return ''; }
}
const SYNC_SHORT = { local: 'محفوظ محلياً', synced: 'المزامنة مفعّلة', error: 'تعارض/مراجعة المزامنة' };
function setSyncStatus(message) {
  const badge = $('syncStatusBadge');
  if (badge) {
    const state = /متزامن مع|جاري المزامنة/.test(message) ? 'synced' : /غير متاحة|تعارض|يحتاج إصلاح|لم تكتمل/.test(message) ? 'error' : 'local';
    const busy = /جاري المزامنة/.test(message);
    badge.dataset.state = state;
    badge.innerHTML = `<i class="status-dot"></i><span class="sync-text">${esc(busy ? 'جاري المزامنة…' : (SYNC_SHORT[state] || message))}</span>`;
    badge.title = message;
  }
  const navStatus = document.querySelector('.side-nav-foot .nav-label');
  if (navStatus) navStatus.textContent = badge?.dataset.state === 'synced' ? 'متصل ومتزامن مع Neon' : badge?.dataset.state === 'error' ? 'يحتاج مراجعة' : 'محفوظ على هذا الجهاز';
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

/* ------------------------------------------------------------------ */
/* Clock and boot                                                      */
/* ------------------------------------------------------------------ */
function updateClock() {
  const now = new Date();
  const date = localDate(now).replaceAll('-', '/');
  const time = now.toTimeString().slice(0, 8);
  const weekday = new Intl.DateTimeFormat('ar-EG', { weekday: 'long' }).format(now);
  if ($('liveDate')) { $('liveDate').textContent = date; $('liveDate').title = weekday; }
  if ($('liveTime')) $('liveTime').textContent = time;
  if ($('statusClock')) $('statusClock').textContent = `${date} ${now.toTimeString().slice(0, 5)} ${new Intl.DateTimeFormat('ar-EG', { weekday: 'long' }).format(now)}`;
}
/* ------------------------------------------------------------------ */
/* Floating page dialogs: confirm/prompt replacements + toast popups   */
/* ------------------------------------------------------------------ */
const TRUSTED_DEVICE_KEY = `${DB_KEY}_TRUSTED_DEVICE`;
const LAST_STAFF_KEY = `${DB_KEY}_LAST_STAFF`;
const AUTO_LOCK_DEFAULT_MINUTES = 10;
const nativeConfirm = typeof window.confirm === 'function' ? window.confirm.bind(window) : () => true;
let dialogResolver = null;
function askDialog({ title = 'تأكيد', icon = '❓', body = '', note = '', confirmText = 'متابعة', cancelText = 'إلغاء', tone = 'confirm', onlyOk = false } = {}) {
  const modal = $('syncDialog');
  if (!modal) return Promise.resolve(nativeConfirm(body));
  if (dialogResolver) { dialogResolver(false); dialogResolver = null; }
  $('syncDialogTitle').textContent = title;
  $('syncDialogIco').textContent = icon;
  $('syncDialogBody').innerHTML = `${body}<span class="page-modal-note">${esc(note || '')}</span>`;
  const foot = $('syncDialogFoot');
  foot.innerHTML = '';
  const close = answer => {
    modal.hidden = true;
    const resolve = dialogResolver; dialogResolver = null;
    if (resolve) resolve(answer);
  };
  const okButton = document.createElement('button');
  okButton.type = 'button'; okButton.className = `dialog-action ${tone}`; okButton.textContent = confirmText;
  okButton.onclick = () => close(true);
  foot.append(okButton);
  if (!onlyOk) {
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button'; cancelButton.className = 'dialog-action'; cancelButton.textContent = cancelText;
    cancelButton.onclick = () => close(false);
    foot.append(cancelButton);
  }
  modal.hidden = false;
  window.setTimeout(() => okButton.focus(), 30);
  return new Promise(resolve => { dialogResolver = resolve; });
}
function closeSyncDialog() { if (dialogResolver) { dialogResolver(false); dialogResolver = null; } if ($('syncDialog')) $('syncDialog').hidden = true; }
function showSyncDialog({ title = 'المزامنة', icon = '☁️', body = '', note = '', ok = 'حسناً', tone = 'neutral' } = {}) {
  return askDialog({ title, icon, body, note, confirmText: ok, tone, onlyOk: true });
}
// A browser-owned confirm is a native function; test harnesses (and some embeds) replace it with a stub.
const confirmIsInteractive = (() => {
  try { return typeof window.confirm === 'function' && /\[native code\]/.test(String(window.confirm)); } catch { return false; }
})();
function appConfirm(message, options = {}) {
  // Promise-based confirmation so callers can await the small floating dialog.
  if (!confirmIsInteractive || !document.body || !document.body.dataset.appReady) return Promise.resolve(nativeConfirm(message));
  const text = String(message);
  const tone = /^(حذف|استبدال|استعادة|تفريغ)/.test(text) ? 'cancel' : 'confirm';
  return askDialog({ title: options.title || 'تأكيد العملية', icon: options.icon || '❔', body: esc(text),
    confirmText: options.confirmText || 'متابعة', cancelText: 'إلغاء', tone: options.tone || tone });
}
window.confirm = message => nativeConfirm(message);

/* ---- welcome popup: appears after a successful login and closes itself ---- */
let welcomeTimer = 0;
function showWelcomePopup(name) {
  const popup = $('welcomePopup'); if (!popup) return;
  $('welcomeTitle').textContent = `أهلاً بك يا ${name}`;
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? 'صباح الخير' : hour < 17 ? 'طاب نهارك' : 'مساء الخير';
  $('welcomeSub').textContent = `${partOfDay} — تم تسجيل الدخول بنجاح، بالتوفيق في يومك`;
  popup.hidden = false; popup.classList.remove('out');
  window.clearTimeout(welcomeTimer);
  welcomeTimer = window.setTimeout(closeWelcomePopup, 3000);
}
function closeWelcomePopup() {
  const popup = $('welcomePopup'); if (!popup || popup.hidden) return;
  window.clearTimeout(welcomeTimer);
  popup.classList.add('out');
  window.setTimeout(() => { popup.hidden = true; popup.classList.remove('out'); }, 260);
}

/* ---- start screen: animated loading bar, then the rounded login box ---- */
let startScreenTimer = 0;
function startScreenProgress(done) {
  const fill = $('startLoadFill'), pct = $('startLoadPct'), label = $('startLoaderLabel');
  const steps = ['جارٍ تحضير البرنامج…', 'تحميل البيانات المحلية…', 'فحص الأصناف والخزنة…', 'تجهيز شاشة البداية…'];
  let value = 0, step = 0;
  window.clearInterval(startScreenTimer);
  startScreenTimer = window.setInterval(() => {
    value = Math.min(100, value + (value < 60 ? 17 : value < 85 ? 9 : 4));
    if (fill) fill.style.width = `${value}%`;
    if (pct) pct.textContent = `${value}%`;
    const nextStep = Math.min(steps.length - 1, Math.floor(value / 26));
    if (nextStep !== step && label) { step = nextStep; label.textContent = steps[step]; }
    if (value >= 100) { window.clearInterval(startScreenTimer); window.setTimeout(done, 180); }
  }, 130);
}
function finishStartScreen() {
  window.clearInterval(startScreenTimer);
  if ($('startLoader')) $('startLoader').hidden = true;
  if ($('startLogin')) $('startLogin').hidden = false;
  if ($('startFooterUser')) $('startFooterUser').textContent = staffList().map(user => user.name).join(' / ') || 'مدير';
  $('unlockPinInp')?.focus();
}

/* ---- auto lock after inactivity + "remember this device" ---- */
let autoLockTimer = 0;
let autoLockArmed = false;
function prefersReducedMotion() {
  try { return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}
function autoLockMinutes() {
  const value = Number(getAppearance().autoLockMinutes);
  return Number.isFinite(value) ? Math.min(120, Math.max(0, value)) : AUTO_LOCK_DEFAULT_MINUTES;
}
function setAutoLockMinutes(value) {
  const minutes = Number(value);
  const appearance = getAppearance();
  appearance.autoLockMinutes = Number.isFinite(minutes) ? Math.min(120, Math.max(0, Math.round(minutes))) : AUTO_LOCK_DEFAULT_MINUTES;
  saveAppearance(appearance);
  if ($('autoLockSelect')) $('autoLockSelect').value = String(appearance.autoLockMinutes);
  if (!appearance.autoLockMinutes) { window.clearTimeout(autoLockTimer); notify('تم إيقاف القفل التلقائي.'); return; }
  armAutoLock();
  notify(`سيتم قفل الشاشة تلقائياً بعد ${appearance.autoLockMinutes} دقيقة بدون استخدام.`);
}
function togglePinVisibility(button) {
  const field = $('unlockPinInp'); if (!field) return;
  const show = field.type === 'password';
  field.type = show ? 'text' : 'password';
  if (button) button.textContent = show ? '🙈' : '👁️';
  field.focus();
}
function isTrustedDevice() {
  try { return localStorage.getItem(TRUSTED_DEVICE_KEY) === 'yes'; } catch { return false; }
}
function rememberDeviceStep(checked) {
  const box = $('rememberDevice');
  if (box) box.checked = checked;
  const hint = $('rememberDeviceHint');
  if (hint) hint.textContent = checked ? 'هذا الجهاز موثوق: ستُفتح الشاشة الرئيسية مباشرة عند التشغيل.' : 'غير موثوق: ستظهر شاشة البداية والدخول في كل تشغيل.';
}
function toggleRememberDevice(checked) {
  try {
    if (checked) localStorage.setItem(TRUSTED_DEVICE_KEY, 'yes'); else localStorage.removeItem(TRUSTED_DEVICE_KEY);
  } catch { notify('تعذر حفظ تفضيل الجهاز في المتصفح.'); return; }
  rememberDeviceStep(checked);
  recordAudit(checked ? 'تفعيل تذكر هذا الجهاز' : 'إلغاء تذكر هذا الجهاز');
  notify(checked ? 'تم تفعيل «تذكر هذا الجهاز».' : 'تم إلغاء «تذكر هذا الجهاز».');
}
function lastLoginStaff() {
  try { return localStorage.getItem(LAST_STAFF_KEY) || ''; } catch { return ''; }
}
function armAutoLock() {
  window.clearTimeout(autoLockTimer);
  const minutes = autoLockMinutes();
  if (!minutes || !staffSession || $('lockModal').style.display === 'flex') return;
  autoLockTimer = window.setTimeout(() => {
    if ($('lockModal').style.display === 'flex') return;
    lockApp();
    notify(`تم قفل الشاشة تلقائياً بعد ${minutes} دقيقة بدون استخدام.`);
  }, minutes * 60 * 1000);
}
function noteActivity() {
  if (staffSession && $('lockModal').style.display !== 'flex') armAutoLock();
}

function initializeApp() {
  applyAppearance(); applyDesign(); applySidebarPreference(); decorateActionButtons();
  loadDB(); updateClock(); populateCategoriesSelect(); renderItemsTable(); generateNewCode();
  updateInvoiceUI(); updateActiveUserBadge(); renderHeldCount(); renderSystemAlerts();
  renderLabels(); loadLabelOptions();
  restoreGroups();
  setDashboardOpen(Boolean(getAppearance().boardOpen), { persist: false });
  setupInstallPrompt();
  window.clearInterval(clockTimer);
  clockTimer = window.setInterval(updateClock, 1000);
  window.addEventListener('online', scheduleAutoSync);
  $('sideNav').addEventListener('click', event => {
    const link = event.target.closest('.nav-link'); if (!link) return;
    document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('selected', item === link));
    if (window.innerWidth <= 760) toggleSidebar(false);
  });
  $('windowLayer').addEventListener('click', event => { if (event.target === $('windowLayer')) closeWorkspace(); });
  window.addEventListener('keydown', handleGlobalShortcut);
  let rememberedStaff = '';
  try { rememberedStaff = sessionStorage.getItem(ACTIVE_STAFF_KEY) || ''; } catch { /* Session storage may be disabled. */ }
  if (staffList().some(user => user.id === rememberedStaff)) { activeStaffId = rememberedStaff; updateActiveUserBadge(); armAutoLock(); }
  else if (isTrustedDevice() && staffList().some(user => user.id === lastLoginStaff())) {
    // Trusted device: skip the start screen and open the dashboard straight away.
    activeStaffId = lastLoginStaff();
    try { sessionStorage.setItem(ACTIVE_STAFF_KEY, activeStaffId); } catch { /* private mode */ }
    staffSession = true; updateActiveUserBadge(); armAutoLock();
    document.body.dataset.appReady = 'true';
  } else { activeStaffId = 'owner'; lockApp(); }
  document.body.dataset.appReady = 'true';
  for (const event of ['pointerdown', 'keydown', 'wheel', 'focusin']) window.addEventListener(event, noteActivity, { passive: true });
  rememberDeviceStep(isTrustedDevice());
  renderActivityLog(); paintDraftHint(); startDraftAutosave(); renderStockAlerts(); syncAppBadge();
  const scan = $('invBarcodeInp');
  if (scan) {
    scan.addEventListener('input', () => { if ($('invSuggest')) showSuggestions(); });
    scan.addEventListener('focus', () => { if (scan.value.trim()) showSuggestions(); });
    scan.addEventListener('blur', () => window.setTimeout(hideSuggestions, 160));
  }
  window.setTimeout(offerDraftRestore, 700);
}
function handleGlobalShortcut(event) {
  if ($('lockModal').style.display === 'flex') return;
  if ($('keypadModal').classList.contains('open')) {
    if (event.key === 'Escape') { event.preventDefault(); closeKeypad(); }
    return;
  }
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName);
  const inInvoice = $('windowLayer').classList.contains('open') && $('sec-invoice').classList.contains('active');
  if (event.key === 'Escape' && $('windowLayer').classList.contains('open')) { closeWorkspace(); return; }
  if (event.key === 'F1') { event.preventDefault(); openTreasury('all'); return; }
  if (event.key === 'F2') { event.preventDefault(); openInvoiceSec('sale'); $('invBarcodeInp').focus(); return; }
  if (event.key === 'F3') { event.preventDefault(); if (inInvoice) { clearInvCart(); $('invBarcodeInp').focus(); } else openInvoiceSec('sale'); return; }
  if (event.key === 'F4' && inInvoice) { event.preventDefault(); saveInvoice(false); return; }
  if (event.key === 'F5') { event.preventDefault(); restoreHeldInvoice(); return; }
  if (event.key === 'F6' && inInvoice) { event.preventDefault(); holdCurrentInvoice(); return; }
  if (event.key === 'F7' && inInvoice) { event.preventDefault(); clearInvCart(); $('invBarcodeInp').focus(); return; }
  if (event.key === 'F8' && inInvoice) { event.preventDefault(); focusCartField('qty'); return; }
  if (event.key === 'F9' && inInvoice) { event.preventDefault(); focusCartField('price'); return; }
  if (event.key === 'F10') { event.preventDefault(); if (inInvoice) saveInvoice(true); else openInvLog('sale'); return; }
  if (event.key === 'F11') { event.preventDefault(); openInvLog('sale'); return; }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && inInvoice) { event.preventDefault(); saveInvoice('thermal'); return; }
  if (!typing && event.key === 'Delete' && inInvoice && selectedCartIndex >= 0) { event.preventDefault(); removeCartRow(selectedCartIndex); }
}

/* ------------------------------------------------------------------ */
/* Shell: screens, window, navigation, appearance                      */
/* ------------------------------------------------------------------ */
const SEC_TITLES = {
  'sec-invoice': '🛒 شاشة البيع والاستعلام', 'sec-items': '📦 بيانات الأصناف والمخزون',
  'sec-categories': '📁 بيانات المجموعات', 'sec-stock': '🏢 جرد المخزن',
  'sec-labels': '🏷️ طباعة ملصقات الباركود', 'sec-parties': '👥 إدارة العملاء والموردين',
  'sec-invlog': '📑 سجل الفواتير', 'sec-treasury': '💰 الخزنة والحسابات',
  'sec-profits': '📈 التقارير والأرباح', 'sec-settings': '⚙️ إعدادات النظام'
};
function openSec(secId, titleText) {
  const permission = ({ 'sec-items': 'inventory', 'sec-categories': 'inventory', 'sec-stock': 'stock', 'sec-settings': 'admin', 'sec-profits': 'admin', 'sec-treasury': 'cash', 'sec-labels': 'inventory' })[secId];
  if (permission && !ensurePermission(permission)) return;
  if (secId === 'sec-parties' && !ensurePermission($('partyType').value === 'supplier' ? 'supplier' : 'customer')) return;
  document.querySelectorAll('.sec-view').forEach(el => el.classList.remove('active'));
  $(secId)?.classList.add('active');
  $('windowLayer').classList.add('open', 'maximized');
  $('windowLayer').classList.remove('minimized'); $('windowDock').hidden = true;
  $('maximizeWindowButton').setAttribute('aria-label', 'تصغير النافذة');
  $('maximizeWindowButton').textContent = '❐';
  document.body.style.overflow = 'hidden';
  $('winTitle').textContent = titleText || SEC_TITLES[secId] || 'شاشة البرنامج';
  if (secId === 'sec-items') { populateCategoriesSelect(); renderItemsTable(); }
  if (secId === 'sec-categories') renderCategoriesTable();
  if (secId === 'sec-parties') renderPartiesTable();
  if (secId === 'sec-settings') loadSettingsForm();
  if (secId === 'sec-invlog') renderInvLog();
  if (secId === 'sec-treasury') { renderTreasury(); if ($('kpiCashSide')) $('kpiCashSide').textContent = money(treasuryBalance()); }
  if (secId === 'sec-profits') renderProfits();
  if (secId === 'sec-labels') { loadLabelOptions(); renderLabels(); }
  if (secId === 'sec-invoice') renderPosTiles();
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
  const theme = THEMES.includes(appearance.theme) ? appearance.theme : 'vista-classic';
  document.body.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
  if ($('darkModeButton')) {
    $('darkModeButton').textContent = theme === 'night' ? '☀️' : '🌙';
    $('darkModeButton').title = theme === 'night' ? 'الوضع النهاري' : 'الوضع الليلي';
    $('darkModeButton').setAttribute('aria-label', $('darkModeButton').title);
  }
  const root = document.body.style;
  if (appearance.accent && /^#[0-9a-f]{6}$/i.test(appearance.accent)) {
    // Keep the custom accent readable: derive bar/hover shades from the chosen colour.
    root.setProperty('--accent', appearance.accent);
    root.setProperty('--g-bar', appearance.accent);
    root.setProperty('--g-dark', `color-mix(in srgb, ${appearance.accent} 82%, #000000)`);
    root.setProperty('--g-line', `color-mix(in srgb, ${appearance.accent} 68%, #000000)`);
    root.setProperty('--press-glow', `${appearance.accent}55`);
    if ($('customAccent')) $('customAccent').value = appearance.accent;
  } else {
    for (const name of ['--accent', '--g-bar', '--g-dark', '--g-line', '--press-glow']) root.removeProperty(name);
    if ($('customAccent')) $('customAccent').value = ACCENT_DEFAULTS[theme] || '#2563eb';
  }
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    const active = button.dataset.themeChoice === theme;
    button.title = active ? 'الثيم المفعّل حالياً' : 'اضغط لتفعيل هذا الثيم';
  });
  const current = $('currentThemeName');
  if (current) current.textContent = THEME_LABELS[theme] || 'كلاسيكي أخضر';
}
function selectTheme(theme) {
  if (!THEMES.includes(theme)) return;
  const appearance = getAppearance();
  appearance.theme = theme;
  delete appearance.accent; // A theme switch must visibly change the interface, not keep a stale custom colour.
  saveAppearance(appearance);
  applyAppearance();
  applyDesign();
  const label = THEME_LABELS[theme] || theme;
  notify(`تم تفعيل الثيم: ${label}. يمكنك تغيير اللون الأساسي من الأسفل.`);
}
function setCustomAccent(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  const appearance = getAppearance(); appearance.accent = color; saveAppearance(appearance); applyAppearance();
}
function resetAccent() {
  const appearance = getAppearance(); delete appearance.accent; saveAppearance(appearance); applyAppearance();
  notify('تمت استعادة لون الثيم الأصلي.');
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
  const shell = $('appShell'), isMobile = window.matchMedia ? window.matchMedia('(max-width: 760px)').matches : window.innerWidth <= 760;
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
      (handler.includes('openProfit') ? '📈' : handler.includes('openTreasury') ? '💰' : handler.includes('openParty') ? '👥' : handler.includes('openInvoice') || handler.includes('openInvLog') ? '🧾' : handler.includes('openSec') && handler.includes('sec-labels') ? '🏷️' : handler.includes('openStock') || label.includes('أصناف') ? '📦' : handler.includes('lockApp') ? '🔐' : '◈');
    const cleanLabel = label.replace(/^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*/u, '').trim() || label;
    const iconEl = document.createElement('span'); iconEl.className = 'button-icon'; iconEl.setAttribute('aria-hidden', 'true'); iconEl.textContent = icon;
    const labelEl = document.createElement('span'); labelEl.className = 'button-label'; labelEl.textContent = cleanLabel;
    button.replaceChildren(iconEl, labelEl);
  });
}
function toggleDarkMode() {
  const appearance = getAppearance();
  if (appearance.theme === 'night') appearance.theme = appearance.previousTheme || 'vista-classic';
  else { appearance.previousTheme = appearance.theme || 'vista-classic'; appearance.theme = 'night'; }
  saveAppearance(appearance); applyAppearance();
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */
function treasuryBalance() {
  return roundMoney(db.treasury.reduce((sum, t) => sum + (t.type === 'in' ? t.amount : -t.amount), 0));
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
function renderSystemAlerts() {
  const list = $('systemAlertsList'); if (!list) return;
  const low = db.items.filter(item => item.qty <= item.minQty).length;
  const out = db.items.filter(item => item.qty <= 0).length;
  const customers = db.parties.filter(party => party.type === 'customer' && Math.abs(party.balance) > 0.009);
  const suppliers = db.parties.filter(party => party.type === 'supplier' && Math.abs(party.balance) > 0.009);
  const status = $('syncStatusBadge')?.dataset.state;
  const alerts = [];
  if (!out && !low) alerts.push(`<li class="alert-good"><button type="button" onclick="openStockFilter('all')">✅ المخزون في وضع سليم — لا توجد نواقص</button></li>`);
  if (out) alerts.push(`<li class="alert-danger"><button type="button" onclick="openStockFilter('zero')">🚨 ${out} صنف نافد من المخزن تماماً — اضغط للعرض</button></li>`);
  if (low - out > 0) alerts.push(`<li class="alert-warn"><button type="button" onclick="openStockFilter('low')">⚠️ ${low - out} صنف وصل لحد الطلب</button></li>`);
  if (customers.length) {
    const total = roundMoney(customers.reduce((sum, p) => sum + Math.max(0, p.balance), 0));
    alerts.push(`<li class="alert-danger"><button type="button" onclick="openPartyReport('customer','balances')">👥 مستحقات على ${customers.length} عميل بإجمالي ${money(total)} ج.م</button></li>`);
  }
  if (suppliers.length) {
    const total = roundMoney(suppliers.reduce((sum, p) => sum + Math.max(0, p.balance), 0));
    alerts.push(`<li class="alert-info"><button type="button" onclick="openPartyReport('supplier','balances')">🚚 أرصدة ${suppliers.length} مورد بإجمالي ${money(total)} ج.م</button></li>`);
  }
  if (status === 'error') alerts.push(`<li class="alert-danger"><button type="button" onclick="openSec('sec-settings','⚙️ إعدادات المزامنة')">☁️ المزامنة لم تكتمل — راجع الإعدادات</button></li>`);
  list.innerHTML = alerts.join('');
  if ($('alertsCount')) $('alertsCount').textContent = alerts.length ? `(${alerts.length})` : '';
}

/* Dashboard and quick-access collapsibles */
function setDashboardOpen(open, { persist = true } = {}) {
  const board = $('homeDashboard'); if (!board) return;
  board.classList.toggle('collapsed', !open);
  const toggle = $('boardToggle');
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
  if ($('boardHint')) $('boardHint').textContent = open ? 'اضغط لإغلاق الأرقام' : 'اضغط لعرض الأرقام';
  if (persist) { const appearance = getAppearance(); appearance.boardOpen = Boolean(open); saveAppearance(appearance); }
}
function toggleDashboard(force) {
  const board = $('homeDashboard'); if (!board) return;
  setDashboardOpen(force === undefined ? board.classList.contains('collapsed') : Boolean(force));
}
const OPEN_GROUPS_KEY = 'openActionGroups';
function openGroups() {
  try { const value = JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function saveOpenGroups(keys) {
  try { localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(keys)); } catch { /* visual preference only */ }
}
function setActionGroup(key, open, { persist = true } = {}) {
  const group = document.querySelector(`.action-group[data-group="${key}"]`); if (!group) return;
  group.classList.toggle('open', Boolean(open));
  const head = group.querySelector('.group-head');
  if (head) head.setAttribute('aria-expanded', String(Boolean(open)));
  if (persist) {
    const keys = new Set(openGroups());
    if (open) keys.add(key); else keys.delete(key);
    saveOpenGroups([...keys]);
  }
}
function toggleActionGroup(key) {
  const group = document.querySelector(`.action-group[data-group="${key}"]`); if (!group) return;
  setActionGroup(key, !group.classList.contains('open'));
}
function expandAllGroups() {
  const keys = [];
  document.querySelectorAll('.action-group[data-group]').forEach(group => { keys.push(group.dataset.group); setActionGroup(group.dataset.group, true, { persist: false }); });
  saveOpenGroups(keys);
}
function collapseAllGroups() {
  document.querySelectorAll('.action-group[data-group]').forEach(group => setActionGroup(group.dataset.group, false, { persist: false }));
  saveOpenGroups([]);
}
function restoreGroups() {
  const stored = openGroups();
  document.querySelectorAll('.action-group[data-group]').forEach(group => setActionGroup(group.dataset.group, stored.includes(group.dataset.group), { persist: false }));
}

function updateDashboardKPIs() {
  const today = localDate();
  const cash = treasuryBalance();
  const salesToday = roundMoney(db.invoices.reduce((sum, inv) => sum + (inv.date === today ? (inv.mode === 'sale' ? inv.netTotal : inv.mode === 'sale_return' ? -inv.netTotal : 0) : 0), 0));
  if ($('kpiCash')) $('kpiCash').textContent = money(cash);
  if ($('kpiSalesToday')) $('kpiSalesToday').textContent = money(salesToday);
  if ($('kpiNetProfit')) $('kpiNetProfit').textContent = money(calculateTotalProfits().net);
  if ($('kpiLowStock')) $('kpiLowStock').textContent = db.items.filter(i => i.qty <= i.minQty).length;
  if ($('kpiCashSide')) $('kpiCashSide').textContent = money(cash);
}

/* ------------------------------------------------------------------ */
/* Design studio: full control over colours, images, shapes            */
/* ------------------------------------------------------------------ */
const DESIGN_KEY = `${DB_KEY}_DESIGN`;
const DESIGN_DEFAULTS = Object.freeze({
  radius: 12, borderWidth: 1, shadow: 2,
  appBg: '', headerA: '', headerB: '', sectionA: '', sectionB: '',
  sideA: '', sideB: '', buttonBg: '', buttonText: '', borderColor: '',
  headerImage: '', backgroundImage: '', headerHeight: 118, fontScale: 100,
  startBackground: '', startBackgroundOpacity: 50
});
const DESIGN_PRESETS = Object.freeze({
  'blue-cyan': { headerA:'#0a1a3c', headerB:'#0f7c93', sectionA:'#0a1a3c', sectionB:'#0f7c93', sideA:'#0a1a3c', sideB:'#123a6b', radius:14, shadow:2, borderWidth:1, appBg:'#dcd9c6', buttonBg:'#f4f5f9', buttonText:'#22314a', borderColor:'#b8c4d4' },
  'midnight': { headerA:'#050a18', headerB:'#1b2a4a', sectionA:'#050a18', sectionB:'#22335c', sideA:'#04070f', sideB:'#141f36', radius:10, shadow:3, borderWidth:1, appBg:'#c9cfdd', buttonBg:'#eef1f8', buttonText:'#1b2436', borderColor:'#9aa7bd' },
  'emerald': { headerA:'#06402b', headerB:'#17a673', sectionA:'#06402b', sectionB:'#118f62', sideA:'#04301f', sideB:'#0b5c3c', radius:16, shadow:2, borderWidth:1, appBg:'#dbe8df', buttonBg:'#f2faf5', buttonText:'#123a2a', borderColor:'#a9cbb7' },
  'royal': { headerA:'#1b0b3b', headerB:'#5b2ec4', sectionA:'#1b0b3b', sectionB:'#6d3ad6', sideA:'#150830', sideB:'#3b1d84', radius:18, shadow:3, borderWidth:1, appBg:'#ded9ec', buttonBg:'#f6f3ff', buttonText:'#2a1d4a', borderColor:'#b8a9dd' },
  'sunset': { headerA:'#4a1710', headerB:'#e0762c', sectionA:'#4a1710', sectionB:'#c95c22', sideA:'#3a110c', sideB:'#8a3312', radius:14, shadow:2, borderWidth:1, appBg:'#f0e2d8', buttonBg:'#fff7f1', buttonText:'#4a2417', borderColor:'#d8b49c' },
  'graphite': { headerA:'#111827', headerB:'#364152', sectionA:'#111827', sectionB:'#3b4658', sideA:'#0b121c', sideB:'#232c3b', radius:8, shadow:1, borderWidth:1, appBg:'#dfe2e8', buttonBg:'#f3f4f7', buttonText:'#1f2733', borderColor:'#b3bac6' },
  'rose': { headerA:'#3d0f24', headerB:'#b04a76', sectionA:'#3d0f24', sectionB:'#a33f68', sideA:'#2b0a19', sideB:'#77214a', radius:20, shadow:2, borderWidth:1, appBg:'#eedde5', buttonBg:'#fff6fa', buttonText:'#3d1727', borderColor:'#d3a9bd' },
  'steel': { headerA:'#0d1b26', headerB:'#3f6b86', sectionA:'#0d1b26', sectionB:'#486f87', sideA:'#08131c', sideB:'#28495e', radius:6, shadow:1, borderWidth:1, appBg:'#d7dee3', buttonBg:'#f1f4f7', buttonText:'#1d2b36', borderColor:'#a7b6c1' }
});
const DESIGN_FIELDS = ['radius', 'borderWidth', 'shadow', 'appBg', 'headerA', 'headerB', 'sectionA', 'sectionB', 'sideA', 'sideB', 'buttonBg', 'buttonText', 'borderColor', 'headerHeight', 'fontScale'];
function getDesign() {
  try {
    const stored = JSON.parse(localStorage.getItem(DESIGN_KEY) || '{}');
    return { ...DESIGN_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch { return { ...DESIGN_DEFAULTS }; }
}
function saveDesign(design) {
  try { localStorage.setItem(DESIGN_KEY, JSON.stringify(design)); }
  catch { notify('تعذر حفظ التخصيص في المتصفح. قلّل حجم الصور المرفوعة ثم أعد المحاولة.'); }
}
function applyDesign() {
  const design = getDesign();
  // Write on <html> and <body> so per-theme stylesheet variables cannot override the saved design.
  const root = document.documentElement.style;
  const bodyStyle = document.body.style;
  const setVar = (name, value) => { root.setProperty(name, value); bodyStyle.setProperty(name, value); };
  const dark = document.body.dataset.theme === 'night';
  setVar('--radius-ui', `${Number(design.radius) || 0}px`);
  setVar('--radius-card', `${(Number(design.radius) || 0) + 2}px`);
  setVar('--radius-btn', `${Math.max(0, (Number(design.radius) || 0) - 2)}px`);
  setVar('--line-dark', design.borderColor || (dark ? '#5a6349' : '#8b8669'));
  setVar('--line', design.borderColor || (dark ? '#434a39' : '#b5b096'));
  setVar('--line-soft', design.borderColor || (dark ? '#3c4233' : '#d9d5bb'));
  setVar('--line-w', `${Math.max(0, Number(design.borderWidth) || 0)}px`);
  document.documentElement.dataset.border = String(Number(design.borderWidth) || 0);
  setVar('--header-h', `${Math.min(220, Math.max(80, Number(design.headerHeight) || 118))}px`);
  if (design.appBg) setVar('--shell-bg', design.appBg);
  const headerImage = Boolean(design.headerImage);
  if (design.headerA && design.headerB) {
    setVar('--head-1', design.headerA);
    setVar('--head-2', design.headerA);
    setVar('--head-3', design.headerB);
    setVar('--side-1', design.sideA || design.headerA);
    setVar('--side-2', design.sideA || design.headerA);
    setVar('--side-3', design.sideB || design.headerB);
  }
  if (design.sectionA && design.sectionB) {
    setVar('--sec-1', design.sectionA);
    setVar('--sec-2', design.sectionB);
  }
  if (design.sideA && design.sideB) {
    setVar('--side-1', design.sideA);
    setVar('--side-3', design.sideB);
    if (!design.side2) setVar('--side-2', design.sideA);
  }
  if (design.buttonBg) {
    setVar('--btn', design.buttonBg);
    setVar('--btn-2', design.buttonBg);
    setVar('--btn-light', `color-mix(in srgb, ${design.buttonBg} 92%, #ffffff)`);
  }
  if (design.buttonText) { setVar('--btn-ink', design.buttonText); setVar('--btn-ink-2', design.buttonText); }
  if (design.fontScale) setVar('--fs', `${(12.5 * Number(design.fontScale)) / 100}px`);
  const header = $('appHeader');
  if (header) {
    header.classList.toggle('has-image', headerImage);
    header.style.setProperty('--header-image', headerImage ? `url("${design.headerImage}")` : 'none');
    header.style.boxShadow = design.shadow === 0 ? 'none' : undefined;
  }
  document.body.style.setProperty('--app-bg-image', design.backgroundImage ? `url("${design.backgroundImage}")` : 'none');
  document.body.classList.toggle('has-bg-image', Boolean(design.backgroundImage));
  document.documentElement.dataset.shadow = String(design.shadow ?? 2);
  document.documentElement.dataset.sharp = Number(design.radius) === 0 ? '1' : '0';
  if ($('designRadius')) $('designRadius').value = design.radius;
  if ($('designBorder')) $('designBorder').value = design.borderWidth;
  if ($('designHeaderHeight')) $('designHeaderHeight').value = design.headerHeight;
  if ($('designFontScale')) $('designFontScale').value = design.fontScale;
  for (const [id, key] of [['designAppBg','appBg'],['designHeaderA','headerA'],['designHeaderB','headerB'],['designSectionA','sectionA'],['designSectionB','sectionB'],['designSideA','sideA'],['designSideB','sideB'],['designButtonBg','buttonBg'],['designButtonText','buttonText'],['designBorderColor','borderColor']]) {
    const el = $(id);
    if (el) el.value = /^#[0-9a-f]{6}$/i.test(design[key] || '') ? design[key] : '#ffffff';
  }
  if ($('designShadow')) $('designShadow').value = String(design.shadow ?? 2);
  if ($('headerImageStatus')) $('headerImageStatus').textContent = headerImage ? 'صورة مرفوعة ✔' : 'لا توجد صورة';
  if ($('backgroundImageStatus')) $('backgroundImageStatus').textContent = design.backgroundImage ? 'صورة مرفوعة ✔' : 'لا توجد صورة';
  applyStartBackground();
}
function setDesignField(field, value) {
  if (!DESIGN_FIELDS.includes(field)) return;
  const design = getDesign();
  if (['radius', 'borderWidth', 'shadow', 'headerHeight', 'fontScale'].includes(field)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const bounds = { radius: [0, 32], borderWidth: [0, 4], shadow: [0, 3], headerHeight: [80, 220], fontScale: [85, 125] }[field];
    design[field] = Math.max(bounds[0], Math.min(bounds[1], numeric));
  } else if (String(value).startsWith('data:image/')) design[field] = String(value);
  else if (/^#[0-9a-f]{6}$/i.test(String(value)) || value === '') design[field] = String(value);
  saveDesign(design); applyDesign();
}
function resetDesign() {
  saveDesign({ ...DESIGN_DEFAULTS });
  applyDropdownDefaults();
  applyDesign();
  notify('تمت إعادة التخصيص بالكامل إلى القيم الافتراضية.');
}
function applyDropdownDefaults() {
  const design = getDesign();
  if ($('designRadius')) $('designRadius').value = design.radius;
  if ($('designBorder')) $('designBorder').value = design.borderWidth;
  if ($('designShadow')) $('designShadow').value = String(design.shadow);
  if ($('designHeaderHeight')) $('designHeaderHeight').value = design.headerHeight;
  if ($('designFontScale')) $('designFontScale').value = design.fontScale;
}
function applyThemePreset(key) {
  const preset = DESIGN_PRESETS[key];
  if (!preset) return;
  const design = { ...getDesign(), ...preset };
  saveDesign(design);
  const appearance = getAppearance();
  appearance.theme = 'custom';
  delete appearance.accent;
  saveAppearance(appearance);
  document.body.dataset.theme = 'custom';
  applyDesign();
  applyAppearance();
  notify(`تم تطبيق القالب الجاهز. يمكنك تعديل أي لون بعده.`);
}
function readImageFile(input, onDone) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!/^image\//.test(file.type)) { alert('اختر ملف صورة (PNG أو JPG).'); input.value = ''; return; }
  if (file.size > 1.5 * 1024 * 1024) { alert('حجم الصورة أكبر من 1.5 ميجابايت. صغّرها ثم أعد المحاولة.'); input.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { onDone(String(reader.result)); input.value = ''; };
  reader.onerror = () => { alert('تعذر قراءة الصورة.'); input.value = ''; };
  reader.readAsDataURL(file);
}
function uploadHeaderImage(input) {
  readImageFile(input, data => { const design = getDesign(); design.headerImage = data; saveDesign(design); applyDesign(); notify('تم رفع صورة الهيدر.'); });
}
function uploadBackgroundImage(input) {
  readImageFile(input, data => { const design = getDesign(); design.backgroundImage = data; saveDesign(design); applyDesign(); notify('تم رفع صورة خلفية التطبيق.'); });
}
function applyStartBackground() {
  const design = getDesign();
  const opacity = Math.min(100, Math.max(0, Number(design.startBackgroundOpacity) || 0)) / 100;
  const screen = $('lockModal');
  if (screen) screen.style.setProperty('--start-bg-image', design.startBackground ? `url("${design.startBackground}")` : 'none');
  if (screen) screen.style.setProperty('--start-bg-opacity', String(opacity));
  if ($('startBgStatus')) $('startBgStatus').textContent = design.startBackground ? 'صورة مرفوعة ✔' : 'لا توجد صورة — الخلفية متدرجة';
  if ($('startBgOpacity')) $('startBgOpacity').value = design.startBackgroundOpacity ?? 50;
}
function uploadStartBackground(input) {
  readImageFile(input, data => {
    const design = getDesign(); design.startBackground = data; saveDesign(design); applyStartBackground();
    notify('تم رفع خلفية شاشة البداية.');
  });
}
function clearStartBackground() {
  const design = getDesign(); delete design.startBackground; saveDesign(design); applyStartBackground();
  notify('أُعيدت خلفية شاشة البداية إلى التدرج الافتراضي.');
}
function setStartBackgroundOpacity(value) {
  const design = getDesign();
  design.startBackgroundOpacity = Math.min(100, Math.max(0, Number(value) || 0));
  saveDesign(design); applyStartBackground();
}
function clearHeaderImage() { const design = getDesign(); delete design.headerImage; saveDesign(design); applyDesign(); }
function clearBackgroundImage() { const design = getDesign(); delete design.backgroundImage; saveDesign(design); applyDesign(); }

/* ------------------------------------------------------------------ */
/* Install as an app (PWA)                                             */
/* ------------------------------------------------------------------ */
let deferredInstallPrompt = null;
function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); deferredInstallPrompt = event;
    if ($('installHint')) $('installHint').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if ($('installHint')) $('installHint').hidden = true;
    notify('تم تثبيت البرنامج على الجهاز. يمكنك فتحه من سطح المكتب بدون متصفح.');
  });
}
async function installApp() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice.catch(() => ({}));
    deferredInstallPrompt = null;
    if (choice?.outcome === 'accepted') notify('جاري تثبيت البرنامج على الجهاز…');
    return;
  }
  notify('لتثبيت البرنامج: من متصفح Chrome أو Edge اضغط على أيقونة التثبيت (⬇️/⊕) في شريط العنوان، أو القائمة ⋮ ← «تثبيت التطبيق». على iPhone: مشاركة ← «إضافة إلى الشاشة الرئيسية».');
}

/* ------------------------------------------------------------------ */
/* POS: header, tiles, cart, keypad                                    */
/* ------------------------------------------------------------------ */
function invoicePermission(mode) {
  return mode.startsWith('purchase') ? 'purchase' : mode === 'quote' ? 'quote' : mode === 'sale_return' ? 'sale-return' : 'sale';
}
function openInvoiceSec(mode) {
  if (!ensurePermission(invoicePermission(mode))) return;
  if (mode !== $('invMode').value && invCart.length && !confirm('تغيير نوع العملية سيفرغ الفاتورة غير المحفوظة. هل تريد المتابعة؟')) return;
  openSec('sec-invoice', SEC_TITLES['sec-invoice']);
  if (mode !== $('invMode').value) clearInvCart();
  $('invMode').value = mode; updateInvoiceUI();
  // every floating screen opens large: the whole app width is the working area
  if (!$('windowLayer').classList.contains('maximized')) maximizeWorkspace();
  paintDraftHint();
  window.setTimeout(() => { if ($('windowLayer').classList.contains('open')) $('invBarcodeInp').focus(); }, 0);
}
function changeInvoiceMode(mode) {
  if (!ensurePermission(invoicePermission(mode))) { $('invMode').value = lastInvoiceMode; return; }
  if (mode !== lastInvoiceMode && invCart.length && !confirm('تغيير نوع العملية سيفرغ الفاتورة غير المحفوظة. هل تريد المتابعة؟')) { $('invMode').value = lastInvoiceMode; return; }
  if (mode !== lastInvoiceMode) clearInvCart();
  updateInvoiceUI();
}
function switchInvoiceTab(tab) {
  currentInvoiceTab = TAB_LABELS[tab] ? tab : 'details';
  $$('#invTabs [data-inv-tab]').forEach(button => {
    const active = button.dataset.invTab === tab;
    button.classList.toggle('is-active', active);
    button.classList.toggle('bg-green', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('[data-inv-group]').forEach(group => { group.hidden = group.dataset.invGroup !== tab; });
  if ($('invPanelTitle')) $('invPanelTitle').textContent = TAB_LABELS[tab] || '';
}
function updateInvoiceUI() {
  const mode = $('invMode').value; lastInvoiceMode = mode;
  const supplier = mode.startsWith('purchase'), isReturn = mode.endsWith('_return'), quote = mode === 'quote';
  if ($('posTitleText')) $('posTitleText').textContent = MODE_LABELS[mode];
  $('invPanelTitle').textContent = TAB_LABELS[currentInvoiceTab] || '';
  $('lblInvParty').textContent = supplier ? 'المورد' : 'العميل';
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
  renderPosTiles();
  renderInvCart();
}
function selectPosGroup(group) {
  posGroup = group;
  renderPosTiles();
}
const ITEMS_TAB_LABELS = { edit: 'بيانات الصنف', prices: 'الأسعار والربح', actions: 'إجراءات وأدوات' };
function switchItemsTab(tab) {
  const key = ITEMS_TAB_LABELS[tab] ? tab : 'edit';
  $$('#sec-items [data-items-tab]').forEach(button => {
    const active = button.dataset.itemsTab === key;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('#sec-items [data-items-group]').forEach(group => { group.hidden = group.dataset.itemsGroup !== key; });
  if ($('itemsPanelTitle')) $('itemsPanelTitle').textContent = ITEMS_TAB_LABELS[key];
}

function renderPosTiles() {
  const groupSelect = $('posGroupSelect');
  if (!groupSelect) return;
  const chips = [{ key: 'all', label: 'كل المجموعات', count: db.items.length },
    ...db.categories.map(cat => ({ key: cat, label: cat, count: db.items.filter(i => i.cat === cat).length }))];
  if (!chips.some(chip => chip.key === posGroup)) posGroup = 'all';
  groupSelect.innerHTML = chips.map(chip => `<option value="${esc(chip.key)}">${esc(chip.label)} — ${chip.count} صنف</option>`).join('');
  groupSelect.value = posGroup;
  if ($('posGroupCount')) {
    const active = chips.find(chip => chip.key === posGroup);
    $('posGroupCount').textContent = `${active ? active.count : 0} صنف`;
  }
  const term = $('posQuickSearch')?.value.trim().toLocaleLowerCase() || '';
  posTiles = db.items
    .filter(item => (posGroup === 'all' || item.cat === posGroup) && (!term || [item.name, item.code].some(value => String(value).toLocaleLowerCase().includes(term))))
    .slice(0, 30);
  $('posQuickItems').innerHTML = posTiles.map((item, index) => `<button type="button" class="item-tile" onclick="addPosTile(${index})" title="${esc(item.name)} — متاح ${esc(item.qty)}">
      <b>${esc(item.name)}</b><span>${money(item.sell)}</span><i>${esc(item.code)} · متاح ${esc(item.qty)}</i>
    </button>`).join('') || `<div class="empty-row" style="grid-column:1/-1">${term ? 'لا توجد أصناف مطابقة للبحث في هذه المجموعة.' : 'لا توجد أصناف في هذه المجموعة بعد — أضف أصنافاً من شاشة الأصناف.'}</div>`;
}
function addPosTile(index) {
  const item = posTiles[index];
  if (item) pushCartItem(item.code, 1);
}
function bumpInvoiceQty(delta) {
  const field = $('invAddQty');
  const value = Math.max(0.001, roundQuantity((Number(field.value) || 1) + delta));
  field.value = String(value);
  field.focus();
  playScanFeedback('click');
}
/* ---- barcode / name search: instant suggestions + arrow-key navigation ---- */
let suggestions = [];
let suggestionIndex = -1;
function suggestionMatches(query) {
  const term = normalizeSearch(query);
  if (!term) return [];
  const scored = [];
  for (const item of db.items) {
    const code = normalizeSearch(item.code), name = normalizeSearch(item.name);
    let score = 0;
    if (code === term) score = 100;
    else if (name === term) score = 95;
    else if (code.startsWith(term)) score = 80;
    else if (name.startsWith(term)) score = 70;
    else if (name.includes(term)) score = 55;
    else if (code.includes(term)) score = 40;
    else if (fuzzyScore(name, term) >= 0.62) score = 30;
    if (!score) continue;
    if (item.qty <= 0 && !$('invMode').value.endsWith('_return')) score -= 5;
    scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'ar'));
  return scored.slice(0, 8).map(entry => entry.item);
}
function normalizeSearch(value) {
  return String(value || '')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[\u200C\u200D\u200E\u200F]/g, '')
    .replace(/\s+/g, ' ').trim().toLocaleLowerCase('ar');
}
function fuzzyScore(text, term) {
  if (!text || !term) return 0;
  if (text.length > 60) text = text.slice(0, 60);
  let index = 0, hits = 0;
  for (const char of term) { const found = text.indexOf(char, index); if (found >= 0) { hits += 1; index = found + 1; } }
  return hits / term.length * 0.75 + (text.includes(term) ? 0.25 : 0) * (hits === term.length ? 1 : 0);
}
function renderSuggestionList() {
  const box = $('invSuggest');
  if (!box) return;
  const query = $('invBarcodeInp')?.value || '';
  suggestions = suggestionMatches(query);
  if (suggestionIndex >= suggestions.length) suggestionIndex = suggestions.length - 1;
  if (!suggestions.length) { box.innerHTML = ''; return; }
  const cartIds = new Set(invCart.map(line => line.id));
  const price = item => $('invMode').value.startsWith('purchase') ? item.buy : $('invPriceTier').value === 'wholesale' ? item.wholesale : item.sell;
  box.innerHTML = suggestions.map((item, index) => `<button type="button" class="suggest-row${index === suggestionIndex ? ' active' : ''}" role="option" aria-selected="${index === suggestionIndex}" data-code="${esc(item.code)}" onclick="pickSuggestion(${index})" onmouseenter="highlightSuggestion(${index})">
      <span class="s-code">${esc(item.code)}</span>
      <span class="s-name">${esc(item.name)}</span>
      <span class="s-price">${money(price(item))}</span>
      <span class="s-stock${item.qty <= 0 ? ' out' : item.qty <= (item.minQty || 0) ? ' low' : ''}">${roundQuantity(item.qty)} ${esc(item.unit || '')}</span>
      ${cartIds.has(item.id) ? '<span class="s-tag">في الفاتورة</span>' : ''}
    </button>`).join('');
}
function showSuggestions() {
  const box = $('invSuggest');
  if (!box) return;
  suggestionIndex = -1;
  renderSuggestionList();
  box.hidden = !suggestions.length;
  $('invBarcodeInp')?.setAttribute('aria-expanded', String(!box.hidden));
  paint();
  function paint() {
    [...box.querySelectorAll('.suggest-row')].forEach((row, index) => {
      row.classList.toggle('active', index === suggestionIndex);
      row.setAttribute('aria-selected', index === suggestionIndex ? 'true' : 'false');
      if (index === suggestionIndex) row.scrollIntoView?.({ block: 'nearest' });
    });
  }
}
function hideSuggestions() {
  const box = $('invSuggest'); if (box) { box.hidden = true; box.innerHTML = ''; }
  $('invBarcodeInp')?.setAttribute('aria-expanded', 'false');
  suggestions = []; suggestionIndex = -1;
}
function highlightSuggestion(index) {
  suggestionIndex = index;
  const box = $('invSuggest'); if (!box) return;
  [...box.querySelectorAll('.suggest-row')].forEach((row, i) => { row.classList.toggle('active', i === index); row.setAttribute('aria-selected', i === index ? 'true' : 'false'); });
}
function moveSuggestion(step) {
  if (!suggestions.length) return false;
  suggestionIndex = (suggestionIndex + step + suggestions.length) % suggestions.length;
  highlightSuggestion(suggestionIndex);
  return true;
}
function pickSuggestion(index) {
  const item = suggestions[index];
  if (!item) return;
  $('invBarcodeInp').value = item.code;
  $('invAddQty').value = $('invAddQty').value || 1;
  hideSuggestions();
  pushCartItem(item.code, num('invAddQty') || 1);
}
function handleScanKey(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!suggestions.length) { showSuggestions(); if (!suggestions.length) return; }
    event.preventDefault();
    moveSuggestion(event.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (suggestions.length && suggestionIndex >= 0) { pickSuggestion(suggestionIndex); return; }
    const typed = normalizeSearch($('invBarcodeInp').value);
    const exact = typed ? suggestions.find(item => normalizeSearch(item.code) === typed || normalizeSearch(item.name) === typed) : null;
    if (exact) $('invBarcodeInp').value = exact.code;
    hideSuggestions();
    addInvItemFromInput();
    return;
  }
  if (event.key === 'Escape') { hideSuggestions(); return; }
  if (event.key === 'Tab' && suggestions.length) { event.preventDefault(); pickSuggestion(Math.max(0, suggestionIndex)); }
}
function addInvItemFromInput() {
  if (!ensurePermission(invoicePermission($('invMode').value))) return;
  const value = $('invBarcodeInp').value.trim(), qty = num('invAddQty');
  if (!value) return alert('اختر الصنف أو اكتب كود الصنف أولاً.');
  if (!Number.isFinite(qty) || qty <= 0) return alert('الكمية يجب أن تكون أكبر من صفر.');
  pushCartItem(value, qty);
}
function pushCartItem(value, qty) {
  const mode = $('invMode').value;
  let item = db.items.find(i => i.code.toLocaleLowerCase() === String(value).toLocaleLowerCase() || i.name === value);
  if (!item) {
    const loose = suggestionMatches(value).filter(candidate => normalizeSearch(candidate.name) === normalizeSearch(value) || normalizeSearch(candidate.code) === normalizeSearch(value));
    if (loose.length === 1) item = loose[0];
    else if (loose.length > 1) { showSuggestions(); return alert('يوجد أكثر من صنف مطابق — اختر الصنف من القائمة بالأسهم ثم Enter.'); }
  }
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
    else invCart.push({ id: item.id, code: item.code, name: item.name, unit: item.unit, qty, price, discPct: 0, buyCost: item.buy, minSell: item.minSell });
  }
  $('invBarcodeInp').value = ''; $('invAddQty').value = 1;
  selectedCartIndex = invCart.findIndex(c => c.id === item.id);
  renderInvCart(); playScanFeedback(); $('invBarcodeInp').focus();
}
function updateCartPricesByTier() {
  if (!['sale', 'quote'].includes($('invMode').value)) return;
  invCart.forEach(c => { const item = db.items.find(i => i.id === c.id); if (item) c.price = $('invPriceTier').value === 'wholesale' ? item.wholesale : item.sell; });
  renderInvCart();
}
function selectCartRow(index) {
  selectedCartIndex = Number(index);
  $$('#invCartTbody tr').forEach(row => row.classList.toggle('selected-row', Number(row.dataset.index) === selectedCartIndex));
}
function focusCartField(field) {
  if (!invCart.length) return alert('لا توجد بنود في الفاتورة. أضف صنفاً أولاً.');
  const index = selectedCartIndex >= 0 && selectedCartIndex < invCart.length ? selectedCartIndex : invCart.length - 1;
  openKeypad({ mode: 'cart', index, field });
}
function openKeypad({ mode = 'cart', index = -1, field = 'qty' } = {}) {
  keypad = { mode, index, field };
  const row = mode === 'cart' ? invCart[index] : null;
  const labels = { qty: 'الكمية', price: 'السعر', disc: 'نسبة الخصم %', pay: 'المبلغ المدفوع' };
  setKeypadTab(field, true);
  $('keypadTitle').textContent = row ? `تعديل — ${row.name}` : 'إدخال قيمة';
  $('keypadFieldLabel').textContent = labels[field] || 'القيمة';
  const initial = mode === 'cart' ? (field === 'qty' ? row?.qty : field === 'price' ? row?.price : field === 'disc' ? row?.discPct : '') : '';
  $('keypadValue').value = initial === '' || initial === undefined ? '' : String(initial);
  $('keypadModal').classList.add('open');
  window.setTimeout(() => { $('keypadValue').focus(); $('keypadValue').select?.(); }, 0);
}
function setKeypadTab(tab, silent) {
  if (tab === 'pay') { if (keypad.mode !== 'cart') keypad.mode = 'cart'; keypad.field = 'pay'; }
  else keypad.field = tab;
  $$('#keypadModal [data-kpad-tab]').forEach(button => button.classList.toggle('active', button.dataset.kpadTab === tab));
  const labels = { qty: 'الكمية', price: 'السعر', disc: 'نسبة الخصم %', pay: 'المبلغ المدفوع' };
  if (!silent) $('keypadFieldLabel').textContent = labels[tab] || 'القيمة';
}
function closeKeypad() { $('keypadModal').classList.remove('open'); }
function keypadPress(key) {
  const input = $('keypadValue');
  if (key === 'C') { input.value = ''; return; }
  if (key === 'AC') { input.value = ''; return; }
  if (key === 'back') { input.value = input.value.slice(0, -1); return; }
  if (key === '.') { if (!input.value.includes('.')) input.value = input.value ? `${input.value}.` : '0.'; return; }
  if (input.value.replace('.', '').length >= 9) return;
  input.value += key;
}
function applyKeypad() {
  const raw = $('keypadValue').value.trim();
  const value = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(value) || value < 0) return alert('أدخل قيمة رقمية صحيحة.');
  if (keypad.field === 'pay') {
    closeKeypad(); $('invPaidAmount').value = String(roundMoney(value)); calcInvoiceTotals();
    dispatchInput($('invPaidAmount'));
    return;
  }
  const row = invCart[keypad.index];
  if (!row) { closeKeypad(); return alert('لم يتم تحديد بند صالح في الفاتورة.'); }
  if (keypad.field === 'qty' && value <= 0) return alert('الكمية يجب أن تكون أكبر من صفر.');
  if (keypad.field === 'disc' && value > 100) return alert('نسبة الخصم لا تتجاوز 100%.');
  const field = keypad.field;
  closeKeypad();
  updateCartRow(keypad.index, field === 'price' ? 'price' : field, value);
}
function renderInvCart() {
  const mode = $('invMode').value, isReturn = mode.endsWith('_return');
  $('invCartTbody').innerHTML = invCart.map((c, index) => {
    const gross = lineGross(c);
    const net = c.returnNetTotal !== undefined && isReturn ? c.returnNetTotal : gross;
    return `<tr data-index="${index}" class="${index === selectedCartIndex ? 'selected-row' : ''}" onclick="selectCartRow(${index})">
      <td>${index + 1}</td>
      <td><strong>${esc(c.code)}</strong></td>
      <td class="cell-name">${esc(c.name)}</td>
      <td>عدد</td>
      <td><input aria-label="سعر ${esc(c.name)}" type="number" min="0" step="any" value="${esc(c.price)}" ${isReturn ? 'disabled' : ''} onchange="updateCartRow(${index},'price',this.value)"></td>
      <td><input aria-label="كمية ${esc(c.name)}" type="number" min="0.001" ${isReturn ? `max="${c.maxQty}"` : ''} step="any" value="${esc(c.qty)}" onchange="updateCartRow(${index},'qty',this.value)"></td>
      <td><input aria-label="خصم ${esc(c.name)}" type="number" min="0" max="100" step="any" value="${esc(c.discPct)}" ${isReturn ? 'disabled' : ''} onchange="updateCartRow(${index},'discPct',this.value)"></td>
      <td>${money(gross)}</td>
      <td><strong>${money(net)}</strong></td>
      <td class="no-print"><button type="button" class="act-btn bg-red" style="padding:1px 6px" title="حذف البند" onclick="event.stopPropagation();removeCartRow(${index})">✖</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="10" class="empty-row">الفاتورة فارغة. اقرأ باركود الصنف أو اضغط على أحد الأصناف السريعة لإضافتها.</td></tr>';
  if ($('posCartHint')) $('posCartHint').textContent = invCart.length ? `${invCart.length} بند — انقر على البند ثم F8/F9 لتعديل الكمية أو السعر` : 'لا توجد بنود بعد';
  calcInvoiceTotals();
}
function removeCartRow(index) {
  invCart.splice(index, 1);
  if (selectedCartIndex >= invCart.length) selectedCartIndex = invCart.length - 1;
  renderInvCart();
}
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
  let discountTotal = 0;
  if (!invCart.length) { $('invSubTotal').value = '0.00'; $('invNetTotal').value = '0.00'; }
  else try {
    const totals = calculateTotals(invCart, Number($('invDiscAmount').value) || 0, Number($('invDiscPct').value) || 0);
    discountTotal = totals.discountTotal;
    $('invSubTotal').value = money(totals.subtotal); $('invNetTotal').value = money(totals.netTotal);
  } catch { $('invSubTotal').value = money(invCart.reduce((sum, c) => sum + lineGross(c), 0)); $('invNetTotal').value = '0.00'; }
  if ($('invDiscTotalView')) $('invDiscTotalView').value = money(discountTotal);
  const net = Number($('invNetTotal').value);
  if (quote || $('invPayType').value === 'credit') $('invPaidAmount').value = '0.00';
  else if ($('invPayType').value === 'cash') $('invPaidAmount').value = money(net);
  calcInvoiceRemaining();
  if ($('posNetDisplay')) $('posNetDisplay').textContent = $('invNetTotal').value;
  if ($('posItemsCount')) $('posItemsCount').textContent = `${roundQuantity(invCart.reduce((sum, c) => sum + c.qty, 0))} مادة`;
  renderDiscountLimit();
}
function calcInvoiceRemaining() {
  const net = Number($('invNetTotal').value) || 0;
  const paid = Number($('invPaidAmount').value) || 0;
  const remain = roundMoney(net - paid);
  $('invRemainAmount').value = money(remain);
  const change = roundMoney(paid - net);
  const box = $('cashChangeBox');
  if ($('cashChangeValue')) $('cashChangeValue').textContent = money(Math.max(0, change));
  if (box) box.dataset.state = change > 0.0001 ? 'over' : 'none';
  return remain;
}
function dispatchInput(field) {
  if (!field) return;
  const EventClass = field.ownerDocument?.defaultView?.Event || Event;
  field.dispatchEvent(new EventClass('input', { bubbles: true }));
}
/* ---- camera barcode scanning (native BarcodeDetector, no external library) ---- */
let cameraStream = null;
let cameraTimer = 0;
let cameraBusy = false;
function mediaDevices() { try { return window.navigator?.mediaDevices || null; } catch { return null; } }
function cameraSupported() {
  return Boolean(mediaDevices()?.getUserMedia) && typeof window.BarcodeDetector === 'function';
}
function cameraUnavailableReason() {
  if (!mediaDevices()?.getUserMedia) return 'المتصفح لا يسمح بالوصول للكاميرا (يجب فتح البرنامج عبر https أو localhost).';
  if (typeof window.BarcodeDetector !== 'function') return 'متصفح هذا الجهاز لا يدعم قراءة الباركود تلقائياً — استخدم قارئ الباركود أو أدخل الكود يدوياً.';
  return '';
}
async function openCameraScanner() {
  const reason = cameraUnavailableReason();
  if (reason) { await showSyncDialog({ title: 'الكاميرا غير متاحة', icon: '📷', body: esc(reason), ok: 'حسناً' }); $('invBarcodeInp')?.focus(); return; }
  if (!ensurePermission(invoicePermission($('invMode').value))) return;
  const modal = $('cameraModal');
  if (!modal) return;
  modal.hidden = false;
  if ($('cameraNote')) $('cameraNote').textContent = 'جارٍ تشغيل الكاميرا…';
  cameraBusy = false;
  try {
    cameraStream = await mediaDevices().getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch {
    modal.hidden = true;
    await showSyncDialog({ title: 'تعذّر تشغيل الكاميرا', icon: '📷', body: 'لم يُسمح باستخدام الكاميرا. افتح رمز القفل بجانب العنوان وامنح الإذن، ثم أعد المحاولة.', ok: 'حسناً' });
    return;
  }
  const video = $('cameraVideo');
  video.srcObject = cameraStream;
  try { await video.play(); } catch { /* autoplay can be blocked; detection still runs on frames */ }
  if ($('cameraNote')) $('cameraNote').textContent = 'وجّه الكاميرا نحو الباركود — تتم القراءة تلقائياً وتُضاف المادة للفاتورة.';
  startCameraDetection();
}
function startCameraDetection() {
  window.clearInterval(cameraTimer);
  const video = $('cameraVideo');
  if (!video) return;
  let detector = null;
  try { detector = new window.BarcodeDetector({ formats: ['code_39', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'itf', 'codabar'] }); }
  catch { try { detector = new window.BarcodeDetector(); } catch { detector = null; } }
  if (!detector) return;
  cameraTimer = window.setInterval(async () => {
    if (cameraBusy || !cameraStream || $('cameraModal')?.hidden) return;
    if (video.readyState < 2) return;
    cameraBusy = true;
    try {
      const codes = await detector.detect(video);
      const raw = codes?.map(code => String(code.rawValue || '').trim()).find(Boolean);
      if (raw) handleCameraCode(raw);
    } catch { /* a missed frame is normal */ }
    finally { cameraBusy = false; }
  }, 320);
}
function handleCameraCode(raw) {
  const code = String(raw || '').trim();
  if (!code) return;
  const item = db.items.find(entry => entry.code === code) || suggestionMatches(code)[0];
  if (!item) {
    if ($('cameraNote')) $('cameraNote').textContent = `الكود ${code} غير مسجل في الأصناف — أضفه من شاشة الأصناف.`;
    playScanFeedback('click');
    return;
  }
  playScanFeedback();
  closeCameraScanner();
  $('invBarcodeInp').value = item.code;
  $('invAddQty').value = $('invAddQty').value || 1;
  addInvItemFromInput();
  notify(`تمت قراءة «${item.name}» من الكاميرا.`);
}
function closeCameraScanner(manual) {
  window.clearInterval(cameraTimer);
  cameraTimer = 0; cameraBusy = false;
  if (cameraStream) { try { cameraStream.getTracks().forEach(track => track.stop()); } catch { /* already stopped */ } }
  cameraStream = null;
  const video = $('cameraVideo');
  if (video) { try { video.pause(); } catch { /* ignore */ } video.srcObject = null; }
  if ($('cameraModal')) $('cameraModal').hidden = true;
  if (manual) window.setTimeout(() => $('invBarcodeInp')?.focus(), 30);
}

/* ---- scan sound + haptics (WebAudio, no asset files) ---- */
let audioContext = null;
function audioEngine() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioContext) audioContext = new Ctor();
    if (audioContext.state === 'suspended') audioContext.resume?.();
    return audioContext;
  } catch { return null; }
}
function scanFeedbackSetting() {
  const value = getAppearance().scanFeedback;
  return ['beep', 'chime', 'click', 'silent'].includes(value) ? value : 'beep';
}
function scanVibrateEnabled() { return getAppearance().scanVibrate !== false; }
function setScanFeedback(value) {
  if (!['beep', 'chime', 'click', 'silent'].includes(value)) return;
  const appearance = getAppearance(); appearance.scanFeedback = value; saveAppearance(appearance);
  if ($('scanSoundSelect')) $('scanSoundSelect').value = value;
  notify(value === 'silent' ? 'تم إسكات صوت قراءة الباركود.' : `تم ضبط صوت القراءة على «${$('scanSoundSelect')?.selectedOptions?.[0]?.textContent || value}».`);
  playScanFeedback(value === 'silent' ? 'click' : value);
}
function setScanVibrate(checked) {
  const appearance = getAppearance(); appearance.scanVibrate = Boolean(checked); saveAppearance(appearance);
  if ($('vibrateFeedback')) $('vibrateFeedback').checked = Boolean(checked);
  notify(checked ? 'تم تفعيل اهتزاز الهاتف عند القراءة.' : 'تم إيقاف اهتزاز الهاتف.');
  if (checked) playScanFeedback('beep');
}
function playScanFeedback(kind) {
  const style = kind || scanFeedbackSetting();
  if (style === 'silent') return;
  if (window.navigator?.vibrate && scanVibrateEnabled()) { try { window.navigator.vibrate(style === 'chime' ? [18, 40, 18] : 22); } catch { /* vibration is optional */ } }
  const context = audioEngine();
  if (!context) return;
  const now = context.currentTime;
  const tones = style === 'chime' ? [[880, 0.09, 0], [1320, 0.12, 0.09]] : style === 'click' ? [[1600, 0.035, 0]] : [[1245, 0.07, 0]];
  for (const [frequency, duration, delay] of tones) {
    const oscillator = context.createOscillator(), gain = context.createGain();
    oscillator.type = style === 'click' ? 'square' : 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, now + delay);
    gain.gain.exponentialRampToValueAtTime(style === 'click' ? 0.06 : 0.14, now + delay + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(now + delay); oscillator.stop(now + delay + duration + 0.02);
  }
}
function applyScanFeedbackUI() {
  if ($('scanSoundSelect')) $('scanSoundSelect').value = scanFeedbackSetting();
  if ($('vibrateFeedback')) $('vibrateFeedback').checked = scanVibrateEnabled();
}
function setQuickPaid(value) {
  const field = $('invPaidAmount'); if (!field) return;
  const net = roundMoney(Number($('invNetTotal').value) || 0);
  const current = roundMoney(Number(field.value) || 0);
  // The first chip replaces the auto-filled "exact cash" amount, later chips accumulate banknotes.
  const adding = current > 0 && Math.abs(current - net) > 0.0001;
  if (value === 'exact') field.value = money(net);
  else if (value === 'round') field.value = money(Math.ceil(net / 5) * 5);
  else field.value = money(adding ? roundMoney(current + Number(value)) : roundMoney(Number(value)));
  dispatchInput(field);
  calcInvoiceRemaining();
}
function clearInvCart() {
  invCart = []; selectedCartIndex = -1; delete $('invCartTbody').dataset.quoteId;
  $('invDiscAmount').value = 0; $('invDiscPct').value = 0; $('invReturnSource').value = '';
  $('invBarcodeInp').value = ''; $('invAddQty').value = 1; clearDraft(); renderInvCart();
}
/* ---- auto-saved draft: the running invoice survives a refresh or a crash ---- */
let draftTimer = 0;
let draftFingerprint = '';
function draftSnapshot() {
  return {
    savedAt: new Date().toISOString(), user: activeStaffId, mode: $('invMode')?.value || 'sale',
    items: clone(invCart), partyId: $('invPartySelect')?.value || '', priceTier: $('invPriceTier')?.value || 'retail',
    payType: $('invPayType')?.value || 'cash', paid: $('invPaidAmount')?.value || '0',
    discountAmount: $('invDiscAmount')?.value || '0', discountPct: $('invDiscPct')?.value || '0',
    quoteId: $('invCartTbody')?.dataset.quoteId || '', note: $('invPrintNote')?.value || ''
  };
}
function readDraft() {
  try { const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); return draft && Array.isArray(draft.items) ? draft : null; }
  catch { return null; }
}
function clearDraft() {
  draftFingerprint = '';
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  paintDraftHint();
}
function saveDraftNow(force) {
  if (!$('invMode') || !document.body.dataset.appReady) return;
  const snapshot = draftSnapshot();
  if (!$('invCartTbody')?.dataset.quoteId && !snapshot.items.length && !Number(snapshot.discountAmount) && !Number(snapshot.discountPct) && !Number(snapshot.paid)) {
    if (readDraft()) clearDraft(); else paintDraftHint();
    return;
  }
  const fingerprint = JSON.stringify(snapshot);
  if (!force && fingerprint === draftFingerprint) return;
  draftFingerprint = fingerprint;
  try { localStorage.setItem(DRAFT_KEY, fingerprint); } catch { return; }
  paintDraftHint();
}
function formatDraftAge(iso) {
  const saved = new Date(iso).getTime();
  if (!Number.isFinite(saved)) return 'قبل قليل';
  const seconds = Math.max(0, Math.round((Date.now() - saved) / 1000));
  if (seconds < 60) return `قبل ${seconds} ثانية`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `قبل ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `قبل ${hours} ساعة` : `قبل ${Math.round(hours / 24)} يوم`;
}
function paintDraftHint() {
  const hint = $('draftHint'), button = $('restoreDraftBtn');
  const draft = readDraft();
  if (hint) {
    hint.hidden = !draft;
    if (draft) hint.textContent = `💾 مسودة محفوظة تلقائياً (${draft.items.length} صنف) — ${formatDraftAge(draft.savedAt)}`;
  }
  if (button) button.hidden = !draft;
}
function restoreSavedDraft(silent) {
  const draft = readDraft();
  if (!draft) { if (!silent) notify('لا توجد مسودة محفوظة حالياً.'); return false; }
  const valid = draft.items.every(line => db.items.some(item => item.id === line.id) && Number.isFinite(Number(line.qty)) && line.qty > 0);
  if (!valid) { clearDraft(); if (!silent) notify('المسودة تحتوي أصنافاً لم تعد موجودة، تم تجاهلها.'); return false; }
  if (!silent && invCart.length && JSON.stringify(invCart) !== JSON.stringify(draft.items) && !confirm('استعادة المسودة ستستبدل الفاتورة الحالية. هل تريد المتابعة؟')) return false;
  openSec('sec-invoice', '🛒 مسودة محفوظة');
  $('invMode').value = INVOICE_MODES.includes(draft.mode) ? draft.mode : 'sale';
  updateInvoiceUI();
  invCart = clone(draft.items);
  if ([...$('invPartySelect').options].some(option => option.value === String(draft.partyId))) $('invPartySelect').value = String(draft.partyId);
  $('invPriceTier').value = draft.priceTier || 'retail'; $('invPayType').value = draft.payType || 'cash';
  $('invPaidAmount').value = draft.paid || '0';
  $('invDiscAmount').value = draft.discountAmount || '0'; $('invDiscPct').value = draft.discountPct || '0';
  if ($('invPrintNote')) $('invPrintNote').value = draft.note || '';
  if (draft.quoteId) $('invCartTbody').dataset.quoteId = String(draft.quoteId);
  selectedCartIndex = invCart.length - 1;
  renderInvCart();
  if (draft.user && staffList().some(user => user.id === draft.user)) { activeStaffId = draft.user; updateActiveUserBadge(); }
  if (!silent) { recordAudit('استعادة مسودة محفوظة تلقائياً'); notify('تم استرجاع المسودة المحفوظة تلقائياً.'); }
  $('invBarcodeInp')?.focus();
  return true;
}
/* ---- app badge: unfinished work visible on the installed app icon ---- */
async function syncAppBadge() {
  const count = (() => {
    try {
      const held = safeReadArray(HELD_CARTS_KEY).length;
      const draft = readDraft();
      return held + (draft && draft.items?.length ? 1 : 0);
    } catch { return 0; }
  })();
  paintBadgeHints(count);
  try {
    if (!('setAppBadge' in navigator)) return;
    if (!activeStaffId || !document.body.dataset.appReady) { await navigator.clearAppBadge?.(); return; }
    if (count) await navigator.setAppBadge(count); else await navigator.clearAppBadge?.();
  } catch { /* app badges are best-effort */ }
}
function paintBadgeHints(count) {
  const button = $('restoreHeldButton');
  if (button) {
    const held = safeReadArray(HELD_CARTS_KEY).length;
    button.textContent = held ? `↩️ استعادة معلقة (${held})` : '↩️ استعادة معلقة (0)';
    button.classList.toggle('has-held', held > 0);
  }
  if ($('draftBadge')) {
    $('draftBadge').hidden = !count;
    $('draftBadge').textContent = count ? String(count) : '';
  }
  if ($('appBadgeHint')) {
    $('appBadgeHint').textContent = count
      ? `يوجد ${count} عمل غير مكتمل (${safeReadArray(HELD_CARTS_KEY).length} معلّقة + ${count - safeReadArray(HELD_CARTS_KEY).length} مسودة) — تظهر شارة على أيقونة التطبيق المثبّت.`
      : 'لا توجد فواتير معلّقة أو مسودات — أيقونة التطبيق بدون شارة.';
  }
}
function offerDraftRestore() {
  const draft = readDraft();
  if (!draft || invCart.length || document.body.dataset.appReady !== 'true') return;
  if ($('lockModal')?.style.display === 'flex') return;
  appConfirm(`توجد مسودة فاتورة محفوظة تلقائياً (${draft.items.length} صنف — ${formatDraftAge(draft.savedAt)}). هل تريد استكمالها؟`,
    { title: 'مسودة محفوظة', icon: '💾', confirmText: 'استكمال المسودة', cancelText: 'لاحقاً', tone: 'confirm' })
    .then(answer => { if (answer) restoreSavedDraft(true); });
}
function discardSavedDraft() {
  if (!readDraft()) return;
  clearDraft();
  notify('تم حذف المسودة المحفوظة.');
}
function startDraftAutosave() {
  window.clearInterval(draftTimer);
  draftTimer = window.setInterval(() => { saveDraftNow(false); syncAppBadge(); }, DRAFT_EVERY_MS);
  window.addEventListener('beforeunload', () => saveDraftNow(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraftNow(true); });
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
  clearInvCart(); renderHeldCount(); syncAppBadge(); alert('تم تعليق الفاتورة مؤقتاً على هذا الجهاز.');
}
function restoreHeldInvoice(index = 0) {
  const held = safeReadArray(HELD_CARTS_KEY), draft = held[index];
  if (!draft) return alert('لا توجد فواتير معلقة لاستعادتها.');
  const permission = invoicePermission(String(draft.mode));
  if (!ensurePermission(permission)) return;
  if (invCart.length && !confirm('استعادة الفاتورة المعلقة ستستبدل المسودة الحالية. هل تريد المتابعة؟')) return;
  if (!Array.isArray(draft.items) || !draft.items.every(line => db.items.some(item => item.id === line.id) && Number.isFinite(Number(line.qty)) && line.qty > 0)) return alert('الفاتورة المعلقة غير صالحة أو تحتوي أصنافاً لم تعد موجودة.');
  openSec('sec-invoice', '🛒 استعادة فاتورة معلقة');
  $('invMode').value = draft.mode; updateInvoiceUI();
  invCart = clone(draft.items);
  if ([...$('invPartySelect').options].some(option => option.value === String(draft.partyId))) $('invPartySelect').value = String(draft.partyId);
  $('invPriceTier').value = draft.priceTier || 'retail'; $('invPayType').value = draft.payType || 'cash';
  $('invPaidAmount').value = draft.paid || '0'; $('invDiscAmount').value = draft.discountAmount || '0'; $('invDiscPct').value = draft.discountPct || '0';
  if (draft.quoteId) $('invCartTbody').dataset.quoteId = String(draft.quoteId);
  selectedCartIndex = invCart.length - 1;
  renderInvCart();
  held.splice(index, 1); localStorage.setItem(HELD_CARTS_KEY, JSON.stringify(held)); renderHeldCount(); syncAppBadge();
  recordAudit('استعادة فاتورة معلقة'); $('invBarcodeInp').focus();
}
function loadReturnSource() {
  invCart = []; selectedCartIndex = -1;
  const source = db.invoices.find(inv => inv.id === Number($('invReturnSource').value));
  if (source) {
    $('invPartySelect').value = String(source.partyId);
    invoiceLines(source).forEach(line => {
      const qty = roundQuantity(line.qty - returnedQuantity(db.invoices, source.id, line.id));
      if (qty > 0) {
        const returnedNet = roundMoney(db.invoices.filter(inv => inv.sourceId === source.id).flatMap(inv => invoiceLines(inv)).filter(c => c.id === line.id).reduce((sum, c) => sum + c.netTotal, 0));
        const remainingNet = roundMoney(line.netTotal - returnedNet);
        invCart.push({ id: line.id, code: line.code, name: line.name, unit: db.items.find(i => i.id === line.id)?.unit || 'عدد',
          qty, maxQty: qty, sourceNetRemaining: remainingNet, returnNetTotal: remainingNet,
          price: remainingNet / qty, discPct: 0, buyCost: line.buyCost, minSell: 0 });
      }
    });
  }
  renderInvCart();
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
  openSec('sec-invoice', '🛒 تحويل عرض سعر إلى مبيعات'); $('invMode').value = 'sale'; updateInvoiceUI();
  invCart = invoiceLines(quote).map(c => { const item = db.items.find(i => i.id === c.id); return { ...c, unit: item?.unit || 'عدد', price: c.netTotal / c.qty, discPct: 0, buyCost: item?.buy ?? c.buyCost, minSell: item?.minSell ?? c.minSell }; });
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
/* ---- A5 preview of the running invoice, before anything is saved ---- */
function previewInvoiceDraft() {
  const mode = $('invMode').value, partyId = Number($('invPartySelect').value) || 0;
  const { totals, paid, remain, party } = validateInvoice(mode, partyId, num('invPaidAmount'));
  return { ...totals, id: 'مسودة', date: localDate(), time: new Date().toTimeString().slice(0, 5), mode,
    partyId, partyName: party?.name || 'عميل نقدي', prevBalance: party?.balance || 0, paidAmount: paid, remainAmount: remain,
    newBalance: party?.balance || 0, note: $('invPrintNote')?.value.trim() || '',
    store: { name: db.settings.name, address: db.settings.address, phone: db.settings.phone } };
}
function previewInvoiceA5(invoice) {
  if (!invoice && !ensurePermission(invoicePermission($('invMode').value))) return;
  let draft = invoice;
  if (!draft) {
    try { draft = previewInvoiceDraft(); }
    catch (error) { return alert(error.message); }
  }
  window.__previewInvoice = draft;
  const modal = $('invoicePreview');
  if (!modal) return;
  $('previewPaper').innerHTML = invoiceDocBody(draft, 'a5');
  if ($('previewBadge')) $('previewBadge').textContent = invoice ? `فاتورة محفوظة #${invoice.id}` : 'قبل الحفظ — مسودة';
  if ($('previewTitle')) $('previewTitle').textContent = `معاينة ${MODE_LABELS[draft.mode] || 'فاتورة'} — حجم A5`;
  if ($('previewZoom')) { $('previewZoom').value = '100'; setPreviewZoom('100'); }
  modal.hidden = false;
  playScanFeedback('click');
}
function setPreviewZoom(value) {
  const zoom = Math.min(130, Math.max(70, Number(value) || 100)) / 100;
  if ($('previewPaper')) $('previewPaper').style.transform = `scale(${zoom})`;
  if ($('previewPaper')) $('previewPaper').style.marginBottom = `${Math.round((zoom - 1) * 320)}px`;
}
function printPreviewA5() {
  const draft = window.__previewInvoice;
  if (!draft) return;
  const area = $('printAreaA5');
  const previous = area.innerHTML;
  area.innerHTML = invoiceDocBody(draft, 'a5');
  const style = $('thermalPrintStyle');
  const previousStyle = style?.textContent || '';
  if (style) style.textContent = `@media print{@page{size:A5;margin:7mm} body > :not(#printAreaA5){display:none!important} #printAreaA5{display:block!important} .p-table th,.p-table td{border:1px solid #999;padding:3px 4px;text-align:center} .p-table{width:100%;border-collapse:collapse} .preview-paper{transform:none!important}}`;
  try { window.print(); } finally {
    area.innerHTML = previous;
    if (style) style.textContent = previousStyle;
  }
}
function previewSavedInvoice(id, event) {
  event?.stopPropagation?.();
  const invoice = db.invoices.find(entry => entry.id === Number(id));
  if (!invoice) return notify('لم يتم العثور على الفاتورة المطلوبة.');
  previewInvoiceA5(invoice);
}
function closeInvoicePreview() { if ($('invoicePreview')) $('invoicePreview').hidden = true; }
function saveInvoice(doPrint) {
  const activeMode = $('invMode').value;
  if (!ensurePermission(invoicePermission(activeMode))) return;
  if (!['sale', 'quote'].includes(activeMode)) { saveInvoiceNow(doPrint); return; }
  if (invoiceDiscountPercent() <= discountLimitFor() + 0.0001 || isAdmin()) { saveInvoiceNow(doPrint); return; }
  confirmOverLimitDiscount()
    .then(approved => { if (approved) saveInvoiceNow(doPrint); })
    .catch(error => { console.error(error); });
}
function saveInvoiceNow(doPrint) {
  const activeMode = $('invMode').value;
  try {
    const mode = $('invMode').value, partyId = Number($('invPartySelect').value) || 0;
    const { totals, paid, remain, source, party } = validateInvoice(mode, partyId, num('invPaidAmount'));
    const quoteId = Number($('invCartTbody').dataset.quoteId) || undefined;
    if (quoteId && (mode !== 'sale' || db.invoices.find(i => i.id === quoteId)?.convertedToId)) throw new Error('عرض السعر لم يعد متاحاً للتحويل.');
    const invoice = { ...totals, id: nextId(db.invoices), date: localDate(), time: new Date().toTimeString().slice(0, 5), mode,
      partyId, partyName: party?.name || 'عميل نقدي', prevBalance: party?.balance || 0, paidAmount: paid, remainAmount: remain,
      newBalance: party?.balance || 0, note: $('invPrintNote')?.value.trim() || '', store: { name: db.settings.name, address: db.settings.address, phone: db.settings.phone } };
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
    clearDraft(); syncAppBadge();
    renderSystemAlerts(); renderStockAlerts();
    if (doPrint === 'thermal') printInvoiceThermal(invoice); else if (doPrint) printInvoiceA5(invoice); else alert('✅ تم حفظ الفاتورة محلياً بنجاح.');
  } catch (error) { alert(error.message); }
}
function printInvoiceById(id) {
  const invoice = db.invoices.find(inv => inv.id === id); if (!invoice) return;
  if (!ensurePermission(invoice.mode.startsWith('purchase') ? 'purchase-log' : 'sales-log')) return;
  printInvoiceA5(invoice);
}
function printInvoiceThermalById(id) {
  const invoice = db.invoices.find(inv => inv.id === id); if (!invoice) return;
  if (!ensurePermission(invoice.mode.startsWith('purchase') ? 'purchase-log' : 'sales-log')) return;
  printInvoiceThermal(invoice);
}
function printInvoiceThermal(inv) {
  const store = inv.store || db.settings, width = getAppearance().receiptWidth === '58' ? 58 : 80;
  const rows = invoiceLines(inv).map(line => `<tr><td>${esc(line.name)}<br>${esc(line.qty)} × ${money(line.price)}</td><td>${money(line.netTotal)}</td></tr>`).join('');
  const header = `<div class="receipt-head"><h2>${esc(store.name)}</h2><p>${esc(store.address)}</p><p>${esc(store.phone)}</p><p>${esc(MODE_LABELS[inv.mode])} #${inv.id}</p><p>${esc(inv.date)} — ${esc(inv.time)}</p><p>${esc(inv.partyName)}</p></div>`;
  const receipt = `<div class="thermal-receipt">${header}<table><thead><tr><th>الصنف</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table><div class="receipt-totals"><p><span>الإجمالي</span><strong>${money(inv.subtotal ?? inv.netTotal)} ج.م</strong></p><p><span>الخصم</span><strong>${money(inv.discountTotal ?? 0)} ج.م</strong></p><p><span>الصافي</span><strong>${money(inv.netTotal)} ج.م</strong></p><p><span>المدفوع</span><strong>${money(inv.paidAmount)} ج.م</strong></p><p><span>المتبقي</span><strong>${money(inv.remainAmount)} ج.م</strong></p></div>${inv.note ? `<p style="font-size:9px;text-align:center">${esc(inv.note)}</p>` : ''}<p class="receipt-thanks">${inv.mode === 'quote' ? 'عرض سعر فقط — ليس إيصال دفع' : 'شكراً لتعاملكم معنا'}</p></div>`;
  const style = $('thermalPrintStyle');
  style.textContent = `@media print{@page{size:${width}mm auto;margin:2mm}body.thermal-print #printAreaA5{display:block!important;position:absolute!important;top:0!important;left:0!important;width:${width - 4}mm!important;max-width:${width - 4}mm!important;padding:0!important;margin:0!important;font-size:10px!important;color:#111!important}body.thermal-print #printAreaA5 table{width:100%;border-collapse:collapse}body.thermal-print #printAreaA5 th,body.thermal-print #printAreaA5 td{font-size:10px!important;padding:3px 1px!important;border-bottom:1px dashed #555!important;text-align:center!important}body.thermal-print #printAreaA5 .receipt-totals p{display:flex!important;justify-content:space-between!important;margin:3px 0!important}body.thermal-print #printAreaA5 .receipt-head h2{font-size:14px!important}}`;
  $('printAreaA5').innerHTML = receipt; document.body.classList.add('thermal-print');
  const cleanup = () => { document.body.classList.remove('thermal-print'); style.textContent = ''; window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup, { once: true }); window.print(); window.setTimeout(cleanup, 3000);
}
function invoiceQrMarkup(inv) {
  const vat = 0;
  try {
    const qr = qrCodeSvg(`POS|${db.settings.name}|INV-${inv.id}|${inv.date}|${money(inv.netTotal)}|${money(vat)}`, 92);
    return `<div style="text-align:center">${qr}<div style="font-size:9px">${esc(db.settings.phone || '')}</div></div>`;
  } catch { return ''; }
}
/* ---- A5 document markup shared by print / PDF / WhatsApp share ---- */
function invoiceDocCss(paper = 'a5') {
  const size = paper === 'a4' ? 'A4' : 'A5';
  return `@page{size:${size};margin:${paper === 'a4' ? '10mm' : '7mm'}}
    *{box-sizing:border-box}
    body{margin:0;padding:${paper === 'a4' ? '6mm' : '4mm'};background:#fff;color:#111;font-family:'Cairo',Tahoma,Arial,sans-serif}
    .doc{max-width:${paper === 'a4' ? '190mm' : '138mm'};margin:0 auto}
    .p-header{text-align:center;border-bottom:2px solid #1c3d1a;padding-bottom:6px;margin-bottom:8px}
    .p-header h2{margin:0;font-size:${paper === 'a4' ? '20px' : '16px'};color:#1c3d1a}
    .p-header p{margin:2px 0;font-size:${paper === 'a4' ? '11px' : '9.5px'};color:#444}
    .p-header h3{margin:4px 0 0;font-size:${paper === 'a4' ? '14px' : '12px'};color:#0f4c81}
    .p-meta{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:${paper === 'a4' ? '11px' : '9.5px'};margin:6px 0;padding:5px 7px;border:1px solid #ccc;border-radius:4px;background:#fafafa}
    .p-table{width:100%;border-collapse:collapse;margin:6px 0;font-size:${paper === 'a4' ? '11px' : '9.5px'}}
    .p-table th,.p-table td{border:1px solid #999;padding:${paper === 'a4' ? '4px 5px' : '3px 4px'};text-align:center}
    .p-table thead th{background:#e8f0e2;font-weight:700}
    .p-totals{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:${paper === 'a4' ? '11px' : '9.5px'};padding:5px 7px;margin-top:5px;border:1px dashed #999;border-radius:4px}
    .p-sign{display:flex;justify-content:space-between;margin-top:${paper === 'a4' ? '22px' : '14px'};font-size:${paper === 'a4' ? '11px' : '9.5px'}}
    .p-foot{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;margin-top:8px;padding-top:6px;border-top:1px solid #ccc;font-size:9px;color:#555}
    .p-foot svg{width:${paper === 'a4' ? '80px' : '62px'};height:auto}
    .p-note{text-align:center;font-size:9.5px;color:#555}`;
}
function invoiceDocBody(inv, paper = 'a5') {
  const store = inv.store || db.settings;
  const rows = invoiceLines(inv).map((c, index) => `<tr><td>${index + 1}</td><td>${esc(c.code || '')}</td><td style="text-align:right">${esc(c.name)}</td><td>${esc(c.qty)}</td><td>${money(c.price)}</td><td>${esc(c.discPct)}%</td><td>${money(c.netTotal)}</td></tr>`).join('');
  return `<div class="doc">
    <div class="p-header"><h2>${esc(store.name)}</h2><p>${esc(store.address)} | هاتف: ${esc(store.phone)}</p><h3>${esc(MODE_LABELS[inv.mode])} رقم #${inv.id}</h3></div>
    <div class="p-meta"><span>التاريخ: ${esc(inv.date)} (${esc(inv.time)})</span><span>العميل: ${esc(inv.partyName)}</span><span>الهاتف: ${esc(store.phone)}</span></div>
    <table class="p-table"><thead><tr><th>م</th><th>الكود</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>خصم</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="p-totals"><span>عدد المواد: ${invoiceLines(inv).length}</span><span>إجمالي البنود: ${money(inv.subtotal ?? invoiceLines(inv).reduce((sum, c) => sum + lineGross(c), 0))}</span><span>الخصم الإضافي: ${money(inv.discountTotal ?? 0)}</span></div>
    <div class="p-totals"><span>الصافي: ${money(inv.netTotal)} ج.م</span><span>${inv.mode.startsWith('purchase') ? 'المسدّد للمورد' : 'المدفوع'}: ${money(inv.paidAmount)}</span><span>المتبقي: ${money(inv.remainAmount)}</span></div>
    ${inv.mode !== 'quote' ? `<div class="p-totals"><span>الرصيد السابق: ${money(inv.prevBalance)}</span><span>الرصيد الحالي: ${money(inv.newBalance)} ج.م</span></div>` : '<p class="p-note">عرض أسعار فقط — ليس إيصال دفع ولا يغيّر المخزون.</p>'}
    ${inv.note ? `<p class="p-note">ملاحظات: ${esc(inv.note)}</p>` : ''}
    <div class="p-sign"><span>توقيع العميل: ........................</span><span>توقيع الموظف: ........................</span></div>
    <div class="p-foot"><span>نظام نقاط البيع وإدارة المكتبات</span>${invoiceQrMarkup(inv)}</div>
  </div>`;
}
function invoiceDocHtml(inv, paper = 'a5') {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(MODE_LABELS[inv.mode])} #${inv.id}</title><style>${invoiceDocCss(paper)}</style></head><body>${invoiceDocBody(inv, paper)}</body></html>`;
}
function openInvoiceDocument(invoiceId, paper = 'a5') {
  const inv = db.invoices.find(entry => entry.id === Number(invoiceId));
  if (!inv) return notify('لم يتم العثور على الفاتورة المطلوبة.');
  if (!ensurePermission(inv.mode.startsWith('purchase') ? 'purchase-log' : 'sales-log')) return;
  const win = window.open('', '_blank');
  if (!win) return notify('المتصفح منع فتح النافذة — اسمح بالنوافذ المنبثقة لهذا الموقع.');
  win.document.write(invoiceDocHtml(inv, paper)); win.document.close(); win.focus();
  win.setTimeout(() => { try { win.print(); } catch { /* user can print from the new tab */ } }, 600);
}
async function exportInvoicePdfById(invoiceId, paper = 'a5') {
  const inv = db.invoices.find(entry => entry.id === Number(invoiceId));
  if (!inv) return notify('لم يتم العثور على الفاتورة المطلوبة.');
  if (!ensurePermission(inv.mode.startsWith('purchase') ? 'purchase-log' : 'sales-log')) return;
  const fileName = `Invoice_${inv.id}_${inv.date}.pdf`;
  const html = invoiceDocHtml(inv, paper);
  download(html, 'text/html;charset=utf-8', `Invoice_${inv.id}_${inv.date}.html`);
  recordAudit(`تصدير ${MODE_LABELS[inv.mode]} #${inv.id} للطباعة كـ PDF`);
  const approved = await appConfirm(`تم تنزيل نسخة ${paper.toUpperCase()} جاهزة للطباعة باسم «Invoice_${inv.id}_${inv.date}.html». افتح الملف ثم اختر «طباعة» وأمر «حفظ كـ PDF» للحصول على ملف ${fileName}. هل تريد فتح معاينة الطباعة الآن أيضاً؟`,
    { title: 'تصدير PDF', icon: '📄', confirmText: 'فتح معاينة الطباعة', cancelText: 'تم', tone: 'confirm' });
  if (approved) openInvoiceDocument(inv.id, paper);
}
function invoiceShareText(inv) {
  const store = inv.store || db.settings;
  const lines = invoiceLines(inv).slice(0, 12).map(line => `• ${line.name} × ${roundQuantity(line.qty)} = ${money(line.netTotal)}`);
  const extra = invoiceLines(inv).length > 12 ? `
• … و${invoiceLines(inv).length - 12} صنف آخر` : '';
  return [`*${store.name}*`, `${MODE_LABELS[inv.mode]} رقم #${inv.id}`, `التاريخ: ${inv.date} — ${inv.time}`, `العميل: ${inv.partyName}`, '', ...lines, extra, '',
    `الإجمالي: ${money(inv.subtotal ?? inv.netTotal)} ج.م`, `الخصم: ${money(inv.discountTotal ?? 0)} ج.م`, `الصافي: ${money(inv.netTotal)} ج.م`,
    `المدفوع: ${money(inv.paidAmount)} ج.م`, `المتبقي: ${money(inv.remainAmount)} ج.م`, '', inv.mode === 'quote' ? 'عرض سعر — غير مدفوع' : 'شكراً لتعاملكم معنا', store.phone ? `هاتف: ${store.phone}` : ''].filter(Boolean).join('\n');
}
function whatsappLink(text, phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  const withCountry = digits.startsWith('0') ? `20${digits.slice(1)}` : digits;
  const base = withCountry ? `https://wa.me/${withCountry}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(text)}`;
}
async function shareInvoiceOnWhatsApp(invoiceId) {
  const inv = db.invoices.find(entry => entry.id === Number(invoiceId));
  if (!inv) return notify('لم يتم العثور على الفاتورة المطلوبة.');
  if (!ensurePermission(inv.mode.startsWith('purchase') ? 'purchase-log' : 'sales-log')) return;
  const text = invoiceShareText(inv);
  const party = db.parties.find(entry => entry.id === inv.partyId);
  const link = whatsappLink(text, party?.phone || '');
  recordAudit(`مشاركة ${MODE_LABELS[inv.mode]} #${inv.id} عبر واتساب`);
  const win = window.open(link, '_blank');
  if (!win) { download(text, 'text/plain;charset=utf-8', `Invoice_${inv.id}_WhatsApp.txt`); return notify('تم تنزيل نص الفاتورة — أرفقه في واتساب يدوياً.'); }
  notify(`تم فتح واتساب لمشاركة ${MODE_LABELS[inv.mode]} #${inv.id}.`);
}
function printInvoiceA5(inv) {
  const store = inv.store || db.settings;
  const rows = invoiceLines(inv).map((c, index) => `<tr><td>${index + 1}</td><td>${esc(c.code || '')}</td><td>${esc(c.name)}</td><td>${esc(c.qty)}</td><td>${money(c.price)}</td><td>${esc(c.discPct)}%</td><td>${money(c.netTotal)}</td></tr>`).join('');
  triggerA5Print(`<div class="p-header"><h2>${esc(store.name)}</h2><p>${esc(store.address)} | هاتف: ${esc(store.phone)}</p><h3>${esc(MODE_LABELS[inv.mode])} رقم #${inv.id}</h3></div>
    <div class="p-meta"><span>التاريخ: ${esc(inv.date)} (${esc(inv.time)})</span><span>العميل: ${esc(inv.partyName)}</span><span>الهاتف: ${esc(store.phone)}</span></div>
    <table class="p-table"><thead><tr><th>م</th><th>الكود</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>خصم</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="p-totals"><span>عدد المواد: ${invoiceLines(inv).length}</span><span>إجمالي البنود: ${money(inv.subtotal ?? invoiceLines(inv).reduce((s, c) => s + lineGross(c), 0))}</span><span>الخصم الإضافي: ${money(inv.discountTotal ?? 0)}</span></div>
    <div class="p-totals"><span>الصافي: ${money(inv.netTotal)} ج.م</span><span>${inv.mode.startsWith('purchase') ? 'المسدّد للمورد' : 'المدفوع'}: ${money(inv.paidAmount)}</span><span>المتبقي: ${money(inv.remainAmount)}</span></div>
    ${inv.mode !== 'quote' ? `<div class="p-totals"><span>الرصيد السابق: ${money(inv.prevBalance)}</span><span>الرصيد الحالي: ${money(inv.newBalance)} ج.م</span></div>` : '<p style="text-align:center">عرض أسعار فقط — ليس إيصال دفع ولا يغيّر المخزون.</p>'}
    ${inv.note ? `<p style="text-align:center">ملاحظات: ${esc(inv.note)}</p>` : ''}
    <div class="p-sign"><span>توقيع العميل: ........................</span><span>توقيع الموظف: ........................</span></div>
    <div class="p-foot"><span style="font-size:9.5px">نظام نقاط البيع وإدارة المكتبات</span>${invoiceQrMarkup(inv)}</div>`);
}

/* ---------------- items ---------------- */
function populateCategoriesSelect() {
  const previous = $('itemCategory').value;
  $('itemCategory').innerHTML = db.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (db.categories.includes(previous)) $('itemCategory').value = previous;
  if ($('labelCategory')) {
    const previousLabel = $('labelCategory').value;
    $('labelCategory').innerHTML = '<option value="all">كل الأصناف</option>' + db.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (db.categories.includes(previousLabel) || previousLabel === 'all') $('labelCategory').value = previousLabel;
  }
}
function quickAddCategory() {
  if (!ensurePermission('inventory')) return;
  const name = prompt('أدخل اسم المجموعة الجديدة:')?.trim();
  if (!name) return;
  if (db.categories.some(c => c.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert('المجموعة موجودة بالفعل.');
  if (commitDB(draft => { draft.categories.push(name); })) { populateCategoriesSelect(); $('itemCategory').value = name; renderPosTiles(); }
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
      resetItemForm(); renderItemsTable(); renderPosTiles(); renderLabels();
    }
  } catch (error) { alert(error.message); }
}
function resetItemForm() {
  $('itemEditId').value = ''; $('itemName').value = ''; $('itemQty').value = 10; $('itemMinQty').value = 3;
  $('itemBuyPrice').value = 0; $('itemProfitPct').value = 20; $('itemSellPrice').value = 0;
  $('itemWholesale').value = 0; $('itemMinSell').value = 0; $('itemNotes').value = ''; generateNewCode();
}
function renderItemsTable() {
  const body = $('itemsTbody'); if (!body) return;
  const q = $('itemSearchInp').value.trim().toLocaleLowerCase();
  const list = db.items.filter(i => [i.name, i.code, i.cat].some(v => String(v).toLocaleLowerCase().includes(q)));
  let totBuy = 0, totSell = 0;
  body.innerHTML = list.map(i => {
    totBuy += i.buy * i.qty; totSell += i.sell * i.qty;
    const input = (field, width) => `<input aria-label="${esc(i.name)}: ${field}" type="${field === 'name' ? 'text' : 'number'}" ${field === 'name' ? '' : 'min="0" step="any"'} value="${esc(i[field])}" style="width:${width}px;max-width:100%" onchange="inlineUpdateItem(${i.id},'${field}',this.value)">`;
    return `<tr><td><strong>${esc(i.code)}</strong></td><td class="cell-name">${quickEditMode ? input('name', 170) : esc(i.name)}</td>
      <td>${esc(i.cat)}</td><td>${esc(i.warehouse)}</td><td style="font-weight:bold;color:${i.qty <= i.minQty ? 'var(--danger)' : '#20591f'}">${quickEditMode ? input('qty', 64) : esc(i.qty)}</td><td>${esc(i.unit)}</td>
      <td>${quickEditMode ? input('buy', 72) : money(i.buy)}</td><td>${quickEditMode ? input('sell', 72) : money(i.sell)}</td><td>${quickEditMode ? input('wholesale', 72) : money(i.wholesale)}</td>
      <td>${money(i.minSell)}</td><td>${esc(i.notes || '-')}</td>
      ${quickEditMode ? '<td colspan="3"><span class="badge bg-green">حفظ تلقائي</span></td>' : `<td class="no-print"><button type="button" class="act-btn bg-orange" onclick="editItem(${i.id})">✏️ تعديل</button></td><td class="no-print"><button type="button" class="act-btn bg-red" onclick="deleteItem(${i.id})">🗑️ حذف</button></td><td class="no-print"><button type="button" class="act-btn bg-blue" onclick="printBarcodeLabel(${i.id})">🏷️ باركود</button></td>`}</tr>`;
  }).join('') || '<tr><td colspan="14" class="empty-row">لا توجد أصناف مطابقة. أضف صنفاً من النموذج بالأعلى.</td></tr>';
  document.querySelectorAll('#sec-items thead th').forEach((th, index) => th.classList.toggle('no-print', index >= 11));
  $('totItemsCount').textContent = list.length; $('totItemsBuy').textContent = money(totBuy); $('totItemsSell').textContent = money(totSell);
  if ($('headItemsCount')) $('headItemsCount').textContent = String(list.length);
  if ($('headItemsValue')) $('headItemsValue').textContent = money(totSell);
  if ($('itemsTableHint')) $('itemsTableHint').textContent = q ? `${list.length} نتيجة بحث` : `${list.length} صنف`;
}
function inlineUpdateItem(id, field, value) {
  if (!ensurePermission('inventory') || !['name', 'qty', 'buy', 'sell', 'wholesale'].includes(field)) return;
  const item = db.items.find(i => i.id === id);
  if (!item) return;
  if (field !== 'name' && value.trim() === '') { alert('لا تترك القيمة الرقمية فارغة.'); renderItemsTable(); return; }
  const updated = { ...item, [field]: field === 'name' ? value.trim() : Number(value) };
  if (!updated.name || (field !== 'name' && (!Number.isFinite(updated[field]) || updated[field] < 0))) { alert('القيمة غير صالحة؛ لم يُحفظ التعديل.'); renderItemsTable(); return; }
  if (field === 'buy' || field === 'sell') updated.profitPct = updated.buy > 0 ? roundMoney((updated.sell - updated.buy) / updated.buy * 100) : 0;
  if (commitDB(draft => { draft.items[draft.items.findIndex(i => i.id === id)] = updated; })) { renderItemsTable(); renderPosTiles(); }
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
    if (Number($('itemEditId').value) === id) resetItemForm(); renderItemsTable(); renderPosTiles(); renderLabels();
  }
}
function showSingleItemProfit() { openProfitSec('item'); }
function barcodeBlock(code, barHeight = 44, hideText = false) {
  try { return code39Svg(code, { barHeight, hideText }); } catch (error) { return `<div style="font-size:9px;color:#b1251d">${esc(error.message)}</div>`; }
}
function printBarcodeLabel(id) {
  const item = db.items.find(i => i.id === id); if (!item) return;
  triggerA5Print(`<div style="text-align:center;border:1px solid #000;padding:10px;max-width:280px;margin:auto"><strong>${esc(db.settings.name)}</strong><p style="margin:4px 0">${esc(item.name)}</p>${barcodeBlock(item.code, 50)}<div>السعر: ${money(item.sell)} ج.م</div></div>`);
}

/* ---------------- barcode label sheets ---------------- */
function loadLabelOptions() { populateCategoriesSelect(); renderLabels(); }
function renderLabels() {
  const preview = $('labelPreview'); if (!preview) return;
  const cat = $('labelCategory').value || 'all';
  const copies = Math.max(1, Math.min(40, Number($('labelCopies').value) || 1));
  const cols = Math.max(2, Math.min(4, Number($('labelCols').value) || 3));
  const barHeight = Math.max(24, Math.min(80, Number($('labelBarHeight').value) || 44));
  const showStore = $('labelStoreName').checked, showName = $('labelShowName').checked,
    showPrice = $('labelShowPrice').checked, showCode = $('labelShowCode').checked;
  const list = db.items.filter(item => cat === 'all' || item.cat === cat);
  labelCache = list;
  preview.style.gridTemplateColumns = `repeat(${cols},minmax(0,1fr))`;
  if ($('headLabelsCount')) $('headLabelsCount').textContent = String(list.length);
  const cells = [];
  for (const item of list) {
    for (let copy = 0; copy < copies; copy++) {
      cells.push(`<div class="label-cell">${showStore ? `<i>${esc(db.settings.name)}</i>` : ''}${showName ? `<b>${esc(item.name)}</b>` : ''}${barcodeBlock(item.code, barHeight, !showCode)}${showPrice ? `<span>${money(item.sell)}</span>` : ''}</div>`);
    }
  }
  preview.innerHTML = cells.join('') || '<div class="empty-row">لا توجد أصناف لطباعة ملصقاتها في هذه المجموعة.</div>';
  if ($('labelCount')) $('labelCount').textContent = `${list.length} صنف × ${copies} = ${cells.length} ملصق`;
}
function printLabels() {
  renderLabels();
  const preview = $('labelPreview');
  if (!preview || !preview.querySelector('.label-cell')) return alert('لا توجد ملصقات للطباعة. اختر مجموعة بها أصناف.');
  document.body.classList.add('print-labels');
  const cols = Math.max(2, Math.min(4, Number($('labelCols').value) || 3));
  triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><p>ملصقات باركود — ${localDate()}</p></div><div class="label-sheet" style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr))">${preview.innerHTML}</div>`);
  document.body.classList.remove('print-labels');
}

/* ---------------- categories ---------------- */
function renderCategoriesTable() {
  const body = $('catsTbody'); if (!body) return;
  body.innerHTML = db.categories.map((c, index) => `<tr><td>${index + 1}</td><td>${esc(c)}</td><td>${db.items.filter(i => i.cat === c).length}</td><td class="no-print"><button type="button" class="act-btn bg-red" onclick="deleteCategory(${index})">حذف</button></td></tr>`).join('') || '<tr><td colspan="4">لا توجد مجموعات.</td></tr>';
  const th = document.querySelector('#sec-categories th:last-child'); if (th) th.classList.add('no-print');
  if ($('headCatsCount')) $('headCatsCount').textContent = String(db.categories.length);
}
function addCategory() {
  if (!ensurePermission('inventory')) return;
  const name = $('catNameInp').value.trim(); if (!name) return alert('أدخل اسم المجموعة.');
  if (db.categories.some(c => c.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert('المجموعة موجودة بالفعل.');
  if (commitDB(draft => { draft.categories.push(name); })) { $('catNameInp').value = ''; renderCategoriesTable(); populateCategoriesSelect(); renderPosTiles(); }
}
function deleteCategory(index) {
  if (!ensurePermission('inventory')) return;
  const category = db.categories[index]; if (!category) return;
  if (db.items.some(i => i.cat === category)) return alert('لا يمكن حذف مجموعة مرتبطة بأصناف. انقل الأصناف إلى مجموعة أخرى أولاً.');
  if (confirm(`حذف المجموعة «${category}»؟`) && commitDB(draft => { draft.categories.splice(index, 1); })) { renderCategoriesTable(); populateCategoriesSelect(); renderPosTiles(); }
}
/* ---- actionable low-stock window + one-click purchase order ---- */
function lowStockItems() {
  return db.items.filter(item => item.qty <= item.minQty)
    .map(item => ({ item, gap: Math.max(1, Math.ceil(Number(item.minQty) || 0) * 2 - Number(item.qty || 0)) }))
    .sort((a, b) => a.item.qty - b.item.qty || a.item.name.localeCompare(b.item.name, 'ar'));
}
function stockAlertOpen() { const box = $('stockAlerts'); return Boolean(box && !box.hidden); }
function renderStockAlerts() {
  const list = $('stockAlertsList');
  if (!list) return;
  const rows = lowStockItems();
  const out = rows.filter(row => row.item.qty <= 0).length;
  if ($('stockAlertsTitle')) $('stockAlertsTitle').textContent = rows.length ? `نواقص المخزون (${rows.length})` : 'المخزون سليم';
  const badge = $('stockAlertsBtn');
  if (badge) {
    badge.textContent = rows.length ? `⚠️ نواقص (${rows.length})` : '✅ المخزون';
    badge.dataset.unread = rows.length ? 'yes' : 'no';
    badge.setAttribute('aria-pressed', stockAlertOpen() ? 'true' : 'false');
  }
  if ($('stockAlertsMeta')) $('stockAlertsMeta').textContent = rows.length
    ? `${out} نافد · ${rows.length - out} وصل لحد الطلب`
    : 'لا توجد أصناف تحت الحد الأدنى حالياً';
  list.innerHTML = rows.slice(0, 25).map(({ item }) => `<div class="stock-row">
      <span class="s-name">${esc(item.name)}</span>
      <span class="s-qty ${item.qty <= 0 ? 'out' : 'low'}">${roundQuantity(item.qty)} / ${roundQuantity(item.minQty)}</span>
      <button type="button" class="s-add" onclick="quickPurchaseForItem(${item.id})">طلب</button>
    </div>`).join('') || '<div class="stock-alerts-empty">✅ كل الأصناف أعلى من الحد الأدنى.</div>';
}
function toggleStockAlerts(force) {
  const box = $('stockAlerts');
  if (!box) return;
  const open = force === undefined ? box.hidden : Boolean(force);
  box.hidden = !open;
  renderStockAlerts();
}
function openStockAlertsPage() {
  toggleStockAlerts(false);
  if (!ensurePermission('stock')) return;
  openStockFilter(lowStockItems().some(row => row.item.qty <= 0) ? 'zero' : 'low');
}
function quickPurchaseForItem(itemId) {
  const item = db.items.find(entry => entry.id === Number(itemId));
  if (!item) return;
  toggleStockAlerts(false);
  openInvoiceSec('purchase');
  $('invPriceTier').value = 'retail';
  invCart = [];
  const gap = Math.max(1, Math.ceil((Number(item.minQty) || 0) * 2 - Number(item.qty || 0)));
  invCart.push({ id: item.id, code: item.code, name: item.name, unit: item.unit, qty: gap, price: item.buy, discPct: 0, buyCost: item.buy, minSell: item.minSell });
  selectedCartIndex = 0;
  renderInvCart();
  recordAudit(`طلب شراء سريع للصنف الناقص: ${item.name} (${gap})`);
  notify(`تم تجهيز طلب شراء لـ «${item.name}» بعدد ${gap} — اختر المورد ثم احفظ الفاتورة.`);
}
function openPurchaseOrderFromLowStock() {
  if (!ensurePermission('purchase')) return;
  const rows = lowStockItems();
  if (!rows.length) { toggleStockAlerts(false); return notify('لا توجد نواقص لطلبها.'); }
  toggleStockAlerts(false);
  openInvoiceSec('purchase');
  invCart = [];
  for (const { item, gap } of rows) {
    invCart.push({ id: item.id, code: item.code, name: item.name, unit: item.unit, qty: gap, price: item.buy, discPct: 0, buyCost: item.buy, minSell: item.minSell });
  }
  selectedCartIndex = invCart.length - 1;
  renderInvCart();
  recordAudit(`طلب شراء سريع لكل النواقص (${rows.length} صنف)`);
  notify(`تمت إضافة ${rows.length} صنفاً ناقصاً إلى فاتورة مشتريات — راجع الكميات واختر المورد.`);
}
function openStockFilter(filter) {
  if (!ensurePermission('stock')) return;
  openSec('sec-stock', filter === 'zero' ? '🚨 كشف النواقص' : filter === 'low' ? '⚠️ أصناف وصلت لحد الطلب' : '🏢 جرد المخزن العام');
  const list = db.items.filter(i => filter === 'zero' ? i.qty <= 0 : filter === 'low' ? i.qty <= i.minQty : true);
  $('stockTbody').innerHTML = list.map(i => `<tr><td>${esc(i.code)}</td><td class="cell-name">${esc(i.name)}</td><td>${esc(i.cat)}</td><td>${esc(i.warehouse)}</td><td style="color:${i.qty <= i.minQty ? 'var(--danger)' : '#20591f'};font-weight:bold">${esc(i.qty)} ${esc(i.unit)}</td><td>${esc(i.minQty)}</td><td>${money(i.buy)}</td><td>${money(i.qty * i.buy)}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">لا توجد أصناف مطابقة.</td></tr>';
}

/* ---------------- parties ---------------- */
function openPartySec(type) {
  if (!ensurePermission(type === 'supplier' ? 'supplier' : 'customer')) return;
  if ($('partyType').value !== type) resetPartyForm();
  $('partyType').value = type;
  openSec('sec-parties', type === 'supplier' ? '🚚 إدارة الموردين ودور النشر' : '👥 إدارة العملاء والمدارس');
  $('partyFormTitle').textContent = type === 'supplier' ? 'بيانات المورد' : 'بيانات العميل'; renderPartiesTable();
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
  $('partiesTbody').innerHTML = list.map((p, index) => `<tr><td>${index + 1}</td><td class="cell-name">${esc(p.name)}</td><td>${esc(p.phone || '-')}</td><td>${esc(p.notes || '-')}</td><td style="font-weight:bold">${money(p.balance)}</td>
    <td class="no-print"><button type="button" class="act-btn bg-blue" onclick="showStatementFor(${p.id})">كشف حساب</button></td><td class="no-print"><button type="button" class="act-btn bg-orange" onclick="editParty(${p.id})">تعديل</button></td><td class="no-print"><button type="button" class="act-btn bg-red" onclick="deleteParty(${p.id})">حذف</button></td></tr>`).join('') || '<tr><td colspan="8">لا توجد حسابات مسجلة.</td></tr>';
  $('partiesTbody').closest('table').querySelectorAll('thead th').forEach((th, i) => th.classList.toggle('no-print', i >= 5));
  if ($('headPartiesCount')) $('headPartiesCount').textContent = String(list.length);
  if ($('headPartiesBalance')) $('headPartiesBalance').textContent = money(list.reduce((sum, p) => sum + p.balance, 0));
  if ($('partiesHeadTitle')) $('partiesHeadTitle').textContent = $('partyType').value === 'supplier' ? '🚚 إدارة الموردين ودور النشر' : '👥 إدارة العملاء والمدارس';
  if ($('partyStatementBox').style.display !== 'none') renderPartyStatement();
}
function deleteParty(id) {
  if (!ensurePermission('admin')) return;
  const party = db.parties.find(p => p.id === id); if (!party) return;
  if (db.invoices.some(i => i.partyId === id) || db.treasury.some(t => t.partyId === id) || party.balance !== 0) return alert('لا يمكن حذف حساب له رصيد أو حركات مالية. احتفظ بالحساب للحفاظ على كشوف الحساب.');
  if (confirm('حذف هذا الحساب؟') && commitDB(draft => { draft.parties = draft.parties.filter(p => p.id !== id); })) { resetPartyForm(); renderPartiesTable(); }
}
/* ---- quick customer created from inside the invoice ---- */
function toggleQuickParty(force) {
  const box = $('invQuickParty');
  if (!box) return;
  const buying = $('invMode').value.startsWith('purchase');
  if (!ensurePermission(buying ? 'supplier' : 'customer')) return;
  const open = force === undefined ? box.hidden : Boolean(force);
  box.hidden = !open;
  if ($('invQuickPartyBtn')) $('invQuickPartyBtn').setAttribute('aria-expanded', String(open));
  if (open) { $('invQuickPartyName').focus(); if ($('invQuickPartyBalance')) $('invQuickPartyBalance').value = '0'; }
  else { $('invQuickPartyName').value = ''; if ($('invQuickPartyPhone')) $('invQuickPartyPhone').value = ''; }
}
function saveQuickParty() {
  const buying = $('invMode').value.startsWith('purchase');
  if (!ensurePermission(buying ? 'supplier' : 'customer')) return;
  const name = $('invQuickPartyName').value.trim();
  const phone = $('invQuickPartyPhone').value.trim();
  const balance = roundMoney(Number($('invQuickPartyBalance')?.value) || 0);
  if (name.length < 2) return alert('أدخل اسم العميل (حرفان على الأقل).');
  const existing = db.parties.find(party => party.type === (buying ? 'supplier' : 'customer') && party.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  if (existing) {
    toggleQuickParty(false);
    $('invPartySelect').value = String(existing.id);
    return notify(`الاسم موجود بالفعل — تم اختيار «${existing.name}».`);
  }
  let created = null;
  const saved = commitDB(draft => {
    created = { id: nextId(draft.parties), type: buying ? 'supplier' : 'customer', name, phone, balance: Number.isFinite(balance) ? balance : 0, notes: 'أُضيف من شاشة البيع' };
    draft.parties.push(created);
  });
  if (!saved) return;
  toggleQuickParty(false);
  updateInvoiceUI();
  $('invPartySelect').value = String(created.id);
  recordAudit(`إضافة ${buying ? 'مورد' : 'عميل'} سريع من شاشة البيع: ${name}`);
  renderPartiesTable();
  notify(`تمت إضافة «${name}» واختياره في الفاتورة.`);
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

/* ---------------- invoice log ---------------- */
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
  $('invLogTbody').innerHTML = list.map(i => `<tr><td>#${i.id}</td><td>${esc(i.date)}</td><td>${esc(MODE_LABELS[i.mode])}</td><td>${esc(i.partyName)}</td><td>${money(i.netTotal)}</td><td>${money(i.paidAmount)}</td><td>${money(i.remainAmount)}</td>
    <td class="no-print"><button type="button" class="act-btn bg-teal" onclick="previewSavedInvoice(${i.id}, event)">معاينة</button> <button type="button" class="act-btn bg-teal" onclick="printInvoiceById(${i.id})">طباعة A5</button> <button type="button" class="act-btn bg-blue" onclick="printInvoiceThermalById(${i.id})">حرارية</button> <button type="button" class="act-btn bg-purple" onclick="exportInvoicePdfById(${i.id})">PDF</button> <button type="button" class="act-btn bg-green" onclick="shareInvoiceOnWhatsApp(${i.id})">واتساب</button>${i.mode === 'quote' && !i.convertedToId ? ` <button type="button" class="act-btn bg-green" onclick="loadQuoteForSale(${i.id})">تحويل للبيع</button>` : ''}${i.convertedToId ? ` <small>محوّلة إلى #${i.convertedToId}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">لا توجد فواتير في هذه الفترة.</td></tr>';
  const th = document.querySelector('#sec-invlog th:last-child'); if (th) th.classList.add('no-print');
  if ($('headInvLogCount')) $('headInvLogCount').textContent = String(list.length);
}

/* ---------------- treasury & profits ---------------- */
function openTreasury(filter) {
  if (!ensurePermission('cash') || (filter === 'expense' && !ensurePermission('admin'))) return;
  openSec('sec-treasury', '💰 إدارة الخزينة'); if (filter !== 'all') $('trType').value = filter;
  if ($('kpiCashSide')) $('kpiCashSide').textContent = money(treasuryBalance());
  renderTreasury();
}
function addTreasuryMove() {
  const type = $('trType').value;
  if (type === 'expense' ? !ensurePermission('admin') : !ensurePermission('cash')) return;
  const amount = roundMoney(num('trAmount')), note = $('trNote').value.trim();
  if (!['in', 'out', 'expense'].includes(type) || !Number.isFinite(amount) || amount <= 0 || !note) return alert('أدخل مبلغاً موجباً وبيان الحركة.');
  if (commitDB(draft => { draft.treasury.push({ id: nextId(draft.treasury), date: localDate(), type, amount: roundMoney(amount), note }); })) {
    $('trAmount').value = 0; $('trNote').value = ''; renderTreasury();
    if ($('kpiCashSide')) $('kpiCashSide').textContent = money(treasuryBalance());
  }
}
function renderTreasury() {
  $('treasuryTbody').innerHTML = db.treasury.slice().reverse().map(t => `<tr><td>${esc(t.date)}</td><td>${t.type === 'in' ? 'وارد خزنة' : t.type === 'expense' ? 'مصروفات' : 'منصرف خزنة'}</td><td class="cell-name">${esc(t.note)}</td><td style="color:#20591f;font-weight:bold">${t.type === 'in' ? money(t.amount) : '-'}</td><td style="color:var(--danger);font-weight:bold">${t.type !== 'in' ? money(t.amount) : '-'}</td></tr>`).join('') || '<tr><td colspan="5" class="empty-row">لا توجد حركات خزنة.</td></tr>';
  if ($('kpiCashSide')) $('kpiCashSide').textContent = money(treasuryBalance());
  if ($('headTreasuryBalance')) $('headTreasuryBalance').textContent = money(treasuryBalance());
}
function openProfitSec(mode = 'general') {
  if (!ensurePermission('admin')) return;
  const selected = $('profItemFilter').value;
  const items = new Map(db.items.map(i => [String(i.id), i.name]));
  db.invoices.filter(i => ['sale', 'sale_return'].includes(i.mode)).flatMap(i => i.items).forEach(i => { if (!items.has(String(i.id))) items.set(String(i.id), `${i.name} (محذوف من المخزن)`); });
  $('profItemFilter').innerHTML = '<option value="all">كل الأصناف</option>' + [...items].map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  if ([...items.keys()].includes(selected)) $('profItemFilter').value = selected;
  if (mode === 'item') { const itemId = $('itemEditId').value; if (itemId && items.has(itemId)) $('profItemFilter').value = itemId; }
  openSec('sec-profits', mode === 'item' ? '📈 أرباح صنف محدد' : mode === 'period' ? '📈 أرباح فترة محددة' : '📈 التقرير العام وصافي الأرباح');
  if (mode === 'item') $('profItemFilter').focus(); if (mode === 'period') $('profDateFrom').focus();
  renderProfits();
}
function renderProfits() {
  try {
    const filter = $('profItemFilter').value, result = calculateTotalProfits($('profDateFrom').value, $('profDateTo').value, filter);
    for (const [id, value] of Object.entries({ profTotSales: result.sales, profTotCost: result.cost, profGross: result.gross, profExpenses: result.expenses, profNet: result.net })) $(id).textContent = money(value);
    if ($('headNetProfit')) $('headNetProfit').textContent = money(result.net);
    $('profitScopeNote').textContent = filter !== 'all' ? 'ربح الصنف بعد الخصومات والمرتجعات. المصروفات العامة لا تُخصم من صنف منفرد؛ تظهر في تقرير كل الأصناف.' : 'الأرباح بعد خصومات الفواتير ومرتجع المبيعات وتكلفة البيع التاريخية، وخصم المصروفات العامة للفترة.';
    $('profitsTbody').innerHTML = result.itemRows.map(r => `<tr><td>${esc(r.code)}</td><td class="cell-name">${esc(r.name)}</td><td>${esc(roundQuantity(r.qty))}</td><td>${money(r.rev)}</td><td>${money(r.cst)}</td><td style="font-weight:bold;color:${r.rev - r.cst >= 0 ? '#20591f' : 'var(--danger)'}">${money(r.rev - r.cst)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-row">لا توجد مبيعات مطابقة للفترة المحددة.</td></tr>';
  } catch (error) {
    $('profitScopeNote').textContent = error.message; $('profitsTbody').innerHTML = '';
    for (const id of ['profTotSales', 'profTotCost', 'profGross', 'profExpenses', 'profNet']) $(id).textContent = '—';
  }
}
/* ---------------- settings, sync, backup ---------------- */
function applySettingsUI() {
  $('lblStoreName').textContent = db.settings.name;
  $('lblStorePhone').textContent = db.settings.phone || '';
  $('lblStoreAddress').textContent = db.settings.address || '';
  $('lblStoreAddress').hidden = !db.settings.address;
  document.title = `${db.settings.name} | نقاط البيع`;
}
function loadSettingsForm() {
  $('setStoreName').value = db.settings.name; $('setStoreAddress').value = db.settings.address; $('setStorePhone').value = db.settings.phone;
  $('setPinCode').value = ''; $('setSyncKey').value = sessionToken();
  $('rememberSyncKey').checked = Boolean(localStorage.getItem(REMEMBERED_TOKEN_KEY)) || !sessionToken();
  $('receiptWidth').value = getAppearance().receiptWidth === '58' ? '58' : '80';
  if ($('autoLockSelect')) $('autoLockSelect').value = String(autoLockMinutes());
  if ($('rememberDeviceSettings')) $('rememberDeviceSettings').checked = isTrustedDevice();
  applyScanFeedbackUI();
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
  if (!token) {
    if (!automatic) {
      openSec('sec-settings', '⚙️ إعدادات المزامنة');
      showSyncDialog({ title: 'مفتاح المزامنة مطلوب', icon: '🔑', body: 'أدخل مفتاح المزامنة في الإعدادات أولاً.', note: 'بياناتك المحلية لم تتغير.', ok: 'فتح الإعدادات', tone: 'neutral' });
    }
    return false;
  }
  if (storageBlocked) { if (!automatic) alert('أصلح التخزين المحلي قبل المزامنة.'); return false; }
  if (automatic && (!syncMeta.dirty || syncMeta.revision === null || syncBusy)) return false;
  const previousStatus = $('syncStatusBadge').textContent;
  syncBusy = true; setSyncStatus('جاري المزامنة…');
  const startVersion = localVersion;
  try {
    if (direction === 'pull') {
      if (!automatic && !(await appConfirm('السحب سيستبدل البيانات المحلية والفاتورة غير المحفوظة. صدّر نسخة احتياطية إذا أردت الاحتفاظ بها. هل تريد المتابعة؟', { title: 'سحب البيانات من السحابة', icon: '⬇️', confirmText: 'سحب واستبدال' }))) { setSyncStatus(previousStatus); return false; }
      const remote = await apiRequest('GET', null, token);
      if (!Number.isSafeInteger(remote.revision) || remote.revision < 0) throw new Error('إصدار خادم المزامنة قديم. انشر api/sync.js المحدث مع الواجهة أولاً.');
      if (localVersion !== startVersion) { setSyncStatus(previousStatus); alert('تغيرت البيانات المحلية أثناء السحب؛ لم نستبدلها. أعد المحاولة بعد انتهاء الحفظ.'); return false; }
      if (remote.empty) { setSyncStatus(previousStatus); alert('قاعدة البيانات فارغة. ارفع بياناتك أولاً.'); return false; }
      const next = normalizeDatabase(remote.payload);
      writeLocalState(next, { revision: remote.revision, dirty: false });
      db = next; localVersion += 1; syncMeta = { revision: remote.revision, dirty: false }; refreshAfterReplace();
      setSyncStatus('متزامن مع Neon ✅');
      if (!automatic) showSyncDialog({ title: 'تم السحب بنجاح', icon: '✅', body: 'تم سحب البيانات من السحابة والتحقق منها، واستُبدلت البيانات المحلية.', ok: 'تم' });
    } else {
      let baseRevision = syncMeta.revision;
      if (baseRevision === null) {
        const remote = await apiRequest('GET', null, token);
        if (!Number.isSafeInteger(remote.revision) || remote.revision < 0) throw new Error('إصدار خادم المزامنة قديم. انشر api/sync.js المحدث مع الواجهة قبل الرفع.');
        if (!remote.empty) {
          if (automatic || !(await appConfirm('توجد بيانات سحابية لم تُربط بهذه النسخة المحلية. الأفضل سحبها أولاً. يمكنك بدلاً من ذلك استبدالها بعد تأمين نسخة احتياطية. هل تريد استبدال النسخة السحابية؟', { title: 'تعارض النسخ السحابية', icon: '⚠️', confirmText: 'استبدال النسخة السحابية' }))) {
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
      if (dirty) scheduleAutoSync();
      else if (!automatic) showSyncDialog({ title: 'تم الرفع بنجاح', icon: '✅', body: `تم رفع بيانات المكتبة إلى السحابة.<span class="page-modal-note">إصدار المزامنة الحالي: ${esc(String(result.revision))}</span>`, ok: 'تم' });
    }
    return true;
  } catch (error) {
    const message = error.name === 'AbortError' ? 'انتهت مهلة الاتصال. البيانات المحلية محفوظة.' : error.status === 409 ? 'يوجد تعديل أحدث على جهاز آخر. صدّر نسخة محلية ثم اسحب النسخة السحابية قبل إعادة الرفع.' : error.message;
    setSyncStatus(error.status === 409 ? 'تعارض نسخ — لم تُستبدل البيانات' : 'محفوظ محلياً — المزامنة غير متاحة');
    if (!automatic) {
      showSyncDialog({ title: 'المزامنة لم تكتمل', icon: '⚠️', body: esc(message), note: 'بياناتك المحلية لم تتغير.', ok: 'حسناً', tone: 'cancel' });
      alert(message);
    }
    else notify(`المزامنة لم تكتمل: ${message}`);
    return false;
  } finally { syncBusy = false; }
}
function refreshAfterReplace() {
  invCart = []; quickEditMode = false; selectedCartIndex = -1; delete $('invCartTbody').dataset.quoteId;
  resetItemForm(); resetPartyForm(); clearInvCart(); applySettingsUI(); updateDashboardKPIs(); populateCategoriesSelect(); renderItemsTable(); updateInvoiceUI(); renderLabels();
  const active = document.querySelector('.sec-view.active')?.id;
  if (active === 'sec-stock') openStockFilter('all');
  if (active === 'sec-categories') renderCategoriesTable(); if (active === 'sec-parties') renderPartiesTable();
  if (active === 'sec-invlog') renderInvLog(); if (active === 'sec-treasury') renderTreasury(); if (active === 'sec-profits') renderProfits(); if (active === 'sec-settings') loadSettingsForm();
}
function download(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type })), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportFullBackup() { if (!ensurePermission('admin')) return; download(JSON.stringify(db, null, 2), 'application/json', `POS_Backup_${localDate()}.json`); recordAudit('تصدير نسخة احتياطية'); }
function exportRecovery() { if (recoveryRaw !== null) download(recoveryRaw, 'application/json', `POS_Recovery_${localDate()}.json`); }
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
  download('\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8;', 'POS_Items.csv');
}

/* ---------------- printing ---------------- */
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
  triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><p>${esc(db.settings.address)} | هاتف: ${esc(db.settings.phone)}</p><h3>تقرير جرد وأسعار الأصناف (A5)</h3></div><table class="p-table"><thead><tr><th>الكود</th><th>الصنف</th><th>الكمية</th><th>شراء</th><th>بيع</th></tr></thead><tbody>${rows}</tbody></table>`);
}
function printCurrentScreenA5() {
  const active = document.querySelector('.sec-view.active'), table = active?.querySelector('table');
  if (!table) return alert('لا يوجد تقرير جدولي في هذه الشاشة. افتح الأصناف أو المخزن أو الفواتير أو التقارير للطباعة.');
  const summary = active.querySelector('.t-foot-bar')?.textContent || '';
  triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><p>${esc(db.settings.address)} | هاتف: ${esc(db.settings.phone)}</p><h3>${esc($('winTitle').textContent)}</h3></div>${printableTable(table)}<p>${esc(summary)}</p>`);
}

/* ---------------- login ---------------- */
function renderStartStats() {
  if (!$('startStats')) return;
  const today = localDate();
  const low = db.items.filter(item => item.qty <= item.minQty).length;
  const invoicesToday = db.invoices.filter(inv => inv.date === today && inv.mode === 'sale').length;
  if ($('startStatItems')) $('startStatItems').textContent = String(db.items.length);
  if ($('startStatLow')) $('startStatLow').textContent = String(low);
  if ($('startStatToday')) $('startStatToday').textContent = String(invoicesToday);
}
function lockApp() {
  closeWorkspace(); closeKeypad(); closeWelcomePopup();
  window.clearTimeout(autoLockTimer);
  renderStartStats();
  beforeLockFocus = document.activeElement;
  $('loginStaffSelect').innerHTML = staffList().map(user => `<option value="${esc(user.id)}">${esc(loginName(user))} — ${roleLabel(user.role)}</option>`).join('');
  $('loginStaffSelect').value = activeStaffId;
  if ($('startStoreName')) $('startStoreName').textContent = db?.settings?.name || 'مكتبة الجمال';
  if ($('startLogin')) $('startLogin').hidden = true;
  if ($('startLoader')) { $('startLoader').hidden = false; if ($('startLoadFill')) $('startLoadFill').style.width = '0%'; if ($('startLoadPct')) $('startLoadPct').textContent = '0%'; }
  $('unlockPinInp').value = '';
  $('lockModal').style.display = 'flex';
  startScreenProgress(finishStartScreen);
  document.querySelectorAll('body > :not(#lockModal):not(#printAreaA5):not(script)').forEach(el => { el.inert = true; });
}
function unlockApp() {
  const user = staffList().find(entry => entry.id === $('loginStaffSelect').value);
  if (!user || $('unlockPinInp').value !== user.pin) return alert('الرقم السري غير صحيح.');
  activeStaffId = user.id; staffSession = true;
  try { sessionStorage.setItem(ACTIVE_STAFF_KEY, activeStaffId); } catch { notify('تعذر حفظ جلسة المستخدم؛ سيطلب النظام تسجيل الدخول مرة أخرى عند تحديث الصفحة.'); }
  $('lockModal').style.display = 'none'; $('unlockPinInp').value = '';
  document.querySelectorAll('[inert]').forEach(el => { el.inert = false; });
  updateActiveUserBadge(); renderStaffTable(); recordAudit(`تسجيل دخول (${roleLabel(user.role)})`);
  try { localStorage.setItem(LAST_STAFF_KEY, activeStaffId); } catch { /* private mode */ }
  armAutoLock();
  showWelcomePopup(loginName(user));
  beforeLockFocus?.focus();
}

// Explicit public API for the HTML buttons; implementation details remain module-scoped.
Object.assign(window, {
  openSec, closeWorkspace, minimizeWorkspace, restoreWorkspace, maximizeWorkspace, selectTheme, setCustomAccent, resetAccent, setReceiptWidth,
  toggleSidebar, showHome, toggleDarkMode, toggleClassicGrid, quickAddCategory, generateNewCode, calcPriceFromProfit, calcProfitFromPrice,
  saveItem, resetItemForm, saveStaff, deleteStaff, renderItemsTable, inlineUpdateItem, toggleQuickEditItems, editItem, deleteItem,
  showSingleItemProfit, printBarcodeLabel, addCategory, deleteCategory, openStockFilter, openInvoiceSec, changeInvoiceMode, updateInvoiceUI,
  loadReturnSource, addInvItemFromInput, setQuickPaid, renderDiscountLimit, discountLimitFor,
  toggleActivityLog, refreshActivityLog, renderActivityLog, openActivityPage, activityIcon,
  saveDraftNow, restoreSavedDraft, discardSavedDraft, readDraft, paintDraftHint, startDraftAutosave, offerDraftRestore,
  handleScanKey, showSuggestions, hideSuggestions, moveSuggestion, pickSuggestion, suggestionMatches,
  playScanFeedback, setScanFeedback, setScanVibrate, applyScanFeedbackUI,
  openCameraScanner, closeCameraScanner, handleCameraCode, cameraSupported,
  toggleStockAlerts, renderStockAlerts, openStockAlertsPage, quickPurchaseForItem, openPurchaseOrderFromLowStock, lowStockItems,
  syncAppBadge, paintBadgeHints,
  previewInvoiceA5, previewSavedInvoice, closeInvoicePreview, printPreviewA5, setPreviewZoom, previewInvoiceDraft,
  invoiceDocHtml, invoiceDocBody, openInvoiceDocument, exportInvoicePdfById, invoiceShareText, whatsappLink, shareInvoiceOnWhatsApp, updateCartPricesByTier, updateCartRow, removeCartRow, calcInvoiceTotals, calcInvoiceRemaining, clearInvCart,
  holdCurrentInvoice, restoreHeldInvoice, convertQuoteToSale, loadQuoteForSale, saveInvoice, printInvoiceById, printInvoiceThermalById,
  openPartySec, openPartyReport, resetPartyForm, saveParty, editParty, deleteParty, savePartyVoucher, toggleQuickParty, saveQuickParty, showStatementFor, renderPartyStatement,
  printPartyStatementA5, openInvLog, renderInvLog, openTreasury, addTreasuryMove, openProfitSec, renderProfits, saveSettings, syncToCloud,
  exportFullBackup, importFullBackup, exportItemsCSV, printItemsReportA5, printCurrentScreenA5, lockApp, unlockApp,
  switchInvoiceTab, switchItemsTab, selectPosGroup, addPosTile, bumpInvoiceQty, selectCartRow, focusCartField, openKeypad, setKeypadTab, closeKeypad, keypadPress, applyKeypad,
  renderPosTiles, renderLabels, printLabels,
  toggleDashboard, setDashboardOpen, toggleActionGroup, setActionGroup, expandAllGroups, collapseAllGroups,
  installApp, setupInstallPrompt, applyDesign, resetDesign, setDesignField, applyThemePreset, uploadHeaderImage, uploadBackgroundImage, clearHeaderImage, clearBackgroundImage,
  uploadStartBackground, clearStartBackground, setStartBackgroundOpacity,
  showWelcomePopup, closeWelcomePopup, showNoticePopup, closeNoticePopup, askDialog,
  toggleRememberDevice, togglePinVisibility, setAutoLockMinutes, armAutoLock, isTrustedDevice, renderStartStats, showSyncDialog, closeSyncDialog, startScreenProgress, finishStartScreen
});
export { initializeApp };
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initializeApp, { once: true });
else initializeApp();
