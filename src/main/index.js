'use strict';

const { app, ipcMain, session, shell, Menu, dialog, nativeTheme } = require('electron');
const { Store } = require('./store');
const { BrowserShell, PARTITION } = require('./shell');
const { PasswordVault } = require('./passwords');
const { DEFAULT_SHORTCUTS, SEARCH_ENGINES, normalizeInput, prettifyUrl } = require('./urls');
const { buildAppMenu, popupToolsMenu } = require('./menu');

// One window per launch for now; the array leaves room for multi-window later.
/** @type {BrowserShell[]} */
const shells = [];
let store;
let vault;

/** Permissions we grant silently. Everything else is denied until there is UI to ask. */
const AUTO_GRANTED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);

function currentShell() {
  return shells[0] || null;
}

function configureSession() {
  const ses = session.fromPartition(PARTITION);

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(AUTO_GRANTED.has(permission));
  });

  ses.on('will-download', (_event, item) => {
    const shellRef = currentShell();
    const name = item.getFilename();
    shellRef?.send('shell:toast', { kind: 'download', message: `Downloading ${name}…` });

    item.once('done', (_e, state) => {
      if (state === 'completed') {
        shellRef?.send('shell:toast', {
          kind: 'download-done',
          message: `Saved ${name}`,
          path: item.getSavePath()
        });
      } else {
        shellRef?.send('shell:toast', { kind: 'error', message: `Download failed: ${name}` });
      }
    });
  });
}

