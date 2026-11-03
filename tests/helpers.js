import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { emptyDatabase } from '../lib/data.js';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
export const DB_KEY = 'BOOKSTORE_POS_COMPLETE_DB_V2';
export const META_KEY = `${DB_KEY}_SYNC_META`;
export const TOKEN_KEY = `${DB_KEY}_SESSION_TOKEN`;
let sequence = 0;
export function fixture(t, { db = emptyDatabase(), meta = null, token = '', fetch } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:3000/', pretendToBeVisual: true });
  const { window } = dom;
  const alerts = [], confirms = [], prints = [], downloads = [];
  let confirmAnswer = true;
  window.alert = message => alerts.push(String(message));
  window.confirm = message => { confirms.push(message); return confirmAnswer; };
  window.prompt = () => 'مجموعة جديدة';
  window.print = () => prints.push(window.document.getElementById('printAreaA5').innerHTML);
  window.scrollTo = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};
  window.URL.createObjectURL = blob => { downloads.push(blob); return `blob:mock-${downloads.length}`; };
  window.URL.revokeObjectURL = () => {};
  for (const [key, value] of Object.entries({ window, document: window.document, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    alert: window.alert, confirm: window.confirm, prompt: window.prompt, URL: window.URL, Blob: window.Blob, File: globalThis.File,
    fetch: fetch || (async () => { throw new Error('Network unavailable'); }) })) globalThis[key] = value;
  window.localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (meta) window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
  t.after(() => window.close());
  return { window, alerts, confirms, prints, downloads, setConfirm: value => { confirmAnswer = value; },
    $: id => window.document.getElementById(id),
    fill: (id, value) => { window.document.getElementById(id).value = String(value); },
    saved: () => JSON.parse(window.localStorage.getItem(DB_KEY)),
    load: async () => import(`../app.js?test=${++sequence}`) };
}
export function seedDatabase() {
  const db = emptyDatabase();
  db.items = [
    { id: 1, code: '1001', name: 'كتاب', cat: 'كتب خارجية', type: 'كتاب خارجي', warehouse: 'الرئيسي', unit: 'عدد', qty: 10, minQty: 2, buy: 100, profitPct: 50, sell: 150, wholesale: 130, minSell: 110, notes: '' },
    { id: 2, code: '1002', name: 'قلم', cat: 'أقلام وأدوات كتابة', type: 'أدوات مدرسية', warehouse: 'الرئيسي', unit: 'عدد', qty: 5, minQty: 1, buy: 5, profitPct: 100, sell: 10, wholesale: 8, minSell: 7, notes: '' }
  ];
  db.parties.push({ id: 2, type: 'customer', name: 'عميل آجل', phone: '', balance: 100, notes: '' }, { id: 3, type: 'supplier', name: 'مورد', phone: '', balance: 500, notes: '' });
  return db;
}
export function addLine(f, code = '1001', qty = 1) { f.fill('invBarcodeInp', code); f.fill('invAddQty', qty); f.window.addInvItemFromInput(); }
export function blobText(f, blob) { return new Promise((resolve, reject) => { const reader = new f.window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsText(blob); }); }
export async function backupObject(f) { f.window.exportFullBackup(); return JSON.parse(await blobText(f, f.downloads.at(-1))); }
