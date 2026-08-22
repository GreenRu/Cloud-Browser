'use strict';

const path = require('path');
const { BrowserWindow, Menu, clipboard, shell, screen, nativeTheme } = require('electron');
const { WebContentsView } = require('electron');
const { Tab } = require('./tab');
const { normalizeInput, prettifyUrl, resolveLoadTarget } = require('./urls');
const { PasswordVault } = require('./passwords');

const PARTITION = 'persist:cloud';

// Until the renderer measures itself, park the page view below a toolbar-sized
// strip and to the right of a default sidebar so the first paint is not wrong.
const DEFAULT_INSETS = { left: 252, top: 40, right: 10, bottom: 10 };

// Must match --titlestrip-h and the top stop of the sky gradient in the
// renderer stylesheet, so the OS-drawn window controls sit flush on the sky.
const TITLEBAR_HEIGHT = 40;
const THEME_CHROME = {
  day: { color: '#74b1e5', symbol: '#1d3a56' },
  night: { color: '#16243c', symbol: '#c3d5ec' }
};

/**
 * Keep the window inside the display it will open on. Saved bounds can outlive
 * the monitor that produced them, and the defaults are simply too large for a
 * small or heavily scaled screen.
 */
function fitToScreen(saved) {
  const hasPosition = Number.isInteger(saved.x) && Number.isInteger(saved.y);
  const display = hasPosition
    ? screen.getDisplayMatching({ x: saved.x, y: saved.y, width: saved.width || 1280, height: saved.height || 820 })
    : screen.getPrimaryDisplay();
  const area = display.workArea;

  const width = Math.min(saved.width || 1280, area.width - 40);
  const height = Math.min(saved.height || 820, area.height - 40);
  const bounds = { ...saved, width: Math.max(640, width), height: Math.max(420, height) };

  if (hasPosition) {
    bounds.x = Math.min(Math.max(saved.x, area.x), area.x + area.width - bounds.width);
    bounds.y = Math.min(Math.max(saved.y, area.y), area.y + area.height - bounds.height);
  }
  return bounds;
}

/**
 * The browser window: a chrome UI (BrowserWindow web contents) painted across
 * the whole window, with the active tab's WebContentsView layered below it.
 */
class BrowserShell {
  constructor(store, vault) {
    this.store = store;
    this.vault = vault || new PasswordVault();
    this.pendingLogin = null;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.insets = { ...DEFAULT_INSETS };
    this.findQuery = '';
    this.previewView = null;
    this.previewAttached = false;
    this.previewUrl = null;

    const bounds = fitToScreen(store.get('window') || {});
    const theme = THEME_CHROME[store.get('theme')] || THEME_CHROME.day;

    this.window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: Number.isInteger(bounds.x) ? bounds.x : undefined,
      y: Number.isInteger(bounds.y) ? bounds.y : undefined,
      minWidth: 640,
      minHeight: 420,
      show: false,
      backgroundColor: theme.color,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: theme.color, symbolColor: theme.symbol, height: TITLEBAR_HEIGHT },
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'chrome.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    this.window.setMenuBarVisibility(false);
    if (bounds.maximized) this.window.maximize();

    this.window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    this.window.once('ready-to-show', () => this.window.show());
    this.window.on('resize', () => this._layout());
    this.window.on('enter-full-screen', () => this._layout());
    this.window.on('leave-full-screen', () => this._layout());
    this.window.on('move', () => this._persistBounds());
    this.window.on('resized', () => this._persistBounds());
    // Capture the session while the tabs still exist: by the time 'closed' or
    // 'before-quit' fire, they have already been torn down.
    this.window.on('close', () => this.persistSession());
    this.window.on('closed', () => {
      this.destroyPreview();
      for (const tab of this.tabs.values()) tab.destroy();
      this.tabs.clear();
    });

    this.window.webContents.on('did-finish-load', () => {
      this._broadcast();
      if (this.tabs.size === 0) this._restoreSession();
    });

