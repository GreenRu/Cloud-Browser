/*
 * Stratus - a small web browser with cloud-shaped tabs.
 * Copyright (C) 2026 Sutton Sager
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

'use strict';

const { app, ipcMain, session, shell, Menu, dialog, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./store');
const { BrowserShell, PARTITION } = require('./shell');
const { PasswordVault } = require('./passwords');
const { DEFAULT_SHORTCUTS, SEARCH_ENGINES, normalizeInput, prettifyUrl, targetsFromArgv,
  setPluginPages } = require('./urls');
const { buildAppMenu, popupToolsMenu } = require('./menu');
const { registerSky } = require('./sky');
const { PluginHost } = require('./plugins');
const { CardWallet } = require('./cards');
const importer = require('./import');

/*
 * The app's name decides where its profile lives, so it has to be set before
 * anything reads a path - and before app-ready, because Chromium's OSCrypt
 * takes its encryption key from "Local State" inside that directory as it
 * initialises. Setting it later would leave saved passwords undecryptable.
 */
const APP_NAME = 'Stratus';
const PREVIOUS_NAME = 'Cloud Browser';
app.setName(APP_NAME);

/**
 * Carry the profile over from the old name, once.
 *
 * The whole directory is copied, "Local State" included: that file holds the
 * key the saved passwords were encrypted with, so leaving it behind would turn
 * every stored login into unreadable ciphertext.
 */
function migrateProfile() {
  try {
    const appData = app.getPath('appData');
    const next = path.join(appData, APP_NAME);
    const previous = path.join(appData, PREVIOUS_NAME);
    if (fs.existsSync(next) || !fs.existsSync(previous)) return;
    fs.cpSync(previous, next, { recursive: true });
    console.log(`[stratus] carried the profile over from "${PREVIOUS_NAME}"`);
  } catch (err) {
    // A fresh profile is a worse outcome than a slow start, but not a fatal one.
    console.error('[stratus] could not migrate the old profile:', err.message);
  }
}

migrateProfile();

