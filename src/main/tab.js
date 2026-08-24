'use strict';

const path = require('path');
const { WebContentsView, shell } = require('electron');
const { prettifyUrl, resolveLoadTarget, hostLabel } = require('./urls');

const ERROR_PAGE = path.join(__dirname, '..', 'pages', 'error.html');

// Keep in step with --page-radius in the renderer stylesheet.
const PAGE_RADIUS = 14;

let nextTabId = 1;

/**
 * A single browsing tab: one WebContentsView plus the presentation state the
 * chrome UI needs in order to draw its cloud.
 */
class Tab {
  constructor({ url, partition, onChange, onOpenTab, onContextMenu, onDressPage, pluginDirs }) {
    this.id = `tab-${nextTabId++}`;
    this.onChange = onChange;

    this.view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, '..', 'preload', 'page.js'),
        // Which folders hold plugins, so the preload can recognise a plugin's
        // own page. Passed rather than guessed: any other local file must not
        // be mistaken for one.
        additionalArguments: [`--stratus-plugin-dirs=${JSON.stringify(pluginDirs || [])}`],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        // Chromium's own PDF viewer, so a .pdf opens rather than downloading.
        plugins: true,
        spellcheck: true,
        backgroundThrottling: true
      }
    });
    this.view.setBackgroundColor('#ffffff');
    // Available since Electron 35; harmless to skip on anything older.
    this.view.setBorderRadius?.(PAGE_RADIUS);

    this.url = url;
    this.title = hostLabel(url) || 'New Tab';
    this.favicon = null;
    this.loading = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.muted = false;
    this.audible = false;
    this.errorUrl = null;   // URL we failed to load, kept visible in the omnibox

    /*
     * Where this cloud has been, as a tree rather than a list.
     *
     * Chromium keeps a line: go back three pages and follow a different link
     * and the three you had ahead of you are gone. What actually happened is a
     * fork, and this remembers it - every page keeps the page it was opened
     * from, so the whole shape of a session's wandering survives.
     *
     * `marks` maps Chromium's own index onto our nodes, which is how a step
     * back is told apart from a new page: the same index and URL coming round
     * again is a move, anything else is somewhere new.
     */
    this.trail = [];
    this.trailAt = null;    // the node the cloud is on now
    this.marks = [];

    /**
     * Tabs shown beside this one after a merge. Whole Tab objects are kept, not
     * just their views, so a merged tab can be split apart again and so each
     * pane keeps updating its own title and favicon while merged.
     *
     * This tab's own view is always the first column; these follow it left to
     * right. A merged tab is still one entry in the strip.
     */
    this.extraPanes = [];
    this.hosted = false;  // true while another tab is showing this one

    /**
     * How the width is shared between the panes, as fractions summing to one.
     * Empty until someone drags a divider; until then the panes are equal.
     */
    this.sizes = [];

    this._wire({ onOpenTab, onContextMenu, onDressPage });
    this.loadURL(url);
  }

  get webContents() {
    return this.view.webContents;
  }

  get destroyed() {
    return this.view.webContents.isDestroyed();
  }

  /** The share of the width each pane gets, always as many as there are panes. */
  paneSizes() {
    const n = this.paneCount;
    if (this.sizes.length !== n) this.sizes = new Array(n).fill(1 / n);
    return this.sizes;
  }

  /**
   * Set the shares from a drag. Every pane keeps a usable minimum, and what is
   * left over is spread so they still add up to the whole width.
   */
  setPaneSizes(next) {
    const n = this.paneCount;
    if (!Array.isArray(next) || next.length !== n) return false;

    const min = Math.min(0.12, 1 / (n * 2));
    const clamped = next.map((v) => (Number.isFinite(v) ? Math.max(min, v) : min));
    const total = clamped.reduce((a, b) => a + b, 0);
    this.sizes = clamped.map((v) => v / total);
    return true;
  }

  /** Every view this tab is responsible for, left to right. */
  get views() {
    return [this.view, ...this.extraPanes.flatMap((pane) => pane.views)];
  }

  get paneCount() {
    return 1 + this.extraPanes.length;
  }

  /**
   * Take over another tab's page, so the two show side by side. The source tab
   * keeps its webContents alive - only ownership moves - and is marked
   * released so its own destroy() cannot close what now belongs here.
   */
  adopt(other) {
    if (!other || other === this || other.destroyed) return;
    // Flatten: merging into an already-merged tab gives one row, not a tree.
    const incoming = [other, ...other.extraPanes];
    other.extraPanes = [];
    for (const pane of incoming) {
      pane.hosted = true;
      this.extraPanes.push(pane);
    }
    // A new pane means the old shares no longer describe the row.
    this.sizes = [];
  }

  /**
   * Hand the adopted tabs back, in order. They keep their pages; only
   * ownership returns to them.
   */
  release() {
    const freed = this.extraPanes;
    this.extraPanes = [];
    this.sizes = [];
    for (const pane of freed) pane.hosted = false;
    return freed;
  }

  /** Serializable snapshot handed to the renderer. */
  serialize() {
    return {
      id: this.id,
      panes: this.paneCount,
      paneSizes: this.paneCount > 1 ? this.paneSizes().slice() : null,
      paneTitles: this.extraPanes.map((pane) => pane.title),
      url: this.errorUrl || prettifyUrl(this.url),
      title: this.title,
      favicon: this.favicon,
      loading: this.loading,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
      muted: this.muted,
      audible: this.audible
    };
  }

  _emit() {
    this.onChange?.(this);
  }

  _wire({ onOpenTab, onContextMenu, onDressPage }) {
    const wc = this.webContents;

    wc.on('page-title-updated', (_e, title) => {
      this.title = title || hostLabel(this.url);
      this._emit();
      this._renameStep();
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      this.favicon = favicons?.[0] || null;
      this._emit();
    });

    wc.on('did-start-loading', () => {
      this.loading = true;
      this._emit();
    });

    wc.on('did-stop-loading', () => {
      this.loading = false;
      this._syncNavState();
      this._emit();
    });

    /**
     * One step of the journey. Called for every main-frame navigation, whether
     * it is somewhere new or a step back through where we have been.
     */
    const onStep = (url) => {
      if (this.destroyed || !url || /^about:blank$/i.test(url)) return;

      const index = this.webContents.navigationHistory.getActiveIndex();
      const known = this.marks[index];
      const already = known && this.trail.find((n) => n.id === known);

      if (already && already.url === url) {
        // Back or forward: the same place we already know about.
        this.trailAt = already.id;
        return;
      }

      const node = {
        id: `${this.id}-n${this.trail.length}`,
        parent: this.trailAt,
        url,
        title: this.title || hostLabel(url),
        at: Date.now()
      };
      this.trail.push(node);
      this.trailAt = node.id;

      // Chromium has just thrown away everything that was ahead of here. Our
      // tree keeps those pages - they simply become a branch nobody is on.
      this.marks.length = index;
      this.marks[index] = node.id;
    };

    const onNavigated = (url) => {
      if (url.startsWith('file://') && url.includes('/pages/error.html')) return;
      this.errorUrl = null;
      this.url = url;
      if (!this.title || this.title === 'New Tab') this.title = hostLabel(url);
      onStep(url);
      this._syncNavState();
      this._emit();
    };

    /*
     * Plugins get their turn here, once per page, before anything else runs.
     * They are handed the URL and nothing else; whether anything applies to it
     * is the plugin host's decision, not this tab's.
     */
    wc.on('dom-ready', () => onDressPage?.(this, wc.getURL()));

    wc.on('did-navigate', (_e, url) => onNavigated(url));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) onNavigated(url);
    });

    wc.on('did-fail-load', (_e, code, description, validatedURL, isMainFrame) => {
      // -3 is ERR_ABORTED, fired for ordinary user-cancelled navigations.
      if (!isMainFrame || code === -3) return;
      this.errorUrl = validatedURL || this.url;
      this.title = 'Page unavailable';
      this.favicon = null;
      this.view.webContents.loadFile(ERROR_PAGE, {
        query: { url: this.errorUrl, code: String(code), description: description || '' }
      });
      this._emit();
    });

    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      this.errorUrl = this.url;
      this.title = 'Page crashed';
      this.loading = false;
      this.view.webContents.loadFile(ERROR_PAGE, {
        query: { url: this.url, code: '', description: 'The page stopped responding and was closed.' }
      });
      this._emit();
    });

    wc.on('audio-state-changed', (_e, details) => {
      this.audible = typeof details === 'object' ? details.audible : details;
      this._emit();
    });

    wc.on('context-menu', (_e, params) => onContextMenu?.(this, params));

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'save-to-disk') return { action: 'allow' };
      // Popups and target=_blank links become tabs, never stray OS windows.
      if (/^https?:/i.test(url)) {
        onOpenTab?.(url, { background: disposition === 'background-tab' });
      } else if (/^(mailto|tel):/i.test(url)) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  }

  /** Keep the trail's own name for a page in step with the page's title. */
  _renameStep() {
    const node = this.trail.find((n) => n.id === this.trailAt);
    if (node && this.title) node.title = this.title;
  }

  _syncNavState() {
    if (this.destroyed) return;
    const nav = this.webContents.navigationHistory;
    this.canGoBack = nav.canGoBack();
    this.canGoForward = nav.canGoForward();
  }

  loadURL(url) {
    this.url = url;
    this.errorUrl = null;
    this.webContents.loadURL(resolveLoadTarget(url)).catch(() => {
      /* surfaced through did-fail-load */
    });
  }

  reload(ignoreCache = false) {
    if (this.errorUrl) return this.loadURL(this.errorUrl);
    ignoreCache ? this.webContents.reloadIgnoringCache() : this.webContents.reload();
  }

  stop() {
    this.webContents.stop();
  }

  goBack() {
    if (this.canGoBack) this.webContents.navigationHistory.goBack();
  }

  goForward() {
    if (this.canGoForward) this.webContents.navigationHistory.goForward();
  }

  setMuted(muted) {
    this.muted = muted;
    this.webContents.setAudioMuted(muted);
    this._emit();
  }

  setZoom(delta) {
    const level = delta === 0 ? 0 : this.webContents.getZoomLevel() + delta;
    this.webContents.setZoomLevel(Math.max(-5, Math.min(5, level)));
  }

  destroy() {
    // While hosted, this tab's lifetime belongs to whoever adopted it.
    if (this.hosted) return;
    for (const pane of this.extraPanes) {
      pane.hosted = false;
      pane.destroy();
    }
    this.extraPanes = [];
    if (!this.destroyed) this.webContents.close();
  }
}

module.exports = { Tab, PAGE_RADIUS };
