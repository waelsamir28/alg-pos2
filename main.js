/**
 * Electron entry point — trial desktop build of the POS.
 *
 * The app is a static bundle (index.html + app.js + lib/ + fonts/ + icons) that also talks to
 * `/api/sync` for cloud sync. Electron would load `file://` URLs, where the bundle's
 * root-absolute paths and a stable localStorage origin both break, so this process:
 *   1. starts a loopback HTTP server that serves the bundle (see electron/local-server.js),
 *   2. forwards `/api/sync` to the existing serverless handler,
 *   3. opens one locked-down BrowserWindow on that local address.
 *
 * Local data works with no configuration at all; cloud sync needs DATABASE_URL + SYNC_TOKEN
 * in the environment (the same variables the web build uses).
 *
 * ES module: package.json declares "type": "module" (Electron 28+ can run an ESM main process).
 */
import { app, BrowserWindow, Menu, dialog, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalServer } from './electron/local-server.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// `npm run electron:dev` points the window at the already-running dev server instead.
const DEV_URL = process.env.POS_DEV_URL || '';

let localServer = null;
let mainWindow = null;

async function loadSyncHandler() {
  try {
    const module = await import('./api/sync.js');
    return module.default || null;
  } catch (error) {
    // Sync is optional: the POS keeps working on local storage only.
    console.warn('Cloud sync handler unavailable:', error.name || 'Error');
    return null;
  }
}

function createWindow(url) {
  const origin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#f4f6fa',
    title: 'نقاط البيع',
    autoHideMenuBar: true,
    icon: path.join(ROOT, 'icon-512.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // The POS never needs a popup: any external link opens in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (target.startsWith(origin)) return; // the app itself may switch pages on its own origin
    event.preventDefault();
    if (/^https?:/i.test(target)) shell.openExternal(target);
  });

  mainWindow.loadURL(url);
  return mainWindow;
}

function stopServer() {
  if (!localServer) return;
  const closing = localServer.close();
  localServer = null;
  return closing;
}

// One running copy keeps a single localStorage database per machine.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    let url = DEV_URL;
    if (!url) {
      try {
        localServer = await createLocalServer({ root: ROOT, syncHandler: await loadSyncHandler() });
        url = localServer.url;
      } catch (error) {
        dialog.showErrorBox('تعذر تشغيل البرنامج', `لم يستطع التطبيق فتح منفذ محلي.\n${error.message || error}`);
        app.quit();
        return;
      }
    }
    createWindow(url);
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(url); });
  }).catch(error => {
    dialog.showErrorBox('تعذر تشغيل البرنامج', String(error?.stack || error));
    app.quit();
  });
}

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => { stopServer(); });
