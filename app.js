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
const THEMES = ['vista-classic', 'vista-blue', 'vista-emerald', 'vista-rose', 'win11-indigo', 'win11-mint', 'win11-sunset', 'ref-light-blue', 'ref-light-purple', 'ref-light-maroon', 'ref-dark-gray', 'ref-dark-purple', 'night', 'custom'];
const ACCENT_DEFAULTS = { 'vista-classic': '#3b7323', 'vista-blue': '#1f74a8', 'vista-emerald': '#1f8a5c', 'vista-rose': '#b04a76', 'win11-indigo': '#5b5bd6', 'win11-mint': '#12857a', 'win11-sunset': '#c8603f', 'ref-light-blue': '#1e6fb8', 'ref-light-purple': '#6a5acd', 'ref-light-maroon': '#8b1e1e', 'ref-dark-gray': '#4a9eff', 'ref-dark-purple': '#a855f7', night: '#8fb4ff' };
const THEME_LABELS = { 'vista-classic': 'كلاسيكي أخضر', 'vista-blue': 'Vista أزرق', 'vista-emerald': 'Vista أخضر طبيعي', 'vista-rose': 'Vista وردي', 'win11-indigo': 'Windows 11 نيلي', 'win11-mint': 'Windows 11 نعناعي', 'win11-sunset': 'Windows 11 غروب', 'ref-light-blue': 'مرجعي أزرق فاتح', 'ref-light-purple': 'مرجعي بنفسجي فاتح', 'ref-light-maroon': 'مرجعي عنابي', 'ref-dark-gray': 'مرجعي رمادي داكن', 'ref-dark-purple': 'مرجعي بنفسجي داكن', night: 'الوضع الليلي', custom: 'تخصيص كامل' };

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
  paintStaffAvatar();
  if ($('titleBarUser')) $('titleBarUser').textContent = `${activeStaff().name} · ${roleLabel(activeStaff().role)}`;
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
      <span class="a-body"><span class="a-text">${esc(entry.action)}</span><span class="a-meta">${avatarMarkup(entry.user, 'sm')} ${esc(entry.time)} · ${esc(entry.user)} (${roleLabel(entry.role)})</span></span>
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
  $('auditTbody')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
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
  body.innerHTML = safeReadArray(AUDIT_KEY).slice(0, 50).map(entry => `<tr><td>${esc(entry.time)}</td><td><span class="avatar-chip">${avatarMarkup(entry.user, 'sm')}${esc(entry.user)} (${roleLabel(entry.role)})</span></td><td>${esc(entry.action)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-row">لا توجد حركات مسجلة بعد.</td></tr>';
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
  updateSyncStateBox();
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
function commitDB(change, { flash = '' } = {}) {
  const candidate = clone(db);
  try {
    change(candidate);
    const saved = persistDB(candidate);
    if (saved && flash) flashSaveSuccess(flash);
    return saved;
  }
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
  if ($('statusDate')) $('statusDate').textContent = date;
  if ($('statusTime')) $('statusTime').textContent = time;
  if ($('statusStore')) $('statusStore').textContent = storeSetting('defaultWarehouse', 'الرئيسي');
  if ($('titleBarClock')) $('titleBarClock').textContent = `${date} ${now.toTimeString().slice(0, 5)}`;
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
    document.querySelectorAll('#startSteps i').forEach((dot, index) => dot.classList.toggle('done', value >= (index + 1) * 25 - 12));
    if (value >= 100) {
      document.querySelectorAll('#startSteps i').forEach(dot => dot.classList.add('done'));
      window.clearInterval(startScreenTimer); window.setTimeout(done, 180);
    }
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
  applyAppearance(); applyLook(); applyDesign(); applySidebarPreference(); decorateActionButtons(); paintIconMode();
  loadDB(); updateClock(); populateCategoriesSelect(); renderItemsTable(); generateNewCode();
  updateInvoiceUI(); updateActiveUserBadge(); renderHeldCount(); renderSystemAlerts();
  renderLabels(); loadLabelOptions();
  restoreGroups();
  setDashboardOpen(Boolean(getAppearance().boardOpen), { persist: false });
  setupInstallPrompt();
  window.clearInterval(clockTimer);
  clockTimer = window.setInterval(updateClock, 1000);
  window.addEventListener('online', scheduleAutoSync);
  $('sideNav')?.addEventListener('click', event => {
    const link = event.target.closest('.nav-link'); if (!link) return;
    document.querySelectorAll('.nav-link').forEach(item => item.classList.toggle('selected', item === link));
    if (window.innerWidth <= 760) toggleSidebar(false);
  });
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.addEventListener('mouseenter', () => previewTheme(button.dataset.themeChoice));
    button.addEventListener('mouseleave', restoreThemePreview);
    button.addEventListener('focus', () => previewTheme(button.dataset.themeChoice));
    button.addEventListener('blur', restoreThemePreview);
  });
  $('windowLayer').addEventListener('click', event => { if (event.target === $('windowLayer')) closeWorkspace(); });
  $('floatWindows').addEventListener('click', event => { if (event.target === $('floatWindows')) closeWorkspace(); });
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
  applyInvoiceTones(); applyDocSettingsUI();
  document.body.classList.add('shell-v2');
  paintNavbar(); renderDashboard(); renderTabs(); paintTitleChrome(); shellSecondaryNav();
  paintCalcScreen(); syncInvoiceChrome(); renderHr();
  ['wallet', 'cart', 'chart', 'alert'].forEach((name, index) => {
    const slot = document.querySelectorAll('#dashKpis .dk-ico')[index];
    if (slot) slot.innerHTML = lookIcon(name);
  });
  window.addEventListener('resize', closeMenus, { passive: true });
  document.addEventListener('click', event => {
    if (!$('navMenuLayer') || $('navMenuLayer').hidden) return;
    if (!event.target.closest('.app-navbar') && !event.target.closest('.nav-menu')) closeMenus();
  }, true);
  applyAutoNight(); applyLook(); updateDashboardKPIs();
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
  if (event.altKey && !event.ctrlKey && /^[1-9]$/.test(event.key)) {
    const menu = SHELL_MENUS[Number(event.key) - 1];
    const button = document.querySelector(`.app-navbar .nv-btn[data-menu="${menu?.key}"]`);
    if (menu && button) { event.preventDefault(); toggleNavMenu(menu.key, button); }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w' && document.body.classList.contains('shell-v2')) {
    if (activeTab && activeTab !== 'home') { event.preventDefault(); closeTab(activeTab); }
    return;
  }
  if (event.key === 'Escape' && openMenuKey) { event.preventDefault(); closeMenus(); return; }
  if (event.key === 'Escape' && document.body.dataset.focus === 'on') { exitFocusMode(); return; }
  if (event.key === 'F9' && event.shiftKey && !typing) { event.preventDefault(); toggleFocusMode(); return; }
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
  if (openMenuKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    const items = [...document.querySelectorAll('.nav-menu .nm-item')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next].focus();
    return;
  }
  if (openMenuKey && event.key === 'Enter' && document.activeElement?.classList?.contains('nm-item')) {
    event.preventDefault();
    document.activeElement.dataset.page ? (closeMenus(), openPage(document.activeElement.dataset.page)) : document.activeElement.click();
    return;
  }
}

/* ------------------------------------------------------------------ */
/* Shell: screens, window, navigation, appearance                      */
/* ------------------------------------------------------------------ */
/* ===================== SHELL V2: navbar menus, dropdowns, page tabs, dashboard cards ===================== */
const SHELL_MENUS = [
  { key: 'home', label: 'الرئيسية', icon: 'home', items: [
    { label: 'لوحة المتابعة', page: 'home', icon: 'grid' },
    { label: 'تنبيهات النظام', page: 'home', icon: 'alert' }
  ] },
  { key: 'sales', label: 'المبيعات', icon: 'cart', items: [
    { label: 'فاتورة مبيعات', page: 'sale', icon: 'cart', kbd: 'F2' },
    { label: 'مرتجع مبيعات', page: 'sale_return', icon: 'swap' },
    { label: 'عرض أسعار', page: 'quote', icon: 'doc' },
    { label: 'سجل الفواتير', page: 'log-sale', icon: 'receipt', kbd: 'F11' },
    { label: 'مبيعات فترة', page: 'log-sale-period', icon: 'chart' }
  ] },
  { key: 'purchases', label: 'المشتريات', icon: 'truck', items: [
    { label: 'فاتورة مشتريات', page: 'purchase', icon: 'truck' },
    { label: 'مرتجع مشتريات', page: 'purchase_return', icon: 'swap' },
    { label: 'فواتير المشتريات', page: 'log-purchase', icon: 'receipt' }
  ] },
  { key: 'stock', label: 'المخازن', icon: 'box', items: [
    { label: 'بيانات الأصناف', page: 'items', icon: 'box' },
    { label: 'المجموعات', page: 'categories', icon: 'folder' },
    { label: 'كشف النواقص', page: 'stock-zero', icon: 'alert' },
    { label: 'حد الطلب', page: 'stock-low', icon: 'alert' },
    { label: 'جرد المخزن', page: 'stock-all', icon: 'grid' },
    { label: 'ملصقات الباركود', page: 'labels', icon: 'tag' }
  ] },
  { key: 'people', label: 'العملاء', icon: 'users', items: [
    { label: 'إدارة العملاء', page: 'customers', icon: 'users' },
    { label: 'أرصدة العملاء', page: 'customers-balances', icon: 'chart' },
    { label: 'كشف حساب عميل', page: 'customers-statement', icon: 'receipt' }
  ] },
  { key: 'suppliers', label: 'الموردون', icon: 'truck', items: [
    { label: 'إدارة الموردين', page: 'suppliers', icon: 'truck' },
    { label: 'أرصدة الموردين', page: 'suppliers-balances', icon: 'chart' },
    { label: 'كشف حساب مورد', page: 'suppliers-statement', icon: 'receipt' }
  ] },
  { key: 'staff', label: 'الموظفون', icon: 'user', items: [
    { label: 'إدارة الموظفين', page: 'employees', icon: 'user' },
    { label: 'الحضور والانصراف', page: 'employees-attendance', icon: 'bell' },
    { label: 'المرتبات والخصومات', page: 'employees-payroll', icon: 'money' },
    { label: 'الإجازات والجزاءات', page: 'employees-vacations', icon: 'doc' }
  ] },
  { key: 'money', label: 'الخزينة', icon: 'wallet', items: [
    { label: 'الخزينة', page: 'treasury-all', icon: 'wallet', kbd: 'F1' },
    { label: 'وارد الخزينة', page: 'treasury-in', icon: 'plus' },
    { label: 'منصرف الخزينة', page: 'treasury-out', icon: 'download' },
    { label: 'المصروفات', page: 'treasury-expense', icon: 'money' }
  ] },
  { key: 'reports', label: 'التقارير', icon: 'chart', items: [
    { label: 'التقرير العام وصافي الأرباح', page: 'profits-general', icon: 'chart' },
    { label: 'أرباح صنف', page: 'profits-item', icon: 'chart' },
    { label: 'أرباح فترة', page: 'profits-period', icon: 'chart' },
    { label: 'سجل النشاط', page: 'activity', icon: 'bell' }
  ] },
  { key: 'file', label: 'ملف', icon: 'doc', items: [
    { label: 'إعدادات النظام', page: 'settings', icon: 'settings' },
    { label: 'تغيير المستخدم', page: 'lock', icon: 'lock' },
    { label: 'إغلاق كل الشاشات', page: 'close-all', icon: 'trash' }
  ] }
];
const PAGE_DEFS = {
  home: { title: 'لوحة المتابعة', home: true, section: '' },
  sale: { section: 'sec-invoice', title: 'فاتورة مبيعات', run: () => openInvoiceSec('sale') },
  purchase: { section: 'sec-invoice', title: 'فاتورة مشتريات', run: () => openInvoiceSec('purchase') },
  sale_return: { section: 'sec-invoice', title: 'مرتجع مبيعات', run: () => openInvoiceSec('sale_return') },
  purchase_return: { section: 'sec-invoice', title: 'مرتجع مشتريات', run: () => openInvoiceSec('purchase_return') },
  quote: { section: 'sec-invoice', title: 'عرض أسعار', run: () => openInvoiceSec('quote') },
  'log-sale': { section: 'sec-invlog', title: 'سجل فواتير المبيعات', run: () => openInvLog('sale') },
  'log-purchase': { section: 'sec-invlog', title: 'سجل فواتير المشتريات', run: () => openInvLog('purchase') },
  'log-sale-period': { section: 'sec-invlog', title: 'مبيعات فترة', run: () => openInvLog('sale', true) },
  items: { section: 'sec-items', title: 'بيانات الأصناف', run: () => openSec('sec-items', '📦 بيانات الأصناف والمخزون') },
  categories: { section: 'sec-categories', title: 'المجموعات', run: () => openSec('sec-categories', '📁 بيانات المجموعات') },
  labels: { section: 'sec-labels', title: 'ملصقات الباركود', run: () => openSec('sec-labels', '🏷️ طباعة ملصقات الباركود') },
  'stock-zero': { section: 'sec-stock', title: 'كشف النواقص', run: () => openStockFilter('zero') },
  'stock-low': { section: 'sec-stock', title: 'حد الطلب', run: () => openStockFilter('low') },
  'stock-all': { section: 'sec-stock', title: 'جرد المخزن', run: () => openStockFilter('all') },
  customers: { section: 'sec-parties', title: 'إدارة العملاء', run: () => openPartySec('customer') },
  suppliers: { section: 'sec-parties', title: 'إدارة الموردين', run: () => openPartySec('supplier') },
  employees: { section: 'sec-hr', title: 'إدارة الموظفين', run: () => openHrPage('employees') },
  'employees-attendance': { section: 'sec-hr', title: 'الحضور والانصراف', run: () => openHrPage('attendance') },
  'employees-payroll': { section: 'sec-hr', title: 'المرتبات', run: () => openHrPage('payroll') },
  'employees-vacations': { section: 'sec-hr', title: 'الإجازات', run: () => openHrPage('vacations') },
  'customers-balances': { section: 'sec-parties', title: 'أرصدة العملاء', run: () => openPartyReport('customer', 'balances') },
  'suppliers-balances': { section: 'sec-parties', title: 'أرصدة الموردين', run: () => openPartyReport('supplier', 'balances') },
  'customers-statement': { section: 'sec-parties', title: 'كشف حساب عميل', run: () => openPartyReport('customer', 'statement') },
  'suppliers-statement': { section: 'sec-parties', title: 'كشف حساب مورد', run: () => openPartyReport('supplier', 'statement') },
  'treasury-all': { section: 'sec-treasury', title: 'الخزينة', run: () => openTreasury('all') },
  'treasury-in': { section: 'sec-treasury', title: 'وارد الخزينة', run: () => openTreasury('in') },
  'treasury-out': { section: 'sec-treasury', title: 'منصرف الخزينة', run: () => openTreasury('out') },
  'treasury-expense': { section: 'sec-treasury', title: 'المصروفات', run: () => openTreasury('expense') },
  'profits-general': { section: 'sec-profits', title: 'التقرير العام والأرباح', run: () => openProfitSec('general') },
  'profits-item': { section: 'sec-profits', title: 'أرباح صنف', run: () => openProfitSec('item') },
  'profits-period': { section: 'sec-profits', title: 'أرباح فترة', run: () => openProfitSec('period') },
  settings: { section: 'sec-settings', title: 'إعدادات النظام', run: () => openSec('sec-settings', '⚙️ إعدادات النظام') },
  activity: { section: 'sec-settings', title: 'سجل النشاط', run: () => openActivityPage() },
  lock: { title: 'قفل الشاشة', action: () => lockApp() },
  'close-all': { title: 'إغلاق الكل', action: () => closeAllTabs() }
};
const DASH_GROUPS = [
  { key: 'cash', title: 'النقدية والخزنة', tint: 'cash', icon: 'wallet', items: [
    { label: 'الخزينة', page: 'treasury-all', icon: 'wallet' },
    { label: 'وارد', page: 'treasury-in', icon: 'plus' },
    { label: 'منصرف', page: 'treasury-out', icon: 'download' },
    { label: 'المصروفات', page: 'treasury-expense', icon: 'money' }
  ] },
  { key: 'invoice', title: 'الفواتير', tint: 'invoice', icon: 'cart', items: [
    { label: 'فاتورة مبيعات', page: 'sale', icon: 'cart' },
    { label: 'فاتورة مشتريات', page: 'purchase', icon: 'truck' },
    { label: 'مرتجع مبيعات', page: 'sale_return', icon: 'swap' },
    { label: 'عرض أسعار', page: 'quote', icon: 'doc' }
  ] },
  { key: 'people', title: 'العملاء والموردون', tint: 'people', icon: 'users', items: [
    { label: 'العملاء', page: 'customers', icon: 'users' },
    { label: 'الموردون', page: 'suppliers', icon: 'truck' },
    { label: 'أرصدة العملاء', page: 'customers-balances', icon: 'chart' },
    { label: 'أرصدة الموردين', page: 'suppliers-balances', icon: 'chart' }
  ] },
  { key: 'stock', title: 'المخزون والأصناف', tint: 'stock', icon: 'box', items: [
    { label: 'الأصناف', page: 'items', icon: 'box' },
    { label: 'المجموعات', page: 'categories', icon: 'folder' },
    { label: 'النواقص', page: 'stock-zero', icon: 'alert' },
    { label: 'الملصقات', page: 'labels', icon: 'tag' }
  ] },
  { key: 'reports', title: 'التقارير', tint: 'reports', icon: 'chart', items: [
    { label: 'الأرباح', page: 'profits-general', icon: 'chart' },
    { label: 'أرباح صنف', page: 'profits-item', icon: 'chart' },
    { label: 'سجل الفواتير', page: 'log-sale', icon: 'receipt' },
    { label: 'جرد المخزن', page: 'stock-all', icon: 'grid' }
  ] },
  { key: 'staff', title: 'الموظفون', tint: 'staff', icon: 'user', items: [
    { label: 'إدارة الموظفين', page: 'employees', icon: 'user' },
    { label: 'الحضور والانصراف', page: 'employees-attendance', icon: 'bell' },
    { label: 'المرتبات', page: 'employees-payroll', icon: 'money' },
    { label: 'الإجازات', page: 'employees-vacations', icon: 'doc' }
  ] },
  { key: 'settings', title: 'البرنامج', tint: 'settings', icon: 'settings', items: [
    { label: 'الإعدادات', page: 'settings', icon: 'settings' },
    { label: 'المستخدمون', page: 'lock', icon: 'lock' },
    { label: 'سجل النشاط', page: 'activity', icon: 'bell' }
  ] }
];
let openTabs = [];
let activeTab = '';
let openMenuKey = '';
function pageDef(key) { return PAGE_DEFS[key] || null; }
function navIconMarkup(name) {
  const svg = lookIcon(name);
  return `<span class="nm-ico" aria-hidden="true">${svg || ''}</span>`;
}
function openPage(key) {
  const def = pageDef(key);
  if (!def) return;
  if (def.action) { def.action(); return; }
  if (def.home) { activatePage('home'); return; }
  def.run();
  // picking a page always dismisses the dropdown that started it
  closeMenus();
  // a permission guard aborts the screen, so no tab is registered for it
  if (!$('windowLayer').classList.contains('open')) return;
  registerTab(key, def.title);
  activeTab = key;
  presentActivePane();
  renderTabs();
}
function registerTab(key, title) {
  const existing = openTabs.find(tab => tab.key === key);
  if (existing) { existing.title = title || existing.title; activeTab = key; }
  else { openTabs.push({ key, title }); activeTab = key; }
  renderTabs();
}
/* the home tab only hides the open screens; their tabs (and their state) stay alive */
function showShellHome() {
  toggleCalculator(false);
  document.body.classList.remove('screen-open', 'section-open');
  document.body.style.overflow = '';
  if ($('sectionPool')) [...$('sectionPool').querySelectorAll('.float-window')].forEach(el => { el.hidden = true; });
  if ($('windowLayer')) { $('windowLayer').classList.remove('open'); $('windowLayer').hidden = true; }
  ensureHomeVisible();
  renderTabs();
}
function ensureHomeVisible() {
  ['dashWrap', 'homeDashboard', 'alertsPanel', 'classicPanel'].forEach(id => { if ($(id)) $(id).hidden = false; });
}
/* exactly one visible pane: the screen that belongs to the active tab */
function presentActivePane() {
  const layer = $('windowLayer');
  if (!layer) return;
  const win = activeFloatId ? floatWindows.get(activeFloatId) : null;
  if (!win) { showShellHome(); return; }
  [...floatWindows.values()].forEach(entry => {
    const current = entry.el === win.el;
    entry.el.hidden = !current;
    entry.el.classList.toggle('active', current);
  });
  layer.hidden = false;
  layer.classList.add('open');
  if ($('floatTaskbar')) $('floatTaskbar').hidden = true;
  if ($('windowDock')) $('windowDock').hidden = true;
  ['dashWrap', 'homeDashboard', 'alertsPanel', 'classicPanel'].forEach(id => { if ($(id)) $(id).hidden = true; });
  document.body.classList.add('screen-open');
  document.body.classList.remove('section-open');
  document.body.style.overflow = '';
}
function activatePage(key) {
  closeMenus();
  if (key === 'home') { activeTab = 'home'; showShellHome(); return; }
  const def = pageDef(key);
  if (!def || def.action) return;
  if (!openTabs.some(tab => tab.key === key)) { openPage(key); return; }
  // re-run the screen so shared pages (invoice modes, clients/suppliers) show their own data
  def.run();
  activeTab = key;
  presentActivePane();
  renderTabs();
}
function closeTab(key) {
  if (key === 'home') { activatePage('home'); return; }
  const index = openTabs.findIndex(tab => tab.key === key);
  if (index < 0) return;
  const wasActive = activeTab === key;
  const def = pageDef(key);
  openTabs.splice(index, 1);
  // drop only the screen of this tab; a shared screen stays alive for its other tabs
  if (def && def.section && !openTabs.some(tab => pageDef(tab.key)?.section === def.section)) removeFloatWindow(def.section);
  if (wasActive) {
    const next = openTabs.filter(tab => tab.key !== 'home').at(-1);
    if (next) activatePage(next.key); else { activeTab = 'home'; showShellHome(); }
  } else { presentActivePane(); renderTabs(); }
}
function removeFloatWindow(sectionId) {
  const win = floatWindows.get(sectionId);
  if (!win) return;
  win.el.remove();
  floatWindows.delete(sectionId);
  if (activeFloatId === sectionId) activeFloatId = [...floatWindows.keys()].at(-1) || null;
}
function closeAllTabs() {
  openTabs = openTabs.filter(tab => tab.key === 'home');
  for (const [id, entry] of [...floatWindows]) { entry.el.remove(); floatWindows.delete(id); }
  activeFloatId = null;
  activeTab = 'home';
  showShellHome();
  notify('تم إغلاق كل الشاشات.');
}
function renderTabs() {
  const bar = $('tabBar');
  if (!bar) return;
  if (!openTabs.some(tab => tab.key === 'home')) openTabs.unshift({ key: 'home', title: 'الرئيسية', home: true });
  // the pinned home tab always sits at the far right, new tabs open next to it
  const ordered = [openTabs.find(tab => tab.key === 'home'), ...openTabs.filter(tab => tab.key !== 'home')];
  const tabs = ordered.map(tab => `<button type="button" class="tab${tab.home ? ' is-home' : ''}" role="tab"
      data-tab="${esc(tab.key)}" aria-selected="${String(tab.key === activeTab)}" onclick="activatePage('${esc(tab.key)}')">
      <span>${esc(tab.title)}</span>
      <span class="tab-x" role="button" tabindex="-1" aria-label="إغلاق ${esc(tab.title)}" onclick="event.stopPropagation();closeTab('${esc(tab.key)}')">✕</span>
    </button>`).join('');
  const extra = ordered.length > 1
    ? `<span class="tab-extra"><span>${ordered.length - 1} شاشة مفتوحة</span><button type="button" onclick="closeAllTabs()" title="إغلاق كل الشاشات" aria-label="إغلاق كل الشاشات">✕ إغلاق الكل</button></span>`
    : '<span class="tab-extra"><span>اضغط أي زر في القائمة ليفتح في تبويب</span></span>';
  bar.innerHTML = tabs + extra;
  if ($('tabCount')) $('tabCount').textContent = String(ordered.length - 1);
}
function paintNavbar() {
  const bar = $('appNavbar');
  if (!bar) return;
  const theme = db.settings || {};
  bar.innerHTML = SHELL_MENUS.map(menu => `<button type="button" class="nv-btn" data-menu="${menu.key}"
      aria-haspopup="menu" aria-expanded="false" onclick="toggleNavMenu('${menu.key}', this)">
      <span aria-hidden="true">${lookIcon(menu.icon)}</span><span>${esc(menu.label)}</span><span class="nv-caret" aria-hidden="true">▾</span>
    </button>`).join('')
    + `<span class="nv-spacer"></span>
      <button type="button" class="nv-icon-btn nv-bell" title="التنبيهات" aria-label="التنبيهات" onclick="openStockAlertsPage()">
        ${lookIcon('bell')}<b id="navBellCount" hidden>0</b>
      </button>
      <button type="button" class="nv-icon-btn" title="تثبيت التطبيق" aria-label="تثبيت التطبيق" onclick="installApp()">${lookIcon('download')}</button>
      <button type="button" class="nv-icon-btn" title="${theme.name ? esc(theme.name) : 'المستخدم'}" aria-label="قفل الشاشة" onclick="lockApp()">${lookIcon('user')}</button>`;
  paintNavBell();
}
function paintNavBell() {
  const bell = $('navBellCount');
  if (!bell) return;
  const count = lowStockItems().length;
  bell.hidden = count === 0;
  bell.textContent = String(count);
}
function findMenu(key) { return SHELL_MENUS.find(menu => menu.key === key) || null; }
function toggleNavMenu(key, button) {
  if (openMenuKey === key) { closeMenus(); return; }
  openNavMenu(key, button);
}
function openNavMenu(key, button) {
  const menu = findMenu(key);
  const layer = $('navMenuLayer');
  if (!menu || !layer) return;
  openMenuKey = key;
  layer.innerHTML = `<div class="nav-menu" role="menu" aria-label="${esc(menu.label)}">
      <div class="nm-head">${esc(menu.label)}</div>
      ${menu.items.map(item => `<button type="button" class="nm-item" role="menuitem" data-page="${esc(item.page)}" onclick="closeMenus();openPage('${esc(item.page)}')">
        ${navIconMarkup(item.icon)}<span class="nm-label">${esc(item.label)}</span>${item.kbd ? `<span class="nm-kbd">${esc(item.kbd)}</span>` : ''}
      </button>`).join('')}
    </div>`;
  layer.hidden = false;
  document.querySelectorAll('.app-navbar .nv-btn').forEach(btn => btn.setAttribute('aria-expanded', String(btn.dataset.menu === key)));
  const box = layer.querySelector('.nav-menu');
  const rect = button.getBoundingClientRect();
  const width = Math.min(300, Math.max(250, rect.width + 60));
  box.style.width = `${width}px`;
  const rtl = (window.getComputedStyle?.(document.documentElement)?.direction || 'rtl') === 'rtl';
  let left = rtl ? rect.right - width : rect.left;
  left = Math.max(6, Math.min(window.innerWidth - width - 6, left));
  box.style.top = `${Math.round(rect.bottom + 4)}px`;
  box.style.left = `${Math.round(left)}px`;
  window.requestAnimationFrame(() => box.classList.add('in'));
  box.querySelector('.nm-item')?.focus({ preventScroll: true });
}
function openHomeMenu() {
  const first = document.querySelector('.app-navbar .nv-btn[data-menu="sales"]');
  if (first) openNavMenu('sales', first); else { const m = document.querySelector('.app-navbar .nv-btn'); if (m) openNavMenu(m.dataset.menu, m); }
}
function closeMenus() {
  const layer = $('navMenuLayer');
  if (!layer || layer.hidden) { openMenuKey = ''; return; }
  layer.hidden = true;
  layer.innerHTML = '';
  openMenuKey = '';
  document.querySelectorAll('.app-navbar .nv-btn').forEach(btn => btn.setAttribute('aria-expanded', 'false'));
}
function renderDashboard() {
  const host = $('dashBody');
  if (!host) return;
  host.innerHTML = DASH_GROUPS.map(group => `<section class="dash-group" data-tint="${esc(group.tint)}">
      <h3><span class="dg-ico" aria-hidden="true">${lookIcon(group.icon)}</span>${esc(group.title)}</h3>
      <div class="dg-grid">
        ${group.items.map(item => `<button type="button" class="dash-card" data-page="${esc(item.page)}" onclick="openPage('${esc(item.page)}')">
          <span class="dc-ico" aria-hidden="true">${lookIcon(item.icon)}</span><span>${esc(item.label)}</span>
        </button>`).join('')}
      </div>
    </section>`).join('');
}
function paintTitleChrome() {
  if ($('titleBarName')) $('titleBarName').textContent = db.settings.name;
  if ($('titleBarLogo')) $('titleBarLogo').src = lookSettings().storeLogo || '/icon-192.png';
  if ($('titleBarUser')) $('titleBarUser').textContent = `${activeStaff().name} · ${roleLabel(activeStaff().role)}`;
  if ($('titleBarClock')) $('titleBarClock').textContent = `${localDate()} ${new Date().toTimeString().slice(0, 5)}`;
  if ($('footerBrand')) $('footerBrand').textContent = db.settings.name;
  if ($('footerPhone')) $('footerPhone').textContent = db.settings.phone ? `☎ ${db.settings.phone}` : '';
  if ($('footerAddress')) $('footerAddress').textContent = db.settings.address || '';
  document.title = `${db.settings.name} | نقاط البيع`;
  paintNavBell();
}
function shellSecondaryNav() {
  // the tab strip is the only page switcher now: no in-page ✕ and no window title bar
  document.querySelectorAll('.page-close-btn').forEach(button => { button.hidden = true; button.style.display = 'none'; });
  document.querySelectorAll('.win-header, #winHeader, .float-titlebar').forEach(header => { header.hidden = true; });
}

/* ================================================================== */
/* WORKSPACE PAGES: links, POS utilities, clients, settings, HR        */
/* ================================================================== */
function storeSetting(key, fallback = '') {
  const value = db?.settings?.[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}
function optionList(values) {
  return values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
}
/* keep one tab per screen: a more specific link renames the invoice tab */
function linkPageTab(key, title) {
  if (!openTabs.some(tab => tab.key === key)) return;
  registerTab(key, title);
}
function openSalesInvoice() { openPage('sale'); linkPageTab('sale', 'فاتورة مبيعات'); }
function openPurchaseInvoice() { openPage('purchase'); linkPageTab('purchase', 'فاتورة مشتريات'); }
function openSaleReturn() { openPage('sale_return'); linkPageTab('sale_return', 'مرتجع مبيعات'); }
function openPurchaseReturn() { openPage('purchase_return'); linkPageTab('purchase_return', 'مرتجع مشتريات'); }
function openQuotePage() { openPage('quote'); linkPageTab('quote', 'عرض أسعار'); }
function openCustomersPage() { openPage('customers'); linkPageTab('customers', 'إدارة العملاء'); }
function openSuppliersPage() { openPage('suppliers'); linkPageTab('suppliers', 'إدارة الموردين'); }
function openSettingsPage(tab = 'look') { switchSettingsTab(tab); openPage('settings'); }

/* ---------------- invoice workspace utilities ---------------- */
const INVOICE_PAGE_TITLES = { sale: 'فاتورة مبيعات', sale_return: 'مرتجع مبيعات', purchase: 'فاتورة مشتريات', purchase_return: 'مرتجع مشتريات', quote: 'عرض أسعار' };
function syncInvoiceChrome() {
  const currentMode = $('invMode')?.value || 'sale';
  if (INVOICE_PAGE_TITLES[currentMode] && openTabs.some(tab => tab.key === currentMode)) registerTab(currentMode, INVOICE_PAGE_TITLES[currentMode]);
  if ($('invDateView')) $('invDateView').value = localDate().replaceAll('-', '/');
  if ($('invNumberView')) {
    const draftId = Number($('invCartTbody')?.dataset?.quoteId) || 0;
    const next = draftId || nextId(db.invoices);
    $('invNumberView').value = `#${next}`;
    $('invNumberView').title = draftId ? 'رقم عرض السعر المفتوح للتحويل' : 'رقم الفاتورة التالي';
  }
  if ($('invEmployeeView')) $('invEmployeeView').value = `${activeStaff().name} · ${roleLabel(activeStaff().role)}`;
  if ($('statusStore')) $('statusStore').textContent = storeSetting('defaultWarehouse', 'الرئيسي');
  if ($('posPayHint')) {
    const payType = $('invPayType')?.value || 'cash';
    $('posPayHint').textContent = payType === 'cash' ? 'البيع النقدي يملأ المدفوع تلقائياً ويحسب الباقي.'
      : payType === 'credit' ? 'البيع الآجل يضيف المبلغ على رصيد حساب العميل.' : 'أدخل المبلغ المدفوع ويُحسب المتبقي على الحساب.';
  }
  paintCalcScreen();
}
function paintInvoiceSelects() {
  const warehouses = [storeSetting('defaultWarehouse', 'الرئيسي'), ...db.items.map(item => item.warehouse).filter(Boolean)];
  const safes = [storeSetting('defaultSafe', 'الخزينة الرئيسية')];
  if ($('invWarehouseView')) {
    const previous = $('invWarehouseView').value;
    $('invWarehouseView').innerHTML = optionList([...new Set(warehouses)]);
    if (previous) $('invWarehouseView').value = previous;
  }
  if ($('invSafeView')) {
    const previous = $('invSafeView').value;
    $('invSafeView').innerHTML = optionList([...new Set(safes)]);
    if (previous) $('invSafeView').value = previous;
  }
}
function renderPosItemSearch(term = $('posItemSearch')?.value || '') {
  const host = $('posItemSearchResults');
  if (!host) return;
  const query = String(term).trim().toLocaleLowerCase();
  if (!query) {
    host.innerHTML = '<p class="ws-hint" style="margin:2px 0">اكتب حرفين على الأقل للبحث بالاسم أو الكود.</p>';
    return;
  }
  const matches = db.items.filter(item => `${item.name} ${item.code}`.toLocaleLowerCase().includes(query)).slice(0, 12);
  host.innerHTML = matches.length ? matches.map(item => `<button type="button" class="posx-hit" onclick="addWatchItem(${item.id})">
      <b>${esc(item.name)}</b><small>${esc(item.code)}</small><span class="ph-price">${money(item.sell)}</span>
    </button>`).join('') : '<p class="ws-hint" style="margin:2px 0">لا توجد نتائج مطابقة.</p>';
}
function addWatchItem(itemId) {
  const item = db.items.find(entry => entry.id === itemId);
  if (!item) return;
  if ($('invBarcodeInp')) $('invBarcodeInp').value = item.code;
  addInvItemFromInput();
}

