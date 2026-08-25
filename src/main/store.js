'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_SHORTCUTS } = require('./urls');

const DEFAULTS = {
  theme: 'day',                       // 'day' | 'night'
  homepage: 'stratus://newtab',
  searchEngine: 'google',
  shortcuts: { ...DEFAULT_SHORTCUTS },
  savePasswords: true,
  saveCards: true,                    // offer to keep payment cards at all
  saveCardCvv: false,                 // and the code on the back with them
  cvvDisabledAt: 0,                   // when that was last switched off - see cards.js
  pluginThemeValues: {},              // { 'plugin:theme': { field: value } }
  enabledPlugins: [],                 // plugin ids switched *on* - nothing runs unasked
  showFullUrl: true,
  restoreSession: true,               // reopen the clouds that were open last time
  saveHistory: true,                  // record the pages visited at all
  defaultZoom: 1,                     // 0.5 - 2, applied to every page
  window: { width: 1280, height: 820, x: null, y: null, maximized: false },
  sidebarWidth: 252,
  skyLinks: null,                     // { id, label, url, slot } - null means "not set yet"
  bookmarks: [],                      // { id, title, url, addedAt }
  history: [],                        // { url, title, visitedAt }
  session: []                         // urls restored on launch
};

/**
 * The clouds a new profile's sky starts with. `slot` is a place in the
 * scattered arrangement the new tab page lays out - see SKY_SLOTS there.
 */
const DEFAULT_SKY = [
  { id: 'sky-google', label: 'Google', url: 'https://www.google.com', slot: 0 },
  { id: 'sky-wikipedia', label: 'Wikipedia', url: 'https://www.wikipedia.org', slot: 1 },
  { id: 'sky-mdn', label: 'MDN', url: 'https://developer.mozilla.org', slot: 2 },
  { id: 'sky-github', label: 'GitHub', url: 'https://github.com', slot: 3 },
  { id: 'sky-youtube', label: 'YouTube', url: 'https://www.youtube.com', slot: 4 },
  { id: 'sky-hn', label: 'Hacker News', url: 'https://news.ycombinator.com', slot: 5 }
];

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
      // The internal scheme was renamed with the app; saved state predates it.
      if (typeof data.homepage === 'string') {
        data.homepage = data.homepage.replace(/^cloud:\/\//, 'stratus://');
      }
      if (Array.isArray(data.session)) {
        data.session = data.session.map((url) =>
          typeof url === 'string' ? url.replace(/^cloud:\/\//, 'stratus://') : url
        );
      }

      // The sky starts with a few well-known places and is the user's after
      // that, including when they empty it - so null, not [], means untouched.
      if (data.skyLinks == null) data.skyLinks = structuredClone(DEFAULT_SKY);
      data.skyLinks = (data.skyLinks || []).filter(
        (l) => l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url)
      );

      // Drop anything a previous version recorded that is not a web page.
      data.history = (data.history || []).filter((e) => e && /^https?:\/\//i.test(e.url));
      data.bookmarks = (data.bookmarks || []).filter((b) => b && /^https?:\/\//i.test(b.url));
      return data;
    } catch {
      // No file yet, or an unreadable one: a fresh profile, which still starts
      // with a sky rather than an empty one.
      const fresh = structuredClone(DEFAULTS);
      fresh.skyLinks = structuredClone(DEFAULT_SKY);
      return fresh;
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
    // Nothing is written down when the user has asked for nothing to be.
    if (this.data.saveHistory === false) return;
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

  /** Forget one page. Identified by where and when, since a URL can recur. */
  removeHistory(url, visitedAt) {
    const before = this.data.history.length;
    this.data.history = this.data.history.filter(
      (e) => !(e.url === url && (visitedAt === undefined || e.visitedAt === visitedAt))
    );
    if (this.data.history.length !== before) this.save();
    return before - this.data.history.length;
  }

  /** Forget everything visited in a stretch of time - a day, from the page. */
  clearHistoryBetween(from, to) {
    const before = this.data.history.length;
    this.data.history = this.data.history.filter(
      (e) => !(e.visitedAt >= from && e.visitedAt <= to)
    );
    if (this.data.history.length !== before) this.save();
    return before - this.data.history.length;
  }

  clearHistory() {
    this.data.history = [];
    this.save();
  }

  // --- bookmarks -----------------------------------------------------------

  isBookmarked(url) {
    return this.data.bookmarks.some((b) => b.url === url);
  }

  /**
   * Add several bookmarks at once, skipping any address already kept.
   *
   * Used by the importer, which routinely offers hundreds and should not
   * produce a second copy of everything on a second run.
   */
  addBookmarks(list) {
    const have = new Set(this.data.bookmarks.map((b) => b.url));
    const added = [];

    for (const entry of Array.isArray(list) ? list : []) {
      const url = String(entry && entry.url ? entry.url : '');
      if (!/^https?:\/\//i.test(url) || have.has(url)) continue;
      have.add(url);
      added.push({
        id: `bm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: String(entry.title || url).slice(0, 200),
        url,
        folder: String(entry.folder || '').slice(0, 200),
        addedAt: Date.now()
      });
    }

    if (added.length) {
      this.data.bookmarks.unshift(...added);
      this.save();
    }
    return added.length;
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

module.exports = { Store, DEFAULT_SKY, DEFAULTS };
