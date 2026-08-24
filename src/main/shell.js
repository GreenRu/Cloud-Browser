'use strict';

const fs = require('fs');
const path = require('path');
const { BrowserWindow, Menu, clipboard, shell, screen, nativeTheme } = require('electron');
const { WebContentsView } = require('electron');
const { Tab, PAGE_RADIUS } = require('./tab');
const { normalizeInput, prettifyUrl, resolveLoadTarget } = require('./urls');
const { PasswordVault } = require('./passwords');

const PARTITION = 'persist:cloud';

/**
 * The world plugin scripts run in. Isolated from the page's own JavaScript in
 * both directions: a page cannot reach a plugin, and a plugin cannot be
 * tampered with by the page it is dressing.
 */
const PLUGIN_WORLD = 1000;

/** The seam between two merged panes, and the width of the grip on it. */
const PANE_GAP = 8;

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

/** And this one the .thought-bubble radius the card is drawn with. */
const BUBBLE_RADIUS = 22;

// Must match --titlestrip-h and the top stop of the sky gradient in the
// renderer stylesheet, so the OS-drawn window controls sit flush on the sky.
const TITLEBAR_HEIGHT = 40;
/** A titlebar overlay colour has to be a colour, not `rgba(...)` or a name. */
function hexOnly(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : null;
}

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
  constructor(store, vault, plugins = null) {
    this.store = store;
    this.vault = vault || new PasswordVault();
    this.pendingLogin = null;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.insets = { ...DEFAULT_INSETS };
    this.gutters = [];
    this.findQuery = '';
    /**
     * The last few clouds closed, newest first, so one can be brought back.
     * Only where they were and what they were showing - the page itself is
     * gone, and is loaded again from scratch.
     */
    this.closed = [];
    /** The plugin host, when the browser was started with one. */
    this.plugins = plugins;
    /**
     * One preview per thing that can ask for one: the address bar, and each
     * pane of a merged cloud. Keyed by the webContents the keyboard belongs to
     * while its bubble is up, so panes searching side by side never fight over
     * a single view.
     */
    this.previews = new Map();
    this.frameView = null;
    this.frameAttached = false;
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
    this.window.on('enter-full-screen', () => this.setFullScreen(true));
    this.window.on('leave-full-screen', () => this.setFullScreen(false));
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
      if (LIVE_PAGE_PREVIEW) {
        // Order matters and is fixed here: the card first, the live view over
        // it. Re-adding a view later to correct the order would steal focus.
        this._ensureBubbleFrame();
        this._ensurePreview(this.window.webContents);
      }
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
    // Only if the user wants last time's clouds back; otherwise the home page.
    const session = this.store.get('restoreSession') === false
      ? null
      : this.store.get('session');
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

    // Merged tabs share the page area as columns with a gutter between, in
    // whatever proportions the dividers have been dragged to. Full screen is
    // the page and nothing else: the panes meet edge to edge, with no seam
    // between them and no rounding at the corners.
    const views = tab.views;
    const gap = views.length > 1 && !this.fullScreen ? PANE_GAP : 0;
    const usable = Math.max(0, boxWidth - gap * (views.length - 1));
    const sizes = tab.paneSizes();

    // Where the dividers are, for the renderer to hang a grip on. They are the
    // one part of the page area the chrome can still draw in.
    const gutters = [];
    let x = left;

    const radius = this.fullScreen ? 0 : PAGE_RADIUS;

    views.forEach((view, i) => {
      const last = i === views.length - 1;
      const width = last ? left + boxWidth - x : Math.round(usable * sizes[i]);
      view.setBounds({ x, y: top, width: Math.max(1, width), height: boxHeight });
      view.setBorderRadius?.(radius);
      x += width;
      if (!last && gap > 0) {
        gutters.push({ x, y: top, width: gap, height: boxHeight });
        x += gap;
      }
    });

    this.gutters = gutters;
  }

  // --- tabs ----------------------------------------------------------------

  newTab(rawUrl, { background = false } = {}) {
    const url = rawUrl || this.store.get('homepage');
    const tab = new Tab({
      url,
      partition: PARTITION,
      onChange: (t) => this._onTabChanged(t),
      onOpenTab: (u, opts) => this.newTab(u, opts),
      onContextMenu: (t, params) => this._showPageContextMenu(t, params),
      onDressPage: (t, url) => this.applyPlugins(t, url),
      pluginDirs: this.plugins ? this.plugins.dirs : []
    });

    tab.webContents.on('did-finish-load', () => this.autofill(tab));
    // A page resets its own zoom on every navigation, so it is set again here.
    tab.webContents.on('did-finish-load', () => this.applyZoom(tab));

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

  /**
   * Hand a freshly loaded page to the plugins that asked for it.
   *
   * Stylesheets go in directly. Scripts run in an isolated world, so plugin
   * code sees the DOM and nothing else: not the page's own JavaScript, not
   * Node, and not the browser's bridge. A plugin that throws takes only itself
   * down with it.
   */
  applyPlugins(tab, url) {
    if (!this.plugins || !tab || tab.destroyed) return;
    const { styles, scripts } = this.plugins.injectionsFor(url);
    if (!styles.length && !scripts.length) return;

    const wc = tab.webContents;
    for (const rule of styles) {
      wc.insertCSS(rule.source).catch(() => {});
    }
    for (const rule of scripts) {
      wc.executeJavaScriptInIsolatedWorld(PLUGIN_WORLD, [{
          code: `(() => { try {\n${rule.source}\n} catch (err) {` +
            ` console.error('[plugin ${rule.plugin}]', err); } })();`
        }])
        .catch(() => {});
    }
  }

  /**
   * The zoom every page starts at. Applied when a tab is made and again when
   * the setting changes, so it is one number rather than a per-page habit.
   */
  applyZoom(tab) {
    const zoom = Number(this.store.get('defaultZoom'));
    if (!Number.isFinite(zoom) || zoom <= 0) return;
    for (const view of tab.views) {
      if (!view.webContents.isDestroyed()) view.webContents.setZoomFactor(zoom);
    }
  }

  setDefaultZoom(zoom) {
    const value = Math.min(2, Math.max(0.5, Number(zoom) || 1));
    this.store.set('defaultZoom', value);
    for (const tab of this.tabs.values()) {
      if (!tab.destroyed) this.applyZoom(tab);
    }
    return value;
  }

  /**
   * Where every cloud has been, as trees.
   *
   * `exclude` leaves out the page doing the asking - a timeline looking at
   * itself is not what anyone wants to see.
   */
  trails(exclude = null) {
    const found = exclude ? this._ownerOf(exclude) : null;
    const skip = found ? found.tab.id : null;

    return {
      activeId: this.activeId === skip ? null : this.activeId,
      clouds: this.order
        .map((id) => this.tabs.get(id))
        .filter((tab) => tab && !tab.destroyed && tab.id !== skip)
        .map((tab) => ({
          id: tab.id,
          title: tab.title,
          url: prettifyUrl(tab.url),
          at: tab.trailAt,
          nodes: tab.trail.map((n) => ({ ...n, url: prettifyUrl(n.url) }))
        }))
        .filter((cloud) => cloud.nodes.length > 0)
    };
  }

  /** Search keywords: the user's own, with any a plugin contributes behind them. */
  shortcuts() {
    return { ...(this.plugins ? this.plugins.shortcuts() : {}), ...this.store.get('shortcuts') };
  }

  /**
   * Tell a plugin's scripts that one of its commands was chosen. It arrives in
   * the isolated world as an event on `window`, which is the only channel a
   * plugin has.
   */
  runPluginCommand(pluginId, commandId) {
    const tab = this.activeTab;
    if (!tab || tab.destroyed) return;
    const detail = JSON.stringify({ plugin: pluginId, command: commandId });
    tab.webContents.executeJavaScriptInIsolatedWorld(PLUGIN_WORLD, [{
      code: `window.dispatchEvent(new CustomEvent('stratus:command', { detail: ${detail} }));`
    }]).catch(() => {});
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
    // The tab view now sits above both of ours; lift them back, frame first so
    // the preview ends up on top of it. Safe here because switching tabs is
    // never mid-keystroke.
    for (const layer of [this.frameView, ...this.previewViews]) {
      if (!layer || layer.webContents.isDestroyed()) continue;
      this.window.contentView.removeChildView(layer);
      this.window.contentView.addChildView(layer);
    }
    this._layout();
    tab.webContents.focus();
    this._broadcast();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    // Its panes are going; so is anything they were previewing.
    this.hidePreview();

    const index = this.order.indexOf(id);

    // Worth remembering, unless it was showing nothing worth coming back to.
    const url = prettifyUrl(tab.url);
    if (url && url !== 'about:blank') {
      this.closed.unshift({ url, title: tab.title, index });
      this.closed.length = Math.min(this.closed.length, 10);
    }
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

  /** Bring back the cloud closed most recently, where it was. */
  reopenClosedTab() {
    const last = this.closed.shift();
    if (!last) return null;

    const tab = this.newTab(last.url);
    if (tab && last.index >= 0 && last.index < this.order.length) {
      this.moveTab(tab.id, last.index);
    }
    return tab;
  }

  /** The same page again, in a cloud of its own, next to the one it came from. */
  duplicateTab(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.destroyed) return null;

    const copy = this.newTab(prettifyUrl(tab.url), { background: true });
    if (copy) this.moveTab(copy.id, this.order.indexOf(id) + 1);
    return copy;
  }

  /** Everything but this one. */
  closeOtherTabs(id) {
    if (!this.tabs.has(id)) return;
    for (const other of this.order.filter((tabId) => tabId !== id)) this.closeTab(other);
  }

  /** Everything under this one in the strip. */
  closeTabsBelow(id) {
    const at = this.order.indexOf(id);
    if (at < 0) return;
    for (const below of this.order.slice(at + 1)) this.closeTab(below);
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

    // Leaving the strip because they joined something is not the same as being
    // closed, and must not look like it. Said before the state that drops them.
    this.send('shell:merged', { host: host.id, ids: rest.map((t) => t.id) });
    this.activate(host.id);
  }

  /**
   * Undo a merge: every adopted pane becomes its own entry again, placed
   * directly after the host so the strip reads in the order they were shown.
   */
  /** Let go of the previews owned by pages that are no longer on screen. */
  _prunePreviews() {
    for (const owner of [...this.previews.keys()]) {
      if (owner === this.window.webContents) continue;
      if (owner.isDestroyed() || !this._ownerOf(owner)) this._dropPreview(owner);
    }
  }

  splitTab(id) {
    const host = this.tabs.get(id);
    if (!host || host.destroyed || host.paneCount < 2) return;

    const freed = host.release();
    const at = this.order.indexOf(id);

    this._afterSplit();

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

  // Splitting a merged cloud apart moves its panes; anything they were
  // previewing has to move with them, and the simplest true answer is to put
  // the previews away and let them be asked for again.
  _afterSplit() {
    this.hidePreview();
    this._prunePreviews();
  }

  /** Drag a divider: the panes trade width and the views follow at once. */
  setPaneSizes(id, sizes) {
    const tab = this.tabs.get(id);
    if (!tab || tab.destroyed || tab.paneCount < 2) return;
    if (!tab.setPaneSizes(sizes)) return;
    this._layout();
    // The seams have moved, and the grips on them are drawn by the renderer.
    // Safe mid-drag: the strip leaves the grips alone while one is being held.
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
  /**
   * The card drawn around the preview.
   *
   * The chrome renderer draws one too, and that DOM is what reports where the
   * live view should go - but the renderer sits *below* the page, so anything
   * it draws inside the stage is hidden the moment a tab is open. This view is
   * stacked above the page and below the preview, so the head row and the ring
   * of padding around the view are the parts you actually see.
   *
   * Pages that have a bubble of their own - the new tab page's search bar -
   * draw their own frame and never ask for this one.
   */
  _ensureBubbleFrame() {
    if (this.frameView && !this.frameView.webContents.isDestroyed()) return this.frameView;

    this.frameView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'bubble.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    // Transparent outside the card, so the rounded corners show the page
    // behind them rather than a square of colour.
    this.frameView.setBackgroundColor('#00000000');
    this.frameView.setBorderRadius?.(BUBBLE_RADIUS);

    const wc = this.frameView.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // It shows one line of text. It never navigates anywhere.
    wc.on('will-navigate', (event) => event.preventDefault());

    // Same rule as the preview: it must never hold the keyboard.
    wc.on('focus', () => {
      const back = () => {
        // The card is only ever the address bar's, so the keyboard goes back
        // to the chrome.
        if (!this.window.isDestroyed()) this.window.webContents.focus();
      };
      setTimeout(back, 0);
      setTimeout(back, 80);
    });

    wc.loadFile(path.join(__dirname, '..', 'pages', 'bubble.html')).catch(() => {});

    this.frameView.setVisible(false);
    this.window.contentView.addChildView(this.frameView);
    return this.frameView;
  }

  /** Put the frame away, leaving the view it framed alone. */
  hideBubbleFrame() {
    if (!this.frameAttached || !this.frameView) return;
    this.frameView.setVisible(false);
    this.frameAttached = false;
  }

  /** The chrome's own preview, for the callers that only ever mean that one. */
  get previewView() {
    const entry = this.previews.get(this.window.webContents);
    return entry ? entry.view : null;
  }

  get previewUrl() {
    const entry = this.previews.get(this.window.webContents);
    return entry ? entry.url : null;
  }

  get previewAttached() {
    const entry = this.previews.get(this.window.webContents);
    return Boolean(entry && entry.attached);
  }

  get previewExpanding() {
    return [...this.previews.values()].some((e) => e.expanding);
  }

  previewFor(owner) {
    return this.previews.get(owner) || null;
  }

  previewUrlFor(owner) {
    const entry = this.previews.get(owner);
    return entry ? entry.url : null;
  }

  previewAttachedFor(owner) {
    const entry = this.previews.get(owner);
    return Boolean(entry && entry.attached);
  }

  previewBoundsFor(owner) {
    const entry = this.previews.get(owner);
    return entry ? entry.view.getBounds() : null;
  }

  /** Every preview view, oldest first - the order they are stacked in. */
  get previewViews() {
    return [...this.previews.values()].map((e) => e.view);
  }

  _ensurePreview(owner) {
    const existing = this.previews.get(owner);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;

    const view = new WebContentsView({
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
    view.setBackgroundColor('#ffffff');
    view.setBorderRadius?.(PREVIEW_RADIUS);

    // A preview must never become a window or steal the session.
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
      // Back to whoever is being typed into - this preview's own owner, which
      // is the address bar or one particular pane's search bar.
      if (!owner.isDestroyed()) owner.focus();
      else this.window.webContents.focus();
    };

    view.webContents.on('focus', () => {
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
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    returnFocus();

    const entry = { view, owner, url: null, attached: false, expanding: false };
    this.previews.set(owner, entry);
    return entry;
  }

  /**
   * The tab a webContents belongs to, and the pane within it. For an unmerged
   * cloud those are the same object; for a merged one the pane is the tab whose
   * page it actually is, which is what a preview opened from it should replace.
   */
  _ownerOf(contents) {
    for (const tab of this.tabs.values()) {
      for (const pane of [tab, ...tab.extraPanes]) {
        if (pane.webContents === contents) return { tab, pane };
      }
    }
    return null;
  }

  /**
   * A preview asked for by one of the browser's own pages. The page measures in
   * its own coordinates and knows nothing of where it sits in the window, so
   * the offset comes from the view the message arrived from - never from
   * anything the page says about itself.
   */
  showPreviewInPage(sender, input, rect, viewport) {
    const found = this._ownerOf(sender);
    // Only a pane of the cloud being looked at; a background page must not put
    // a view over the one in front.
    if (!found || found.tab.id !== this.activeId || !rect) return;

    const at = found.pane.view.getBounds();
    this.showPreview(
      input,
      { x: rect.x + at.x, y: rect.y + at.y, width: rect.width, height: rect.height },
      viewport,
      sender
    );
  }

  /**
   * `owner` is the webContents the keyboard belongs to while the bubble is up:
   * the chrome for the address bar, or a page's own view when the page has a
   * search bar of its own. The preview must never keep focus it is handed.
   */
  showPreview(input, rect, viewport, owner = this.window.webContents, frame = null) {
    if (this.window.isDestroyed() || !rect || !viewport || !owner || owner.isDestroyed()) return;

    const url = normalizeInput(input, this.store.get('searchEngine'), this.shortcuts());
    if (!url) return this.hidePreviewFor(owner);

    this.send('shell:preview-target', { url: prettifyUrl(url), live: LIVE_PAGE_PREVIEW });

    // No view, no navigation, no request: the bubble is destination-only.
    if (!LIVE_PAGE_PREVIEW) return;

    // The card, for whoever has not drawn their own.
    if (frame) {
      const card = this._ensureBubbleFrame();
      card.setBounds({
        x: Math.round(frame.x),
        y: Math.round(frame.y),
        width: Math.max(1, Math.round(frame.width)),
        height: Math.max(1, Math.round(frame.height))
      });
      card.webContents.send('bubble:frame', {
        url: prettifyUrl(url),
        // The card is styled from the two built-in palettes, so it is told
        // which one a custom theme is built on.
        theme: this.themeState().base
      });
      if (!this.frameAttached) {
        card.setVisible(true);
        this.frameAttached = true;
      }
    } else {
      this.hideBubbleFrame();
    }

    const entry = this._ensurePreview(owner);
    const view = entry.view;
    if (!entry.attached) {
      // Only a visibility flip here: adding or re-adding a view steals native
      // focus, and this runs while the user is typing.
      view.setBorderRadius?.(PREVIEW_RADIUS);
      view.setVisible(true);
      entry.attached = true;
    }

    view.setBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height))
    });

    // Every keystroke asks for a load, so drop the one still in flight rather
    // than letting a queue of half-finished pages pile up.
    if (entry.url !== url) {
      entry.url = url;
      view.webContents.stop();
      view.webContents.loadURL(resolveLoadTarget(url)).catch(() => {});
    }
  }

  /**
   * Full screen hands the whole window to the pages: no furniture around them,
   * no seam between them, and no rounded corners.
   */
  setFullScreen(on) {
    this.fullScreen = Boolean(on);
    this.send('shell:full-screen', this.fullScreen);
    this._layout();
    // The seams have gone or come back, and the grips on them are the
    // renderer's to draw.
    this._broadcast();
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
  /** The address bar's preview, for the chrome's own callers. */
  activatePreview() {
    this.activatePreviewFor(this.window.webContents);
  }

  /**
   * Grow a preview into the place it belongs and hand the page over.
   *
   * "Where it belongs" is the pane it was opened from, not the whole page area:
   * a search made in the middle of three panes opens there, leaving the other
   * two where they were.
   */
  activatePreviewFor(owner) {
    const entry = this.previews.get(owner);
    if (!entry || !entry.attached || !entry.url || entry.expanding) return;

    entry.expanding = true;
    // The card would only be in the way of what it framed.
    this.hideBubbleFrame();

    const url = entry.url;
    const from = entry.view.getBounds();
    const found = owner === this.window.webContents ? null : this._ownerOf(owner);
    const to = found ? found.pane.view.getBounds() : this._stageBounds();
    const started = Date.now();

    this.send('shell:preview-expanding');

    /*
     * Every frame of this resizes a live page, which is not cheap, so the
     * animation is given time rather than rushed: a longer run means smaller
     * steps, and small steps are what reads as smooth. The curve eases in as
     * well as out, so it starts from rest instead of snapping away from the
     * bubble.
     *
     * Timed off the clock rather than off the tick, so a late tick shows up as
     * a skipped frame rather than as a slower animation - and asked for more
     * often than 60Hz, so a tick landing late still leaves the next one close
     * to its vsync.
     */
    const DURATION = 380;
    // A pane keeps its rounded corners; only the whole page area squares off.
    const endRadius = found ? PREVIEW_RADIUS : 0;
    let lastRadius = -1;

    const step = () => {
      if (!entry.attached || entry.view.webContents.isDestroyed() || this.window.isDestroyed()) {
        entry.expanding = false;
        return;
      }
      const t = Math.min(1, (Date.now() - started) / DURATION);
      const eased = t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const lerp = (a, b) => Math.round(a + (b - a) * eased);
      entry.view.setBounds({
        x: lerp(from.x, to.x),
        y: lerp(from.y, to.y),
        width: lerp(from.width, to.width),
        height: lerp(from.height, to.height)
      });

      // Only a handful of distinct values over the whole run; setting the same
      // one again costs a native call for nothing.
      const radius = Math.round(PREVIEW_RADIUS + (endRadius - PREVIEW_RADIUS) * eased);
      if (radius !== lastRadius) {
        lastRadius = radius;
        entry.view.setBorderRadius?.(radius);
      }

      if (t < 1) return setTimeout(step, 8);
      this._commitPreview(entry, url);
    };

    step();
  }

  /** Hand the previewed page over to the pane it was opened from. */
  _commitPreview(entry, url) {
    const found = entry.owner === this.window.webContents ? null : this._ownerOf(entry.owner);
    const target = found ? found.pane : this.activeTab;

    if (!target) {
      this.newTab(url);
      entry.expanding = false;
      this.hidePreviewFor(entry.owner);
      return;
    }

    target.loadURL(url);
    const finish = () => {
      entry.expanding = false;
      this.hidePreviewFor(entry.owner);
    };
    target.webContents.once('did-stop-loading', finish);
    // The page may never settle; do not leave the preview parked over it.
    setTimeout(finish, 4000);
  }

  /** Put away the preview belonging to one owner. */
  hidePreviewFor(owner) {
    // The window may be on its way out, in which case reading its web contents
    // throws rather than handing back something already destroyed.
    if (!this.window.isDestroyed() && owner === this.window.webContents) {
      this.hideBubbleFrame();
    }
    const entry = this.previews.get(owner);
    if (!entry || !entry.attached) return;
    if (!entry.view.webContents.isDestroyed() && !this.window.isDestroyed()) {
      entry.view.webContents.stop();
      entry.view.setVisible(false);
    }
    entry.attached = false;
    entry.url = null;
  }

  /** Put every preview away - switching clouds, or closing one. */
  hidePreview() {
    this.hideBubbleFrame();
    for (const owner of this.previews.keys()) this.hidePreviewFor(owner);
  }

  /** Forget a preview entirely, once whoever owned it has gone. */
  _dropPreview(owner) {
    const entry = this.previews.get(owner);
    if (!entry) return;
    this.previews.delete(owner);
    if (!entry.view.webContents.isDestroyed()) {
      if (!this.window.isDestroyed()) {
        try {
          this.window.contentView.removeChildView(entry.view);
        } catch {
          // Already detached.
        }
      }
      entry.view.webContents.close();
    }
  }

  destroyPreview() {
    this.hidePreview();
    for (const owner of [...this.previews.keys()]) this._dropPreview(owner);

    if (this.frameView && !this.frameView.webContents.isDestroyed()) {
      // This also runs from 'closed', by which point the window and its
      // contentView are already gone - reaching for them then throws rather
      // than handing back something dead.
      if (!this.window.isDestroyed()) {
        try {
          this.window.contentView.removeChildView(this.frameView);
        } catch {
          // Already detached.
        }
      }
      this.frameView.webContents.close();
    }
    this.frameView = null;
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

  /**
   * The page a request from `contents` should act on: the pane it came from, or
   * nothing when it came from the chrome. A merged cloud shows several pages at
   * once, and a link followed in the middle one belongs in the middle one.
   */
  paneFor(contents) {
    const found = contents ? this._ownerOf(contents) : null;
    return found ? found.pane : null;
  }

  /**
   * Go somewhere. `from` is whoever asked - a pane of a merged cloud loads it
   * itself, while the address bar drives the cloud as a whole.
   */
  navigate(input, from = null) {
    const url = normalizeInput(input, this.store.get('searchEngine'), this.shortcuts());
    if (!url) return;

    const tab = this.paneFor(from) || this.activeTab;
    if (!tab) {
      this.newTab(url);
      return;
    }

    if (tab.url !== url) tab.loadURL(url);
    else tab.reload();

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
    const theme = this.themeState();
    return {
      tabs: this.order.map((id) => this.tabs.get(id)).filter(Boolean).map((t) => t.serialize()),
      activeId: this.activeId,
      theme: theme.theme,
      themeBase: theme.base,
      themeVars: theme.variables,
      pageThemeVars: theme.pageVariables,
      sidebarWidth: this.store.get('sidebarWidth'),
      showFullUrl: this.store.get('showFullUrl') !== false,
      bookmarks: this.store.get('bookmarks'),
      bookmarked: active ? this.store.isBookmarked(active.url) : false,
      gutters: this.gutters,
      pluginToolbar: this.plugins ? this.plugins.toolbar() : []
    };
  }

  /**
   * Tell the pages that something changed - and only that.
   *
   * The chrome is handed the whole state because it draws it. A page gets a
   * knock at the door with nothing in it: anything that wants to know more asks
   * for exactly what it is allowed to have. Nothing about the other clouds
   * leaks into a page that never asked.
   */
  _nudgePages() {
    for (const tab of this.tabs.values()) {
      if (tab.destroyed) continue;
      for (const view of tab.views) {
        if (!view.webContents.isDestroyed()) view.webContents.send('cloud:changed');
      }
    }
  }

  _broadcast() {
    this.send('shell:state', this.getState());
    this._nudgePages();
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

  /**
   * What the theme actually is, once a plugin's has been resolved: which of the
   * two built-in palettes it is built on, the variables laid over that, and
   * whether websites should be asked for their dark clothes.
   *
   * A theme that is neither built in nor offered by a live plugin falls back to
   * day, so switching a theme plugin off cannot leave the browser unreadable.
   */
  themeState() {
    const theme = this.store.get('theme');
    if (theme === 'day' || theme === 'night') {
      return { theme, base: theme, dark: theme === 'night', variables: {}, pageVariables: {} };
    }

    const custom = this.plugins ? this.plugins.themeVars(theme) : null;
    if (!custom) {
      return { theme: 'day', base: 'day', dark: false, variables: {}, pageVariables: {} };
    }

    return {
      theme,
      base: custom.dark ? 'night' : 'day',
      dark: custom.dark,
      variables: custom.variables,
      pageVariables: custom.pageVariables
    };
  }

  setTheme(theme) {
    this.store.set('theme', theme);
    const state = this.themeState();
    // The window controls are drawn by the system, so they need a colour rather
    // than a variable: take the theme's own sky where it gives one.
    const base = THEME_CHROME[state.base] || THEME_CHROME.day;
    const chrome = {
      color: hexOnly(state.variables['--sky-top']) || base.color,
      symbol: hexOnly(state.variables['--text-on-sky']) || base.symbol
    };

    // Ordinary websites honour prefers-color-scheme, so the whole browser --
    // chrome, built-in pages and the web itself -- switches together.
    nativeTheme.themeSource = state.dark ? 'dark' : 'light';

    // Built-in pages read the theme once at load; tell the open ones directly
    // so a toggle takes effect without a reload. Every pane, not just every
    // entry in the strip: a merged cloud shows several pages at once, and they
    // all have to change together.
    const forPages = {
      theme: state.theme,
      base: state.base,
      variables: state.pageVariables
    };
    for (const tab of this.tabs.values()) {
      if (tab.destroyed) continue;
      for (const view of tab.views) {
        if (!view.webContents.isDestroyed()) view.webContents.send('cloud:theme', forPages);
      }
    }
    // Including the card around the preview, if one is up.
    if (this.frameAttached && this.frameView && !this.frameView.webContents.isDestroyed()) {
      this.frameView.webContents.send('bubble:frame', {
        url: prettifyUrl(this.previewUrl || ''),
        theme: state.base
      });
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

  /**
   * The menu on a cloud in the strip.
   *
   * Native rather than drawn: the strip is one of the few places the chrome can
   * draw at all, but a real menu comes with keyboard handling, the platform's
   * own look, and somewhere to show the shortcut each item already has.
   *
   * `selected` is whatever is ctrl-clicked at the time, which decides whether
   * merging is on offer.
   */
  /**
   * What a cloud's menu offers, as a description rather than a menu.
   *
   * The chrome draws it, because a menu that matches the browser it belongs to
   * beats one that matches the operating system - and the strip is one of the
   * few places the chrome can draw at all. What is *on* offer is decided here,
   * where the state is: which cloud, what is picked, what has been closed.
   */
  tabMenu(id, selected = []) {
    const tab = this.tabs.get(id);
    if (!tab || tab.destroyed) return null;

    const at = this.order.indexOf(id);
    const chosen = selected.filter((tabId) => this.tabs.has(tabId));
    const items = [
      { id: 'reload', label: 'Reload cloud', accelerator: 'Ctrl+R' },
      { id: 'duplicate', label: 'Duplicate cloud' },
      { id: 'mute', label: tab.muted ? 'Unmute cloud' : 'Mute cloud' },
      { type: 'separator' },
      {
        id: 'bookmark',
        label: this.store.isBookmarked(tab.url) ? 'Remove bookmark' : 'Bookmark this page',
        accelerator: 'Ctrl+D'
      },
      { id: 'copy', label: 'Copy address' }
    ];

    // Only when there is something to do it to.
    if (chosen.length > 1) {
      items.push({ type: 'separator' },
        { id: 'merge', label: `Merge ${chosen.length} clouds` });
    } else if (tab.paneCount > 1) {
      items.push({ type: 'separator' },
        { id: 'split', label: `Split into ${tab.paneCount} clouds` });
    }

    items.push(
      { type: 'separator' },
      { id: 'top', label: 'Move to top', enabled: at > 0 },
      { id: 'bottom', label: 'Move to bottom', enabled: at < this.order.length - 1 },
      { type: 'separator' },
      { id: 'reopen', label: 'Reopen closed cloud', accelerator: 'Ctrl+Shift+T', enabled: this.closed.length > 0 },
      { type: 'separator' },
      { id: 'close', label: 'Close cloud', accelerator: 'Ctrl+W', danger: true },
      { id: 'close-others', label: 'Close other clouds', enabled: this.order.length > 1, danger: true },
      { id: 'close-below', label: 'Close clouds below', enabled: at < this.order.length - 1, danger: true }
    );

    return {
      tabId: id,
      title: tab.title || prettifyUrl(tab.url),
      items: items.map((item) => ({ enabled: true, ...item }))
    };
  }

  /** Do what was chosen from it. Nothing here trusts the label, only the name. */
  runTabMenu(id, action, selected = []) {
    const tab = this.tabs.get(id);
    if (!tab || tab.destroyed) return;

    const chosen = selected.filter((tabId) => this.tabs.has(tabId));

    switch (action) {
      case 'reload': tab.reload(); break;
      case 'duplicate': this.duplicateTab(id); break;
      case 'mute':
        tab.setMuted(!tab.muted);
        this._broadcast();
        break;
      case 'bookmark':
        this.store.toggleBookmark({ url: tab.url, title: tab.title });
        this._broadcast();
        break;
      case 'copy': clipboard.writeText(prettifyUrl(tab.url)); break;
      case 'merge': if (chosen.length > 1) this.mergeTabs(chosen); break;
      case 'split': this.splitTab(id); break;
      case 'top': this.moveTab(id, 0); break;
      case 'bottom': this.moveTab(id, this.order.length - 1); break;
      case 'reopen': this.reopenClosedTab(); break;
      case 'close': this.closeTab(id); break;
      case 'close-others': this.closeOtherTabs(id); break;
      case 'close-below': this.closeTabsBelow(id); break;
      default: break;
    }
  }

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
            this.newTab(normalizeInput(selectionText, this.store.get('searchEngine'), this.shortcuts()))
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