/* ---------------- sidebar calculator ---------------- */
let calcState = { entry: '0', stored: null, operator: null, replace: true, label: '0' };
function calcValue(value) { return Number(String(value).replace(/[^\d.-]/g, '')) || 0; }
function calcFormat(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'خطأ';
  return String(Math.round(number * 1e8) / 1e8);
}
function calcApply(left, operator, right) {
  if (operator === '+') return left + right;
  if (operator === '−') return left - right;
  if (operator === '×') return left * right;
  if (operator === '÷') return right ? left / right : NaN;
  return right;
}
function calcInput(key) {
  const state = calcState;
  if (/^[0-9]$/.test(key)) {
    state.entry = state.replace || state.entry === '0' ? key : `${state.entry}${key}`;
    state.replace = false;
  } else if (key === '.') {
    if (state.replace) { state.entry = '0.'; state.replace = false; }
    else if (!state.entry.includes('.')) state.entry = `${state.entry}.`;
  } else if (key === 'C') {
    calcState = { entry: '0', stored: null, operator: null, replace: true, label: '0' };
    return paintCalcScreen();
  } else if (key === 'CE') {
    state.entry = '0'; state.replace = true;
  } else if (key === '←') {
    state.entry = state.entry.length > 1 ? state.entry.slice(0, -1) : '0';
    if (state.entry === '0') state.replace = true;
  } else if (key === '%') {
    state.entry = calcFormat(calcValue(state.entry) / 100);
    state.replace = true;
  } else if (['+', '−', '×', '÷'].includes(key)) {
    const current = calcValue(state.entry);
    state.stored = state.stored === null || state.operator === null ? current : calcApply(state.stored, state.operator, current);
    state.operator = key; state.replace = true;
    state.label = `${calcFormat(state.stored)} ${key}`;
    state.entry = calcFormat(state.stored);
    return paintCalcScreen();
  } else if (key === '=') {
    if (state.operator !== null && state.stored !== null) {
      const result = calcApply(state.stored, state.operator, calcValue(state.entry));
      state.label = `${calcFormat(state.stored)} ${state.operator} ${calcFormat(calcValue(state.entry))} =`;
      state.entry = calcFormat(result);
      state.stored = null; state.operator = null; state.replace = true;
      return paintCalcScreen();
    }
    return;
  }
  state.label = '';
  paintCalcScreen();
}
function paintCalcScreen() {
  const screen = $('calcScreen');
  if (!screen) return;
  const showLabel = calcState.label && calcState.label !== '0' && calcState.label !== 'خطأ';
  screen.textContent = showLabel ? `${calcState.label} ${calcState.entry}`.trim() : (calcState.entry === 'NaN' ? 'خطأ' : calcState.entry);
}
function toggleCalculator(force) {
  const box = $('calcFloat');
  if (!box) return;
  const open = force === undefined ? !box.classList.contains('open') : Boolean(force);
  box.classList.toggle('open', open);
  box.setAttribute('aria-hidden', String(!open));
  if ($('calcToggleBtn')) $('calcToggleBtn').setAttribute('aria-expanded', String(open));
  if (open) { paintCalcScreen(); dragCalcFloat(); }
}
/* the calculator can be dragged by its title bar, like the floating windows */
function dragCalcFloat() {
  const box = $('calcFloat'), head = $('calcFloatHead');
  if (!box || !head || head.dataset.dragReady === '1') return;
  head.dataset.dragReady = '1';
  head.addEventListener('pointerdown', event => {
    if (event.target.closest('button') || window.innerWidth <= 760) return;
    const rect = box.getBoundingClientRect();
    const offsetX = event.clientX - rect.left, offsetY = event.clientY - rect.top;
    box.style.insetInlineStart = 'auto'; box.style.insetBlockStart = 'auto';
    box.style.left = `${rect.left}px`; box.style.top = `${rect.top}px`;
    const move = ev => {
      box.style.left = `${Math.min(Math.max(0, ev.clientX - offsetX), Math.max(0, window.innerWidth - rect.width))}px`;
      box.style.top = `${Math.min(Math.max(0, ev.clientY - offsetY), Math.max(0, window.innerHeight - rect.height))}px`;
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });
}
function sendCalcToPaid() {
  const value = calcValue(calcState.entry);
  if (!Number.isFinite(value) || value < 0) return;
  if ($('invPaidAmount')) { $('invPaidAmount').value = calcFormat(value); calcInvoiceRemaining(); }
}

/* ---------------- clients page ---------------- */
let partyFilter = '';
function partyDisplayCode(party) {
  if (party.code) return party.code;
  if (party.type === 'customer') {
    const index = db.parties.filter(entry => entry.type === 'customer').findIndex(entry => entry.id === party.id);
    return `C-${String(1000 + Math.max(0, index) + 1)}`;
  }
  const index = db.parties.filter(entry => entry.type === 'supplier').findIndex(entry => entry.id === party.id);
  return `S-${String(2000 + Math.max(0, index) + 1)}`;
}
function partyMatches(party, term) {
  const query = String(term || '').trim().toLocaleLowerCase();
  if (!query) return true;
  return [party.name, party.code, partyDisplayCode(party), party.phone, party.phone2, party.email, party.city, party.country]
    .filter(Boolean).some(value => String(value).toLocaleLowerCase().includes(query));
}
function filterParties(term) {
  partyFilter = String(term ?? '');
  if (typeof renderPartiesTable === 'function') renderPartiesTable();
}
function partyDebtTotals(type = $('partyType')?.value || 'customer') {
  const list = db.parties.filter(party => party.type === type);
  const debtors = list.filter(party => roundMoney(party.balance) > 0);
  return {
    count: list.length,
    debtors: debtors.length,
    totalDebt: roundMoney(debtors.reduce((sum, party) => sum + party.balance, 0)),
    totalCredit: roundMoney(list.filter(party => party.balance < 0).reduce((sum, party) => sum + Math.abs(party.balance), 0))
  };
}
function showTotalDebt() {
  const type = $('partyType')?.value || 'customer';
  const totals = partyDebtTotals(type);
  const label = type === 'supplier' ? 'الموردين' : 'العملاء';
  const body = `${label}: ${totals.count} حساب — منهم ${totals.debtors} عليهم مديونية.\n` +
    `مجموع الديون: ${money(totals.totalDebt)}\n` +
    `أرصدة دائنة (لهم): ${money(totals.totalCredit)}`;
  notify(`مجموع ديون ${label}: ${money(totals.totalDebt)} (${totals.debtors} حساب)`);
  alert(`📉 حساب مجموع الديون — ${label}\n\n${body}`);
}
function showSelectedDebt() {
  const editId = Number($('partyEditId')?.value) || 0;
  const party = db.parties.find(entry => entry.id === editId);
  if (!party) { notify('اختر عميلاً من الجدول أولاً لحساب مديونيته.'); return; }
  const invoices = db.invoices.filter(inv => inv.partyId === party.id && ['sale', 'purchase'].includes(inv.mode) && inv.remainAmount > 0);
  const due = roundMoney(invoices.reduce((sum, inv) => sum + inv.remainAmount, 0));
  alert(`📋 ${party.name}\n\nالرصيد الحالي: ${money(party.balance)}\nمتبقي فواتير آجلة: ${money(due)} (${invoices.length} فاتورة)\nآخر حركة: ${invoices.at(-1)?.date || '—'}`);
}
function showPartyBalances() {
  const list = db.parties.filter(party => party.type === ($('partyType')?.value || 'customer')).slice()
    .sort((a, b) => b.balance - a.balance);
  if (!list.length) { notify('لا توجد حسابات مسجلة بعد.'); return; }
  const rows = list.slice(0, 10).map(party => `${partyDisplayCode(party)} — ${party.name}: ${money(party.balance)}`).join('\n');
  alert(`📊 الأرصدة مرتبة تنازلياً\n\n${rows}${list.length > 10 ? `\n… و${list.length - 10} حساب آخر` : ''}`);
}
function selectPartyRow(partyId) {
  const party = db.parties.find(entry => entry.id === partyId);
  if (!party) return;
  $$('#partiesTbody tr').forEach(row => row.classList.toggle('is-selected', Number(row.dataset.partyId) === partyId));
  if ($('partyContactHint')) $('partyContactHint').textContent = party.name;
  const write = (id, value) => { if ($(id)) $(id).textContent = value || '—'; };
  write('partyViewCountry', party.country);
  write('partyViewCity', party.city);
  write('partyViewPhone', party.phone);
  write('partyViewPhone2', party.phone2);
  write('partyViewEmail', party.email);
  write('partyViewBalance', money(party.balance));
  write('partyViewAddress', party.address || party.notes);
  $$('#partiesTbody tr').forEach(row => row.dataset.selected = String(Number(row.dataset.partyId) === partyId));
}

/* ================================================================== */
/* EMPLOYEES & HR (local records, per device)                          */
/* ================================================================== */
const HR_KEY = `${DB_KEY}_HR`;
const HR_LEDGERS = { deduction: 'deductions', advance: 'advances', bonus: 'bonuses' };
const HR_LEDGER_LABELS = { deduction: 'خصم', advance: 'سلفة', bonus: 'مكافأة' };
const HR_STATES = { present: 'حاضر', late: 'متأخر', absent: 'غائب', leave: 'إجازة' };
const HR_VACATIONS = { annual: 'سنوية', sick: 'مرضية', unpaid: 'بدون راتب', permission: 'إذن' };
function hrRead() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem(HR_KEY) || '{}') || {}; } catch { raw = {}; }
  const list = key => Array.isArray(raw[key]) ? raw[key] : [];
  return {
    employees: list('employees'), departments: list('departments'), jobs: list('jobs'),
    attendance: list('attendance'), vacations: list('vacations'), penalties: list('penalties'),
    deductions: list('deductions'), advances: list('advances'), bonuses: list('bonuses')
  };
}
function hrWrite(data) {
  try { localStorage.setItem(HR_KEY, JSON.stringify(data)); return true; }
  catch { notify('تعذر حفظ بيانات الموظفين على هذا الجهاز.'); return false; }
}
function hrMutate(change) {
  const data = hrRead();
  const result = change(data);
  if (result === false) return false;
  if (!hrWrite(data)) return false;
  renderHr();
  return result ?? true;
}
function hrNextId(list) { return list.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1; }
function hrEmployeeName(id) {
  const data = hrRead();
  const employee = data.employees.find(entry => String(entry.id) === String(id));
  return employee ? employee.name : '—';
}
function hrSalaryOf(employee) { return roundMoney(Number(employee?.salary) || 0); }
function hrLedgerSum(data, listName, staffId) {
  return roundMoney((data[listName] || []).filter(row => String(row.staffId) === String(staffId))
    .reduce((sum, row) => sum + (Number(row.amount) || 0), 0));
}
function hrFillStaffSelect(id, placeholder = false) {
  const select = $(id);
  if (!select) return;
  const data = hrRead();
  const previous = select.value;
  select.innerHTML = (placeholder ? '<option value="">اختر الموظف</option>' : '') +
    data.employees.map(employee => `<option value="${esc(employee.id)}">${esc(employee.name)}</option>`).join('');
  if (data.employees.some(employee => String(employee.id) === previous)) select.value = previous;
}
function showHrPanel(key = 'employees') {
  const panel = key || 'employees';
  $$('#hrTiles .hr-tile').forEach(tile => {
    const active = tile.dataset.hr === panel;
    tile.classList.toggle('is-active', active);
    tile.setAttribute('aria-selected', String(active));
  });
  $$('#hrPanels .hr-panel').forEach(section => section.classList.toggle('active', section.dataset.hrPanel === panel));
  if (panel === 'reports') renderHrReport();
}
function openHrTile(panel) { openHrPage(panel); }
function openHrPage(panel = 'employees') {
  if (!ensurePermission('admin')) return;
  openSec('sec-hr', '👔 إدارة الموظفين');
  setActiveNav('staff');
  if ($('sec-hr')) $('sec-hr').dataset.hrPanel = panel;
  showHrPanel(panel);
  renderHr();
}
function renderHr() {
  if (!$('hrEmployeesTbody')) return;
  const data = hrRead();
  const today = localDate();
  const todayRows = data.attendance.filter(row => row.date === today);

  $('hrEmployeesTbody').innerHTML = data.employees.map((employee, index) => {
    const status = todayRows.find(row => String(row.staffId) === String(employee.id));
    const tone = !status ? 'info' : status.state === 'present' ? 'ok' : status.state === 'late' ? 'warn' : 'bad';
    const label = status ? HR_STATES[status.state] || status.state : 'لم يُسجل';
    return `<tr><td>${index + 1}</td><td class="is-name">${esc(employee.name)}</td><td>${esc(employee.job || '—')}</td>
      <td>${esc(employee.department || '—')}</td><td dir="ltr">${esc(employee.phone || '—')}</td>
      <td class="is-num">${money(employee.salary)}</td><td><span class="ws-tag" data-tone="${tone}">${esc(label)}</span></td>
      <td class="no-print"><span class="row-actions">
        <button type="button" class="iconbtn is-edit" title="تعديل" onclick="editHrEmployee(${employee.id})">✎</button>
        <button type="button" class="iconbtn is-del" title="حذف" onclick="deleteHrRecord('employees', ${employee.id})">✕</button>
      </span></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="ws-empty">لا يوجد موظفون مسجلون — استخدم «إدارة الموظفين ⚙» في الأعلى لإضافة أول موظف.</td></tr>';
  if ($('hrEmployeesHint')) $('hrEmployeesHint').textContent = `${data.employees.length} موظف`;
  if ($('hrCountEmployees')) $('hrCountEmployees').textContent = String(data.employees.length);

  // attendance
  if ($('hrAttendanceDate')) $('hrAttendanceDate').textContent = today.replaceAll('-', '/');
  $('hrAttendanceToday').innerHTML = todayRows.map(row => `<tr><td class="is-name">${esc(hrEmployeeName(row.staffId))}</td>
      <td>${esc(row.inTime || '—')}</td><td>${esc(row.outTime || '—')}</td>
      <td><span class="ws-tag" data-tone="${row.state === 'present' ? 'ok' : row.state === 'late' ? 'warn' : 'bad'}">${esc(HR_STATES[row.state] || row.state)}</span></td></tr>`
  ).join('') || '<tr><td colspan="4" class="ws-empty">لم يُسجل حضور اليوم بعد.</td></tr>';
  if ($('hrCountAttendance')) $('hrCountAttendance').textContent = String(todayRows.length);

  // payroll
  let payrollTotal = 0;
  $('hrPayrollTbody').innerHTML = data.employees.map((employee, index) => {
    const bonus = hrLedgerSum(data, 'bonuses', employee.id), deduction = hrLedgerSum(data, 'deductions', employee.id);
    const advance = hrLedgerSum(data, 'advances', employee.id), penalty = roundMoney((data.penalties || [])
      .filter(row => String(row.staffId) === String(employee.id)).reduce((sum, row) => sum + (Number(row.amount) || 0), 0));
    const net = roundMoney(hrSalaryOf(employee) + bonus - deduction - advance - penalty);
    payrollTotal += net;
    return `<tr><td>${index + 1}</td><td class="is-name">${esc(employee.name)}</td><td class="is-num">${money(employee.salary)}</td>
      <td class="is-num">${money(bonus)}</td><td class="is-num">${money(roundMoney(deduction + penalty))}</td>
      <td class="is-num">${money(advance)}</td><td class="is-num"><b>${money(net)}</b></td>
      <td><span class="ws-tag" data-tone="${net > 0 ? 'ok' : 'bad'}">${net > 0 ? 'مستحق' : 'مسدد'}</span></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="ws-empty">لا توجد مرتبات — أضف موظفين أولاً.</td></tr>';
  if ($('hrPayrollTotal')) $('hrPayrollTotal').textContent = `الإجمالي: ${money(payrollTotal)}`;
  if ($('hrCountPayroll')) $('hrCountPayroll').textContent = String(data.employees.length);
  if ($('hrKpiEmployees')) $('hrKpiEmployees').textContent = String(data.employees.length);
  if ($('hrKpiPresent')) $('hrKpiPresent').textContent = String(todayRows.filter(row => ['present', 'late'].includes(row.state)).length);
  if ($('hrKpiPayroll')) $('hrKpiPayroll').textContent = money(payrollTotal);
  const deductionTotal = roundMoney((data.deductions || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0));
  if ($('hrKpiDeductions')) $('hrKpiDeductions').textContent = money(deductionTotal);
  if ($('hrDeductionTotal')) $('hrDeductionTotal').textContent = `الإجمالي: ${money(deductionTotal)}`;
  if ($('hrAdvanceTotal')) $('hrAdvanceTotal').textContent = `الإجمالي: ${money(roundMoney((data.advances || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0)))}`;
  if ($('hrBonusTotal')) $('hrBonusTotal').textContent = `الإجمالي: ${money(roundMoney((data.bonuses || []).reduce((sum, row) => sum + (Number(row.amount) || 0), 0)))}`;

  // departments & jobs
  if ($('hrDepartmentsTbody')) {
    $('hrDepartmentsTbody').innerHTML = data.departments.map(department => `<tr><td class="is-name">${esc(department.name)}</td>
      <td>${esc(department.head || '—')}</td><td>${data.employees.filter(employee => employee.department === department.name).length}</td>
      <td class="no-print"><button type="button" class="iconbtn is-del" onclick="deleteHrRecord('departments', ${department.id})">✕</button></td></tr>`
    ).join('') || '<tr><td colspan="4" class="ws-empty">لا توجد أقسام مسجلة.</td></tr>';
    if ($('hrDeptCount')) $('hrDeptCount').textContent = `${data.departments.length} قسم`;
    if ($('hrCountDepartments')) $('hrCountDepartments').textContent = String(data.departments.length);
  }
  if ($('hrJobsTbody')) {
    $('hrJobsTbody').innerHTML = data.jobs.map(job => `<tr><td class="is-name">${esc(job.name)}</td><td>${esc(job.department || '—')}</td>
      <td class="is-num">${money(job.salary)}</td><td>${data.employees.filter(employee => employee.job === job.name).length}</td>
      <td class="no-print"><button type="button" class="iconbtn is-del" onclick="deleteHrRecord('jobs', ${job.id})">✕</button></td></tr>`
    ).join('') || '<tr><td colspan="5" class="ws-empty">لا توجد وظائف مسجلة.</td></tr>';
    if ($('hrCountJobs')) $('hrCountJobs').textContent = String(data.jobs.length);
  }
  if ($('hrJobDept')) {
    const previous = $('hrJobDept').value;
    $('hrJobDept').innerHTML = '<option value="">بدون قسم</option>' + data.departments.map(department => `<option value="${esc(department.name)}">${esc(department.name)}</option>`).join('');
    if (previous) $('hrJobDept').value = previous;
  }

  // vacations
  if ($('hrVacationsTbody')) {
    $('hrVacationsTbody').innerHTML = data.vacations.map(vacation => `<tr><td class="is-name">${esc(hrEmployeeName(vacation.staffId))}</td>
      <td>${esc(HR_VACATIONS[vacation.type] || vacation.type)}</td><td>${esc(vacation.from)}</td><td>${esc(vacation.to)}</td>
      <td class="is-num">${vacation.days}</td>
      <td class="no-print"><button type="button" class="iconbtn is-del" onclick="deleteHrRecord('vacations', ${vacation.id})">✕</button></td></tr>`
    ).join('') || '<tr><td colspan="6" class="ws-empty">لا توجد إجازات مسجلة.</td></tr>';
    if ($('hrCountVacations')) $('hrCountVacations').textContent = String(data.vacations.length);
  }

  // penalties
  if ($('hrPenaltiesTbody')) {
    const penalties = data.penalties || [];
    $('hrPenaltiesTbody').innerHTML = penalties.slice().reverse().map(penalty => `<tr><td>${esc(penalty.date)}</td>
      <td class="is-name">${esc(hrEmployeeName(penalty.staffId))}</td><td class="is-name">${esc(penalty.reason)}</td>
      <td class="is-num">${money(penalty.amount)}</td>
      <td class="no-print"><button type="button" class="iconbtn is-del" onclick="deleteHrRecord('penalties', ${penalty.id})">✕</button></td></tr>`
    ).join('') || '<tr><td colspan="5" class="ws-empty">لا توجد جزاءات.</td></tr>';
    if ($('hrCountPenalties')) $('hrCountPenalties').textContent = String(penalties.length);
  }

  // ledgers (deductions / advances / bonuses)
  for (const [kind, listName] of Object.entries(HR_LEDGERS)) {
    const body = $({ deductions: 'hrDeductionsTbody', advances: 'hrAdvancesTbody', bonuses: 'hrBonusesTbody' }[listName]);
    const rows = data[listName] || [];
    if (body) {
      body.innerHTML = rows.slice().reverse().map(row => `<tr><td>${esc(row.date)}</td>
        <td class="is-name">${esc(hrEmployeeName(row.staffId))}</td><td class="is-name">${esc(row.reason || HR_LEDGER_LABELS[kind])}</td>
        <td class="is-num">${money(row.amount)}</td>
        <td class="no-print"><button type="button" class="iconbtn is-del" onclick="deleteHrRecord('${listName}', ${row.id})">✕</button></td></tr>`
      ).join('') || `<tr><td colspan="5" class="ws-empty">لا توجد ${HR_LEDGER_LABELS[kind]}ات مسجلة.</td></tr>`;
    }
    const counter = $({ deductions: 'hrCountDeductions', advances: 'hrCountAdvances', bonuses: 'hrCountBonuses' }[listName]);
    if (counter) counter.textContent = String(rows.length);
  }

  for (const id of ['hrAttStaff', 'hrVacStaff', 'hrPenStaff', 'hrDedStaff', 'hrAdvStaff', 'hrBonusStaff']) hrFillStaffSelect(id, true);
  if ($('hrReportStaff')) {
    const previous = $('hrReportStaff').value;
    $('hrReportStaff').innerHTML = '<option value="all">كل الموظفين</option>' + data.employees.map(employee => `<option value="${esc(employee.id)}">${esc(employee.name)}</option>`).join('');
    if (previous) $('hrReportStaff').value = previous;
  }
}
function saveHrEmployee() {
  const name = $('hrEmpName').value.trim();
  if (name.length < 2) return alert('أدخل اسم الموظف (حرفان على الأقل).');
  const editId = Number($('hrEmpEditId').value) || 0;
  const record = {
    name, phone: $('hrEmpPhone').value.trim(), email: $('hrEmpEmail').value.trim(),
    job: $('hrEmpJob').value.trim(), department: $('hrEmpDept').value.trim(),
    salary: roundMoney(Number($('hrEmpSalary').value) || 0), hireDate: $('hrEmpHireDate').value || localDate(),
    notes: $('hrEmpNotes').value.trim()
  };
  const saved = hrMutate(data => {
    if (editId) { const employee = data.employees.find(entry => entry.id === editId); if (!employee) return false; Object.assign(employee, record); return true; }
    data.employees.push({ id: hrNextId(data.employees), ...record });
    return true;
  });
  if (!saved) return;
  ['hrEmpName', 'hrEmpPhone', 'hrEmpEmail', 'hrEmpJob', 'hrEmpDept', 'hrEmpNotes'].forEach(id => { if ($(id)) $(id).value = ''; });
  if ($('hrEmpSalary')) $('hrEmpSalary').value = '0';
  if ($('hrEmpEditId')) $('hrEmpEditId').value = '';
  if ($('hrEmpFormTitle')) $('hrEmpFormTitle').textContent = 'بيانات الموظف';
  notify(editId ? 'تم تحديث بيانات الموظف.' : 'تمت إضافة الموظف.');
}
function editHrEmployee(id) {
  const data = hrRead();
  const employee = data.employees.find(entry => entry.id === id);
  if (!employee) return;
  if ($('hrEmpEditId')) $('hrEmpEditId').value = String(employee.id);
  if ($('hrEmpName')) $('hrEmpName').value = employee.name || '';
  if ($('hrEmpPhone')) $('hrEmpPhone').value = employee.phone || '';
  if ($('hrEmpEmail')) $('hrEmpEmail').value = employee.email || '';
  if ($('hrEmpJob')) $('hrEmpJob').value = employee.job || '';
  if ($('hrEmpDept')) $('hrEmpDept').value = employee.department || '';
  if ($('hrEmpSalary')) $('hrEmpSalary').value = String(employee.salary || 0);
  if ($('hrEmpHireDate')) $('hrEmpHireDate').value = employee.hireDate || '';
  if ($('hrEmpNotes')) $('hrEmpNotes').value = employee.notes || '';
  if ($('hrEmpFormTitle')) $('hrEmpFormTitle').textContent = `تعديل الموظف — ${employee.name}`;
  showHrPanel('employees');
  $('hrEmpName')?.focus();
}
function deleteHrRecord(listName, id) {
  const data = hrRead();
  const label = listName === 'employees' ? 'الموظف' : 'السجل';
  if (!window.confirm(`حذف ${label}؟`)) return;
  const removed = hrMutate(next => {
    next[listName] = (next[listName] || []).filter(row => row.id !== id);
    if (listName === 'employees') {
      for (const key of ['attendance', 'vacations', 'penalties', 'deductions', 'advances', 'bonuses']) {
        next[key] = (next[key] || []).filter(row => String(row.staffId) !== String(id));
      }
    }
    return true;
  });
  if (removed) notify('تم حذف السجل.');
  void data;
}
function renderHrAttendance() { renderHr(); }
function saveHrAttendance() {
  const staffId = Number($('hrAttStaff').value) || 0;
  if (!staffId) return alert('اختر الموظف أولاً.');
  const state = $('hrAttState').value, today = localDate();
  const saved = hrMutate(data => {
    const existing = data.attendance.find(row => row.date === today && String(row.staffId) === String(staffId));
    const record = { date: today, staffId, state, inTime: $('hrAttIn').value || '', outTime: $('hrAttOut').value || '', note: '' };
    if (existing) Object.assign(existing, record);
    else data.attendance.push({ id: hrNextId(data.attendance), ...record });
    return true;
  });
  if (saved) notify(`تم تسجيل ${HR_STATES[state] || state} لـ ${hrEmployeeName(staffId)}.`);
}
function saveHrDepartment() {
  const name = $('hrDeptName').value.trim();
  if (name.length < 2) return alert('أدخل اسم القسم.');
  const saved = hrMutate(data => {
    if (data.departments.some(department => department.name === name)) return false;
    data.departments.push({ id: hrNextId(data.departments), name, head: $('hrDeptHead').value.trim() });
    return true;
  });
  if (saved === false) return alert('هذا القسم موجود بالفعل.');
  $('hrDeptName').value = ''; $('hrDeptHead').value = '';
  notify('تمت إضافة القسم.');
}
function saveHrJob() {
  const name = $('hrJobName').value.trim();
  if (name.length < 2) return alert('أدخل اسم الوظيفة.');
  const saved = hrMutate(data => {
    data.jobs.push({ id: hrNextId(data.jobs), name, department: $('hrJobDept').value, salary: roundMoney(Number($('hrJobSalary').value) || 0) });
    return true;
  });
  if (saved) { $('hrJobName').value = ''; $('hrJobSalary').value = '0'; notify('تمت إضافة الوظيفة.'); }
}
function saveHrVacation() {
  const staffId = Number($('hrVacStaff').value) || 0, from = $('hrVacFrom').value, to = $('hrVacTo').value;
  if (!staffId || !from || !to) return alert('اختر الموظف وتاريخ البداية والنهاية.');
  const days = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);
  if (!Number.isFinite(days)) return alert('التواريخ غير صالحة.');
  const saved = hrMutate(data => {
    data.vacations.push({ id: hrNextId(data.vacations), staffId, type: $('hrVacType').value, from, to, days });
    return true;
  });
  if (saved) notify(`تم تسجيل إجازة ${days} يوم.`);
}
function saveHrPenalty() {
  const staffId = Number($('hrPenStaff').value) || 0, amount = roundMoney(Number($('hrPenAmount').value) || 0);
  const reason = $('hrPenReason').value.trim();
  if (!staffId || amount <= 0 || !reason) return alert('اختر الموظف وأدخل مبلغ الجزاء والسبب.');
  const saved = hrMutate(data => {
    data.penalties.push({ id: hrNextId(data.penalties), staffId, amount, reason, date: localDate() });
    return true;
  });
  if (saved) { $('hrPenAmount').value = '0'; $('hrPenReason').value = ''; notify('تم تسجيل الجزاء.'); }
}
function saveHrLedger(kind) {
  const listName = HR_LEDGERS[kind];
  if (!listName) return;
  const fieldIds = {
    deduction: ['hrDedStaff', 'hrDedAmount', 'hrDedReason'],
    advance: ['hrAdvStaff', 'hrAdvAmount', 'hrAdvReason'],
    bonus: ['hrBonusStaff', 'hrBonusAmount', 'hrBonusReason']
  }[kind];
  const staffId = Number($(fieldIds[0]).value) || 0;
  const amount = roundMoney(Number($(fieldIds[1]).value) || 0);
  const reason = $(fieldIds[2]).value.trim();
  if (!staffId || amount <= 0) return alert('اختر الموظف وأدخل مبلغاً موجباً.');
  const saved = hrMutate(data => {
    data[listName].push({ id: hrNextId(data[listName]), staffId, amount, reason, date: localDate() });
    return true;
  });
  if (saved) { $(fieldIds[1]).value = '0'; $(fieldIds[2]).value = ''; notify(`تم تسجيل ${HR_LEDGER_LABELS[kind]}.`); }
}
function hrReportRows(staffId = 'all', from = '', to = '') {
  const data = hrRead();
  const inRange = date => (!from || date >= from) && (!to || date <= to);
  return data.employees
    .filter(employee => staffId === 'all' || String(employee.id) === String(staffId))
    .map(employee => {
      const rows = data.attendance.filter(row => String(row.staffId) === String(employee.id) && inRange(row.date));
      const hours = rows.reduce((sum, row) => {
        if (!row.inTime || !row.outTime) return sum;
        const [inH, inM] = row.inTime.split(':').map(Number), [outH, outM] = row.outTime.split(':').map(Number);
        return sum + Math.max(0, (outH * 60 + outM) - (inH * 60 + inM));
      }, 0) / 60;
      const vacations = data.vacations.filter(row => String(row.staffId) === String(employee.id)).reduce((sum, row) => sum + (Number(row.days) || 0), 0);
      return {
        id: employee.id, name: employee.name,
        present: rows.filter(row => row.state === 'present').length,
        late: rows.filter(row => row.state === 'late').length,
        absent: rows.filter(row => row.state === 'absent').length,
        leave: rows.filter(row => row.state === 'leave').length + vacations,
        hours: Math.round(hours * 10) / 10
      };
    });
}
function renderHrReport() {
  const body = $('hrReportTbody');
  if (!body) return;
  const from = $('hrReportFrom')?.value || '', to = $('hrReportTo')?.value || '';
  const rows = hrReportRows($('hrReportStaff')?.value || 'all', from, to);
  body.innerHTML = rows.map(row => `<tr><td class="is-name">${esc(row.name)}</td><td class="is-num">${row.present}</td>
    <td class="is-num">${row.late}</td><td class="is-num">${row.absent}</td><td class="is-num">${row.leave}</td>
    <td class="is-num">${row.hours}</td></tr>`).join('') || '<tr><td colspan="6" class="ws-empty">لا توجد بيانات في هذا النطاق.</td></tr>';
  if ($('hrReportRange')) $('hrReportRange').textContent = `${from || 'البداية'} → ${to || 'اليوم'}`;
}
function printHrReport() {
  const rows = hrReportRows($('hrReportStaff')?.value || 'all', $('hrReportFrom')?.value || '', $('hrReportTo')?.value || '');
  const area = $('printAreaA5');
  if (!area) return;
  area.innerHTML = `<div style="padding:14px;font-family:'Cairo',Tahoma,sans-serif" dir="rtl">
    <h2 style="margin:0 0 8px">${esc(db.settings.name)} — تقرير الحضور والانصراف</h2>
    <p style="margin:0 0 10px;font-size:11px">${esc($('hrReportRange')?.textContent || '')}</p>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      <thead><tr><th>الموظف</th><th>حضور</th><th>تأخير</th><th>غياب</th><th>إجازات</th><th>ساعات</th></tr></thead>
      <tbody>${rows.map(row => `<tr><td>${esc(row.name)}</td><td>${row.present}</td><td>${row.late}</td><td>${row.absent}</td><td>${row.leave}</td><td>${row.hours}</td></tr>`).join('')}</tbody>
    </table></div>`;
  window.print();
}

const SEC_TITLES = {
  'sec-invoice': '🛒 شاشة البيع والاستعلام', 'sec-items': '📦 بيانات الأصناف والمخزون',
  'sec-categories': '📁 بيانات المجموعات', 'sec-stock': '🏢 جرد المخزن',
  'sec-labels': '🏷️ طباعة ملصقات الباركود', 'sec-parties': '👥 إدارة العملاء والموردين',
  'sec-invlog': '📑 سجل الفواتير', 'sec-treasury': '💰 الخزنة والحسابات',
  'sec-profits': '📈 التقارير والأرباح', 'sec-settings': '⚙️ إعدادات النظام', 'sec-hr': '👔 إدارة الموظفين',
  'sec-contact': '📞 اتصل بنا', 'sec-maintenance': '🛠️ الصيانة'
};
const floatWindows = new Map();
let activeFloatId = null;
let floatZ = 6000;
function openSec(secId, titleText) {
  const permission = ({ 'sec-items': 'inventory', 'sec-categories': 'inventory', 'sec-stock': 'stock', 'sec-settings': 'admin', 'sec-profits': 'admin', 'sec-treasury': 'cash', 'sec-labels': 'inventory' })[secId];
  if (permission && !ensurePermission(permission)) return;
  if (secId === 'sec-parties' && !ensurePermission($('partyType').value === 'supplier' ? 'supplier' : 'customer')) return;
  const title = titleText || SEC_TITLES[secId] || 'شاشة البرنامج';
  $(secId)?.classList.add('active');
  document.body.classList.add('section-open');
  document.body.style.overflow = 'hidden';
  setActiveNav(({ 'sec-settings': 'settings', 'sec-parties': 'customers', 'sec-invoice': 'sale' })[secId] || '');
  $('winTitle').textContent = title;
  openFloatWindow(secId, title);
  if (secId === 'sec-items') { populateCategoriesSelect(); renderItemsTable(); }
  if (secId === 'sec-categories') renderCategoriesTable();
  if (secId === 'sec-parties') renderPartiesTable();
  if (secId === 'sec-hr') { renderHr(); showHrPanel($('sec-hr').dataset.hrPanel || 'employees'); }
  if (secId === 'sec-settings') loadSettingsForm();
  if (secId === 'sec-invlog') renderInvLog();
  if (secId === 'sec-treasury') { renderTreasury(); if ($('kpiCashSide')) $('kpiCashSide').textContent = money(treasuryBalance()); }
  if (secId === 'sec-profits') renderProfits();
  if (secId === 'sec-labels') { loadLabelOptions(); renderLabels(); }
  if (secId === 'sec-invoice') renderPosTiles();
  if (secId === 'sec-contact') renderContactMessages();
  if (secId === 'sec-maintenance') renderMaintenanceRequests();
}
function openFloatWindow(secId, title) {
  const section = $(secId);
  if (!section) return;
  let win = floatWindows.get(secId);
  if (!win) {
    const el = document.createElement('div');
    el.className = 'float-window';
    el.dataset.section = secId;
    el.innerHTML = `<div class="float-titlebar"><span class="float-title">${esc(title)}</span><div class="float-controls"><button type="button" class="float-btn" data-float-min title="تصغير" aria-label="تصغير">—</button><button type="button" class="float-btn" data-float-max title="تكبير" aria-label="تكبير">▢</button><button type="button" class="float-btn float-close" data-float-close title="إغلاق" aria-label="إغلاق">✕</button></div></div><div class="float-body"></div>`;
    const body = el.querySelector('.float-body');
    body.appendChild(section);
    el.querySelector('[data-float-min]').addEventListener('click', () => minimizeFloat(secId));
    el.querySelector('[data-float-max]').addEventListener('click', () => maximizeFloat(secId));
    el.querySelector('[data-float-close]').addEventListener('click', () => closeFloat(secId));
    const bar = el.querySelector('.float-titlebar');
    bar.addEventListener('pointerdown', event => {
      if (event.target.closest('button') || window.innerWidth <= 760) return;
      focusFloat(secId);
      const startX = event.clientX, startY = event.clientY;
      const rect = el.getBoundingClientRect();
      const offsetX = startX - rect.left, offsetY = startY - rect.top;
      const move = ev => {
        const x = Math.min(Math.max(0, ev.clientX - offsetX), window.innerWidth - 140);
        const y = Math.min(Math.max(0, ev.clientY - offsetY), window.innerHeight - 140);
        el.style.left = `${x}px`; el.style.top = `${y}px`;
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    });
    $('floatWindows').appendChild(el);
    win = { el, body, section };
    floatWindows.set(secId, win);
  }
  const count = floatWindows.size;
  const offset = (count - 1) * 26;
  win.el.style.left = `${72 + offset}px`;
  win.el.style.top = `${56 + offset}px`;
  win.el.style.width = 'min(980px, calc(100vw - 144px))';
  win.el.style.height = 'min(660px, calc(100vh - 190px))';
  win.el.classList.remove('minimized', 'maximized');
  $('windowLayer').classList.add('open');
  $('windowLayer').classList.remove('minimized', 'maximized');
  $('windowDock').hidden = true;
  focusFloat(secId);
  updateFloatTaskbar();
}
function focusFloat(secId) {
  const win = floatWindows.get(secId);
  if (!win) return;
  activeFloatId = secId;
  floatWindows.forEach((w, id) => w.el.classList.toggle('active', id === secId));
  win.el.style.zIndex = String(++floatZ);
  win.el.classList.remove('minimized');
  updateFloatTaskbar();
}
function closeFloat(secId) {
  const win = floatWindows.get(secId);
  if (!win) return;
  const pool = $('sectionPool')?.querySelector('.win-body');
  if (pool) pool.appendChild(win.section);
  win.section.classList.remove('active');
  win.el.remove();
  floatWindows.delete(secId);
  if (activeFloatId === secId) activeFloatId = [...floatWindows.keys()].at(-1) || null;
  if (!floatWindows.size) {
    $('windowLayer').classList.remove('open', 'minimized', 'maximized');
    $('windowDock').hidden = true;
    document.body.classList.remove('section-open');
    document.body.style.overflow = '';
    setActiveNav('home');
  } else if (activeFloatId) focusFloat(activeFloatId);
  updateFloatTaskbar();
}
function closeAllFloat() {
  for (const secId of [...floatWindows.keys()]) closeFloat(secId);
  $('windowLayer').classList.remove('open', 'minimized', 'maximized');
  $('windowDock').hidden = true;
  document.body.classList.remove('section-open');
  document.body.style.overflow = '';
  setActiveNav('home');
}
function minimizeFloat(secId) {
  const win = floatWindows.get(secId);
  if (!win) return;
  win.el.classList.add('minimized');
  if (activeFloatId === secId) activeFloatId = [...floatWindows.keys()].filter(id => !floatWindows.get(id).el.classList.contains('minimized')).at(-1) || null;
  if ([...floatWindows.values()].some(w => w.el.classList.contains('minimized'))) $('windowDock').hidden = false;
  updateFloatTaskbar();
}
function maximizeFloat(secId) {
  const win = floatWindows.get(secId);
  if (!win) return;
  win.el.classList.toggle('maximized');
  $('windowLayer').classList.toggle('maximized', win.el.classList.contains('maximized'));
}
function updateFloatTaskbar() {
  const taskbar = $('floatTaskbar');
  if (!taskbar) return;
  const entries = [...floatWindows.entries()];
  taskbar.hidden = entries.length === 0;
  taskbar.innerHTML = `<span class="taskbar-label">النوافذ المفتوحة</span>` + entries.map(([id]) => `<button type="button" class="taskbar-btn ${id === activeFloatId ? 'active' : ''}" onclick="focusFloat('${id}')"><span>${esc(SEC_TITLES[id] || 'نافذة')}</span></button>`).join('');
}
function setActiveNav(name) {
  document.querySelectorAll('#mainNav .main-nav-link').forEach(link => link.classList.toggle('active', link.dataset.nav === name));
}
function quickPlaceholder(name) {
  const title = $('placeholderTitle'), heading = $('placeholderHeading'), text = $('placeholderText');
  if (title) title.textContent = `🚧 ${name}`;
  if (heading) heading.textContent = `قسم ${name}`;
  if (text) text.textContent = `قسم «${name}» من ضمن التخطيط الجديد للبرنامج وسيتم تفعيله في التحديث القادم. باقي الشاشات تعمل بشكل كامل.`;
  openSec('sec-placeholder', `🚧 ${name}`);
}
const CONTACT_KEY = `${DB_KEY}_CONTACT_MESSAGES`;
const MAINTENANCE_KEY = `${DB_KEY}_MAINTENANCE_REQUESTS`;
function readLocalList(key) {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function writeLocalList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); }
  catch { notify('تعذر حفظ البيانات محلياً. تحقق من مساحة التخزين.'); }
}
function saveContactMessage() {
  const name = $('contactName').value.trim(), phone = $('contactPhone').value.trim(), email = $('contactEmail').value.trim();
  const subject = $('contactSubject').value.trim(), message = $('contactMessage').value.trim();
  if (!name || !message) return alert('الاسم والرسالة مطلوبان.');
  const list = readLocalList(CONTACT_KEY);
  list.unshift({ id: Date.now(), date: localDate(), time: new Date().toTimeString().slice(0, 5), name, phone, email, subject, message, read: false });
  writeLocalList(CONTACT_KEY, list);
  ['contactName', 'contactPhone', 'contactEmail', 'contactSubject', 'contactMessage'].forEach(id => { $(id).value = ''; });
  renderContactMessages();
  notify('✅ تم حفظ الرسالة على هذا الجهاز.');
}
function renderContactMessages() {
  const list = readLocalList(CONTACT_KEY);
  $('contactTbody').innerHTML = list.map((m, index) => `<tr><td>${index + 1}</td><td>${esc(m.date)} ${esc(m.time || '')}</td><td>${esc(m.name)}</td><td>${esc(m.subject || '-')}</td><td>${m.read ? 'مقروءة' : 'جديدة'}</td><td class="no-print"><button type="button" class="act-btn bg-blue" onclick="markContactRead(${m.id})">تعيين كمقروء</button><button type="button" class="act-btn bg-red" onclick="deleteContactMessage(${m.id})">حذف</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty-row">لا توجد رسائل بعد.</td></tr>';
}
function markContactRead(id) {
  writeLocalList(CONTACT_KEY, readLocalList(CONTACT_KEY).map(m => m.id === id ? { ...m, read: true } : m));
  renderContactMessages();
}
function deleteContactMessage(id) {
  writeLocalList(CONTACT_KEY, readLocalList(CONTACT_KEY).filter(m => m.id !== id));
  renderContactMessages();
}
function saveMaintenanceRequest() {
  const device = $('maintDevice').value.trim(), issue = $('maintIssue').value.trim(), priority = $('maintPriority').value;
  if (!device || !issue) return alert('اسم الجهاز والمشكلة مطلوبان.');
  const list = readLocalList(MAINTENANCE_KEY);
  list.unshift({ id: Date.now(), date: localDate(), device, issue, priority, status: 'new' });
  writeLocalList(MAINTENANCE_KEY, list);
  $('maintDevice').value = ''; $('maintIssue').value = ''; $('maintPriority').value = 'medium';
  renderMaintenanceRequests();
  notify('✅ تم تسجيل طلب الصيانة.');
}
function renderMaintenanceRequests() {
  const labels = { low: 'منخفضة', medium: 'متوسطة', high: 'عالية', new: 'جديد', progress: 'قيد التنفيذ', done: 'مكتمل' };
  const list = readLocalList(MAINTENANCE_KEY);
  $('maintenanceTbody').innerHTML = list.map((m, index) => `<tr><td>${index + 1}</td><td>${esc(m.date)}</td><td>${esc(m.device)}</td><td>${esc(m.issue)}</td><td>${esc(labels[m.priority] || m.priority)}</td><td>${esc(labels[m.status] || m.status)}</td><td class="no-print"><button type="button" class="act-btn bg-blue" onclick="advanceMaintenanceStatus(${m.id})">تحديث الحالة</button><button type="button" class="act-btn bg-red" onclick="deleteMaintenanceRequest(${m.id})">حذف</button></td></tr>`).join('') || '<tr><td colspan="7" class="empty-row">لا توجد طلبات صيانة.</td></tr>';
}
function advanceMaintenanceStatus(id) {
  const order = ['new', 'progress', 'done'];
  writeLocalList(MAINTENANCE_KEY, readLocalList(MAINTENANCE_KEY).map(m => m.id === id ? { ...m, status: order[(order.indexOf(m.status) + 1) % order.length] } : m));
  renderMaintenanceRequests();
}
function deleteMaintenanceRequest(id) {
  writeLocalList(MAINTENANCE_KEY, readLocalList(MAINTENANCE_KEY).filter(m => m.id !== id));
  renderMaintenanceRequests();
}
function closeWorkspace() {
  // in the tabbed shell the ✕ of a page closes its tab, so the strip and the screen stay in step
  if (document.body.classList.contains('shell-v2') && activeTab && activeTab !== 'home') { closeTab(activeTab); return; }
  if (activeFloatId) closeFloat(activeFloatId);
  else closeAllFloat();
}
function minimizeWorkspace() {
  if (activeFloatId) { minimizeFloat(activeFloatId); $('windowDock').hidden = false; }
  else if ($('windowLayer').classList.contains('open')) { $('windowLayer').classList.add('minimized'); $('windowDock').hidden = false; }
}
function restoreWorkspace() {
  let win = activeFloatId ? floatWindows.get(activeFloatId) : null;
  if (!win || !win.el.classList.contains('minimized')) {
    const first = [...floatWindows.entries()].find(([, w]) => w.el.classList.contains('minimized'));
    if (first) win = first[1];
  }
  if (win) {
    win.el.classList.remove('minimized');
    focusFloat(win.section.id);
  }
  $('windowDock').hidden = true;
  document.body.style.overflow = 'hidden';
}
function maximizeWorkspace() {
  if (activeFloatId) maximizeFloat(activeFloatId);
  else $('windowLayer').classList.toggle('maximized');
}

function getAppearance() {
  try { return JSON.parse(localStorage.getItem(APPEARANCE_KEY) || '{}') || {}; } catch { return {}; }
}
function saveAppearance(settings) {
  try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(settings)); } catch { notify('تعذر حفظ تفضيلات المظهر في المتصفح.'); }
}
function applyAppearance() {
  const appearance = getAppearance();
  const theme = THEMES.includes(appearance.theme) ? appearance.theme : 'win11-indigo';
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
function previewTheme(theme) {
  if (!THEMES.includes(theme)) return;
  document.body.dataset.theme = theme;
  const accent = ACCENT_DEFAULTS[theme];
  if (accent) {
    const root = document.body.style;
    root.setProperty('--accent', accent);
    root.setProperty('--g-bar', accent);
    root.setProperty('--g-dark', `color-mix(in srgb, ${accent} 82%, #000000)`);
    root.setProperty('--g-line', `color-mix(in srgb, ${accent} 68%, #000000)`);
    root.setProperty('--press-glow', `${accent}55`);
  }
}
function restoreThemePreview() {
  applyAppearance();
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
  closeAllFloat(); $('appShell').classList.remove('sidebar-open'); $('navScrim').hidden = true;
  setActiveNav('home');
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
  paintLookControls(lookSettings());
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
  const lowCount = db.items.filter(i => i.qty <= i.minQty).length;
  if ($('kpiLowStock')) $('kpiLowStock').textContent = lowCount;
  paintKpiStates({ cash, salesToday, lowCount });
  if ($('dashKpiCash')) $('dashKpiCash').textContent = money(cash);
  if ($('dashKpiSales')) $('dashKpiSales').textContent = money(salesToday);
  if ($('dashKpiProfit')) $('dashKpiProfit').textContent = money(calculateTotalProfits().net);
  if ($('dashKpiLow')) $('dashKpiLow').textContent = String(lowCount);
  const kpiStrip = [['dashKpiCash', cash < 0 ? 'bad' : cash === 0 ? 'warn' : 'good'], ['dashKpiSales', salesToday > 0 ? 'good' : 'warn'],
    ['dashKpiProfit', calculateTotalProfits().net > 0 ? 'good' : 'warn'], ['dashKpiLow', lowCount === 0 ? 'good' : lowCount > 5 ? 'bad' : 'warn']];
  for (const [id, state] of kpiStrip) { const card = $(id)?.closest('.dash-kpi'); if (card) card.dataset.state = state; }
  if ($('kpiCashSide')) $('kpiCashSide').textContent = money(cash);
}

/* ------------------------------------------------------------------ */
/* Design studio: full control over colours, images, shapes            */
/* ------------------------------------------------------------------ */
function paintKpiStates({ cash = 0, salesToday = 0, lowCount = 0 } = {}) {
  const setState = (id, state, trend) => {
    const box = $(id)?.closest('.kpi-box');
    if (!box) return;
    if (state) box.dataset.state = state; else delete box.dataset.state;
    const strong = box.querySelector('strong');
    if (!strong) return;
    let badge = box.querySelector('.kpi-trend');
    if (trend === null || trend === undefined || !Number.isFinite(trend)) { badge?.remove(); return; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'kpi-trend'; strong.after(badge); }
    badge.dataset.dir = trend >= 0 ? 'up' : 'down';
    badge.textContent = `${trend >= 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(0)}%`;
  };
  const yesterdayDate = new Date(); yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = localDate(yesterdayDate);
  const salesBefore = db.invoices.reduce((sum, inv) => sum + (inv.date === yesterday ? (inv.mode === 'sale' ? inv.netTotal : inv.mode === 'sale_return' ? -inv.netTotal : 0) : 0), 0);
  const trend = salesBefore > 0 ? ((salesToday - salesBefore) / salesBefore) * 100 : null;
  setState('kpiCash', cash < 0 ? 'bad' : cash === 0 ? 'warn' : 'good', null);
  setState('kpiSalesToday', salesToday > 0 ? 'good' : 'warn', trend);
  const profit = calculateTotalProfits().net;
  setState('kpiNetProfit', profit > 0 ? 'good' : profit < 0 ? 'bad' : 'warn', null);
  setState('kpiLowStock', lowCount === 0 ? 'good' : lowCount > 5 ? 'bad' : 'warn', null);
}

/* ===================== POLISH LAYER: save flash, state tags, avatars, paper, labels, receipt, focus ===================== */
/* #5 — visible confirmation when a transaction is saved */
function flashSaveSuccess(message = 'تم الحفظ') {
  const badge = $('syncStatusBadge');
  if (badge) {
    badge.dataset.flash = 'ok';
    window.setTimeout(() => { delete badge.dataset.flash; }, 1200);
  }
  document.querySelectorAll('.save-flash-check').forEach(node => node.remove());
  const toast = document.createElement('div');
  toast.className = 'save-flash-check';
  toast.setAttribute('role', 'status');
  toast.innerHTML = `${lookIcon('save')}<span>${esc(message)}</span>`;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 1600);
}
/* #10 — coloured state tags for invoice / item rows */
function invoiceStateTag(inv) {
  if (inv.mode === 'quote') return inv.convertedToId
    ? `<span class="state-tag" data-tag="converted">محوّلة إلى #${esc(inv.convertedToId)}</span>`
    : '<span class="state-tag" data-tag="quote">عرض سعر</span>';
  if (inv.mode.endsWith('_return')) return '<span class="state-tag" data-tag="return">مرتجع</span>';
  if (Number(inv.remainAmount) > 0.009) return `<span class="state-tag" data-tag="due">آجل ${money(inv.remainAmount)}</span>`;
  return '<span class="state-tag" data-tag="paid">مسدَّد</span>';
}
function stockStateTag(item) {
  if (Number(item.qty) <= 0) return '<span class="state-tag" data-tag="void">نافد</span>';
  if (Number(item.qty) <= Number(item.minQty)) return `<span class="state-tag" data-tag="due">حد الطلب</span>`;
  return '';
}
/* #11 — initials avatar for the signed-in staff and the activity log */
function avatarInitials(name) {
  const clean = String(name || '؟').trim().replace(/\s+/g, ' ');
  if (!clean) return '؟';
  const parts = clean.split(' ');
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : clean.slice(0, 2)).toUpperCase();
}
function avatarMarkup(name, size = 'md') {
  return `<span class="avatar-circle" data-size="${size}" aria-hidden="true">${esc(avatarInitials(name))}</span>`;
}
function paintStaffAvatar() {
  const badge = $('activeUserBadge');
  if (!badge) return;
  const user = activeStaff();
  badge.innerHTML = `${avatarMarkup(user.name, 'sm')}<span>${esc(user.name)} · ${esc(roleLabel(user.role))}</span>`;
}
/* #13 — paper frame and watermark for A5 / PDF */
function docPaperOptions() { return { frame: 'none', watermark: '', ...(docSettings().paper || {}) }; }
function setDocFrame(frame) {
  if (!['none', 'line', 'ornament'].includes(frame)) return;
  saveDocSettings({ paper: { ...docPaperOptions(), frame } });
  applyDocSettingsUI();
}
function setDocWatermark(value) {
  const text = String(value || '').slice(0, 28);
  saveDocSettings({ paper: { ...docPaperOptions(), watermark: text } });
  applyDocSettingsUI();
}
function paperFrameCss(paper, frame) {
  if (frame === 'ornament') return `<style>@media print,.preview-paper{}.doc{border:2px solid ${paper};border-radius:6px;padding:10px 12px;position:relative}.doc::before{content:'';position:absolute;inset:4px;border:1px solid ${paper};opacity:.45;border-radius:4px;pointer-events:none}</style>`;
  if (frame === 'line') return `<style>.doc{border-inline-start:5px solid ${paper};padding-inline-start:12px}</style>`;
  return '';
}
/* #14 — label templates */
function setLabelTemplate(template) {
  if (!['standard', 'price', 'barcode', 'mini'].includes(template)) return;
  saveLook({ labelTemplate: template });
  renderLabels();
}
/* #15 — thermal receipt style with a live preview */
function receiptStyle() {
  const style = lookSettings().receiptStyle;
  return ['compact', 'detailed', 'dashed'].includes(style) ? style : 'compact';
}
function setReceiptStyle(style) {
  if (!['compact', 'detailed', 'dashed'].includes(style)) return;
  saveLook({ receiptStyle: style });
  if ($('receiptPreviewBox') && !$('receiptPreviewBox').hidden) previewReceiptStyle();
}
function previewReceiptStyle() {
  const box = $('receiptPreviewBox');
  if (!box) return;
  const style = receiptStyle();
  const sample = { id: 1042, mode: 'sale', date: localDate(), time: '12:30', partyName: 'عميل نقدي', netTotal: 275, paidAmount: 300, remainAmount: 0, subtotal: 285, discountTotal: 10,
    items: [{ name: 'كشكول 60 ورقة', qty: 2, price: 25, netTotal: 50 }, { name: 'قلم جاف أزرق', qty: 5, price: 9, netTotal: 45 }] };
  const rows = sample.items.map(line => style === 'compact'
    ? `<div class="rp-line"><span>${esc(line.qty)} × ${money(line.price)}</span><span>${money(line.netTotal)}</span></div>`
    : `<div class="rp-line"><span>${esc(line.name)}<br><small>${esc(line.qty)} × ${money(line.price)}</small></span><span>${money(line.netTotal)}</span></div>`).join('');
  box.innerHTML = `<h4>${esc(db.settings.name)}</h4>${style === 'compact' ? `<p>${esc(MODE_LABELS[sample.mode])} #${sample.id}</p>` : `<p>${esc(db.settings.address)}</p><p>${esc(db.settings.phone)}</p><p>${esc(MODE_LABELS[sample.mode])} #${sample.id} — ${esc(sample.date)}</p>`}
    ${style === 'dashed' ? '<p>------------------------------</p>' : ''}${rows}${style === 'dashed' ? '<p>------------------------------</p>' : ''}
    <div class="rp-line"><span>الصافي</span><b>${money(sample.netTotal)}</b></div><div class="rp-line"><span>المدفوع</span><b>${money(sample.paidAmount)}</b></div>
    <p style="text-align:center;margin-top:6px">${style === 'detailed' ? 'شكراً لتعاملكم معنا — الاستبدال خلال 14 يوماً بشرط الإيصال' : 'شكراً لتعاملكم معنا'}</p>`;
  box.hidden = false;
}
/* #16 — generate app icons locally from the store logo + brand colour */
function appIconSettings() { return { color: '#0f5132', logo: '', ...(lookSettings().appIcon || {}) }; }
function setAppIconColor(color) {
  if (!/^#[0-9a-f]{6}$/i.test(String(color))) return;
  saveLook({ appIcon: { ...appIconSettings(), color } });
  paintAppIconPreview();
}
function uploadAppIcon(input) {
  readImageFile(input, dataUrl => { saveLook({ appIcon: { ...appIconSettings(), logo: dataUrl } }); paintAppIconPreview(); notify('تم تجهيز الأيقونة — نزّلها الآن.'); });
}
function paintAppIconPreview() {
  const box = $('appIconPreview');
  if (!box) return;
  const config = appIconSettings();
  box.style.background = config.logo ? `linear-gradient(140deg,${config.color},color-mix(in srgb,${config.color} 65%,#000000))` : `linear-gradient(140deg,${config.color},color-mix(in srgb,${config.color} 60%,#ffffff))`;
  box.innerHTML = config.logo ? `<img src="${config.logo}" alt="أيقونة">` : esc(avatarInitials(db.settings.name));
  if ($('appIconColor')) $('appIconColor').value = config.color;
}
function buildAppIconCanvas(size = 512) {
  const config = appIconSettings();
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx || typeof ctx.fillText !== 'function') return null;
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, config.color);
  gradient.addColorStop(1, '#0b1b30');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${Math.round(size * 0.42)}px Cairo, Tahoma, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(avatarInitials(db.settings.name), size / 2, size / 2 + size * 0.02);
  if (config.logo) {
    const img = new Image();
    img.onload = () => { const pad = size * 0.16; ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2); downloadCanvas(canvas, size); };
    img.onerror = () => downloadCanvas(canvas, size);
    img.src = config.logo;
    return canvas;
  }
  downloadCanvas(canvas, size);
  return canvas;
}
function downloadCanvas(canvas, size) {
  try {
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url; link.download = `app-icon-${size}.png`;
    document.body.append(link); link.click(); link.remove();
    notify(`تم تنزيل أيقونة ${size}×${size} بنجاح.`);
  } catch { notify('تعذر توليد الأيقونة على هذا المتصفح.'); }
}
function downloadAppIcon(size = 512) {
  const created = buildAppIconCanvas(size);
  if (!created) notify('تعذر توليد الأيقونة على هذا المتصفح.');
}
/* #18 — kiosk focus mode + rail sidebar */
function enterFocusMode() {
  document.body.dataset.focus = 'on';
  if ($('windowLayer') && !$('windowLayer').classList.contains('open')) openInvoiceSec('sale');
  notify('وضع التركيز مفعّل — اضغط Esc أو «إنهاء التركيز» للخروج.');
}
function exitFocusMode() {
  delete document.body.dataset.focus;
}
function toggleFocusMode(force) {
  const on = force === undefined ? document.body.dataset.focus !== 'on' : Boolean(force);
  if (on) enterFocusMode(); else exitFocusMode();
}
function toggleRailSidebar(checked) {
  saveLook({ rail: Boolean(checked) });
}

