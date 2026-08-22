'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_SHORTCUTS } = require('./urls');

const DEFAULTS = {
  theme: 'day',                       // 'day' | 'night'
  homepage: 'cloud://newtab',
  searchEngine: 'google',
  shortcuts: { ...DEFAULT_SHORTCUTS },
  savePasswords: true,
  showFullUrl: true,
  window: { width: 1280, height: 820, x: null, y: null, maximized: false },
  sidebarWidth: 252,
  bookmarks: [],                      // { id, title, url, addedAt }
  history: [],                        // { url, title, visitedAt }
  session: []                         // urls restored on launch
};

const HISTORY_LIMIT = 2000;

/**
 * Tiny JSON-backed preferences store living in the OS user-data directory.
 * Writes are debounced so rapid updates (history, window moves) stay cheap.
 */
class Store {
  constructor(fileName = 'state.json') {
    this.file = path.join(app.getPath('userData'), fileName);
    this.data = this._read();
    this._flushTimer = null;
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = { ...structuredClone(DEFAULTS), ...JSON.parse(raw) };
      // Drop anything a previous version recorded that is not a web page.
      data.history = (data.history || []).filter((e) => e && /^https?:\/\//i.test(e.url));
      data.bookmarks = (data.bookmarks || []).filter((b) => b && /^https?:\/\//i.test(b.url));
      return data;
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  save() {
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._flushTimer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('[store] failed to persist state:', err.message);
    }
  }

  // --- history -------------------------------------------------------------

  addHistory(entry) {
    // The browser's own pages are not part of the user's browsing history.
    if (!entry.url || !/^https?:\/\//i.test(entry.url)) return;
    const history = this.data.history;
    // Collapse consecutive visits to the same URL into one refreshed entry.
    if (history[0] && history[0].url === entry.url) {
      history[0] = { ...history[0], ...entry };
    } else {
      history.unshift(entry);
    }
    if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
    this.save();
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }

  // --- bookmarks -----------------------------------------------------------

  isBookmarked(url) {
    return this.data.bookmarks.some((b) => b.url === url);
  }

  toggleBookmark({ url, title }) {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    const idx = this.data.bookmarks.findIndex((b) => b.url === url);
    if (idx >= 0) {
      this.data.bookmarks.splice(idx, 1);
      this.save();
      return false;
    }
    this.data.bookmarks.unshift({
      id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      title: title || url,
      url,
      addedAt: Date.now()
    });
    this.save();
    return true;
  }

  removeBookmark(id) {
    this.data.bookmarks = this.data.bookmarks.filter((b) => b.id !== id);
    this.save();
  }
}

module.exports = { Store, DEFAULTS };
