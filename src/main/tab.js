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
  constructor({ url, partition, onChange, onOpenTab, onContextMenu }) {
    this.id = `tab-${nextTabId++}`;
    this.onChange = onChange;

    this.view = new WebContentsView({
      webPreferences: {
        partition,
        preload: path.join(__dirname, '..', 'preload', 'page.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
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

    this._wire({ onOpenTab, onContextMenu });
    this.loadURL(url);
  }

  get webContents() {
    return this.view.webContents;
  }

  get destroyed() {
    return this.view.webContents.isDestroyed();
  }

  /** Serializable snapshot handed to the renderer. */
  serialize() {
    return {
      id: this.id,
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

  _wire({ onOpenTab, onContextMenu }) {
    const wc = this.webContents;

    wc.on('page-title-updated', (_e, title) => {
      this.title = title || hostLabel(this.url);
      this._emit();
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

    const onNavigated = (url) => {
      if (url.startsWith('file://') && url.includes('/pages/error.html')) return;
      this.errorUrl = null;
      this.url = url;
      if (!this.title || this.title === 'New Tab') this.title = hostLabel(url);
      this._syncNavState();
      this._emit();
    };

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
    if (!this.destroyed) this.webContents.close();
  }
}

module.exports = { Tab };
