'use strict';

const fs = require('fs');
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

/**
 * The thought bubble's live page preview: the bubble's interior is a real page,
 * reloaded as the address bar is typed into. Set to false to make the bubble
 * name its destination without fetching anything.
 */
const LIVE_PAGE_PREVIEW = true;

/** Matches the .thought-screen radius in the renderer stylesheet. */
const PREVIEW_RADIUS = 15;

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
    this.previewExpanding = false;
    this.fullScreen = false;

    const bounds = fitToScreen(store.get('window') || {});
    const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.ico');
    const theme = THEME_CHROME[store.get('theme')] || THEME_CHROME.day;

    this.window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: Number.isInteger(bounds.x) ? bounds.x : undefined,
      y: Number.isInteger(bounds.y) ? bounds.y : undefined,
      minWidth: 640,
      minHeight: 420,
      show: false,
      // Only pass it when it exists: Electron throws on a missing icon path.
      ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
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
    // Full screen means the page, not the page plus furniture.
    this.window.on('enter-full-screen', () => {
      this.fullScreen = true;
      this.send('shell:full-screen', true);
      this._layout();
    });
    this.window.on('leave-full-screen', () => {
      this.fullScreen = false;
      this.send('shell:full-screen', false);
      this._layout();
    });
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
      // Built now, while nobody is typing, so showing it later is only a
      // visibility flip.
      if (LIVE_PAGE_PREVIEW) this._ensurePreview();
    });

    // The chrome UI never navigates itself; outbound links become tabs.
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) this.newTab(url);
      return { action: 'deny' };
    });
  }

  // --- lifecycle -----------------------------------------------------------

  _restoreSession() {
    // Anything handed to us on the command line wins: the user asked for that
    // file, not for last night's tabs.
    if (this.pendingTargets && this.pendingTargets.length) {
      const targets = this.pendingTargets;
      this.pendingTargets = [];
      targets.forEach((url, i) => this.newTab(url, { background: i > 0 }));
      return;
    }
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
    // Full screen drops the insets entirely, so the panes fill the display.
    const { left, top, right, bottom } = this.fullScreen
      ? { left: 0, top: 0, right: 0, bottom: 0 }
      : this.insets;
    const boxWidth = Math.max(0, width - left - right);
    const boxHeight = Math.max(0, height - top - bottom);

    // Merged tabs share the page area as equal columns with a gutter between.
    const views = tab.views;
    const gap = views.length > 1 ? 8 : 0;
    const each = Math.floor((boxWidth - gap * (views.length - 1)) / views.length);

    views.forEach((view, i) => {
      view.setBounds({
        x: left + i * (each + gap),
        y: top,
        width: i === views.length - 1 ? boxWidth - i * (each + gap) : each,
        height: boxHeight
      });
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
      for (const view of previous.views) this.window.contentView.removeChildView(view);
    }

    this.hidePreview();
    this.activeId = id;
    for (const view of tab.views) this.window.contentView.addChildView(view);
    // The tab view now sits above the preview; lift the preview back on top.
    // Safe here because switching tabs is never mid-keystroke.
    if (this.previewView && !this.previewView.webContents.isDestroyed()) {
      this.window.contentView.removeChildView(this.previewView);
      this.window.contentView.addChildView(this.previewView);
    }
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

    if (!tab.destroyed) {
      for (const view of tab.views) this.window.contentView.removeChildView(view);
    }
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

  /**
   * Show several tabs side by side as one entry.
   *
   * The first selected tab hosts: it keeps its place in the strip and takes
   * ownership of the others' pages, which then leave the strip without their
   * webContents being closed. One cloud, several columns.
   */
  mergeTabs(ids) {
    if (!Array.isArray(ids) || ids.length < 2) return;

    const tabs = ids.map((id) => this.tabs.get(id)).filter((t) => t && !t.destroyed);
    if (tabs.length < 2) return;

    // Host is whichever selected tab sits highest in the strip, so the merged
    // cloud appears where the user was already looking.
    tabs.sort((a, b) => this.order.indexOf(a.id) - this.order.indexOf(b.id));
    const [host, ...rest] = tabs;

    for (const other of rest) {
      if (this.activeId === other.id) this.activeId = host.id;
      for (const view of other.views) {
        try {
          this.window.contentView.removeChildView(view);
        } catch {
          // Not attached; nothing to detach.
        }
      }
      host.adopt(other);
      this.tabs.delete(other.id);
      const at = this.order.indexOf(other.id);
      if (at >= 0) this.order.splice(at, 1);
    }

    this.activate(host.id);
  }

  /**
   * Undo a merge: every adopted pane becomes its own entry again, placed
   * directly after the host so the strip reads in the order they were shown.
   */
  splitTab(id) {
    const host = this.tabs.get(id);
    if (!host || host.destroyed || host.paneCount < 2) return;

    const freed = host.release();
    const at = this.order.indexOf(id);

    freed.forEach((pane, i) => {
      this.tabs.set(pane.id, pane);
      this.order.splice(at + 1 + i, 0, pane.id);
      // Only the host stays on screen; the rest wait to be activated.
      try {
        this.window.contentView.removeChildView(pane.view);
      } catch {
        // Not attached.
      }
    });

    this._layout();
    this._broadcast();
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
        preload: path.join(__dirname, '..', 'preload', 'preview.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        javascript: true,
        backgroundThrottling: false
      }
    });
    this.previewView.setBackgroundColor('#ffffff');
    this.previewView.setBorderRadius?.(PREVIEW_RADIUS);

    // A preview must never become a window or steal the session.
    this.previewView.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    /*
     * The preview must never hold the keyboard. It can take focus from several
     * directions - being shown, a load committing, or the page itself calling
     * focus() or autofocusing a field - and every one of them sends the user's
     * next keystrokes into the preview instead of the address bar.
     *
     * Rather than chase each cause, bounce focus back whenever it lands here.
     */
    const returnFocus = () => {
      if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) return;
      this.window.webContents.focus();
    };

    this.previewView.webContents.on('focus', () => {
      // Returning focus from inside the focus event is re-entrant and gets
      // undone, so hand it back once the current focus change has finished,
      // and again shortly after in case the page grabs it as it settles.
      setTimeout(returnFocus, 0);
      setTimeout(returnFocus, 80);
      setTimeout(returnFocus, 250);
    });

    // Attached once, for the window's lifetime, and hidden until wanted.
    // Adding a child view moves native focus to it, and doing that mid-word
    // sends the next keystrokes to the preview instead of the address bar.
    this.previewView.setVisible(false);
    this.window.contentView.addChildView(this.previewView);
    this.window.webContents.focus();
    return this.previewView;
  }

  showPreview(input, rect, viewport) {
    if (this.window.isDestroyed() || !rect || !viewport) return;

    const url = normalizeInput(input, this.store.get('searchEngine'), this.store.get('shortcuts'));
    if (!url) return this.hidePreview();

    this.send('shell:preview-target', { url: prettifyUrl(url), live: LIVE_PAGE_PREVIEW });

    // No view, no navigation, no request: the bubble is destination-only.
    if (!LIVE_PAGE_PREVIEW) return;

    const view = this._ensurePreview();
    if (!this.previewAttached) {
      // Only a visibility flip here: adding or re-adding a view steals native
      // focus, and this runs while the user is typing.
      view.setBorderRadius?.(PREVIEW_RADIUS);
      view.setVisible(true);
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
  }

  /** The rect the page view occupies - what the bubble expands into. */
  _stageBounds() {
    const [width, height] = this.window.getContentSize();
    const { left, top, right, bottom } = this.insets;
    return {
      x: left,
      y: top,
      width: Math.max(0, width - left - right),
      height: Math.max(0, height - top - bottom)
    };
  }

  /**
   * A press on the preview opens it: the bubble grows into the page area, then
   * the real tab takes over at the same size, so the swap is invisible.
   */
  activatePreview() {
    if (!this.previewAttached || !this.previewView || !this.previewUrl) return;
    if (this.previewExpanding) return;

    this.previewExpanding = true;
    const url = this.previewUrl;
    const from = this.previewView.getBounds();
    const to = this._stageBounds();
    const started = Date.now();
    const DURATION = 240;

    this.send('shell:preview-expanding');

    const step = () => {
      if (!this.previewAttached || !this.previewView || this.window.isDestroyed()) {
        this.previewExpanding = false;
        return;
      }
      const t = Math.min(1, (Date.now() - started) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3);
      const lerp = (a, b) => Math.round(a + (b - a) * eased);
      this.previewView.setBounds({
        x: lerp(from.x, to.x),
        y: lerp(from.y, to.y),
        width: lerp(from.width, to.width),
        height: lerp(from.height, to.height)
      });
      this.previewView.setBorderRadius?.(Math.round(PREVIEW_RADIUS * (1 - eased)));

      if (t < 1) return setTimeout(step, 16);
      this._commitPreview(url);
    };

    step();
  }

  /** Hand the previewed page over to the real tab and drop the preview. */
  _commitPreview(url) {
    const tab = this.activeTab;
    if (!tab) {
      this.newTab(url);
      this.previewExpanding = false;
      this.hidePreview();
      return;
    }

    tab.loadURL(url);
    const finish = () => {
      this.previewExpanding = false;
      this.hidePreview();
    };
    tab.webContents.once('did-stop-loading', finish);
    // The tab may never settle; do not leave the preview parked over it.
    setTimeout(finish, 4000);
  }

  hidePreview() {
    if (!this.previewAttached || !this.previewView) return;
    if (!this.previewView.webContents.isDestroyed() && !this.window.isDestroyed()) {
      this.previewView.webContents.stop();
      this.previewView.setVisible(false);
    }
    this.previewAttached = false;
    this.previewUrl = null;
  }

  destroyPreview() {
    this.hidePreview();
    if (this.previewView && !this.previewView.webContents.isDestroyed()) {
      // This also runs from 'closed', by which point the window and its
      // contentView are already gone.
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.previewView);
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
      showFullUrl: this.store.get('showFullUrl') !== false,
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