// One window per launch for now; the array leaves room for multi-window later.
/** @type {BrowserShell[]} */
const shells = [];
let store;
let vault;
let plugins;
let cards;

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
  ipcMain.on('tab:pane-sizes', withShell((s, id, sizes) => s.setPaneSizes(id, sizes)));
  ipcMain.on('tab:split', withShell((s, id) => s.splitTab(id)));
  ipcMain.on('tab:merge', withShell((s, ids) => s.mergeTabs(ids)));
  ipcMain.on('tab:menu', withShell((s, id, x, y, selected) => s.showCloudMenu(id, x, y, selected)));

  /*
   * The menu's own view, and only it, may say these things. It is the browser's
   * own page, but the guard costs nothing and the alternative is a channel any
   * page could reach.
   */
  const fromMenu = (handler) => (event, ...args) => {
    const s = currentShell();
    if (!s || !s.menuView || s.menuView.webContents.isDestroyed()) return;
    if (event.sender !== s.menuView.webContents) return;
    handler(s, ...args);
  };

  ipcMain.on('menu:size', fromMenu((s, size) => s.placeCloudMenu(size)));
  ipcMain.on('menu:run', fromMenu((s, action) => s.runCloudMenu(action)));
  ipcMain.on('menu:close', fromMenu((s) => s.hideCloudMenu()));
  ipcMain.on('tab:reopen', withShell((s) => s.reopenClosedTab()));
  ipcMain.on('tab:mute', withShell((s, id, muted) => s.tabs.get(id)?.setMuted(muted)));

  /*
   * A merged cloud shows several pages side by side, and a request from one of
   * them belongs to that one. The sender says which: a pane acts on itself, and
   * the chrome - whose toolbar drives the cloud as a whole - acts on the tab in
   * front. Never on what the message claims about itself.
   */
  const senderTab = (s, event) => s.paneFor(event.sender) || s.activeTab;

  ipcMain.on('nav:go', (event, input) => currentShell()?.navigate(input, event.sender));
  ipcMain.on('nav:back', withShell((s) => s.activeTab?.goBack()));
  ipcMain.on('nav:forward', withShell((s) => s.activeTab?.goForward()));
  ipcMain.on('nav:reload', (event, hard) => {
    const s = currentShell();
    if (s) senderTab(s, event)?.reload(Boolean(hard));
  });
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

  ipcMain.on('preview:show', withShell((s, input, rect, viewport, frame) =>
    s.showPreview(input, rect, viewport, s.window.webContents, frame)));
  // Whoever asked for it is whoever can put it away - the address bar closes
  // the address bar's, a pane closes its own.
  ipcMain.on('preview:hide', (event) => currentShell()?.hidePreviewFor(event.sender));

  // The same bubble, asked for by one of the browser's own pages rather than
  // by the chrome. Which pane it came from decides where it goes.
  ipcMain.on('preview:show-in-page', (event, input, rect, viewport) =>
    currentShell()?.showPreviewInPage(event.sender, input, rect, viewport));

  ipcMain.on('preview:activate', (event) => {
    const shellRef = currentShell();
    if (!shellRef) return;

    // Only a preview view, or the card around the address bar's, may ask for
    // this - never a browsed page. Which preview it was decides which pane the
    // page opens in.
    for (const entry of shellRef.previews.values()) {
      if (entry.view.webContents === event.sender) {
        shellRef.activatePreviewFor(entry.owner);
        return;
      }
    }
    if (shellRef.frameView && !shellRef.frameView.webContents.isDestroyed() &&
        shellRef.frameView.webContents === event.sender) {
      shellRef.activatePreview();
    }
  });

  ipcMain.on('find:query', withShell((s, query, opts) => s.find(query, opts)));
  ipcMain.on('find:stop', withShell((s) => s.stopFind()));

  ipcMain.on('droplet:menu', withShell((s, id, x, y) => s.showDropletMenu(id, x, y)));
  ipcMain.on('droplet:show-bar', withShell((s, on) => s.setDropletsVisible(on)));

  ipcMain.on('droplet:toggle', withShell((s) => {
    const tab = s.activeTab;
    if (!tab) return;
    s.store.toggleBookmark({ url: tab.url, title: tab.title });
    s._broadcast();
  }));
  ipcMain.on('droplet:remove', withShell((s, id) => {
    s.store.removeBookmark(id);
    s._broadcast();
  }));

  ipcMain.handle('history:list', withShell((s, limit = 200) => s.store.get('history').slice(0, limit)));
  // Where the clouds have been, for whoever is drawing it.
  ipcMain.handle('timeline:read', (event) => currentShell()?.trails(event.sender) || null);

  ipcMain.handle('history:remove', withShell((s, url, visitedAt) => {
    const gone = s.store.removeHistory(url, visitedAt);
    s._broadcast();
    return gone;
  }));

  ipcMain.handle('history:clear-between', withShell((s, from, to) => {
    const gone = s.store.clearHistoryBetween(Number(from), Number(to));
    s._broadcast();
    return gone;
  }));

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

  // --- saved cards -----------------------------------------------------------

  ipcMain.handle('cards:list', () => ({
    cards: cards.list(),
    available: cards.available,
    saveCards: store.get('saveCards') !== false,
    keepsCvv: cards.keepsCvv
  }));

  ipcMain.handle('cards:save', (_event, card) => cards.save(card || {}));
  ipcMain.handle('cards:reveal', (_event, id) => cards.reveal(id));
  ipcMain.handle('cards:remove', (_event, id) => cards.remove(id));
  ipcMain.handle('cards:clear', () => {
    cards.clear();
    return true;
  });

  /*
   * The one setting here with a memory. Switching it off destroys every code
   * held; switching it back on does not bring any of them back.
   */
  ipcMain.handle('cards:keep-cvv', (_event, on) => {
    cards.setKeepCvv(on);
    return { keepsCvv: cards.keepsCvv, cards: cards.list() };
  });

  ipcMain.handle('cards:forget-cvv', () => {
    const gone = cards.forgetAllCvv();
    return { forgotten: gone, cards: cards.list() };
  });

  // --- bringing things over from another browser -------------------------------

  ipcMain.handle('import:sources', () => {
    try {
      return importer.findSources();
    } catch (err) {
      return [];
    }
  });

  /** Bookmarks read straight out of another browser's own file. */
  ipcMain.handle('import:bookmarks', (_event, id) => {
    try {
      const added = store.addBookmarks(importer.readSource(String(id)));
      currentShell()?._broadcast();
      return { ok: true, added };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  /**
   * A file the other browser exported. Bookmarks as HTML, logins or cards as
   * CSV - the door every browser leaves open for this, and the only one that
   * works for passwords, which are sealed to the browser that saved them.
   */
  ipcMain.handle('import:file', async (_event, kind) => {
    const filters = kind === 'bookmarks'
      ? [{ name: 'Bookmarks', extensions: ['html', 'htm'] }]
      : [{ name: 'Comma-separated values', extensions: ['csv'] }];

    const picked = await dialog.showOpenDialog(currentShell()?.window, {
      title: 'Choose the file the other browser exported',
      properties: ['openFile'],
      filters
    });
    if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };

    let text;
    try {
      text = fs.readFileSync(picked.filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }

    try {
      if (kind === 'bookmarks') {
        const added = store.addBookmarks(importer.readBookmarkHtml(text));
        currentShell()?._broadcast();
        return { ok: true, added };
      }

      if (kind === 'passwords') {
        if (!vault.available) return { ok: false, error: 'no-keystore' };
        let added = 0;
        for (const entry of importer.readPasswordCsv(text)) {
          const origin = PasswordVault.originOf(entry.url);
          if (!origin) continue;
          if (vault.save({ origin, username: entry.username, password: entry.password })) added += 1;
        }
        return { ok: true, added };
      }

      if (kind === 'cards') {
        if (!cards.available) return { ok: false, error: 'no-keystore' };
        let added = 0;
        for (const card of importer.readCardCsv(text)) {
          if (cards.save(card).ok) added += 1;
        }
        return { ok: true, added, cards: cards.list() };
      }

      return { ok: false, error: 'unknown kind' };
    } finally {
      // Whatever was read, it is not kept around in memory.
      text = null;
    }
  });

  // --- plugins ---------------------------------------------------------------

  /** Everything installed, whether it loaded, and whether it is switched on. */
  ipcMain.handle('plugins:list', () => plugins.list());

  ipcMain.handle('plugins:set-enabled', (_event, id, on) => {
    if (!plugins.setEnabled(id, Boolean(on))) return plugins.list();
    // What a plugin contributes is decided at these two points, so both have to
    // be told when the set of live plugins changes.
    setPluginPages(plugins.pages());
    Menu.setApplicationMenu(buildAppMenu(() => currentShell(), plugins));
    currentShell()?._broadcast();
    return plugins.list();
  });

  /** Read the folder again, for someone who has just added or edited one. */
  ipcMain.handle('plugins:reload', () => {
    plugins.load();
    setPluginPages(plugins.pages());
    Menu.setApplicationMenu(buildAppMenu(() => currentShell(), plugins));
    currentShell()?._broadcast();
    return plugins.list();
  });

  /** One colour, from the theme editor. */
  ipcMain.handle('plugins:set-theme-value', (_event, themeId, fieldId, value) => {
    if (!plugins.setThemeValue(themeId, fieldId, value)) return false;
    // Repaint at once if it is the theme being worn.
    if (store.get('theme') === themeId) currentShell()?.setTheme(themeId);
    return true;
  });

  ipcMain.handle('plugins:open-folder', () => {
    const dir = plugins.dirs[plugins.dirs.length - 1];
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* it may already be there */
    }
    shell.openPath(dir);
    return dir;
  });

  // --- the clouds on the new tab sky ---------------------------------------

  registerSky(ipcMain, { store });

  // --- settings ------------------------------------------------------------

  /**
   * Cookies, storage, caches - everything a site has left behind. Not the same
   * as history, and asked for separately.
   */
  ipcMain.handle('settings:clear-site-data', async () => {
    await session.fromPartition(PARTITION).clearStorageData();
    await session.fromPartition(PARTITION).clearCache();
    return true;
  });

  ipcMain.handle('settings:read', () => ({
    theme: store.get('theme'),
    themeBase: currentShell()?.themeState().base || 'day',
    pageThemeVars: currentShell()?.themeState().pageVariables || {},
    // Whatever a plugin is offering, with the fields it wants filled in and
    // what they are currently set to, so the page can draw the editor.
    customThemes: plugins.themes().map((t) => ({
      id: t.id,
      name: t.name,
      pluginName: plugins.plugins.get(t.plugin)?.name || t.plugin,
      fields: t.fields,
      values: plugins.themeValues(t.id)
    })),
    homepage: store.get('homepage'),
    searchEngine: store.get('searchEngine'),
    engines: SEARCH_ENGINES,
    shortcuts: store.get('shortcuts'),
    defaultShortcuts: DEFAULT_SHORTCUTS,
    savePasswords: store.get('savePasswords'),
    restoreSession: store.get('restoreSession') !== false,
    saveHistory: store.get('saveHistory') !== false,
    defaultZoom: Number(store.get('defaultZoom')) || 1,
    showFullUrl: store.get('showFullUrl') !== false,
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
    if (typeof patch.saveCards === 'boolean') {
      store.set('saveCards', patch.saveCards);
    }
    if (typeof patch.restoreSession === 'boolean') {
      store.set('restoreSession', patch.restoreSession);
    }
    if (typeof patch.saveHistory === 'boolean') {
      store.set('saveHistory', patch.saveHistory);
    }
    if (patch.defaultZoom !== undefined) {
      currentShell()?.setDefaultZoom(patch.defaultZoom);
    }
    if (typeof patch.showFullUrl === 'boolean') {
      store.set('showFullUrl', patch.showFullUrl);
    }
    if (patch.shortcuts && typeof patch.shortcuts === 'object') {
      store.set('shortcuts', sanitizeShortcuts(patch.shortcuts));
    }
    // Built in, or one a live plugin is offering.
    if (typeof patch.theme === 'string' &&
        (patch.theme === 'day' || patch.theme === 'night' || plugins.theme(patch.theme))) {
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

  /*
   * A checkout page asked, because someone put the cursor in a card field.
   *
   * The page says only that it asked; it names no card and gets no list. With
   * more than one saved there is no way to know which is meant, so nothing is
   * filled - the same rule the logins follow.
   */
  ipcMain.on('cards:wanted', (event) => {
    if (!cards || !cards.available) return;
    if (store.get('saveCards') === false) return;

    const shellRef = currentShell();
    // Only a real page. A built-in page or a preview has no business here.
    if (!shellRef || !shellRef.isTabContents(event.sender)) return;
    if (!/^https?:/i.test(event.sender.getURL())) return;

    const saved = cards.list().filter((c) => !c.expired);
    if (saved.length !== 1) return;

    event.sender.send('cards:fill', cards.forFilling(saved[0].id));
  });

  /* A code that was typed by hand, which is what being asked for it means. */
  ipcMain.on('cards:cvv-typed', (event, payload) => {
    if (!cards || !payload) return;
    const shellRef = currentShell();
    if (!shellRef || !shellRef.isTabContents(event.sender)) return;
    cards.rememberCvv(String(payload.id || ''), String(payload.cvv || ''));
  });

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

function createShell(targets = []) {
  const instance = new BrowserShell(store, vault, plugins);
  instance.pendingTargets = targets;
  shells.push(instance);
  instance.window.on('closed', () => {
    const i = shells.indexOf(instance);
    if (i >= 0) shells.splice(i, 1);
  });
  Menu.setApplicationMenu(buildAppMenu(() => currentShell(), plugins));
  return instance;
}

// Single-instance: a second launch focuses the window we already have.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch - including a file opened with Stratus, or a link clicked
  // while Stratus is the default browser - lands here rather than starting a
  // second copy.
  app.on('second-instance', (_e, argv) => {
    const shellRef = currentShell();
    if (!shellRef) return;
    if (shellRef.window.isMinimized()) shellRef.window.restore();
    shellRef.window.focus();
    for (const target of targetsFromArgv(argv)) shellRef.newTab(target);
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.stratus.browser');
    store = new Store();
    vault = new PasswordVault();
    plugins = new PluginHost(store);
    cards = new CardWallet(store);
    setPluginPages(plugins.pages());
    nativeTheme.themeSource = store.get('theme') === 'night' ? 'dark' : 'light';
    configureSession();
    registerIpc();
    createShell(targetsFromArgv(process.argv));

    app.on('activate', () => {
      if (shells.length === 0) createShell();
    });

    // macOS hands files over this way rather than on the command line.
    app.on('open-file', (event, filePath) => {
      event.preventDefault();
      const [target] = targetsFromArgv(['', filePath]);
      if (!target) return;
      const shellRef = currentShell();
      if (shellRef) shellRef.newTab(target);
      else createShell([target]);
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
    dialog.showErrorBox('Stratus hit a problem', String(err?.stack || err));
  }
});

module.exports = { currentShell };
