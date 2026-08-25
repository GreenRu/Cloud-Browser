'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Bringing things over from another browser.
 *
 * Two routes, because no single one covers everything honestly:
 *
 *  - **Read it directly.** Every Chromium browser keeps its bookmarks in a
 *    plain JSON file, and Firefox keeps a compressed JSON backup of its own.
 *    Those can simply be read, and this finds them without being told where.
 *
 *  - **Read a file the other browser exported.** Bookmarks as HTML, passwords
 *    and cards as CSV. Slower for the person doing it, and the only route that
 *    works for passwords at all: Chrome's are sealed to Chrome, and recent
 *    versions bind that seal to the application itself, so no other program can
 *    open them. Every browser can export them, and that is the door meant for
 *    this.
 *
 * Nothing here goes near another browser's password store. It reads bookmarks,
 * and it reads files the user has deliberately exported.
 */

/** Where the browsers that keep bookmarks as JSON put their profiles. */
function chromiumRoots() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  if (process.platform === 'win32') {
    return [
      { name: 'Google Chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data') },
      { name: 'Microsoft Edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
      { name: 'Brave', dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { name: 'Vivaldi', dir: path.join(local, 'Vivaldi', 'User Data') },
      { name: 'Opera', dir: path.join(roaming, 'Opera Software', 'Opera Stable') },
      { name: 'Chromium', dir: path.join(local, 'Chromium', 'User Data') }
    ];
  }

  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return [
      { name: 'Google Chrome', dir: path.join(support, 'Google', 'Chrome') },
      { name: 'Microsoft Edge', dir: path.join(support, 'Microsoft Edge') },
      { name: 'Brave', dir: path.join(support, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Vivaldi', dir: path.join(support, 'Vivaldi') },
      { name: 'Chromium', dir: path.join(support, 'Chromium') }
    ];
  }

  const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [
    { name: 'Google Chrome', dir: path.join(config, 'google-chrome') },
    { name: 'Microsoft Edge', dir: path.join(config, 'microsoft-edge') },
    { name: 'Brave', dir: path.join(config, 'BraveSoftware', 'Brave-Browser') },
    { name: 'Vivaldi', dir: path.join(config, 'vivaldi') },
    { name: 'Chromium', dir: path.join(config, 'chromium') }
  ];
}

function firefoxRoots() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      'Mozilla', 'Firefox', 'Profiles')];
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')];
  }
  return [path.join(home, '.mozilla', 'firefox')];
}

/** Every `Bookmarks` file under a Chromium user-data directory. */
function chromiumProfiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  // Opera keeps one profile at the root; Chrome keeps Default, Profile 1, ...
  for (const candidate of ['.', ...entries.filter((e) => e.isDirectory()).map((e) => e.name)]) {
    const file = path.join(root, candidate, 'Bookmarks');
    try {
      if (fs.statSync(file).isFile()) {
        found.push({ profile: candidate === '.' ? 'Default' : candidate, file });
      }
    } catch {
      // Not a profile.
    }
  }
  return found;
}

/** The newest bookmark backup in a Firefox profile. */
function firefoxBackups(root) {
  let profiles;
  try {
    profiles = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }

  const found = [];
  for (const profile of profiles) {
    const dir = path.join(root, profile.name, 'bookmarkbackups');
    let backups;
    try {
      backups = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonlz4'));
    } catch {
      continue;
    }
    if (!backups.length) continue;

    // The names carry the date, so the last one sorted is the newest.
    backups.sort();
    found.push({ profile: profile.name, file: path.join(dir, backups[backups.length - 1]) });
  }
  return found;
}

/**
 * Firefox writes its backups as `mozLz4`: a magic string, the decompressed
 * size, then one LZ4 block. Small enough to read here rather than take on a
 * dependency for.
 */
function decodeMozLz4(buffer) {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 8) !== 'mozLz40\0') return null;

  const size = buffer.readUInt32LE(8);
  const out = Buffer.alloc(size);
  let input = 12;
  let output = 0;

  while (input < buffer.length && output < size) {
    const token = buffer[input++];

    // Literals: a run copied straight across.
    let literals = token >> 4;
    if (literals === 15) {
      let more;
      do {
        more = buffer[input++];
        literals += more;
      } while (more === 255);
    }
    buffer.copy(out, output, input, input + literals);
    input += literals;
    output += literals;
    if (output >= size) break;

    // A match: repeat something already written, from `offset` back.
    const offset = buffer.readUInt16LE(input);
    input += 2;
    if (offset === 0) return null;

    let length = token & 0x0f;
    if (length === 15) {
      let more;
      do {
        more = buffer[input++];
        length += more;
      } while (more === 255);
    }
    length += 4;

    // Byte at a time: the ranges overlap by design when offset < length.
    let from = output - offset;
    for (let i = 0; i < length && output < size; i++) out[output++] = out[from++];
  }

  return out.slice(0, output);
}

/** Walk either browser's bookmark tree into a flat list. */
function flattenChromium(node, folder, into) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'url' && node.url) {
    into.push({ title: node.name || node.url, url: node.url, folder });
    return;
  }
  const name = node.name ? [folder, node.name].filter(Boolean).join(' / ') : folder;
  for (const child of node.children || []) flattenChromium(child, name, into);
}

