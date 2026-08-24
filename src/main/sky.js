'use strict';

const { normalizeInput } = require('./urls');

/**
 * The clouds on the new tab page's sky.
 *
 * They live in the store rather than in the page, so they survive a restart and
 * so the page - which is sandboxed and knows nothing about the profile - only
 * has to ask. Kept apart from the rest of the IPC so a test can wire up exactly
 * this and nothing else.
 */

/**
 * Register the sky's three channels.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {{ store: import('./store').Store }} deps
 */
function registerSky(ipcMain, { store }) {
  const links = () => store.get('skyLinks') || [];

  ipcMain.handle('sky:list', () => links());

  ipcMain.handle('sky:add', (_event, entry = {}) => {
    // A cloud is a place, so it has to be an address. Left to itself the
    // address bar's reading would turn "how tall is everest" into a perfectly
    // valid search URL, and quietly hang that in the sky.
    const raw = String(entry.url || '').trim();
    const isAddress =
      /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ||
      /^localhost(:\d+)?([/?#]|$)/i.test(raw) ||
      (!/\s/.test(raw) && /\.[a-z]{2,}([/?#:]|$)/i.test(raw));
    if (!isAddress) return links();

    // Past that gate, read it exactly as the address bar would.
    const url = normalizeInput(raw, store.get('searchEngine'), store.get('shortcuts'));
    if (!/^https?:\/\//i.test(url)) return links();

    const list = links();
    // Take the lowest place in the arrangement nobody is standing in, so a new
    // cloud lands in a gap rather than on top of another one.
    const taken = new Set(list.map((l) => l.slot));
    let slot = 0;
    while (taken.has(slot)) slot += 1;

    let label = String(entry.label || '').trim();
    if (!label) {
      try {
        label = new URL(url).hostname.replace(/^www\./, '');
      } catch {
        label = url;
      }
    }

    list.push({
      id: 'sky-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      label: label.slice(0, 40),
      url,
      slot
    });
    store.set('skyLinks', list);
    return list;
  });

  ipcMain.handle('sky:remove', (_event, id) => {
    const list = links().filter((l) => l.id !== id);
    store.set('skyLinks', list);
    return list;
  });
}

module.exports = { registerSky };