/* ===================== LOOK LAYER: density, palettes, icons, header, night, POS shape ===================== */
const LOOK_KEY = `${DB_KEY}_LOOK`;
const LOOK_DEFAULTS = Object.freeze({
  density: 'cozy', look: 'glass', fontWeight: 'normal', numerals: 'normal', icons: 'emoji', motion: 'on',
  palette: 'bookstore', headerStyle: 'name', headerAlign: 'start', storeLogo: '', receiptLogo: false,
  nightMode: 'cool', autoNight: 'off', tileStyle: 'tiles', cartDensity: 'normal',
  colDisc: true, colGross: true, colTime: false, groupColors: true,
  buttons: 'soft', cvd: 'off', rail: false, labelTemplate: 'standard', receiptStyle: 'compact',
  appIcon: { color: '#0f5132', logo: '' }
});
const LOOK_OPTIONS = Object.freeze({
  density: ['cozy', 'compact', 'ultra'], look: ['glass', 'flat', 'sharp'], fontWeight: ['normal', 'bold'],
  numerals: ['normal', 'tabular'], icons: ['emoji', 'svg'], motion: ['on', 'off'],
  headerStyle: ['name', 'logo', 'banner'], headerAlign: ['start', 'center', 'end'],
  tileStyle: ['tiles', 'lines', 'grid'], cartDensity: ['normal', 'tall'],
  buttons: ['pill', 'soft', 'classic'], cvd: ['off', 'on']
});
const LOOK_ATTR = Object.freeze({ density: 'density', look: 'look', fontWeight: 'fontWeight', numerals: 'numerals',
  icons: 'icons', motion: 'motion', tileStyle: 'posStyle', cartDensity: 'cartDensity', buttons: 'buttons', cvd: 'cvd' });
