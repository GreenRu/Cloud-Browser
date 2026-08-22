'use strict';

const path = require('path');
const { pathToFileURL } = require('url');

const SEARCH_ENGINES = {
  google: { name: 'Google', query: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', query: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', query: 'https://www.bing.com/search?q=%s' }
};

const INTERNAL_PAGES = {
  'stratus://newtab': path.join(__dirname, '..', 'pages', 'newtab.html'),
  'stratus://history': path.join(__dirname, '..', 'pages', 'history.html'),
  'stratus://bookmarks': path.join(__dirname, '..', 'pages', 'bookmarks.html'),
  'stratus://settings': path.join(__dirname, '..', 'pages', 'settings.html'),
  'stratus://passwords': path.join(__dirname, '..', 'pages', 'settings.html')
};

/**
 * Search shortcuts: type the keyword, a space, then the query.
 * `gt hola` goes to Google Translate, `yt lofi` to a YouTube search.
 * Users can add their own in Settings; %s is where the query lands.
 */
const DEFAULT_SHORTCUTS = {
  g: 'https://www.google.com/search?q=%s',
  gt: 'https://translate.google.com/?sl=auto&tl=en&op=translate&text=%s',
  yt: 'https://www.youtube.com/results?search_query=%s',
  gh: 'https://github.com/search?q=%s',
  w: 'https://en.wikipedia.org/w/index.php?search=%s',
  mdn: 'https://developer.mozilla.org/en-US/search?q=%s',
  so: 'https://stackoverflow.com/search?q=%s',
  npm: 'https://www.npmjs.com/search?q=%s',
  ddg: 'https://duckduckgo.com/?q=%s',
  maps: 'https://www.google.com/maps/search/%s',
  img: 'https://www.google.com/search?tbm=isch&q=%s'
};

/**
 * Expand `keyword query` into the shortcut's URL. Returns null when the first
 * word is not a known keyword, so ordinary input falls through untouched.
 */
function expandShortcut(text, shortcuts = DEFAULT_SHORTCUTS) {
  const match = text.match(/^(\S+)[ 	]+(.+)$/s);
  if (!match) return null;
  const template = shortcuts?.[match[1].toLowerCase()];
  if (typeof template !== 'string' || !template.includes('%s')) return null;
  return template.replace('%s', encodeURIComponent(match[2].trim()));
}

/** Hosts that are valid without a dot, so `localhost:3000` is not a search. */
const DOTLESS_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOOKS_LIKE_HOST = /^[^\s/?#]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i;

/**
 * Turn whatever the user typed into a real URL.
 * Anything that cannot plausibly be a host becomes a search query.
 */
function normalizeInput(input, engineKey = 'google', shortcuts = DEFAULT_SHORTCUTS) {
  const text = String(input || '').trim();
  if (!text) return null;

  if (INTERNAL_PAGES[text]) return text;
  if (HAS_SCHEME.test(text)) return text;
  if (/^(about|data|blob|mailto|file):/i.test(text)) return text;

  // Checked before host detection: a shortcut always contains a space, which
  // no bare hostname does.
  const shortcut = expandShortcut(text, shortcuts);
  if (shortcut) return shortcut;

  // Local dev servers are almost never TLS, so they default to http.
  if (DOTLESS_HOSTS.test(text)) return `http://${text}`;
  if (LOOKS_LIKE_HOST.test(text)) return `https://${text}`;

  const engine = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES.google;
  return engine.query.replace('%s', encodeURIComponent(text));
}

/** Map a `stratus://` alias to the packaged HTML file that implements it. */
function resolveLoadTarget(url) {
  const file = INTERNAL_PAGES[url];
  return file ? pathToFileURL(file).toString() : url;
}

/** Inverse of resolveLoadTarget, so the URL bar shows `stratus://newtab`. */
function prettifyUrl(url) {
  for (const [alias, file] of Object.entries(INTERNAL_PAGES)) {
    if (url === pathToFileURL(file).toString()) return alias;
  }
  return url;
}

const INTERNAL_TITLES = {
  'stratus://newtab': 'New Tab',
  'stratus://history': 'History',
  'stratus://bookmarks': 'Bookmarks',
  'stratus://settings': 'Settings',
  'stratus://passwords': 'Settings'
};

/** Short, human-readable label for a URL — used for tab titles and the omnibox. */
function hostLabel(url) {
  const internal = INTERNAL_TITLES[prettifyUrl(url)];
  if (internal) return internal;
  try {
    const { hostname } = new URL(url);
    return hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

module.exports = {
  SEARCH_ENGINES,
  INTERNAL_PAGES,
  DEFAULT_SHORTCUTS,
  expandShortcut,
  normalizeInput,
  resolveLoadTarget,
  prettifyUrl,
  hostLabel
};
