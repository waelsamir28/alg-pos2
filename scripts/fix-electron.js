#!/usr/bin/env node
/**
 * Repairs an Electron install whose binary never downloaded.
 *
 * The message "Electron failed to install correctly, please delete node_modules/electron and try
 * installing again" means node_modules/electron exists but its `dist/` folder (the actual
 * Chromium runtime, ~200MB) is missing — usually because the postinstall download hit a proxy,
 * a firewall, a certificate problem or a VPN. Re-running `npm install` alone does not fix it,
 * because npm considers the package already installed.
 *
 * This script downloads the runtime directly with Node's own HTTP client and unpacks it, so the
 * error message in the browser/AV logs is the only thing left to interpret.
 *
 * Usage: npm run fix:electron
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile, readdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const ELECTRON_DIR = path.join('node_modules', 'electron');
const VERSION_URL = 'https://github.com/electron/electron/releases/download';

const log = message => console.log(`\x1b[36m›\x1b[0m ${message}`);
const ok = message => console.log(`\x1b[32m✔\x1b[0m ${message}`);
const warn = message => console.log(`\x1b[33m!\x1b[0m ${message}`);

function fail(message, hint) {
  console.error(`\n\x1b[31m✖ ${message}\x1b[0m`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

function platformSlug() {
  const arch = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[process.arch];
  if (process.platform === 'win32') return `win32-${arch}`;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  return `linux-${arch}`;
}

async function packageVersion() {
  const manifest = JSON.parse(await readFile(path.join(ELECTRON_DIR, 'package.json'), 'utf8'));
  return manifest.version;
}

async function download(url, destination) {
  // Electron's release assets live on a different host after a 302 redirect, and some
  // corporate proxies only allow the first hop, so follow redirects by hand.
  let target = url;
  let response = null;
  for (let hop = 0; hop < 6; hop += 1) {
    response = await fetch(target, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (!next) break;
      target = new URL(next, target).toString();
      continue;
    }
    break;
  }
  if (!response || !response.ok || !response.body) {
    const error = new Error(`HTTP ${response?.status || '?'} من ${new URL(target).host}`);
    error.status = response?.status;
    throw error;
  }
  await pipeline(response.body, createWriteStream(destination));
  const size = (await stat(destination)).size;
  if (size < 10 * 1024 * 1024) throw new Error(`الملف المنزّل صغير جدًا (${size} بايت) — التحميل لم يكتمل.`);
  return size;
}

async function sha256(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function unzip(archive, destination) {
  // PowerShell ships with every Windows install; `tar` does the job on macOS/Linux.
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`], { stdio: 'inherit' });
    return;
  }
  execFileSync('unzip', ['-q', archive, '-d', destination], { stdio: 'inherit' });
}

const VERIFY_ONLY = process.argv.includes('--verify');

async function main() {
  if (!await exists(ELECTRON_DIR)) {
    const hint = 'شغّل أولاً:  npm install';
    if (VERIFY_ONLY) { warn('node_modules/electron غير موجود — شغّل npm install أولاً.'); process.exit(0); }
    fail('مجلد node_modules/electron غير موجود.', hint);
  }
  const version = await packageVersion();
  const slug = platformSlug();
  const distDir = path.join(ELECTRON_DIR, 'dist');

  const installed = async () => {
    if (!await exists(distDir)) return false;
    const entries = await readdir(distDir);
    // a real runtime always has the executable plus at least one resources bundle
    return entries.length >= 2;
  };
  if (await installed()) {
    if (!VERIFY_ONLY) {
      ok('ملفات Electron موجودة بالفعل — لا حاجة للإصلاح.');
      log(`المسار: ${distDir}`);
    }
    return;
  }
  if (VERIFY_ONLY) {
    warn('ملفات Electron غير مكتملة — جاري إصلاحها تلقائيًا قبل التشغيل…');
    return runRepair();
  }

  return runRepair();
}

async function runRepair() {
  const version = await packageVersion();
  const slug = platformSlug();
  const distDir = path.join(ELECTRON_DIR, 'dist');
  log(`تنزيل Electron ${version} لنظام ${slug} …`);
  const archiveName = `electron-v${version}-${slug}.zip`;
  const archive = path.join(os.tmpdir(), archiveName);
  const url = `${VERSION_URL}/v${version}/${archiveName}`;

  let size = 0;
  const sizeOf = async file => { try { return (await stat(file)).size; } catch { return 0; } };
  // A hand-copied archive from a previous attempt (the offline route) is reused as-is.
  if (await sizeOf(archive) > 1024 * 1024) {
    size = await sizeOf(archive);
    warn(`استخدام الملف الموجود مسبقًا: ${archive} (${(size / 1024 / 1024).toFixed(1)} ميجابايت)`);
  }
  try {
    if (!size) size = await download(url, archive);
  } catch (error) {
    if (error.status === 404) {
      fail(`نسخة Electron ${version} غير متاحة لنظام ${slug}.`,
        'جرّب تثبيت نسخة مختلفة:  npm install electron@33 --save-dev');
    }
    fail(`تعذر تنزيل Electron من GitHub (${error.message}).`, [
      'الأسباب الشائعة والحل:',
      '  • بروكسي/شبكة الشركة تمنع github.com  → جرّب شبكة أخرى أو أوقف الـ VPN.',
      '  • مانع فيروسات يفحص التنزيلات       → أوقفه مؤقتًا ثم أعد المحاولة.',
      '  • شهادة SSL غير موثوقة               → شغّل:  npm config set strict-ssl false   ثم أعد المحاولة.',
      '  • الحل المضمون عند حجب GitHub:  نزّل الملف من جهاز/شبكة أخرى إلى:',
      '      ' + archive,
      '    ثم شغّل هذا الأمر مرة أخرى — سيستخدم الملف بدل التنزيل.'
    ].join('\n'));
  }
  ok(`تم تنزيل ${(size / 1024 / 1024).toFixed(1)} ميجابايت.`);

  log('التحقق من البصمة الرقمية (SHA256) …');
  let checksumOk = false;
  try {
    const published = await (await fetch(`${url}.sha256sum`, { redirect: 'follow' })).text();
    if (!/^[a-f0-9]{64}/i.test(published.trim())) throw new Error('no checksum');
    const expected = published.trim().split(/\s+/)[0].toLowerCase();
    checksumOk = expected === await sha256(archive);
    if (checksumOk) ok('البصمة مطابقة للملف الرسمي.');
    else warn('البصمة غير مطابقة — سيتم المتابعة لكن قد يكون الملف تالفًا.');
  } catch {
    warn('لم يتم العثور على ملف البصمة — تم تخطي التحقق.');
  }

  log('فك الضغط …');
  await rm(distDir, { recursive: true, force: true });
  const staging = path.join(ELECTRON_DIR, `dist-unpack-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  try {
    await unzip(archive, staging);
    const entries = await readdir(staging);
    // GitHub archives put the runtime at the root; be tolerant of one wrapping folder.
    const root = entries.length === 1 ? path.join(staging, entries[0]) : staging;
    await mkdir(distDir, { recursive: true });
    for (const entry of await readdir(root)) {
      await rename(path.join(root, entry), path.join(distDir, entry));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  // electron/index.js reads this file to locate the executable.
  const pathFile = path.join(ELECTRON_DIR, 'path.txt');
  await writeFile(pathFile, process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron', 'utf8');

  // electron-builder reuses this cache folder instead of downloading again.
  if (process.platform === 'win32') {
    const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache');
    await mkdir(cacheRoot, { recursive: true });
    await writeFile(path.join(cacheRoot, `${archiveName}`), await readFile(archive));
    log(`نُسخت الحزمة إلى كاش البناء: ${cacheRoot}`);
  }

  await rm(archive, { force: true });
  ok(`تم إصلاح Electron ${version}. جرّب الآن:  npm run electron`);
  if (!checksumOk) warn('ملاحظة: لم يتم التأكد من البصمة الرقمية.');
}

main().catch(error => fail(error.message || String(error)));