function registerIpc() {
  const withShell = (handler) => (event, ...args) => {
    const shellRef = currentShell();
    if (!shellRef) return undefined;
    return handler(shellRef, ...args);
  };

  ipcMain.handle('shell:get-state', withShell((s) => s.getState()));

  ipcMain.on('tab:new', withShell((s, url, opts) => s.newTab(url, opts)));
  ipcMain.on('tab:close', withShell((s, id) => s.closeTab(id)));
  ipcMain.on('tab:activate', withShell((s, id) => s.activate(id)));
  ipcMain.on('tab:move', withShell((s, id, index) => s.moveTab(id, index)));
  ipcMain.on('tab:mute', withShell((s, id, muted) => s.tabs.get(id)?.setMuted(muted)));

  ipcMain.on('nav:go', withShell((s, input) => s.navigate(input)));
  ipcMain.on('nav:back', withShell((s) => s.activeTab?.goBack()));
  ipcMain.on('nav:forward', withShell((s) => s.activeTab?.goForward()));
  ipcMain.on('nav:reload', withShell((s, hard) => s.activeTab?.reload(Boolean(hard))));
  ipcMain.on('nav:stop', withShell((s) => s.activeTab?.stop()));
  ipcMain.on('nav:home', withShell((s) => s.activeTab?.loadURL(s.store.get('homepage'))));

  ipcMain.on('view:zoom', withShell((s, delta) => s.activeTab?.setZoom(delta)));
  ipcMain.on('view:devtools', withShell((s) => s.activeTab?.webContents.toggleDevTools()));
  ipcMain.on('view:content-bounds', withShell((s, rect, viewport) => s.setContentInsets(rect, viewport)));
  ipcMain.on('view:sidebar-width', withShell((s, width) => s.store.set('sidebarWidth', width)));
  ipcMain.on('view:theme', withShell((s, theme) => s.setTheme(theme)));

  // Resolving is free; loading is not. The renderer asks for the destination on
  // every keystroke and only asks for a load once the typing settles.
  ipcMain.handle('preview:resolve', (_event, input) => {
    const url = normalizeInput(input, store.get('searchEngine'), store.get('shortcuts'));
    return url ? prettifyUrl(url) : null;
  });

  ipcMain.on('preview:show', withShell((s, input, rect, viewport) => s.showPreview(input, rect, viewport)));
  ipcMain.on('preview:hide', withShell((s) => s.hidePreview()));

  ipcMain.on('preview:activate', (event) => {
    const shellRef = currentShell();
    // Only the preview view may ask for this, never a browsed page.
    if (!shellRef || !shellRef.previewView) return;
    if (event.sender !== shellRef.previewView.webContents) return;
    shellRef.activatePreview();
  });

  ipcMain.on('find:query', withShell((s, query, opts) => s.find(query, opts)));
  ipcMain.on('find:stop', withShell((s) => s.stopFind()));

  ipcMain.on('bookmark:toggle', withShell((s) => {
    const tab = s.activeTab;
    if (!tab) return;
    s.store.toggleBookmark({ url: tab.url, title: tab.title });
    s._broadcast();
  }));
  ipcMain.on('bookmark:remove', withShell((s, id) => {
    s.store.removeBookmark(id);
    s._broadcast();
  }));

  ipcMain.handle('history:list', withShell((s, limit = 200) => s.store.get('history').slice(0, limit)));
  ipcMain.on('history:clear', withShell((s) => {
    s.store.clearHistory();
    s._broadcast();
  }));

  ipcMain.on('app:open-external', (_e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  ipcMain.on('app:show-item', (_e, filePath) => {
    if (filePath) shell.showItemInFolder(filePath);
  });
  ipcMain.on('app:open-menu', withShell((s, x, y) => popupToolsMenu(s, x, y)));

  // --- settings ------------------------------------------------------------

  ipcMain.handle('settings:read', () => ({
    theme: store.get('theme'),
    homepage: store.get('homepage'),
    searchEngine: store.get('searchEngine'),
    engines: SEARCH_ENGINES,
    shortcuts: store.get('shortcuts'),
    defaultShortcuts: DEFAULT_SHORTCUTS,
    savePasswords: store.get('savePasswords'),
    encryptionAvailable: vault.available,
    blockedOrigins: vault.data.never,
    historyCount: store.get('history').length
  }));

  ipcMain.handle('settings:update', (_event, patch = {}) => {
    if (typeof patch.homepage === 'string' && patch.homepage.trim()) {
      store.set('homepage', patch.homepage.trim());
    }
    if (SEARCH_ENGINES[patch.searchEngine]) {
      store.set('searchEngine', patch.searchEngine);
    }
    if (typeof patch.savePasswords === 'boolean') {
      store.set('savePasswords', patch.savePasswords);
    }
    if (patch.shortcuts && typeof patch.shortcuts === 'object') {
      store.set('shortcuts', sanitizeShortcuts(patch.shortcuts));
    }
    if (patch.theme === 'day' || patch.theme === 'night') {
      currentShell()?.setTheme(patch.theme);
    }
    currentShell()?._broadcast();
    return true;
  });

  // --- saved logins --------------------------------------------------------

  ipcMain.on('passwords:submitted', (event, payload) => {
    const shellRef = currentShell();
    if (shellRef && payload && typeof payload.password === 'string') {
      shellRef.handleSubmittedLogin(event.sender, payload);
    }
  });

  ipcMain.on('passwords:resolve', withShell((s, action) => s.resolveSavePrompt(action)));

  ipcMain.handle('passwords:list', () => vault.list());
  ipcMain.handle('passwords:reveal', (_event, id) => vault.reveal(id));
  ipcMain.handle('passwords:remove', (_event, id) => {
    vault.remove(id);
    return vault.list();
  });
  ipcMain.handle('passwords:clear', () => {
    vault.clear();
    return vault.list();
  });
  ipcMain.handle('passwords:unblock', (_event, origin) => {
    vault.unblock(origin);
    return vault.data.never;
  });
}

/** Keep only well-formed `keyword -> template` pairs from the settings page. */
function sanitizeShortcuts(input) {
  const clean = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).trim().toLowerCase();
    const value = String(rawValue).trim();
    if (!key || /\s/.test(key) || key.length > 24) continue;
    if (!/^https?:\/\//i.test(value) || !value.includes('%s')) continue;
    clean[key] = value;
  }
  return clean;
}

function createShell() {
  const instance = new BrowserShell(store, vault);
  shells.push(instance);
  instance.window.on('closed', () => {
    const i = shells.indexOf(instance);
    if (i >= 0) shells.splice(i, 1);
  });
  Menu.setApplicationMenu(buildAppMenu(() => currentShell()));
  return instance;
}

// Single-instance: a second launch focuses the window we already have.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const shellRef = currentShell();
    if (!shellRef) return;
    if (shellRef.window.isMinimized()) shellRef.window.restore();
    shellRef.window.focus();
    const url = argv.find((a) => /^https?:\/\//i.test(a));
    if (url) shellRef.newTab(url);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.cloudbrowser.app');
    store = new Store();
    vault = new PasswordVault();
    nativeTheme.themeSource = store.get('theme') === 'night' ? 'dark' : 'light';
    configureSession();
    registerIpc();
    createShell();

    app.on('activate', () => {
      if (shells.length === 0) createShell();
    });
  });

  app.on('before-quit', () => {
    for (const s of shells) {
      if (!s.window.isDestroyed()) s.persistSession();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// Never let a renderer crash take the whole app down silently.
process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
  if (app.isReady()) {
    dialog.showErrorBox('Cloud Browser hit a problem', String(err?.stack || err));
  }
});

module.exports = { currentShell };