    // The chrome UI never navigates itself; outbound links become tabs.
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.newTab(url);
      return { action: 'deny' };
    });
  }

  // --- lifecycle -----------------------------------------------------------

  _restoreSession() {
    const session = this.store.get('session');
    const urls = Array.isArray(session) && session.length
      ? session
      : [this.store.get('homepage')];
    urls.forEach((url, i) => this.newTab(url, { background: i > 0 }));
  }

  _persistBounds() {
    if (this.window.isDestroyed()) return;
    const maximized = this.window.isMaximized();
    const b = this.window.getNormalBounds();
    this.store.set('window', { ...b, maximized });
  }

  persistSession() {
    const urls = this.order
      .map((id) => this.tabs.get(id))
      .filter(Boolean)
      .map((t) => prettifyUrl(t.url));
    this.store.set('session', urls);
    this._persistBounds();
    this.store.flush();
  }

  // --- layout --------------------------------------------------------------

  /**
   * The renderer measures where the page should sit (the rect of its `.stage`
   * placeholder) and reports it as insets from each window edge. Insets - not
   * absolute bounds - because the window can resize between two reports, and
   * insets still give the right answer at any size.
   */
  setContentInsets(rect, viewport) {
    if (!rect || !viewport || !viewport.width || !viewport.height) return;
    const next = {
      left: Math.max(0, Math.round(rect.x)),
      top: Math.max(0, Math.round(rect.y)),
      right: Math.max(0, Math.round(viewport.width - rect.x - rect.width)),
      bottom: Math.max(0, Math.round(viewport.height - rect.y - rect.height))
    };
    const unchanged = Object.keys(next).every((k) => next[k] === this.insets[k]);
    if (unchanged) return;
    this.insets = next;
    this._layout();
  }

  _layout() {
    if (this.window.isDestroyed()) return;
    const tab = this.tabs.get(this.activeId);
    if (!tab || tab.destroyed) return;

    const [width, height] = this.window.getContentSize();
    const { left, top, right, bottom } = this.insets;
    tab.view.setBounds({
      x: left,
      y: top,
      width: Math.max(0, width - left - right),
      height: Math.max(0, height - top - bottom)
    });
  }

  // --- tabs ----------------------------------------------------------------

  newTab(rawUrl, { background = false } = {}) {
    const url = rawUrl || this.store.get('homepage');
    const tab = new Tab({
      url,
      partition: PARTITION,
      onChange: (t) => this._onTabChanged(t),
      onOpenTab: (u, opts) => this.newTab(u, opts),
      onContextMenu: (t, params) => this._showPageContextMenu(t, params)
    });

    tab.webContents.on('did-finish-load', () => this.autofill(tab));

    tab.webContents.on('found-in-page', (_e, result) => {
      if (tab.id !== this.activeId) return;
      this.send('shell:find-result', {
        matches: result.matches,
        current: result.activeMatchOrdinal
      });
    });

    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);

    if (!background || !this.activeId) {
      this.activate(tab.id);
    } else {
      this._broadcast();
    }
    return tab;
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.destroyed) return;

    const previous = this.tabs.get(this.activeId);
    if (previous && previous !== tab && !previous.destroyed) {
      this.window.contentView.removeChildView(previous.view);
    }

    this.hidePreview();
    this.activeId = id;
    this.window.contentView.addChildView(tab.view);
    this._layout();
    tab.webContents.focus();
    this._broadcast();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    const index = this.order.indexOf(id);
    this.order.splice(index, 1);
    this.tabs.delete(id);

    if (!tab.destroyed) this.window.contentView.removeChildView(tab.view);
    tab.destroy();

    if (this.activeId === id) {
      this.activeId = null;
      const nextId = this.order[index] || this.order[index - 1];
      if (nextId) {
        this.activate(nextId);
      } else if (!this.window.isDestroyed()) {
        // Never leave an empty shell - a browser always has one tab.
        this.newTab(this.store.get('homepage'));
      }
    } else {
      this._broadcast();
    }
  }

  cycleTab(step) {
    if (this.order.length < 2) return;
    const index = this.order.indexOf(this.activeId);
    const next = (index + step + this.order.length) % this.order.length;
    this.activate(this.order[next]);
  }

  selectByIndex(index) {
    // Index 8 (Ctrl+9) selects the last tab, matching every other browser.
    const id = index >= 8 ? this.order[this.order.length - 1] : this.order[index];
    if (id) this.activate(id);
  }

  moveTab(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    const clamped = Math.max(0, Math.min(this.order.length - 1, toIndex));
    this.order.splice(from, 1);
    this.order.splice(clamped, 0, id);
    this._broadcast();
  }

  get activeTab() {
    return this.tabs.get(this.activeId) || null;
  }

  // --- omnibox preview -----------------------------------------------------

  /**
   * The live page inside the thought bubble.
   *
   * It is a plain view with no preload: nothing here should capture logins or
   * receive autofill, because the user has not chosen to visit this page yet -
   * they are still typing its address.
   */
  _ensurePreview() {
    if (this.previewView && !this.previewView.webContents.isDestroyed()) return this.previewView;

    this.previewView = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
        backgroundThrottling: false
      }
    });
    this.previewView.setBackgroundColor('#ffffff');
    this.previewView.setBorderRadius?.(0);

    // A preview must never become a window or steal the session.
    this.previewView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return this.previewView;
  }

  showPreview(input, rect, viewport) {
    if (this.window.isDestroyed() || !rect || !viewport) return;

    const url = normalizeInput(input, this.store.get('searchEngine'), this.store.get('shortcuts'));
    if (!url) return this.hidePreview();

    const view = this._ensurePreview();
    if (!this.previewAttached) {
      this.window.contentView.addChildView(view);
      this.previewAttached = true;
    }

    view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    });

    // Every keystroke asks for a load, so drop the one still in flight rather
    // than letting a queue of half-finished pages pile up.
    if (this.previewUrl !== url) {
      this.previewUrl = url;
      view.webContents.stop();
      view.webContents.loadURL(resolveLoadTarget(url)).catch(() => {});
    }
    this.send('shell:preview-target', { url: prettifyUrl(url) });
  }

  hidePreview() {
    if (!this.previewAttached || !this.previewView) return;
    if (!this.previewView.webContents.isDestroyed()) {
      this.previewView.webContents.stop();
      this.window.contentView.removeChildView(this.previewView);
    }
    this.previewAttached = false;
    this.previewUrl = null;
  }

  destroyPreview() {
    this.hidePreview();
    if (this.previewView && !this.previewView.webContents.isDestroyed()) {
      this.previewView.webContents.close();
    }
    this.previewView = null;
  }

  // --- saved logins --------------------------------------------------------

  /**
   * Offer the stored credential for whatever origin the tab actually landed
   * on. The origin comes from the tab's own URL, never from the page.
   */
  autofill(tab) {
    if (tab.destroyed) return;
    const origin = PasswordVault.originOf(tab.webContents.getURL());
    if (!origin) return;

    const matches = this.vault.forOrigin(origin);
    // With several saved accounts there is no way to know which one is meant,
    // so nothing is filled until there is a picker to choose with.
    if (matches.length !== 1) return;
    tab.webContents.send('passwords:fill', matches[0]);
  }

  /** A page submitted a login form; ask whether to remember it. */
  handleSubmittedLogin(webContents, { username, password }) {
    if (!this.store.get('savePasswords') || !password) return;

    const tab = [...this.tabs.values()].find((t) => !t.destroyed && t.webContents === webContents);
    if (!tab) return;

    const origin = PasswordVault.originOf(webContents.getURL());
    if (!origin || this.vault.isBlocked(origin)) return;
    if (this.vault.status(origin, username, password) === 'unchanged') return;

    this.pendingLogin = { origin, username, password };
    this.send('shell:save-password', {
      origin,
      username,
      update: this.vault.status(origin, username, password) === 'changed',
      available: this.vault.available
    });
  }

  resolveSavePrompt(action) {
    const pending = this.pendingLogin;
    this.pendingLogin = null;
    if (!pending) return;

    if (action === 'save') {
      try {
        this.vault.save(pending);
      } catch (err) {
        this.send('shell:toast', { kind: 'error', message: `Could not save password: ${err.message}` });
      }
    } else if (action === 'never') {
      this.vault.block(pending.origin);
    }
    this._broadcast();
  }

  // --- navigation ----------------------------------------------------------

  navigate(input) {
    const url = normalizeInput(input, this.store.get('searchEngine'), this.store.get('shortcuts'));
    if (!url) return;
    const tab = this.activeTab;
    if (!tab) {
      this.newTab(url);
    } else if (tab.url !== url) {
      tab.loadURL(url);
    } else {
      tab.reload();
    }
    // Hand focus back to the page, the way every browser does after you commit
    // something in the address bar.
    tab.webContents.focus();
  }

  /**
   * Moving DOM focus inside the chrome is not enough: the page's
   * WebContentsView holds native focus, so keystrokes would still go to the
   * page. Focus the chrome's web contents first, then ask it to focus the
   * control.
   */
  focusChrome(channel) {
    if (this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.send(channel);
  }

  // --- find in page --------------------------------------------------------

  find(query, { forward = true, findNext = false } = {}) {
    const tab = this.activeTab;
    if (!tab) return;
    if (!query) return this.stopFind();
    this.findQuery = query;
    tab.webContents.findInPage(query, { forward, findNext });
  }

  stopFind() {
    this.findQuery = '';
    const tab = this.activeTab;
    if (tab && !tab.destroyed) tab.webContents.stopFindInPage('clearSelection');
  }

  // --- renderer sync -------------------------------------------------------

  _onTabChanged(tab) {
    if (tab.id === this.activeId && !tab.loading && tab.url && !tab.errorUrl) {
      this.store.addHistory({ url: tab.url, title: tab.title, visitedAt: Date.now() });
    }
    this._broadcast();
  }

  getState() {
    const active = this.activeTab;
    return {
      tabs: this.order.map((id) => this.tabs.get(id)).filter(Boolean).map((t) => t.serialize()),
      activeId: this.activeId,
      theme: this.store.get('theme'),
      sidebarWidth: this.store.get('sidebarWidth'),
      bookmarks: this.store.get('bookmarks'),
      bookmarked: active ? this.store.isBookmarked(active.url) : false
    };
  }

  _broadcast() {
    this.send('shell:state', this.getState());
  }

  send(channel, payload) {
    if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
    try {
      this.window.webContents.send(channel, payload);
    } catch {
      // During shutdown the render frame can be disposed while the WebContents
      // still reports itself alive; there is nothing left to deliver to.
    }
  }

  setTheme(theme) {
    this.store.set('theme', theme);
    const chrome = THEME_CHROME[theme] || THEME_CHROME.day;

    // Ordinary websites honour prefers-color-scheme, so the whole browser --
    // chrome, built-in pages and the web itself -- switches together.
    nativeTheme.themeSource = theme === 'night' ? 'dark' : 'light';

    // Built-in pages read the theme once at load; tell the open ones directly
    // so a toggle takes effect without a reload.
    for (const tab of this.tabs.values()) {
      if (!tab.destroyed) tab.webContents.send('cloud:theme', theme);
    }
    try {
      this.window.setTitleBarOverlay({ color: chrome.color, symbolColor: chrome.symbol, height: TITLEBAR_HEIGHT });
    } catch {
      /* platforms without an overlay simply keep their native titlebar */
    }
    this.window.setBackgroundColor(chrome.color);
    this._broadcast();
  }

  // --- context menu --------------------------------------------------------

  _showPageContextMenu(tab, params) {
    const items = [];
    const { linkURL, srcURL, selectionText, isEditable, editFlags = {} } = params;

    if (linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => this.newTab(linkURL, { background: true }) },
        { label: 'Copy link address', click: () => clipboard.writeText(linkURL) },
        { label: 'Open link in system browser', click: () => shell.openExternal(linkURL) },
        { type: 'separator' }
      );
    }

    if (srcURL && params.mediaType === 'image') {
      items.push(
        { label: 'Open image in new tab', click: () => this.newTab(srcURL, { background: true }) },
        { label: 'Copy image address', click: () => clipboard.writeText(srcURL) },
        { type: 'separator' }
      );
    }

    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { role: 'selectAll' },
        { type: 'separator' }
      );
    } else if (selectionText) {
      const preview = selectionText.slice(0, 32) + (selectionText.length > 32 ? '…' : '');
      items.push(
        { role: 'copy' },
        {
          label: `Search for "${preview}"`,
          click: () =>
            this.newTab(normalizeInput(selectionText, this.store.get('searchEngine'), this.store.get('shortcuts')))
        },
        { type: 'separator' }
      );
    }

    items.push(
      { label: 'Back', enabled: tab.canGoBack, click: () => tab.goBack() },
      { label: 'Forward', enabled: tab.canGoForward, click: () => tab.goForward() },
      { label: 'Reload', click: () => tab.reload() },
      { type: 'separator' },
      { label: 'Inspect element', click: () => tab.webContents.inspectElement(params.x, params.y) }
    );

    Menu.buildFromTemplate(items).popup({ window: this.window });
  }
}

module.exports = { BrowserShell, PARTITION };
