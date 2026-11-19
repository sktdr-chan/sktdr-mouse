'use strict';

// =============================================================================
// sktdr-mouse — Electron shell.
// Boots the same local server in-process (server.js → startServer) and shows
// the UI in a native window, so the app runs as a single portable .exe.
// =============================================================================

const { app, BrowserWindow, Menu, dialog } = require('electron');
const path = require('path');

const PORT = Number(process.env.PORT || 3554);
const URL = `http://localhost:${PORT}`;

let mainWindow = null;
let serverInfo = null;

// Host-side caches must live somewhere writable when packaged (asar is read-only)
process.env.SKTDR_DATA_DIR = process.env.SKTDR_DATA_DIR || path.join(app.getPath('userData'), 'data');
process.env.NO_BROWSER = '1';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'sktdr-mouse',
    backgroundColor: '#f5f7fa',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(URL).catch(() => {
    // the server may still be starting — retry once shortly after
    setTimeout(() => mainWindow && mainWindow.loadURL(URL), 800);
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function boot() {
  try {
    const { startServer } = require(path.join(__dirname, '..', 'server.js'));
    serverInfo = startServer(PORT);
  } catch (e) {
    if (e && (e.code === 'EADDRINUSE' || /EADDRINUSE/.test(String(e.message)))) {
      // another instance (or the dev server) is already serving this port
    } else {
      dialog.showErrorBox('sktdr-mouse', `サーバーの起動に失敗しました:\n${e && e.message}`);
      app.quit();
      return;
    }
  }
  // open the window as soon as the server is listening; if the port is busy
  // (EADDRINUSE) a different server already serves it — open right away
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    createWindow();
  };
  if (serverInfo && serverInfo.server && !serverInfo.server.listening) {
    serverInfo.server.once('listening', open);
    setTimeout(open, 1200);
  } else {
    open();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.sktdr.mouse');
    Menu.setApplicationMenu(null);
    boot();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (serverInfo && serverInfo.manager) {
      for (const a of serverInfo.manager.adapters.values()) {
        try {
          a.gracefulClose();
        } catch (e) {
          /* ignore */
        }
      }
    }
  });
}