const PALETTES = Object.freeze({
  bookstore: { headerA: '#0f5132', headerB: '#2f9e63', sideA: '#0b3b25', sideB: '#17694a', radius: 12, shadow: 2, appBg: '#dfe8dd', buttonBg: '#f4f9f2', buttonText: '#173323', borderColor: '#a8c4ad' },
  academic: { headerA: '#0b2d5c', headerB: '#2a7fd4', sideA: '#081f42', sideB: '#1a5490', radius: 10, shadow: 2, appBg: '#dde6f2', buttonBg: '#f2f6fd', buttonText: '#16294a', borderColor: '#a6bad8' },
  terracotta: { headerA: '#6d2f18', headerB: '#d97742', sideA: '#4f2011', sideB: '#98502a', radius: 16, shadow: 2, appBg: '#f1e4da', buttonBg: '#fff7f1', buttonText: '#4a2417', borderColor: '#d8b49c' },
  graphite: { headerA: '#1b2431', headerB: '#5b6b7d', sideA: '#121a24', sideB: '#37424f', radius: 6, shadow: 1, appBg: '#dfe2e8', buttonBg: '#f3f5f8', buttonText: '#1f2733', borderColor: '#b3bac6' },
  violet: { headerA: '#2e1065', headerB: '#7c4dff', sideA: '#210b4d', sideB: '#5a2fd0', radius: 16, shadow: 2, appBg: '#e3ddf4', buttonBg: '#f7f4ff', buttonText: '#2a1d4a', borderColor: '#b8a9dd' },
  charcoal: { headerA: '#0b0f14', headerB: '#39424e', sideA: '#070a0e', sideB: '#232b34', radius: 4, shadow: 1, appBg: '#d4d8dd', buttonBg: '#f2f4f6', buttonText: '#1b222a', borderColor: '#9aa4af' }
});
const ICON_PATHS = Object.freeze({
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5"/><path d="M10 21v-6h4v6"/>',
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3.5h2.6l2.6 11h10.6l2.2-8H6"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M8.5 8h7"/><path d="M8.5 12h7"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>',
  tag: '<path d="M20 12.5 12.5 20 3 10.5V3h7.5z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-5.4 6-5.4s6 2.1 6 5.4"/><path d="M16 5.2a3 3 0 0 1 0 5.6"/><path d="M18 20c0-2.2-.7-3.9-2-5"/>',
  truck: '<path d="M2.5 6.5h11v9h-11z"/><path d="M13.5 10h4l3 3v2.5h-7z"/><circle cx="6" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>',
  wallet: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H19v14H5.5A2.5 2.5 0 0 1 3 16.5z"/><path d="M16 12h3.5"/>',
  lock: '<rect x="4.5" y="10" width="15" height="10.5" rx="2"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16v-4"/><path d="M12.5 16V8"/><path d="M17 16v-6"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2.5h8.9A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18z"/>',
  alert: '<path d="M12 3.5 21 19H3z"/><path d="M12 9.5v4"/><path d="M12 16.4h.01"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.6M12 18.6v2.6M4.4 7.5l2.3 1.3M17.3 15.2l2.3 1.3M4.4 16.5l2.3-1.3M17.3 8.8l2.3-1.3"/>',
  printer: '<path d="M7 8V3.5h10V8"/><rect x="3.5" y="8" width="17" height="8" rx="2"/><path d="M7 13h10v7.5H7z"/>',
  save: '<path d="M4.5 4.5h11l4 4v11h-15z"/><path d="M8 4.5v5h7v-5"/><path d="M8 19.5v-5h8v5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  pause: '<rect x="6.5" y="4.5" width="3.5" height="15" rx="1"/><rect x="14" y="4.5" width="3.5" height="15" rx="1"/>',
  undo: '<path d="M9 6.5 4 11l5 4.5"/><path d="M4 11h9.5a5.5 5.5 0 0 1 0 11H10"/>',
  swap: '<path d="M4 8h13l-3.2-3.2"/><path d="M20 16H7l3.2 3.2"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9 6.5V4h6v2.5"/><path d="M6.5 6.5 7.5 20h9l1-13.5"/>',
  moon: '<path d="M20 13.5A8 8 0 0 1 10.5 4 8.2 8.2 0 1 0 20 13.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"/>',
  download: '<path d="M12 3.5v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.5c0-3.7 3.2-6.1 7.2-6.1s7.2 2.4 7.2 6.1"/>',
  menu: '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  bell: '<path d="M12 3.5a5.5 5.5 0 0 1 5.5 5.5c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5A5.5 5.5 0 0 1 12 3.5z"/><path d="M10 18a2 2 0 0 0 4 0"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  doc: '<path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5V8h4"/>'
});
const EMOJI_ICON_MAP = Object.freeze({
  '🛒': 'cart', '🧾': 'receipt', '📥': 'truck', '📦': 'box', '🏷️': 'tag', '👥': 'users', '🚚': 'truck',
  '💰': 'wallet', '🔐': 'lock', '📈': 'chart', '📁': 'folder', '⚠️': 'alert', '⚙️': 'settings', '🖨️': 'printer',
  '💾': 'save', '🔍': 'search', '⏸️': 'pause', '↩️': 'undo', '🔄': 'swap', '🗑️': 'trash', '🌙': 'moon', '☀️': 'sun',
  '⬇️': 'download', '👤': 'user', '☰': 'menu', '📄': 'doc', '🔔': 'bell', '➕': 'plus', '⌂': 'home', '◈': 'grid'
});
function lookSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}');
    return { ...LOOK_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch { return { ...LOOK_DEFAULTS }; }
}
function saveLook(patch) {
  const next = { ...lookSettings(), ...patch };
  try { localStorage.setItem(LOOK_KEY, JSON.stringify(next)); } catch { /* storage disabled */ }
  applyLook(next);
  return next;
}
function lookIcon(name, extraClass = '') {
  const path = ICON_PATHS[name];
  if (!path) return '';
  return `<svg class="look-svg-ico ${extraClass}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${path}</svg>`;
}
function applyLook(settings = lookSettings()) {
  const look = { ...LOOK_DEFAULTS, ...settings };
  const html = document.documentElement;
  for (const [key, attr] of Object.entries(LOOK_ATTR)) html.setAttribute(`data-${attr.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`, String(look[key]));
  html.setAttribute('data-font-weight', look.fontWeight === 'bold' ? 'bold' : 'normal');
  html.setAttribute('data-numerals', look.numerals === 'tabular' ? 'tabular' : 'normal');
  html.setAttribute('data-look', look.look);
  html.setAttribute('data-motion', look.motion);
  html.setAttribute('data-night', look.nightMode);
  html.setAttribute('data-icons', look.icons);
  html.setAttribute('data-group-colors', look.groupColors === false ? 'off' : 'on');
  html.setAttribute('data-col-disc', look.colDisc === false ? 'off' : 'on');
  html.setAttribute('data-col-gross', look.colGross === false ? 'off' : 'on');
  html.setAttribute('data-col-time', look.colTime === true ? 'off' : 'on');
  // header chrome
  const header = $('appHeader');
  if (header) {
    header.dataset.header = look.headerStyle;
    header.dataset.align = look.headerAlign;
    const logo = $('headLogoImg');
    if (logo) logo.src = look.storeLogo || '/icon-192.png';
  }
  const quick = $('posQuickItems');
  if (quick) quick.dataset.tileStyle = look.tileStyle;
  const wrap = $('posCartTableWrap');
  if (wrap) wrap.dataset.tall = look.cartDensity === 'tall' ? '1' : '0';
  document.body.dataset.night = look.nightMode;
  html.setAttribute('data-rail', look.rail ? 'on' : 'off');
  if ($('railSidebar')) $('railSidebar').checked = Boolean(look.rail);
  const labelTemplate = $('labelTemplate');
  if (labelTemplate && labelTemplate.value !== look.labelTemplate) {
    labelTemplate.value = look.labelTemplate;
    if ($('labelPreview')) renderLabels();
  }
  const receiptStyleSelect = $('receiptStyle');
  if (receiptStyleSelect) receiptStyleSelect.value = look.receiptStyle;
  if ($('docFrameSelect')) $('docFrameSelect').value = docPaperOptions().frame;
  if ($('docWatermarkInp') && document.activeElement !== $('docWatermarkInp')) $('docWatermarkInp').value = docPaperOptions().watermark;
  paintAppIconPreview();
  paintLookControls(look);
  paintIconMode(look.icons);
  if ($('appNavbar') && $('appNavbar').children.length) { paintNavbar(); renderDashboard(); }
  if ($('titleBarLogo')) $('titleBarLogo').src = look.storeLogo || '/icon-192.png';
  return look;
}
function paintLookControls(look) {
  const pairs = [['densitySeg', 'data-density-opt', 'density'], ['lookSeg', 'data-look-opt', 'look'], ['fontWeightSeg', 'data-fontweight-opt', 'fontWeight'],
    ['numeralsSeg', 'data-numerals-opt', 'numerals'], ['iconsSeg', 'data-icons-opt', 'icons'], ['motionSeg', 'data-motion-opt', 'motion'],
    ['headerStyleSeg', 'data-headerstyle-opt', 'headerStyle'], ['headerAlignSeg', 'data-headeralign-opt', 'headerAlign'],
    ['tileStyleSeg', 'data-tilestyle-opt', 'tileStyle'], ['cartDensitySeg', 'data-cartdensity-opt', 'cartDensity'],
    ['nightModeSeg', 'data-night-opt', 'nightMode'], ['autoNightSeg', 'data-autonight-opt', 'autoNight'],
    ['buttonShapeSeg', 'data-buttons-opt', 'buttons'], ['cvdSeg', 'data-cvd-opt', 'cvd']];
  for (const [segId, attr, key] of pairs) {
    const seg = $(segId);
    if (!seg) continue;
    seg.querySelectorAll(`[${attr}]`).forEach(button => {
      const active = button.getAttribute(attr) === String(look[key]);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  document.querySelectorAll('[data-palette]').forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.palette === look.palette)));
  for (const [id, key] of [['colDiscount', 'colDisc'], ['colGross', 'colGross'], ['colUnit', 'colTime'], ['groupColors', 'groupColors']]) {
    const input = $(id);
    if (input) input.checked = Boolean(look[key]);
  }
  const receiptLogo = $('receiptLogo');
  if (receiptLogo) receiptLogo.checked = Boolean(look.receiptLogo);
  const status = $('storeLogoStatus');
  if (status) status.textContent = look.storeLogo ? 'شعار مرفوع ✔' : 'الشعار الافتراضي';
  const nightOn = document.body.dataset.theme === 'night';
  const hint = $('lookHint');
  if (hint) hint.textContent = nightOn
    ? `الثيم الليلي مفعّل — ${look.nightMode === 'warm' ? 'نمط دافئ' : look.nightMode === 'contrast' ? 'تباين عالٍ' : 'كحلي بارد'}، والكثافة الحالية: ${look.density === 'ultra' ? 'فائق الضغط' : look.density === 'compact' ? 'مضغوط' : 'مريح'}.`
    : `الكثافة تتحكم في ارتفاع الصفوف والحشو وأحجام الأزرار — «فائق الضغط» مناسب للشاشات الصغيرة.`;
}
function setLookOption(key, value) {
  const allowed = LOOK_OPTIONS[key];
  if (!allowed || !allowed.includes(value)) return;
  saveLook({ [key]: value });
  if (key === 'cartDensity' || key === 'tileStyle') renderPosTiles();
  const labels = { density: 'كثافة العرض', look: 'شكل الحواف', fontWeight: 'وزن الخط', numerals: 'محاذاة الأرقام', icons: 'الأيقونات', motion: 'الحركة', headerStyle: 'نمط الترويسة', headerAlign: 'موضع الشعار', tileStyle: 'شكل الأصناف', cartDensity: 'ارتفاع السلة', buttons: 'شكل الأزرار', cvd: 'لوحة الألوان الآمنة' };
  notify(`تم تحديث ${labels[key] || 'المظهر'}.`);
}
function setNightMode(mode) {
  if (!['cool', 'warm', 'contrast'].includes(mode)) return;
  saveLook({ nightMode: mode });
  const appearance = getAppearance();
  if (appearance.theme !== 'night') {
    appearance.previousTheme = appearance.theme || 'vista-classic';
    appearance.theme = 'night';
    saveAppearance(appearance); applyAppearance();
  }
  notify(`تم تفعيل الوضع الليلي — ${mode === 'warm' ? 'دافئ' : mode === 'contrast' ? 'تباين عالٍ' : 'كحلي بارد'}.`);
}
function setAutoNight(mode) {
  saveLook({ autoNight: mode === 'on' ? 'on' : 'off' });
  applyAutoNight();
  notify(mode === 'on' ? 'سيتم تفعيل الوضع الليلي تلقائياً بعد الساعة 7 مساءً.' : 'تم إيقاف التبديل التلقائي للوضع الليلي.');
}
function applyAutoNight() {
  const look = lookSettings();
  if (look.autoNight !== 'on') return;
  const hour = new Date().getHours();
  const appearance = getAppearance();
  if (hour >= 19 || hour < 6) {
    if (appearance.theme !== 'night') {
      appearance.previousTheme = appearance.theme || 'vista-classic';
      appearance.theme = 'night';
      saveAppearance(appearance); applyAppearance();
    }
  } else if (appearance.theme === 'night' && appearance.previousTheme) {
    appearance.theme = appearance.previousTheme;
    saveAppearance(appearance); applyAppearance();
  }
}
function applyPalette(key) {
  const palette = PALETTES[key];
  if (!palette) return;
  const design = { ...getDesign(), ...palette };
  saveDesign(design);
  const appearance = getAppearance();
  appearance.theme = 'custom';
  delete appearance.accent;
  saveAppearance(appearance);
  document.body.dataset.theme = 'custom';
  saveLook({ palette: key });
  applyDesign();
  applyAppearance();
  notify('تم تطبيق لوحة الألوان على الهيدر والقائمة والأزرار.');
}
function toggleGroupColors(checked) {
  saveLook({ groupColors: Boolean(checked) });
}
function uploadStoreLogo(input) {
  readImageFile(input, dataUrl => {
    saveLook({ storeLogo: dataUrl });
    if (lookSettings().headerStyle === 'name') saveLook({ headerStyle: 'logo' });
    notify('تم حفظ شعار المكتبة، وسيظهر في الترويسة والفاتورة إن فعّلت ذلك.');
  });
}
function clearStoreLogo() {
  saveLook({ storeLogo: '' });
  notify('تمت العودة إلى الشعار الافتراضي.');
}
function toggleReceiptLogo(checked) {
  saveLook({ receiptLogo: Boolean(checked) });
}
function toggleCartColumn(column, checked) {
  const map = { disc: 'colDisc', gross: 'colGross', time: 'colTime' };
  const key = map[column];
  if (!key) return;
  saveLook({ [key]: Boolean(checked) });
}
function storeLogoSrc() {
  const look = lookSettings();
  if (!look.receiptLogo) return '';
  return look.storeLogo || '/icon-192.png';
}
/* ---- icon painting (SVG set replaces emoji everywhere, no external assets) ---- */
function iconKeyFor(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (EMOJI_ICON_MAP[raw]) return EMOJI_ICON_MAP[raw];
  const first = raw.match(/^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u)?.[0];
  return first ? (EMOJI_ICON_MAP[first] || '') : '';
}
function paintIconMode(mode = lookSettings().icons) {
  const svg = mode === 'svg';
  const swap = (element, key) => {
    if (!element) return;
    if (!svg) { if (element.dataset.emoji) { element.textContent = element.dataset.emoji; delete element.dataset.svg; } return; }
    const emoji = element.dataset.emoji || element.textContent.trim();
    if (!emoji) return;
    const name = key || iconKeyFor(emoji);
    if (!name) return;
    element.dataset.emoji = emoji; element.dataset.svg = name;
    element.innerHTML = lookIcon(name);
  };
  document.querySelectorAll('.c-btn .button-icon, .button-icon').forEach(element => swap(element));
  document.querySelectorAll('.nav-link .nav-icon').forEach(element => swap(element));
  document.querySelectorAll('.head-icon-btn').forEach(button => {
    const handler = button.getAttribute('onclick') || '';
    const key = handler.includes('toggleDarkMode') ? 'moon' : handler.includes('installApp') ? 'download' : handler.includes('lockApp') ? 'user' : '';
    if (!key) return;
    if (!button.dataset.emoji) button.dataset.emoji = button.textContent.trim();
    if (svg) { button.dataset.svg = key; button.innerHTML = lookIcon(key); }
    else if (button.dataset.svg) { button.textContent = button.dataset.emoji; delete button.dataset.svg; }
  });
  document.querySelectorAll('.y-btn .y-ico').forEach(element => swap(element));
  document.querySelectorAll('.pos-action span[aria-hidden="true"]').forEach(span => {
    if (svg) {
      const name = iconKeyFor(span.dataset.emoji || span.textContent);
      if (!name) return;
      if (!span.dataset.emoji) span.dataset.emoji = span.textContent.trim();
      span.dataset.svg = name;
      span.innerHTML = lookIcon(name);
    } else if (span.dataset.svg) {
      span.textContent = span.dataset.emoji || '';
      delete span.dataset.svg;
    }
  });
}

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
  setActiveNav(mode.startsWith('purchase') ? 'purchase' : 'sale');
  if (mode !== $('invMode').value) clearInvCart();
  $('invMode').value = mode; updateInvoiceUI();
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
  $$('[data-inv-group]').forEach(group => {
    const sticky = group.dataset.invAlways === '1';
    group.hidden = sticky ? false : group.dataset.invGroup !== tab;
  });
  if ($('invPanelTitle')) $('invPanelTitle').textContent = TAB_LABELS[tab] || '';
}
const MODE_BADGES = {
  sale: { icon: '💵', label: 'نقدي — إيراد' },
  sale_return: { icon: '↩️', label: 'مرتجع — يُخصم من الخزنة' },
  purchase: { icon: '🚚', label: 'تكلفة — يُخصم من الخزنة' },
  purchase_return: { icon: '↩️', label: 'مرتجع مشتريات — يُضاف للخزنة' },
  quote: { icon: '📄', label: 'عرض سعر — بدون تأثير مالي' }
};
function updateInvoiceUI() {
  const mode = $('invMode').value; lastInvoiceMode = mode;
  const supplier = mode.startsWith('purchase'), isReturn = mode.endsWith('_return'), quote = mode === 'quote';
  if ($('posTitleText')) $('posTitleText').textContent = MODE_LABELS[mode];
  const posWrap = document.querySelector('#sec-invoice .pos-wrap');
  if (posWrap) posWrap.dataset.mode = mode;
  if ($('posModeBadge')) {
    const badge = MODE_BADGES[mode] || MODE_BADGES.sale;
    $('posModeBadge').textContent = `${badge.icon} ${badge.label}`;
    $('posModeBadge').dataset.tone = mode;
  }
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
  paintInvoiceSelects();
  syncInvoiceChrome();
  if ($('invBarcodeInp') && invCart.length === 0) renderPosItemSearch('');
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
    const unit = esc((db.items.find(item => item.id === c.id) || {}).unit || 'عدد');
    return `<tr data-index="${index}" class="${index === selectedCartIndex ? 'selected-row' : ''}" onclick="selectCartRow(${index})">
      <td><strong>${esc(c.code)}</strong></td>
      <td class="cell-name is-name">${esc(c.name)}</td>
      <td>${unit}</td>
      <td><input aria-label="كمية ${esc(c.name)}" type="number" min="0.001" ${isReturn ? `max="${c.maxQty}"` : ''} step="any" value="${esc(c.qty)}" onchange="updateCartRow(${index},'qty',this.value)"></td>
      <td><input aria-label="سعر ${esc(c.name)}" type="number" min="0" step="any" value="${esc(c.price)}" ${isReturn ? 'disabled' : ''} onchange="updateCartRow(${index},'price',this.value)"></td>
      <td><input aria-label="خصم ${esc(c.name)}" type="number" min="0" max="100" step="any" value="${esc(c.discPct)}" ${isReturn ? 'disabled' : ''} onchange="updateCartRow(${index},'discPct',this.value)"></td>
      <td><strong>${money(gross)}</strong></td>
      <td><strong>${money(net)}</strong></td>
      <td class="no-print"><button type="button" class="iconbtn is-del" title="حذف البند" aria-label="حذف البند" onclick="event.stopPropagation();removeCartRow(${index})">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty-row">الفاتورة فارغة. اقرأ باركود الصنف أو اضغط على أحد الأصناف السريعة لإضافتها.</td></tr>';
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
  if (box) { box.hidden = !(change > 0.0001); box.dataset.state = change > 0.0001 ? 'over' : 'none'; }
  if (box) box.dataset.alert = change > tenderAlertLimit() + 0.0001 ? 'yes' : 'no';
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
  const theme = invoiceDocTheme(draft);
  $('previewPaper').dataset.tone = draft.mode;
  $('previewPaper').style.setProperty('--doc-accent', theme.accent);
  $('previewPaper').style.setProperty('--doc-soft', theme.soft);
  $('previewPaper').style.setProperty('--doc-head', theme.head);
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
async function confirmTenderDifference() {
  const net = roundMoney(Number($('invNetTotal')?.value) || 0);
  const paid = roundMoney(Number($('invPaidAmount')?.value) || 0);
  const change = roundMoney(paid - net);
  const limit = tenderAlertLimit();
  if (!(change > limit + 0.0001)) return true;
  const approved = await appConfirm(`الباقي للعميل ${money(change)} ج.م أكبر من حد التنبيه (${money(limit)} ج.م). راجع المبلغ المستلم قبل الحفظ.`,
    { title: 'فرق في الصندوق', icon: '⚠️', confirmText: 'المبلغ صحيح — متابعة', cancelText: 'رجوع للمراجعة', tone: 'cancel' });
  if (approved) recordAudit(`تنبيه فرق صندوق: باقٍ ${money(change)} على فاتورة ${MODE_LABELS[$('invMode').value]}`);
  return approved;
}
/* ---- 8) selling below cost needs a manager, like an over-limit discount ---- */
function belowCostLines() {
  if (!$('invMode').value.startsWith('sale') && $('invMode').value !== 'quote') return [];
  return invoiceLines({ items: invCart, subtotal: 0, discountTotal: 0, netTotal: 0, mode: $('invMode').value })
    .filter(line => { const item = db.items.find(entry => entry.id === line.id); return item && Number(item.buy) > 0 && Number(line.price) < Number(item.buy) - 0.0001; })
    .map(line => ({ name: line.name, price: Number(line.price), cost: Number(db.items.find(entry => entry.id === line.id)?.buy || 0) }));
}
async function confirmBelowCost() {
  const bad = belowCostLines();
  if (!bad.length || isAdmin()) return true;
  const detail = bad.slice(0, 4).map(line => `• ${line.name}: بيع ${money(line.price)} / تكلفة ${money(line.cost)}`).join('\n');
  const approved = await appConfirm(`أصناف تُباع بأقل من سعر التكلفة:
${detail}${bad.length > 4 ? `\n• و${bad.length - 4} صنف آخر` : ''}`,
    { title: 'بيع بأقل من التكلفة', icon: '🛑', confirmText: 'طلب موافقة المدير', cancelText: 'تعديل السعر', tone: 'cancel' });
  if (!approved) return false;
  const pin = window.prompt('أدخل الرقم السري للمدير للموافقة على البيع بأقل من التكلفة:') || '';
  if (pin !== (db.settings.pin || '1234')) { alert('الرقم السري للمدير غير صحيح؛ لم تُحفظ الفاتورة.'); return false; }
  recordAudit(`موافقة مدير على بيع بأقل من التكلفة (${bad.length} صنف)`);
  return true;
}
function saveInvoice(doPrint) {
  const activeMode = $('invMode').value;
  if (!ensurePermission(invoicePermission(activeMode))) return;
  // Normal invoices keep saving synchronously; only a real exception opens a dialog.
  const overDiscount = ['sale', 'quote'].includes(activeMode) && invoiceDiscountPercent() > discountLimitFor() + 0.0001 && !isAdmin();
  const belowCost = ['sale', 'quote'].includes(activeMode) && belowCostLines().length > 0 && !isAdmin();
  const tender = roundMoney(Number($('invPaidAmount').value) || 0) - roundMoney(Number($('invNetTotal').value) || 0) > tenderAlertLimit() + 0.0001;
  if (!overDiscount && !belowCost && !tender) { saveInvoiceNow(doPrint); return; }
  Promise.resolve(overDiscount ? confirmOverLimitDiscount() : true)
    .then(approved => (approved && belowCost ? confirmBelowCost() : approved))
    .then(approved => (approved && tender ? confirmTenderDifference() : approved))
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
    flashSaveSuccess(`تم حفظ ${MODE_LABELS[mode]} #${invoice.id}`);
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
  const receiptStyleName = receiptStyle();
  const receipt = `<div class="thermal-receipt" data-style="${receiptStyleName}">${header}<table><thead><tr><th>الصنف</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table><div class="receipt-totals"><p><span>الإجمالي</span><strong>${money(inv.subtotal ?? inv.netTotal)} ج.م</strong></p><p><span>الخصم</span><strong>${money(inv.discountTotal ?? 0)} ج.م</strong></p><p><span>الصافي</span><strong>${money(inv.netTotal)} ج.م</strong></p><p><span>المدفوع</span><strong>${money(inv.paidAmount)} ج.م</strong></p><p><span>المتبقي</span><strong>${money(inv.remainAmount)} ج.م</strong></p></div>${inv.note ? `<p style="font-size:9px;text-align:center">${esc(inv.note)}</p>` : ''}<p class="receipt-thanks">${inv.mode === 'quote' ? 'عرض سعر فقط — ليس إيصال دفع' : 'شكراً لتعاملكم معنا'}</p></div>`;
  const style = $('thermalPrintStyle');
  const receiptExtra = receiptStyle() === 'compact' ? 'body.thermal-print #printAreaA5 .receipt-head p:nth-of-type(n+2){display:none!important}' : '';
  style.textContent = `@media print{@page{size:${width}mm auto;margin:2mm}${receiptExtra}body.thermal-print #printAreaA5{display:block!important;position:absolute!important;top:0!important;left:0!important;width:${width - 4}mm!important;max-width:${width - 4}mm!important;padding:0!important;margin:0!important;font-size:10px!important;color:#111!important}body.thermal-print #printAreaA5 table{width:100%;border-collapse:collapse}body.thermal-print #printAreaA5 th,body.thermal-print #printAreaA5 td{font-size:10px!important;padding:3px 1px!important;border-bottom:1px dashed #555!important;text-align:center!important}body.thermal-print #printAreaA5 .receipt-totals p{display:flex!important;justify-content:space-between!important;margin:3px 0!important}body.thermal-print #printAreaA5 .receipt-head h2{font-size:14px!important}}`;
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
const DOC_THEME = {
  sale: { accent: '#1c6b34', soft: '#e8f5ea', head: '#0f4c81', tag: 'INVOICE' },
  purchase: { accent: '#8a4b12', soft: '#fbf0df', head: '#7a3f0c', tag: 'BILL' },
  sale_return: { accent: '#8a1f6d', soft: '#fbe9f4', head: '#6d1355', tag: 'RETURN' },
  purchase_return: { accent: '#5c2b7d', soft: '#f2e9fa', head: '#4a2163', tag: 'RETURN-BILL' },
  quote: { accent: '#1d5f8a', soft: '#e8f2fa', head: '#144a6b', tag: 'QUOTE' }
};
/* ---- per-type invoice colours (1) ---- */
const INVOICE_TONES_KEY = `${DB_KEY}_INVOICE_TONES`;
const DOC_SETTINGS_KEY = `${DB_KEY}_DOC`;
const DOC_TEMPLATES = ['classic', 'modern', 'minimal'];
let docSettingsCache = null;
function invoiceTones() {
  let custom = {};
  try { custom = JSON.parse(localStorage.getItem(INVOICE_TONES_KEY) || '{}') || {}; } catch { custom = {}; }
  const tones = {};
  for (const [mode, theme] of Object.entries(DOC_THEME)) tones[mode] = custom[mode] || theme.accent;
  return tones;
}
function setInvoiceTone(mode, color) {
  if (!DOC_THEME[mode] || !/^#[0-9a-f]{6}$/i.test(String(color || ''))) return;
  let custom = {};
  try { custom = JSON.parse(localStorage.getItem(INVOICE_TONES_KEY) || '{}') || {}; } catch { custom = {}; }
  custom[mode] = color;
  try { localStorage.setItem(INVOICE_TONES_KEY, JSON.stringify(custom)); } catch { return notify('تعذر حفظ اللون على هذا الجهاز.'); }
  applyInvoiceTones();
  recordAudit(`تغيير لون فاتورة ${MODE_LABELS[mode]} إلى ${color}`);
  notify('تم تحديث لون هذا النوع في الشاشة والمستند.');
}
function resetInvoiceTones() {
  try { localStorage.removeItem(INVOICE_TONES_KEY); } catch { /* ignore */ }
  applyInvoiceTones();
  recordAudit('استعادة ألوان أنواع الفواتير الأصلية');
  notify('تمت استعادة الألوان الأصلية لكل الأنواع.');
}
function applyInvoiceTones() {
  const tones = invoiceTones();
  const style = $('invoiceToneStyle');
  if (style) {
    style.textContent = Object.entries(tones).map(([mode, color]) => `
      .pos-wrap[data-mode="${mode}"] { --pos-accent:${color}; --pos-accent-2:color-mix(in srgb, ${color} 45%, #ffffff); --pos-surface:color-mix(in srgb, ${color} 6%, #ffffff); --pos-ribbon:linear-gradient(90deg,${color},color-mix(in srgb, ${color} 45%, #ffffff),${color}); }
      .pos-wrap[data-mode="${mode}"] .pos-titlebar { background:linear-gradient(105deg,${color},color-mix(in srgb, ${color} 66%, #ffffff) 62%,color-mix(in srgb, ${color} 45%, #ffffff)); }
    `).join('');
  }
  const fields = { sale: 'toneSale', purchase: 'tonePurchase', sale_return: 'toneSaleReturn', purchase_return: 'tonePurchaseReturn', quote: 'toneQuote' };
  for (const [mode, id] of Object.entries(fields)) if ($(id)) $(id).value = tones[mode];
}

/* ---- A5 document template + accent + signature (2 & 4) ---- */
function docSettings() {
  if (docSettingsCache) return docSettingsCache;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(DOC_SETTINGS_KEY) || '{}') || {}; } catch { stored = {}; }
  docSettingsCache = {
    template: DOC_TEMPLATES.includes(stored.template) ? stored.template : 'modern',
    accent: /^#[0-9a-f]{6}$/i.test(String(stored.accent || '')) ? stored.accent : '',
    paper: stored.paper && typeof stored.paper === 'object'
      ? { frame: ['none', 'line', 'ornament'].includes(stored.paper.frame) ? stored.paper.frame : 'none',
          watermark: typeof stored.paper.watermark === 'string' ? stored.paper.watermark.slice(0, 28) : '' }
      : { frame: 'none', watermark: '' },
    signature: typeof stored.signature === 'string' ? stored.signature : 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="64"><rect x="1" y="1" width="148" height="62" rx="10" fill="none" stroke="#2f7d32" stroke-width="2"/><text x="75" y="30" font-family="Tahoma" font-size="13" font-weight="bold" fill="#2f7d32" text-anchor="middle">ختم المكتبة</text><text x="75" y="48" font-family="Tahoma" font-size="10" fill="#2f7d32" text-anchor="middle">نظام نقاط البيع</text></svg>')
  };
  return docSettingsCache;
}
function saveDocSettings(patch) {
  const next = { ...docSettings(), ...patch };
  docSettingsCache = next;
  try { localStorage.setItem(DOC_SETTINGS_KEY, JSON.stringify(next)); } catch { notify('تعذر حفظ إعدادات المستند.'); }
  return next;
}
function setDocTemplate(template) {
  if (!DOC_TEMPLATES.includes(template)) return;
  saveDocSettings({ template });
  applyDocSettingsUI();
  recordAudit(`تغيير قالب الفاتورة إلى ${{ classic: 'كلاسيك', modern: 'حديث', minimal: 'مصغّر' }[template]}`);
  notify(`قالب الفاتورة الآن «${{ classic: 'كلاسيك', modern: 'حديث', minimal: 'مصغّر' }[template]}».`);
}
function setDocAccent(color) {
  if (!/^#[0-9a-f]{6}$/i.test(String(color || ''))) return;
  saveDocSettings({ accent: color }); applyDocSettingsUI(); notify('تم تحديث لون المستند.');
}
function applyDocSettingsUI() {
  if ($('previewPaper')) $('previewPaper').dataset.frame = docPaperOptions().frame;
  if ($('docFrameSelect')) $('docFrameSelect').value = docPaperOptions().frame;
  if ($('docWatermarkInp') && document.activeElement !== $('docWatermarkInp')) $('docWatermarkInp').value = docPaperOptions().watermark;
  const settings = docSettings();
  document.querySelectorAll('#docTemplateGrid .template-chip').forEach(button => {
    button.setAttribute('aria-pressed', button.dataset.docTemplate === settings.template ? 'true' : 'false');
  });
  if ($('docAccentInp')) $('docAccentInp').value = settings.accent || '#1c6b34';
  if ($('docSignatureStatus')) $('docSignatureStatus').textContent = settings.signature ? 'التوقيع مفعّل ويظهر على الفاتورة' : 'لا يوجد توقيع';
}
function uploadDocSignature(input) {
  const file = input.files?.[0];
  if (!file) return;
  if (!/^image\/(png|jpeg)$/.test(file.type)) { input.value = ''; return notify('اختر صورة PNG أو JPG فقط.'); }
  if (file.size > 400 * 1024) { input.value = ''; return notify('حجم صورة التوقيع يجب ألا يزيد عن 400 كيلوبايت.'); }
  const reader = new FileReader();
  reader.onload = () => { saveDocSettings({ signature: String(reader.result) }); applyDocSettingsUI(); recordAudit('رفع توقيع/ختم المكتبة للفاتورة'); notify('تم حفظ التوقيع وسيظهر على كل فاتورة.'); };
  reader.onerror = () => notify('تعذر قراءة الملف.');
  reader.readAsDataURL(file);
  input.value = '';
}
function clearDocSignature() { saveDocSettings({ signature: '' }); applyDocSettingsUI(); notify('تم إزالة التوقيع من الفواتير.'); }

/* ---- tender difference alert (3) ---- */
function tenderAlertLimit() {
  const value = Number(getAppearance().tenderAlert);
  return Number.isFinite(value) && value > 0 ? value : 100;
}
function setTenderAlert(value) {
  const amount = Number(value);
  const appearance = getAppearance();
  appearance.tenderAlert = Number.isFinite(amount) && amount > 0 ? Math.min(100000, amount) : 0;
  saveAppearance(appearance);
  if ($('tenderAlertAmount')) $('tenderAlertAmount').value = String(appearance.tenderAlert);
  notify(appearance.tenderAlert ? `سيُنبَّه عند زيادة الباقي عن ${money(appearance.tenderAlert)} ج.م.` : 'تم إيقاف تنبيه فرق الصندوق.');
}


function invoiceDocTheme(inv) {
  const mode = inv?.mode;
  const base = DOC_THEME[mode] || DOC_THEME.sale;
  const settings = docSettings();
  const accent = settings.accent || invoiceTones()[mode] || base.accent;
  return { ...base, accent, head: accent, soft: `color-mix(in srgb, ${accent} 12%, #ffffff)`, base };
}
function templateCss(template, theme, paper) {
  if (template === 'classic') {
    return `.doc{border:2px double ${theme.accent};padding:7px}
      .p-header h2{font-family:'Cairo',Tahoma,sans-serif;text-transform:none;letter-spacing:.5px}
      .p-header{border-bottom:2px double ${theme.accent}}
      .p-table th,.p-table td{border:1px solid #444}
      .doc-tag{display:none}`;
  }
  if (template === 'minimal') {
    return `.doc{border-top:3px solid ${theme.accent};padding-top:4px}
      body{font-size:${paper === 'a4' ? '10px' : '8.6px'}}
      .p-header{padding-bottom:3px;margin-bottom:5px}
      .p-header h2{font-size:${paper === 'a4' ? '16px' : '13px'}}
      .p-header p{font-size:${paper === 'a4' ? '9px' : '8px'}}
      .p-table{margin:3px 0}
      .p-table th,.p-table td{border:0;border-bottom:1px solid #ddd;padding:2px 3px}
      .p-table thead th{border-bottom:1.5px solid ${theme.accent}}
      .p-totals{border:0;padding:2px 4px;margin-top:2px;font-size:${paper === 'a4' ? '10px' : '8.6px'}}
      .p-sign{margin-top:8px}
      .doc-tag{font-size:7px;padding:0 6px}`;
  }
  return `.doc{background:linear-gradient(180deg,${theme.soft} 0 ${paper === 'a4' ? '34mm' : '26mm'},#fff ${paper === 'a4' ? '34mm' : '26mm'} 100%)}
    .p-header{text-align:${'right'};border-bottom:0;padding:0 0 6px}
    .p-header h2{font-size:${paper === 'a4' ? '22px' : '18px'}}
    .doc-tag{background:${theme.accent};color:#fff;border-color:${theme.accent}}
    .p-meta{border:0;background:#ffffffcc;box-shadow:0 2px 8px #0000001a}
    .p-table thead th{background:${theme.accent};color:#fff}
    .p-totals{border:0;background:${theme.soft};border-radius:6px}
    .p-sign{margin-top:${paper === 'a4' ? '18px' : '12px'}}`;
}
function invoiceDocCss(paper = 'a5', inv) {
  const size = paper === 'a4' ? 'A4' : 'A5';
  const theme = invoiceDocTheme(inv);
  return `@page{size:${size};margin:${paper === 'a4' ? '10mm' : '7mm'}}
    *{box-sizing:border-box}
    :root{--doc-accent:${theme.accent};--doc-soft:${theme.soft};--doc-head:${theme.head}}
    body{margin:0;padding:${paper === 'a4' ? '6mm' : '4mm'};background:#fff;color:#111;font-family:'Cairo',Tahoma,Arial,sans-serif}
    .doc{max-width:${paper === 'a4' ? '190mm' : '138mm'};margin:0 auto;border-top:6px solid ${theme.accent};padding-top:6px}
    .doc-tag{display:inline-block;font-size:8px;font-weight:800;letter-spacing:1.6px;color:${theme.accent};border:1px solid ${theme.accent};border-radius:999px;padding:1px 8px;margin-bottom:4px}
    .p-header{text-align:center;border-bottom:2px solid ${theme.accent};padding-bottom:6px;margin-bottom:8px}
    .p-header h2{margin:0;font-size:${paper === 'a4' ? '20px' : '16px'};color:${theme.accent}}
    .p-header p{margin:2px 0;font-size:${paper === 'a4' ? '11px' : '9.5px'};color:#444}
    .p-header h3{margin:4px 0 0;font-size:${paper === 'a4' ? '14px' : '12px'};color:${theme.head}}
    .p-meta{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:${paper === 'a4' ? '11px' : '9.5px'};margin:6px 0;padding:5px 7px;border:1px solid #ccc;border-radius:4px;background:${theme.soft}}
    .p-table{width:100%;border-collapse:collapse;margin:6px 0;font-size:${paper === 'a4' ? '11px' : '9.5px'}}
    .p-table th,.p-table td{border:1px solid #999;padding:${paper === 'a4' ? '4px 5px' : '3px 4px'};text-align:center}
    .p-table thead th{background:${theme.soft};color:${theme.head};font-weight:700}
    .p-totals{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:${paper === 'a4' ? '11px' : '9.5px'};padding:5px 7px;margin-top:5px;border:1px dashed ${theme.accent};border-radius:4px;background:#fff}
    ${templateCss(docSettings().template, theme, paper)}
    ${docPaperOptions().frame === 'ornament' ? `.doc{position:relative;border:2px solid ${theme.accent};border-radius:6px;padding:10px 12px}.doc::before{content:'';position:absolute;inset:4px;border:1px solid ${theme.accent};opacity:.45;border-radius:4px;pointer-events:none}` : docPaperOptions().frame === 'line' ? `.doc{position:relative;border-inline-start:5px solid ${theme.accent};padding-inline-start:12px}` : ''}
    .doc-watermark{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;overflow:hidden}
    .doc-watermark span{font-size:${paper === 'a4' ? '52px' : '38px'};font-weight:800;color:${theme.accent};opacity:.10;transform:rotate(-22deg);letter-spacing:2px;text-align:center}
    .p-logo{width:${paper === 'a4' ? '60px' : '48px'};height:auto;max-height:${paper === 'a4' ? '60px' : '48px'};object-fit:contain;display:block;margin:0 auto 4px}
    .p-sign{display:flex;justify-content:space-between;align-items:flex-end;margin-top:${paper === 'a4' ? '22px' : '14px'};font-size:${paper === 'a4' ? '11px' : '9.5px'}}
    .p-signature img{max-height:${paper === 'a4' ? '22mm' : '16mm'};max-width:${paper === 'a4' ? '50mm' : '38mm'};object-fit:contain}
    .p-foot{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;margin-top:8px;padding-top:6px;border-top:1px solid #ccc;font-size:9px;color:#555}
    .p-foot svg{width:${paper === 'a4' ? '80px' : '62px'};height:auto}
    .p-note{text-align:center;font-size:9.5px;color:#555}`;
}
function signatureMarkup() {
  const signature = docSettings().signature;
  return signature ? `<span class="p-signature"><img src="${signature}" alt="توقيع المكتبة"></span>` : '';
}
function invoiceDocBody(inv, paper = 'a5') {
  const store = inv.store || db.settings;
  const rows = invoiceLines(inv).map((c, index) => `<tr><td>${index + 1}</td><td>${esc(c.code || '')}</td><td style="text-align:right">${esc(c.name)}</td><td>${esc(c.qty)}</td><td>${money(c.price)}</td><td>${esc(c.discPct)}%</td><td>${money(c.netTotal)}</td></tr>`).join('');
  const theme = invoiceDocTheme(inv);
  const logoSrc = storeLogoSrc();
  const paperOptions = docPaperOptions();
  return `<div class="doc">
    <div class="p-header">${logoSrc ? `<img class="p-logo" src="${logoSrc}" alt="شعار">` : ''}<span class="doc-tag">${esc(theme.tag)}</span><h2>${esc(store.name)}</h2><p>${esc(store.address)} | هاتف: ${esc(store.phone)}</p><h3>${esc(MODE_LABELS[inv.mode])} رقم #${inv.id}</h3></div>
    <div class="p-meta"><span>التاريخ: ${esc(inv.date)} (${esc(inv.time)})</span><span>العميل: ${esc(inv.partyName)}</span><span>الهاتف: ${esc(store.phone)}</span></div>
    <table class="p-table"><thead><tr><th>م</th><th>الكود</th><th>الصنف</th><th>الكمية</th><th>السعر</th><th>خصم</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="p-totals"><span>عدد المواد: ${invoiceLines(inv).length}</span><span>إجمالي البنود: ${money(inv.subtotal ?? invoiceLines(inv).reduce((sum, c) => sum + lineGross(c), 0))}</span><span>الخصم الإضافي: ${money(inv.discountTotal ?? 0)}</span></div>
    <div class="p-totals"><span>الصافي: ${money(inv.netTotal)} ج.م</span><span>${inv.mode.startsWith('purchase') ? 'المسدّد للمورد' : 'المدفوع'}: ${money(inv.paidAmount)}</span><span>المتبقي: ${money(inv.remainAmount)}</span></div>
    ${inv.mode !== 'quote' ? `<div class="p-totals"><span>الرصيد السابق: ${money(inv.prevBalance)}</span><span>الرصيد الحالي: ${money(inv.newBalance)} ج.م</span></div>` : '<p class="p-note">عرض أسعار فقط — ليس إيصال دفع ولا يغيّر المخزون.</p>'}
    ${inv.note ? `<p class="p-note">ملاحظات: ${esc(inv.note)}</p>` : ''}
    ${docPaperOptions().watermark ? `<div class="doc-watermark" aria-hidden="true"><span>${esc(docPaperOptions().watermark)}</span></div>` : ''}
    <div class="p-sign"><span>توقيع العميل: ........................</span>${signatureMarkup() || '<span>توقيع الموظف: ........................</span>'}</div>
    <div class="p-foot"><span>نظام نقاط البيع وإدارة المكتبات</span>${invoiceQrMarkup(inv)}</div>
  </div>`;
}
function invoiceDocHtml(inv, paper = 'a5') {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(MODE_LABELS[inv.mode])} #${inv.id}</title><style>${invoiceDocCss(paper, inv)}</style></head><body>${invoiceDocBody(inv, paper)}</body></html>`;
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
    if (commitDB(draft => { const index = draft.items.findIndex(i => i.id === item.id); if (index < 0) draft.items.push(item); else draft.items[index] = item; }, { flash: 'تم حفظ الصنف' })) {
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
      <td>${esc(i.cat)}</td><td>${esc(i.warehouse)}</td><td style="font-weight:bold;color:${i.qty <= i.minQty ? 'var(--danger)' : '#20591f'}">${quickEditMode ? input('qty', 64) : esc(i.qty)}${quickEditMode ? '' : stockStateTag(i)}</td><td>${esc(i.unit)}</td>
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
  if (commitDB(draft => { draft.items[draft.items.findIndex(i => i.id === id)] = updated; }, { flash: 'تم تحديث الصنف' })) { renderItemsTable(); renderPosTiles(); }
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
let labelSelected = null;
function labelCopiesMap() {
  const raw = String($('labelCopiesMap')?.value || '');
  const map = new Map();
  for (const chunk of raw.split(/[,،;\n]+/)) {
    const match = chunk.match(/([^=]+)=([0-9]+)/);
    if (match) map.set(match[1].trim(), Math.max(1, Math.min(200, Number(match[2]))));
  }
  return map;
}
function labelCopiesFor(item, fallback, map) {
  return map.get(String(item.code)) || map.get(String(item.id)) || fallback;
}
function renderLabelItems(list, copies, map) {
  const body = $('labelItemsTbody');
  if (!body) return;
  if (!labelSelected) labelSelected = new Set(list.map(item => item.id));
  body.innerHTML = list.map(item => `<tr>
      <td><input type="checkbox" ${labelSelected.has(item.id) ? 'checked' : ''} onchange="toggleLabelItem(${item.id}, this.checked)"></td>
      <td>${esc(item.code)}</td><td class="cell-name">${esc(item.name)}</td>
      <td>${roundQuantity(item.qty)}</td>
      <td><input type="number" min="1" max="200" step="1" value="${labelCopiesFor(item, copies, map)}" style="width:74px" onchange="setLabelCopies('${esc(item.code)}', this.value)"></td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty-row">لا توجد أصناف في هذه المجموعة.</td></tr>';
}
function toggleLabelItem(id, checked) {
  if (!labelSelected) labelSelected = new Set();
  if (checked) labelSelected.add(id); else labelSelected.delete(id);
  renderLabels();
}
function toggleAllLabelItems(select) {
  labelSelected = new Set(select ? labelCache.map(item => item.id) : []);
  renderLabels();
}
function setLabelCopies(code, value) {
  const input = $('labelCopiesMap');
  if (!input) return;
  const map = labelCopiesMap();
  map.set(String(code), Math.max(1, Math.min(200, Number(value) || 1)));
  input.value = [...map.entries()].map(([key, count]) => `${key}=${count}`).join(', ');
  renderLabels();
}
function renderLabels() {
  const preview = $('labelPreview'); if (!preview) return;
  const cat = $('labelCategory').value || 'all';
  const copies = Math.max(1, Math.min(40, Number($('labelCopies').value) || 1));
  const copiesMap = labelCopiesMap();
  const cols = Math.max(2, Math.min(4, Number($('labelCols').value) || 3));
  const barHeight = Math.max(24, Math.min(80, Number($('labelBarHeight').value) || 44));
  const showStore = $('labelStoreName').checked, showName = $('labelShowName').checked,
    showPrice = $('labelShowPrice').checked, showCode = $('labelShowCode').checked;
  const list = db.items.filter(item => cat === 'all' || item.cat === cat);
  labelCache = list;
  preview.style.gridTemplateColumns = `repeat(${cols},minmax(0,1fr))`;
  const template = lookSettings().labelTemplate || 'standard';
  preview.dataset.labelTemplate = template;
  if ($('headLabelsCount')) $('headLabelsCount').textContent = String(list.length);
  if (!labelSelected) labelSelected = new Set(list.map(item => item.id));
  const selected = list.filter(item => labelSelected.has(item.id));
  renderLabelItems(list, copies, copiesMap);
  const cells = [];
  for (const item of selected) {
    const count = labelCopiesFor(item, copies, copiesMap);
    for (let copy = 0; copy < count; copy++) {
      cells.push(`<div class="label-cell" data-template="${template}">${showStore ? `<i>${esc(db.settings.name)}</i>` : ''}${showName ? `<b>${esc(item.name)}</b>` : ''}${barcodeBlock(item.code, barHeight, !showCode)}${showPrice ? `<span>${money(item.sell)}</span>` : ''}</div>`);
    }
  }
  preview.innerHTML = cells.join('') || '<div class="empty-row">لا توجد أصناف لطباعة ملصقاتها في هذه المجموعة.</div>';
  if ($('labelCount')) $('labelCount').textContent = `${selected.length} من ${list.length} صنف — ${cells.length} ملصق جاهز`;
}
function printSelectedLabels() {
  if (!labelSelected || !labelSelected.size) return notify('حدّد صنفاً واحداً على الأقل لطباعة ملصقاته.');
  printLabels();
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
  if (commitDB(draft => { draft.categories.push(name); }, { flash: 'تمت إضافة المجموعة' })) { $('catNameInp').value = ''; renderCategoriesTable(); populateCategoriesSelect(); renderPosTiles(); }
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
  paintNavBell();
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
  setActiveNav('customers');
  $('partyFormTitle').textContent = type === 'supplier' ? 'بيانات المورد' : 'بيانات العميل'; renderPartiesTable();
}
function openPartyReport(type, report) {
  openPartySec(type); $('partyStatementBox').style.display = report === 'balances' ? 'none' : 'block';
  if (report !== 'balances') renderPartyStatement();
}
function resetPartyForm() {
  $('partyEditId').value = ''; $('partyName').value = ''; $('partyPhone').value = ''; $('partyBalance').value = 0; $('partyBalance').disabled = false; $('partyNotes').value = '';
  for (const id of ['partyCode', 'partyCountry', 'partyCity', 'partyPhone2', 'partyEmail', 'partyAddress']) { if ($(id)) $(id).value = ''; }
  if ($('partyCountry')) $('partyCountry').value = 'مصر';
  if ($('partyFormTitle')) $('partyFormTitle').textContent = $('partyType')?.value === 'supplier' ? 'بيانات المورد' : 'بيانات العميل';
  if ($('partyContactHint')) $('partyContactHint').textContent = 'اختر عميلاً من الجدول';
  $$('#partiesTbody tr').forEach(row => row.classList.remove('is-selected'));
  delete $('partiesTbody')?.dataset?.selected;
}
function saveParty() {
  if (!ensurePermission($('partyType').value === 'supplier' ? 'supplier' : 'customer')) return;
  const type = $('partyType').value, name = $('partyName').value.trim(), editId = Number($('partyEditId').value), balance = roundMoney(num('partyBalance'));
  if (!name) return alert('أدخل الاسم.');
  if (!editId && (!Number.isFinite(balance))) return alert('الرصيد الافتتاحي يجب أن يكون رقماً صالحاً.');
  if (db.parties.some(p => p.id !== editId && p.type === type && p.name.toLocaleLowerCase() === name.toLocaleLowerCase())) return alert('يوجد حساب بنفس الاسم بالفعل.');
  const contact = {
    phone: $('partyPhone').value.trim(), notes: $('partyNotes').value.trim(),
    ...($('partyCode') ? { code: $('partyCode').value.trim() } : {}),
    ...($('partyCountry') ? { country: $('partyCountry').value.trim() } : {}),
    ...($('partyCity') ? { city: $('partyCity').value.trim() } : {}),
    ...($('partyPhone2') ? { phone2: $('partyPhone2').value.trim() } : {}),
    ...($('partyEmail') ? { email: $('partyEmail').value.trim() } : {}),
    ...($('partyAddress') ? { address: $('partyAddress').value.trim() } : {})
  };
  const saved = commitDB(draft => {
    if (editId) { const party = draft.parties.find(p => p.id === editId); if (!party) throw new Error('الحساب غير موجود.'); Object.assign(party, { name, ...contact }); }
    else draft.parties.push({ id: nextId(draft.parties), type, name, balance, ...contact });
  }, { flash: 'تم حفظ الحساب' });
  if (saved) { resetPartyForm(); renderPartiesTable(); }
}
function editParty(id) {
  const party = db.parties.find(p => p.id === id); if (!party || !ensurePermission(party.type === 'supplier' ? 'supplier' : 'customer')) return;
  $('partyEditId').value = id; $('partyType').value = party.type; $('partyName').value = party.name; $('partyPhone').value = party.phone;
  $('partyBalance').value = party.balance; $('partyBalance').disabled = true; $('partyNotes').value = party.notes;
  for (const [key, field] of [['code', 'partyCode'], ['country', 'partyCountry'], ['city', 'partyCity'], ['phone2', 'partyPhone2'], ['email', 'partyEmail'], ['address', 'partyAddress']]) {
    if ($(field)) $(field).value = party[key] || '';
  }
  selectPartyRow(id);
  $('partyFormTitle').textContent = 'تعديل بيانات الحساب — الرصيد يُعدّل بالفواتير والسندات'; window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderPartiesTable() {
  const all = db.parties.filter(p => p.type === $('partyType').value);
  const list = all.filter(party => partyMatches(party, partyFilter));
  const previousVoucher = $('voucherPartyId').value, previousStatement = $('statementPartySelect').value;
  $('voucherPartyId').innerHTML = options(list, p => `${p.name} (${money(p.balance)})`);
  $('statementPartySelect').innerHTML = options(list, p => p.name);
  if (list.some(p => String(p.id) === previousVoucher)) $('voucherPartyId').value = previousVoucher;
  if (list.some(p => String(p.id) === previousStatement)) $('statementPartySelect').value = previousStatement;
  const tone = balance => roundMoney(balance) > 0 ? 'bad' : roundMoney(balance) < 0 ? 'info' : 'ok';
  const stateLabel = balance => roundMoney(balance) > 0 ? 'مديونية' : roundMoney(balance) < 0 ? 'دائن' : 'مسدد';
  $('partiesTbody').innerHTML = list.map(p => {
    const selected = Number($('partyEditId')?.value) === p.id || Number($('partiesTbody').dataset.selected || 0) === p.id;
    return `<tr data-party-id="${p.id}" class="${selected ? 'is-selected' : ''}" onclick="selectPartyRow(${p.id})">
      <td>${esc(partyDisplayCode(p))}</td>
      <td class="is-name">${esc(p.name)}</td>
      <td>${esc(p.city || '-')}</td>
      <td dir="ltr">${esc(p.phone || '-')}</td>
      <td class="is-num" style="font-weight:bold">${money(p.balance)}</td>
      <td><span class="ws-tag" data-tone="${tone(p.balance)}">${stateLabel(p.balance)}</span></td>
      <td class="no-print"><span class="row-actions">
        <button type="button" class="iconbtn is-edit" title="تعديل" aria-label="تعديل" onclick="event.stopPropagation();editParty(${p.id})">✎</button>
        <button type="button" class="iconbtn is-view" title="كشف حساب" aria-label="كشف حساب" onclick="event.stopPropagation();showStatementFor(${p.id})">👁</button>
        <button type="button" class="iconbtn is-del" title="حذف" aria-label="حذف" onclick="event.stopPropagation();deleteParty(${p.id})">✕</button>
      </span></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="ws-empty">لا توجد حسابات مسجلة.</td></tr>';
  const headers = $('partiesTbody').closest('table')?.querySelectorAll('thead th') || [];
  headers.forEach((th, i) => th.classList.toggle('no-print', i >= 5));
  if ($('headPartiesCount')) $('headPartiesCount').textContent = String(all.length);
  if ($('partyListCount')) $('partyListCount').textContent = `${list.length} من ${all.length} سجل`;
  if ($('partyListTitle')) $('partyListTitle').textContent = $('partyType').value === 'supplier' ? 'قائمة الموردين' : 'قائمة العملاء';
  if ($('headPartiesBalance')) $('headPartiesBalance').textContent = money(all.reduce((sum, p) => sum + p.balance, 0));
  if ($('partiesHeadTitle')) $('partiesHeadTitle').textContent = $('partyType').value === 'supplier' ? '🚚 إدارة الموردين ودور النشر' : '👥 إدارة العملاء';
  if ($('partyStatementBox') && $('partyStatementBox').style.display !== 'none') renderPartyStatement();
}
function deleteParty(id) {
  if (!ensurePermission('admin')) return;
  const party = db.parties.find(p => p.id === id); if (!party) return;
  if (db.invoices.some(i => i.partyId === id) || db.treasury.some(t => t.partyId === id) || party.balance !== 0) return alert('لا يمكن حذف حساب له رصيد أو حركات مالية. احتفظ بالحساب للحفاظ على كشوف الحساب.');
  if (confirm('حذف هذا الحساب؟') && commitDB(draft => { draft.parties = draft.parties.filter(p => p.id !== id); })) { resetPartyForm(); renderPartiesTable(); }
}
/* ---- quick customer created from inside the invoice (floating window) ---- */
const QUICK_PARTY_FIELDS = ['invQuickPartyName', 'invQuickPartyPhone', 'invQuickPartyPhone2', 'invQuickPartyCity', 'invQuickPartyEmail', 'invQuickPartyNotes'];
function toggleQuickParty(force) {
  const box = $('invQuickParty');
  if (!box) return;
  const buying = $('invMode').value.startsWith('purchase');
  if (!ensurePermission(buying ? 'supplier' : 'customer')) return;
  const open = force === undefined ? !box.classList.contains('open') : Boolean(force);
  box.classList.toggle('open', open);
  box.setAttribute('aria-hidden', String(!open));
  if ($('invQuickPartyTitle')) $('invQuickPartyTitle').textContent = buying ? 'مورد جديد' : 'عميل جديد';
  if ($('invQuickPartyBtn')) $('invQuickPartyBtn').setAttribute('aria-expanded', String(open));
  if (open) {
    clampQuickPartyWindow();
    $('invQuickPartyName').focus();
    if ($('invQuickPartyBalance')) $('invQuickPartyBalance').value = '0';
  } else {
    QUICK_PARTY_FIELDS.forEach(id => { if ($(id)) $(id).value = ''; });
  }
}
function clampQuickPartyWindow() {
  const box = $('invQuickParty');
  if (!box || !window.innerWidth) return;
  box.style.insetInlineStart = '50%';
  box.style.insetBlockStart = '50%';
  if (box.offsetWidth && box.offsetWidth > window.innerWidth - 16) box.style.width = `${window.innerWidth - 16}px`;
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
  // every box of the floating window reaches the stored account (empty ones are dropped)
  const contact = {
    phone,
    ...($('invQuickPartyPhone2')?.value.trim() ? { phone2: $('invQuickPartyPhone2').value.trim() } : {}),
    ...($('invQuickPartyCity')?.value.trim() ? { city: $('invQuickPartyCity').value.trim() } : {}),
    ...($('invQuickPartyEmail')?.value.trim() ? { email: $('invQuickPartyEmail').value.trim() } : {})
  };
  const notes = $('invQuickPartyNotes')?.value.trim();
  let created = null;
  const saved = commitDB(draft => {
    created = {
      id: nextId(draft.parties), type: buying ? 'supplier' : 'customer', name, ...contact,
      balance: Number.isFinite(balance) ? balance : 0, notes: notes || 'أُضيف من شاشة البيع'
    };
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
/* ---- invoice log views: sales, purchases, quotes and everything, each with its own look ---- */
const LOG_KINDS = {  
  sale: { title: '🛍️ سجل فواتير المبيعات', section: '🛍️ فواتير المبيعات المسجلة', party: 'العميل', chip: 'إجمالي المبيعات',
    filters: ['sale', 'sale_return'], permission: 'sales-log' },  
  purchase: { title: '🚚 سجل فواتير المشتريات', section: '🚚 فواتير المشتريات المسجلة', party: 'المورد', chip: 'إجمالي المشتريات',
    filters: ['purchase', 'purchase_return'], permission: 'purchase-log' },  
  quote: { title: '🧾 سجل عروض الأسعار', section: '🧾 عروض الأسعار', party: 'العميل', chip: 'إجمالي العروض',
    filters: ['quote'], permission: 'sales-log' },  
  all: { title: '📚 سجل كل الحركات', section: '📚 كل الفواتير والحركات', party: 'العميل / المورد', chip: 'إجمالي الحركة',
    filters: ['sale', 'sale_return', 'purchase', 'purchase_return', 'quote'], permission: 'admin' }
};
function logKindForFilter(filter) {
  if (filter === 'quote') return 'quote';
  if (String(filter).startsWith('purchase')) return 'purchase';
  if (String(filter).startsWith('sale')) return 'sale';
  return 'all';
}
function setLogKind(kind) {
  const config = LOG_KINDS[kind] || LOG_KINDS.sale;
  if (config.permission === 'admin' ? !ensurePermission('admin') : !ensurePermission(config.permission)) return;
  $('logTypeFilter').value = config.filters[0];
  renderInvLog();
}
function openInvLog(type, period = false) {
  const permission = String(type).startsWith('purchase') ? 'purchase-log' : 'sales-log';
  if (type === 'all' && !ensurePermission('admin')) return;
  if (!ensurePermission(permission)) return;
  openSec('sec-invlog', period ? '📑 فواتير الفترة — حدد من وإلى التاريخ' : '📑 سجل الفواتير'); $('logTypeFilter').value = type; renderInvLog();
  if (period) $('logDateFrom').focus();
}
function applyLogKind(kind, list) {
  const config = LOG_KINDS[kind] || LOG_KINDS.sale;
  const section = $('sec-invlog');
  if (section) section.dataset.logKind = kind;
  document.querySelectorAll('#logSwitch .log-switch-btn').forEach(button => {
    const active = button.dataset.logKind === kind;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  for (const [id, text] of [['invLogTitle', config.title], ['invLogSectionTitle', config.section], ['invLogPartyHead', config.party]]) {
    if ($(id)) $(id).textContent = text;
  }
  const sums = list.reduce((acc, invoice) => {
    acc.net += Number(invoice.netTotal) || 0;
    acc.paid += Number(invoice.paidAmount) || 0;
    acc.remain += Number(invoice.remainAmount) || 0;
    return acc;
  }, { net: 0, paid: 0, remain: 0 });
  if ($('headInvLogTotal')) $('headInvLogTotal').textContent = money(sums.net);
  if ($('invLogSumChip')) $('invLogSumChip').firstChild.textContent = `${config.chip}: `;
  if ($('invLogSumChip')?.lastElementChild) $('invLogSumChip').lastElementChild.textContent = money(sums.net);
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
  $('invLogTbody').innerHTML = list.map(i => `<tr><td>#${i.id}</td><td>${esc(i.date)}</td><td>${esc(MODE_LABELS[i.mode])} ${invoiceStateTag(i)}</td><td>${esc(i.partyName)}</td><td>${money(i.netTotal)}</td><td>${money(i.paidAmount)}</td><td>${money(i.remainAmount)}</td>
    <td class="no-print"><button type="button" class="act-btn bg-teal" onclick="previewSavedInvoice(${i.id}, event)">معاينة</button> <button type="button" class="act-btn bg-teal" onclick="printInvoiceById(${i.id})">طباعة A5</button> <button type="button" class="act-btn bg-blue" onclick="printInvoiceThermalById(${i.id})">حرارية</button> <button type="button" class="act-btn bg-purple" onclick="exportInvoicePdfById(${i.id})">PDF</button> <button type="button" class="act-btn bg-green" onclick="shareInvoiceOnWhatsApp(${i.id})">واتساب</button>${i.mode === 'quote' && !i.convertedToId ? ` <button type="button" class="act-btn bg-green" onclick="loadQuoteForSale(${i.id})">تحويل للبيع</button>` : ''}${i.convertedToId ? ` <small>محوّلة إلى #${i.convertedToId}</small>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">لا توجد فواتير في هذه الفترة.</td></tr>';
  const th = document.querySelector('#sec-invlog th:last-child'); if (th) th.classList.add('no-print');
  if ($('headInvLogCount')) $('headInvLogCount').textContent = String(list.length);
  applyLogKind(logKindForFilter(filter), list);
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
  if (commitDB(draft => { draft.treasury.push({ id: nextId(draft.treasury), date: localDate(), type, amount: roundMoney(amount), note }); }, { flash: 'تم تسجيل حركة الخزنة' })) {
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
  paintTitleChrome();
  // the store banner is gone: the store data lives in the title bar and the printed documents only
  if ($('lblStoreName')) $('lblStoreName').textContent = db.settings.name;
  if ($('lblStorePhone')) $('lblStorePhone').textContent = db.settings.phone || '';
  if ($('lblStoreAddress')) {
    $('lblStoreAddress').textContent = db.settings.address || '';
    $('lblStoreAddress').hidden = !db.settings.address;
  }
  document.title = `${db.settings.name} | نقاط البيع`;
}
const SETTINGS_TABS = ['look', 'store', 'sync', 'staff', 'images'];
function switchSettingsTab(tab) {
  if (!SETTINGS_TABS.includes(tab)) tab = 'look';
  document.querySelectorAll('#settingsTabs [data-settings-tab]').forEach(button => {
    const active = button.dataset.settingsTab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-settings-panel]').forEach(panel => { panel.hidden = panel.dataset.settingsPanel !== tab; });
  if ($('windowLayer')) $('windowLayer').scrollTop = 0;
  if (tab === 'staff') { renderStaffTable(); renderAuditTable(); }
}
function loadSettingsForm() {
  $('setStoreName').value = db.settings.name; $('setStoreAddress').value = db.settings.address; $('setStorePhone').value = db.settings.phone;
  if ($('setStoreMobile')) $('setStoreMobile').value = storeSetting('mobile');
  if ($('setInvoiceNote')) $('setInvoiceNote').value = storeSetting('invoiceNote');
  if ($('setCurrency')) $('setCurrency').value = storeSetting('currency', 'ج.م');
  if ($('setPaperSize')) $('setPaperSize').value = storeSetting('paperSize', 'A5');
  if ($('setPrinter')) $('setPrinter').value = storeSetting('printer');
  if ($('setDefaultWarehouse')) {
    const values = [...new Set([storeSetting('defaultWarehouse', 'الرئيسي'), ...db.items.map(item => item.warehouse).filter(Boolean)])];
    $('setDefaultWarehouse').innerHTML = optionList(values);
    $('setDefaultWarehouse').value = storeSetting('defaultWarehouse', 'الرئيسي');
  }
  if ($('setDefaultSafe')) {
    $('setDefaultSafe').innerHTML = optionList([...new Set([storeSetting('defaultSafe', 'الخزينة الرئيسية'), 'الخزينة الرئيسية'])]);
    $('setDefaultSafe').value = storeSetting('defaultSafe', 'الخزينة الرئيسية');
  }
  if ($('setStoreHint')) $('setStoreHint').textContent = `آخر تحديث: ${localDate().replaceAll('-', '/')}`;
  if ($('setThemeChip')) $('setThemeChip').textContent = `الثيم: ${THEME_LABELS[getAppearance().theme] || THEME_LABELS['win11-indigo']}`;
  if ($('storeLogoPreview') && lookSettings().storeLogo) $('storeLogoPreview').style.backgroundImage = `url(${lookSettings().storeLogo})`;
  $('setPinCode').value = ''; $('setSyncKey').value = sessionToken();
  $('rememberSyncKey').checked = Boolean(localStorage.getItem(REMEMBERED_TOKEN_KEY)) || !sessionToken();
  $('receiptWidth').value = getAppearance().receiptWidth === '58' ? '58' : '80';
  if ($('autoLockSelect')) $('autoLockSelect').value = String(autoLockMinutes());
  if ($('rememberDeviceSettings')) $('rememberDeviceSettings').checked = isTrustedDevice();
  applyScanFeedbackUI();
  applyInvoiceTones(); applyDocSettingsUI();
  if ($('tenderAlertAmount')) $('tenderAlertAmount').value = String(tenderAlertLimit());
  $('staffManagerPanel').hidden = !isAdmin();
  if ($('backupReminderSelect')) $('backupReminderSelect').value = String(backupReminderDays());
  if ($('lastBackupDate')) { let last = '—'; try { last = localStorage.getItem(LAST_BACKUP_KEY) || '—'; } catch { /* ignore */ } $('lastBackupDate').textContent = last; }
  renderStaffTable(); renderAuditTable(); applyAppearance(); updateSyncStateBox();
}
function openSettingsTab(tab = 'look') {
  if (!SETTINGS_TABS.includes(tab)) tab = 'look';
  openSec('sec-settings', '⚙️ إعدادات النظام');
  setActiveNav(tab === 'staff' ? 'staff' : 'settings');
  switchSettingsTab(tab);
  if (tab === 'sync') {
    loadSettingsForm();
    updateSyncStateBox();
    window.setTimeout(() => $('setSyncKey')?.focus(), 60);
  }
}
function updateSyncStateBox() {
  if (!$('syncStateText')) return;
  const state = $('syncStatusBadge')?.dataset.state || 'local';
  const labels = { local: 'محفوظ محلياً — غير متزامن', synced: 'متزامن مع Neon ✅', error: 'يحتاج مراجعة المزامنة' };
  $('syncStateText').textContent = labels[state] || labels.local;
  $('syncRevisionText').textContent = syncMeta.revision === null || syncMeta.revision === undefined ? 'غير مرتبط' : String(syncMeta.revision);
  let saved = false;
  try { saved = Boolean(localStorage.getItem(REMEMBERED_TOKEN_KEY)); } catch { saved = false; }
  $('syncKeyStateText').textContent = saved ? 'محفوظ على هذا الجهاز 🔒' : 'غير محفوظ';
}
function saveSyncKey() {
  if (!ensurePermission('admin')) return;
  const token = $('setSyncKey').value.trim(), remember = $('rememberSyncKey').checked;
  try {
    if (token) {
      if (token.length < 32) { notify('مفتاح المزامنة يجب أن يكون 32 حرفاً على الأقل.'); return; }
      sessionStorage.setItem(TOKEN_KEY, token);
      if (remember) localStorage.setItem(REMEMBERED_TOKEN_KEY, token);
      else localStorage.removeItem(REMEMBERED_TOKEN_KEY);
    } else {
      sessionStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REMEMBERED_TOKEN_KEY);
    }
  } catch {
    notify('تعذر حفظ مفتاح المزامنة. اسمح بتخزين بيانات الموقع أو أوقف خيار التذكر.');
    return;
  }
  $('setSyncKey').value = '';
  setSyncStatus(token ? (remember ? 'تم حفظ مفتاح المزامنة على هذا الجهاز' : 'المفتاح محفوظ لهذه الجلسة فقط') : 'محفوظ محلياً — المزامنة غير مفعلة');
  updateSyncStateBox();
  notify(token ? (remember ? '✅ تم حفظ مفتاح المزامنة على هذا الجهاز. لن تكتبه مرة أخرى.' : '✅ تم حفظ المفتاح لهذه الجلسة فقط.') : 'تم مسح مفتاح المزامنة.');
}
function clearRememberedSyncKey() {
  try { localStorage.removeItem(REMEMBERED_TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  if ($('setSyncKey')) $('setSyncKey').value = '';
  if ($('rememberSyncKey')) $('rememberSyncKey').checked = false;
  setSyncStatus('محفوظ محلياً — المزامنة غير مفعلة');
  updateSyncStateBox();
  notify('🧹 تم مسح مفتاح المزامنة المحفوظ من هذا الجهاز.');
}
function saveSettings() {
  if (!ensurePermission('admin')) return;
  const name = $('setStoreName').value.trim(), pin = $('setPinCode').value.trim(), token = $('setSyncKey').value.trim();
  if (!name) return alert('اسم المكتبة مطلوب.');
  if (pin && pin.length < 4) return alert('رقم قفل الشاشة يجب أن يكون أربعة أحرف على الأقل.');
  const business = {
    name, address: $('setStoreAddress').value.trim(), phone: $('setStorePhone').value.trim(), ...(pin ? { pin } : {}),
    mobile: $('setStoreMobile')?.value.trim() || '', invoiceNote: $('setInvoiceNote')?.value.trim() || '',
    currency: $('setCurrency')?.value.trim() || 'ج.م', paperSize: $('setPaperSize')?.value || 'A5',
    printer: $('setPrinter')?.value || '', defaultWarehouse: $('setDefaultWarehouse')?.value || 'الرئيسي',
    defaultSafe: $('setDefaultSafe')?.value || 'الخزينة الرئيسية'
  };
  if (!commitDB(draft => { Object.assign(draft.settings, business); })) return;
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
const BACKUP_REMINDER_KEY = `${DB_KEY}_BACKUP_REMINDER_DAYS`;
const LAST_BACKUP_KEY = `${DB_KEY}_LAST_BACKUP_DATE`;
function backupReminderDays() {
  try {
    const raw = localStorage.getItem(BACKUP_REMINDER_KEY);
    if (raw === null) return 7;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 7;
  } catch { return 7; }
}
function setBackupReminder(days) {
  const value = Number(days);
  if (!Number.isFinite(value) || value < 0) return;
  try { localStorage.setItem(BACKUP_REMINDER_KEY, String(value)); } catch { /* ignore */ }
  notify(value ? `✅ سيظهر تذكير النسخ الاحتياطي كل ${value} يوم.` : 'تم إيقاف تذكير النسخ الاحتياطي.');
}
function setBackupReminderFromUI() { setBackupReminder(Number($('backupReminderSelect').value) || 0); }
function checkBackupReminder() {
  const days = backupReminderDays();
  if (!days) return;
  let last = '';
  try { last = localStorage.getItem(LAST_BACKUP_KEY) || ''; } catch { last = ''; }
  const lastDate = last ? new Date(`${last}T00:00:00`) : null;
  const diff = lastDate ? (Date.now() - lastDate.getTime()) / 86400000 : Infinity;
  if (diff < days) return;
  const message = lastDate ? `آخر نسخة احتياطية كانت في ${last} (منذ ${Math.floor(diff)} يوم). يُفضّل تنزيل نسخة جديدة الآن.` : 'لم تقم بعمل نسخة احتياطية بعد. يُفضّل تنزيل نسخة الآن لحماية بياناتك.';
  const box = $('appNotice');
  if (!box) return;
  box.innerHTML = `<button type="button" aria-label="إغلاق التنبيه" onclick="this.parentElement.hidden=true">×</button><div>💾 <strong>تذكير النسخ الاحتياطي</strong><br>${esc(message)}</div><div style="margin-top:8px"><button type="button" class="act-btn bg-green" onclick="exportFullBackup(); document.getElementById('appNotice').hidden=true;">⬇️ نسخ احتياطي الآن</button></div>`;
  box.hidden = false;
}
function exportFullBackup() {
  if (!ensurePermission('admin')) return;
  download(JSON.stringify(db, null, 2), 'application/json', `POS_Backup_${localDate()}.json`);
  try { localStorage.setItem(LAST_BACKUP_KEY, localDate()); } catch { /* ignore */ }
  recordAudit('تصدير نسخة احتياطية');
}
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
function activeReportTable() {
  const active = document.querySelector('.float-window.active .sec-view.active') || document.querySelector('.sec-view.active');
  return { active, table: active?.querySelector('table') };
}
function exportCurrentReportExcel() {
  const { active, table } = activeReportTable();
  if (!table) return alert('لا يوجد جدول في هذه الشاشة لتصديره.');
  const cell = value => { let string = String(value ?? '').trim(); if (/^[=\-+@\t\r]/.test(string)) string = `'${string}`; return `"${string.replaceAll('"', '""')}"`; };
  const rows = [...table.querySelectorAll('tr')].map(tr => [...tr.children].map(td => {
    const input = td.querySelector('input, select, textarea');
    if (input) return input.tagName === 'SELECT' ? input.selectedOptions[0]?.textContent || '' : input.value;
    return td.textContent;
  }));
  const csv = '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n');
  download(csv, 'text/csv;charset=utf-8;', `POS_Report_${active?.id || 'report'}_${localDate()}.csv`);
  notify('✅ تم تصدير التقرير بصيغة Excel/CSV.');
}
function exportCurrentReportPDF() {
  const { active, table } = activeReportTable();
  if (!table) return alert('لا يوجد جدول في هذه الشاشة لتصديره.');
  const title = active?.querySelector('.page-bar-title, .pos-title')?.textContent || $('winTitle').textContent;
  triggerA5Print(`<div class="p-header"><h2>${esc(db.settings.name)}</h2><p>${esc(db.settings.address)} | هاتف: ${esc(db.settings.phone)}</p><h3>${esc(title)}</h3></div>${printableTable(table)}<p class="p-foot">تاريخ التصدير: ${esc(localDate())}</p>`);
  notify('اختر «حفظ كملف PDF» من نافذة الطباعة.');
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
  closeAllFloat(); closeKeypad(); closeWelcomePopup();
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
  try { if (!localStorage.getItem(WELCOME_KEY)) showWelcomeWizard(); } catch { /* storage disabled */ }
  window.setTimeout(() => { if ($('welcomeWizard')?.hidden !== false) checkBackupReminder(); }, 1800);
  beforeLockFocus?.focus();
}
const WELCOME_KEY = `${DB_KEY}_WELCOME_DONE`;
function showWelcomeWizard() {
  if (!$('welcomeWizard')) return;
  $('wizStoreName').value = db.settings.name || '';
  $('wizStoreAddress').value = db.settings.address || '';
  $('wizStorePhone').value = db.settings.phone || '';
  $('wizSyncKey').value = '';
  $('wizRememberKey').checked = true;
  $('welcomeWizard').hidden = false;
  document.body.style.overflow = 'hidden';
  window.setTimeout(() => $('wizStoreName')?.focus(), 60);
}
function hideWelcomeWizard() {
  if ($('welcomeWizard')) $('welcomeWizard').hidden = true;
  document.body.style.overflow = '';
}
function skipWelcomeWizard() {
  try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* ignore */ }
  hideWelcomeWizard();
  notify('يمكنك تخصيص بيانات المنشأة والمظهر في أي وقت من الإعدادات.');
}
function saveWelcomeWizard() {
  const name = $('wizStoreName').value.trim() || db.settings.name;
  const address = $('wizStoreAddress').value.trim();
  const phone = $('wizStorePhone').value.trim();
  const token = $('wizSyncKey').value.trim();
  const remember = $('wizRememberKey').checked;
  if (!commitDB(draft => { Object.assign(draft.settings, { name, address, phone }); })) return;
  try {
    if (token) {
      sessionStorage.setItem(TOKEN_KEY, token);
      if (remember) localStorage.setItem(REMEMBERED_TOKEN_KEY, token);
      else localStorage.removeItem(REMEMBERED_TOKEN_KEY);
    }
    localStorage.setItem(WELCOME_KEY, '1');
  } catch { notify('تعذر حفظ مفتاح المزامنة. يمكنك إدخاله لاحقاً من الإعدادات.'); }
  applySettingsUI(); applyAppearance(); updateActiveUserBadge(); hideWelcomeWizard();
  notify('✅ تم حفظ بيانات المنشأة. يمكنك تخصيص البرنامج بالكامل من الإعدادات.');
}

// Explicit public API for the HTML buttons; implementation details remain module-scoped.
Object.assign(window, {
  openPage, activatePage, registerTab, closeTab, closeAllTabs, renderTabs, paintNavbar, renderDashboard, toggleCalculator,
  toggleNavMenu, openNavMenu, closeMenus, openHomeMenu, paintTitleChrome, paintNavBell, shellSecondaryNav,
  SHELL_MENUS, PAGE_DEFS, DASH_GROUPS,
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
  switchSettingsTab, openSettingsTab, saveSyncKey, clearRememberedSyncKey, updateSyncStateBox, setActiveNav, quickPlaceholder, focusFloat, showWelcomeWizard, hideWelcomeWizard, skipWelcomeWizard, saveWelcomeWizard, saveContactMessage, renderContactMessages, markContactRead, deleteContactMessage, saveMaintenanceRequest, renderMaintenanceRequests, advanceMaintenanceStatus, deleteMaintenanceRequest, setBackupReminderFromUI, checkBackupReminder, printSelectedLabels, toggleLabelItem, toggleAllLabelItems, setLabelCopies, labelCopiesMap,
  setInvoiceTone, resetInvoiceTones, applyInvoiceTones, invoiceTones,
  setDocTemplate, setDocAccent, applyDocSettingsUI, uploadDocSignature, clearDocSignature, docSettings,
  tenderAlertLimit, setTenderAlert, confirmTenderDifference, belowCostLines, confirmBelowCost,
  setLogKind, applyLogKind, logKindForFilter,
  toggleStockAlerts, renderStockAlerts, openStockAlertsPage, quickPurchaseForItem, openPurchaseOrderFromLowStock, lowStockItems,
  syncAppBadge, paintBadgeHints,
  previewInvoiceA5, previewSavedInvoice, closeInvoicePreview, printPreviewA5, setPreviewZoom, previewInvoiceDraft,
  invoiceDocHtml, invoiceDocBody, openInvoiceDocument, invoiceDocTheme, DOC_THEME, exportInvoicePdfById, invoiceShareText, whatsappLink, shareInvoiceOnWhatsApp, updateCartPricesByTier, updateCartRow, removeCartRow, calcInvoiceTotals, calcInvoiceRemaining, clearInvCart,
  holdCurrentInvoice, restoreHeldInvoice, convertQuoteToSale, loadQuoteForSale, saveInvoice, printInvoiceById, printInvoiceThermalById,
  openPartySec, openPartyReport, resetPartyForm, saveParty, editParty, deleteParty, savePartyVoucher, toggleQuickParty, saveQuickParty, showStatementFor, renderPartyStatement,
  printPartyStatementA5, openInvLog, renderInvLog, openTreasury, addTreasuryMove, openProfitSec, renderProfits, saveSettings, syncToCloud, loadSettingsForm, renderHrAttendance,
  exportFullBackup, importFullBackup, exportItemsCSV, exportCurrentReportExcel, exportCurrentReportPDF, printItemsReportA5, printCurrentScreenA5, lockApp, unlockApp,
  switchInvoiceTab, switchItemsTab, selectPosGroup, addPosTile, bumpInvoiceQty, selectCartRow, focusCartField, openKeypad, setKeypadTab, closeKeypad, keypadPress, applyKeypad,
  openSalesInvoice, openPurchaseInvoice, openSaleReturn, openPurchaseReturn, openQuotePage, openCustomersPage, openSuppliersPage, openSettingsPage,
  syncInvoiceChrome, paintInvoiceSelects, renderPosItemSearch, addWatchItem, calcInput, paintCalcScreen, sendCalcToPaid, linkPageTab,
  filterParties, partyDebtTotals, showTotalDebt, showSelectedDebt, showPartyBalances, selectPartyRow, partyDisplayCode, partyMatches, hrFillStaffSelect, hrEmployeeName, hrSalaryOf, storeSetting, optionList,
  openHrPage, openHrTile, showHrPanel, renderHr, saveHrEmployee, editHrEmployee, deleteHrRecord, saveHrAttendance, saveHrDepartment, saveHrJob,
  saveHrVacation, saveHrPenalty, saveHrLedger, hrRead, hrWrite, hrMutate, hrReportRows, renderHrReport, printHrReport, HR_KEY,
  renderPosTiles, renderLabels, printLabels,
  toggleDashboard, setDashboardOpen, toggleActionGroup, setActionGroup, expandAllGroups, collapseAllGroups,
  applyLook, lookSettings, saveLook, setLookOption, setNightMode, setAutoNight, applyAutoNight, applyPalette, updateDashboardKPIs,
  flashSaveSuccess, invoiceStateTag, stockStateTag, avatarInitials, avatarMarkup, paintStaffAvatar,
  setDocFrame, setDocWatermark, docPaperOptions, setLabelTemplate, setReceiptStyle, receiptStyle, previewReceiptStyle,
  setAppIconColor, uploadAppIcon, downloadAppIcon, paintAppIconPreview, buildAppIconCanvas,
  enterFocusMode, exitFocusMode, toggleFocusMode, toggleRailSidebar,
  uploadStoreLogo, clearStoreLogo, toggleReceiptLogo, toggleCartColumn, toggleGroupColors, paintIconMode, lookIcon, paintKpiStates,
  installApp, setupInstallPrompt, applyDesign, resetDesign, setDesignField, applyThemePreset, uploadHeaderImage, uploadBackgroundImage, clearHeaderImage, clearBackgroundImage,
  uploadStartBackground, clearStartBackground, setStartBackgroundOpacity,
  showWelcomePopup, closeWelcomePopup, showNoticePopup, closeNoticePopup, askDialog,
  toggleRememberDevice, togglePinVisibility, setAutoLockMinutes, armAutoLock, isTrustedDevice, renderStartStats, showSyncDialog, closeSyncDialog, startScreenProgress, finishStartScreen
});
export { initializeApp };
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', initializeApp, { once: true });
else initializeApp();