function flattenFirefox(node, folder, into) {
  if (!node || typeof node !== 'object') return;
  if (node.uri && /^https?:/i.test(node.uri)) {
    into.push({ title: node.title || node.uri, url: node.uri, folder });
    return;
  }
  const name = node.title ? [folder, node.title].filter(Boolean).join(' / ') : folder;
  for (const child of node.children || []) flattenFirefox(child, name, into);
}

/** What is on this machine that has bookmarks worth offering. */
function findSources() {
  const sources = [];

  for (const { name, dir } of chromiumRoots()) {
    for (const { profile, file } of chromiumProfiles(dir)) {
      let count = 0;
      try {
        count = readChromiumBookmarks(file).length;
      } catch {
        continue;
      }
      if (count) sources.push({ id: `chromium:${file}`, browser: name, profile, kind: 'chromium', count });
    }
  }

  for (const root of firefoxRoots()) {
    for (const { profile, file } of firefoxBackups(root)) {
      let count = 0;
      try {
        count = readFirefoxBookmarks(file).length;
      } catch {
        continue;
      }
      if (count) sources.push({ id: `firefox:${file}`, browser: 'Firefox', profile, kind: 'firefox', count });
    }
  }

  return sources;
}

function readChromiumBookmarks(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = [];
  for (const root of Object.values(parsed.roots || {})) flattenChromium(root, '', out);
  return out.filter((b) => /^https?:/i.test(b.url));
}

function readFirefoxBookmarks(file) {
  const raw = fs.readFileSync(file);
  const json = decodeMozLz4(raw) || raw;
  const parsed = JSON.parse(json.toString('utf8'));
  const out = [];
  flattenFirefox(parsed, '', out);
  return out;
}

/** Read one of the sources found above. */
function readSource(id) {
  const at = id.indexOf(':');
  const kind = id.slice(0, at);
  const file = id.slice(at + 1);
  if (kind === 'chromium') return readChromiumBookmarks(file);
  if (kind === 'firefox') return readFirefoxBookmarks(file);
  throw new Error('unknown source');
}

// --- files the other browser exported ---------------------------------------

/**
 * A CSV row reader that copes with quoted fields and newlines inside them,
 * which every browser's password export contains sooner or later.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }

  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Header names differ between browsers; each of these is one meaning. */
const COLUMNS = {
  url: ['url', 'website url', 'login_uri', 'web site', 'site'],
  username: ['username', 'login_username', 'login name', 'user name', 'email'],
  password: ['password', 'login_password'],
  title: ['name', 'title'],
  number: ['card number', 'number', 'card_number'],
  holder: ['name on card', 'cardholder', 'card holder', 'name'],
  month: ['expiration month', 'exp month', 'expiry month', 'month',
    'expiration_month', 'exp_month'],
  year: ['expiration year', 'exp year', 'expiry year', 'year',
    'expiration_year', 'exp_year'],
  cvv: ['security code', 'cvv', 'cvc', 'card security code', 'card_security_code']
};

function indexColumns(header) {
  const lower = header.map((h) => h.trim().toLowerCase());
  const found = {};
  for (const [meaning, names] of Object.entries(COLUMNS)) {
    const at = lower.findIndex((h) => names.includes(h));
    if (at >= 0) found[meaning] = at;
  }
  return found;
}

/** Logins from a CSV any browser exported. */
function readPasswordCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const at = indexColumns(rows[0]);
  if (at.password === undefined || at.url === undefined) return [];

  return rows.slice(1).map((row) => ({
    url: (row[at.url] || '').trim(),
    username: at.username === undefined ? '' : (row[at.username] || '').trim(),
    password: at.password === undefined ? '' : row[at.password] || ''
  })).filter((entry) => entry.url && entry.password);
}

/** Cards from a CSV any browser exported. */
function readCardCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const at = indexColumns(rows[0]);
  if (at.number === undefined) return [];

  return rows.slice(1).map((row) => ({
    number: (row[at.number] || '').trim(),
    holder: at.holder === undefined ? '' : (row[at.holder] || '').trim(),
    expMonth: at.month === undefined ? '' : (row[at.month] || '').trim(),
    expYear: at.year === undefined ? '' : (row[at.year] || '').trim(),
    cvv: at.cvv === undefined ? '' : (row[at.cvv] || '').trim()
  })).filter((card) => card.number);
}

/**
 * The handful of entities an exported bookmark file actually contains. The
 * address needs this as much as the title does: a query string with two
 * parameters in it is written `?a=1&amp;b=2`, and stored that way it is a
 * different address from the one that was bookmarked.
 */
function unescapeHtml(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');   // last, so `&amp;lt;` survives as the text `&lt;`
}

/** Bookmarks from the HTML file every browser exports. */
function readBookmarkHtml(text) {
  const out = [];
  const link = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = link.exec(text);

  while (match) {
    const url = unescapeHtml(match[1]);
    if (/^https?:/i.test(url)) {
      const title = unescapeHtml(match[2].replace(/<[^>]*>/g, '')).trim();
      out.push({ title: title || url, url, folder: '' });
    }
    match = link.exec(text);
  }
  return out;
}

module.exports = {
  findSources,
  readSource,
  readPasswordCsv,
  readCardCsv,
  readBookmarkHtml,
  parseCsv,
  decodeMozLz4
};
