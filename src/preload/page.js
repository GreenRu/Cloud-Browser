'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* ============================================================
   Bridge for the browser's own bundled pages (new tab, history,
   bookmarks, settings, error).
   ============================================================ */

const here = decodeURIComponent(location.pathname).replace(/\\/g, '/').toLowerCase();

const isInternalPage =
  location.protocol === 'file:' && /\/src\/pages\//.test(here);

/*
 * A page belonging to a plugin, which is a different thing from one of the
 * browser's own. The folders plugins live in are handed to this preload by the
 * main process; a local file anywhere else is just a local file, and gets
 * nothing.
 */
const pluginDirs = (() => {
  const arg = (process.argv || []).find((a) => a.startsWith('--stratus-plugin-dirs='));
  if (!arg) return [];
  try {
    return JSON.parse(arg.slice('--stratus-plugin-dirs='.length))
      .map((dir) => String(dir).replace(/\\/g, '/').toLowerCase());
  } catch {
    return [];
  }
})();

const isPluginPage =
  location.protocol === 'file:' &&
  !isInternalPage &&
  pluginDirs.some((dir) => here.startsWith(dir.startsWith('/') ? dir : `/${dir}`));

if (isInternalPage) {
  contextBridge.exposeInMainWorld('cloudPage', {
    navigate: (input) => ipcRenderer.send('nav:go', input),
    openTab: (url, background = false) => ipcRenderer.send('tab:new', url, { background }),
    reload: () => ipcRenderer.send('nav:reload'),
    resolve: (input) => ipcRenderer.invoke('preview:resolve', input),
    preview: {
      show: (input, rect, viewport) => ipcRenderer.send('preview:show-in-page', input, rect, viewport),
      hide: () => ipcRenderer.send('preview:hide')
    },
    getState: () => ipcRenderer.invoke('shell:get-state'),
    history: {
      list: (limit) => ipcRenderer.invoke('history:list', limit),
      remove: (url, visitedAt) => ipcRenderer.invoke('history:remove', url, visitedAt),
      clearBetween: (from, to) => ipcRenderer.invoke('history:clear-between', from, to),
      clear: () => ipcRenderer.send('history:clear')
    },
    bookmarks: {
      remove: (id) => ipcRenderer.send('bookmark:remove', id)
    },
    sky: {
      list: () => ipcRenderer.invoke('sky:list'),
      add: (entry) => ipcRenderer.invoke('sky:add', entry),
      remove: (id) => ipcRenderer.invoke('sky:remove', id)
    },
    plugins: {
      list: () => ipcRenderer.invoke('plugins:list'),
      setEnabled: (id, on) => ipcRenderer.invoke('plugins:set-enabled', id, on),
      reload: () => ipcRenderer.invoke('plugins:reload'),
      openFolder: () => ipcRenderer.invoke('plugins:open-folder'),
      setThemeValue: (theme, field, value) =>
        ipcRenderer.invoke('plugins:set-theme-value', theme, field, value)
    },
    settings: {
      read: () => ipcRenderer.invoke('settings:read'),
      update: (patch) => ipcRenderer.invoke('settings:update', patch),
      clearSiteData: () => ipcRenderer.invoke('settings:clear-site-data')
    },
    onTheme: (callback) => {
      const handler = (_event, theme) => callback(theme);
      ipcRenderer.on('cloud:theme', handler);
      return () => ipcRenderer.removeListener('cloud:theme', handler);
    },
    passwords: {
      list: () => ipcRenderer.invoke('passwords:list'),
      reveal: (id) => ipcRenderer.invoke('passwords:reveal', id),
      remove: (id) => ipcRenderer.invoke('passwords:remove', id),
      clear: () => ipcRenderer.invoke('passwords:clear'),
      unblock: (origin) => ipcRenderer.invoke('passwords:unblock', origin)
    }
  });
}

/* ============================================================
   Bridge for a plugin's own pages.

   Deliberately smaller than the browser's own: enough to be a useful page -
   go somewhere, open a cloud, read the theme, read where the clouds have been -
   and nothing that touches the profile. No settings, no passwords, no history,
   no plugin management.
   ============================================================ */

if (isPluginPage) {
  contextBridge.exposeInMainWorld('cloudPlugin', {
    navigate: (input) => ipcRenderer.send('nav:go', input),
    openTab: (url, background = false) => ipcRenderer.send('tab:new', url, { background }),
    getState: () => ipcRenderer.invoke('shell:get-state'),
    timeline: () => ipcRenderer.invoke('timeline:read'),
    onTheme: (callback) => {
      const handler = (_event, theme) => callback(theme);
      ipcRenderer.on('cloud:theme', handler);
      return () => ipcRenderer.removeListener('cloud:theme', handler);
    },
    /*
     * A knock at the door: something in the browser changed. It carries
     * nothing - ask for what you want to know.
     */
    onChange: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('cloud:changed', handler);
      return () => ipcRenderer.removeListener('cloud:changed', handler);
    }
  });
}

/* ============================================================
   Login capture and autofill for ordinary web pages.

   This half runs on every site, so it exposes nothing to the page: there is no
   contextBridge call here. It only listens to DOM events and to messages from
   the main process, both inside the isolated world.

   The renderer never states which origin it is - the main process reads that
   from the sender's frame - so a compromised page cannot ask for another
   site's credentials.
   ============================================================ */

const isWebPage = location.protocol === 'https:' || location.protocol === 'http:';
// Only the top document. A cross-origin iframe must never be filled, and
// filling a same-origin one adds nothing.
const isTopFrame = window === window.top;

if (isWebPage && isTopFrame) {
  const USERNAME_HINTS = /user|email|login|account|phone|identifier|name/i;

  const isVisible = (input) =>
    input.offsetParent !== null || input.getClientRects().length > 0;

  function passwordFields(root) {
    return [...root.querySelectorAll('input[type="password"]')].filter(isVisible);
  }

  /**
   * The username is the best text-ish input before the password field: same
   * form when there is one, otherwise the nearest preceding candidate.
   */
  function findUsernameField(passwordField) {
    const scope = passwordField.form || document;
    const candidates = [...scope.querySelectorAll('input')].filter(
      (input) =>
        input !== passwordField &&
        isVisible(input) &&
        ['text', 'email', 'tel', ''].includes((input.type || '').toLowerCase())
    );
    if (!candidates.length) return null;

    const scored = candidates.filter((input) =>
      USERNAME_HINTS.test(`${input.name} ${input.id} ${input.autocomplete} ${input.getAttribute('aria-label') || ''}`)
    );
    const pool = scored.length ? scored : candidates;

    // Prefer the last candidate that appears before the password field.
    const before = pool.filter(
      (input) => passwordField.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_PRECEDING
    );
    return before.length ? before[before.length - 1] : pool[0];
  }

  function reportSubmission() {
    const field = passwordFields(document)[0];
    if (!field || !field.value) return;
    const username = findUsernameField(field);
    ipcRenderer.send('passwords:submitted', {
      username: username ? username.value : '',
      password: field.value
    });
  }

  // Capture phase, so a handler that stops propagation cannot hide the submit.
  window.addEventListener('submit', reportSubmission, true);

  // Many sign-in forms never fire submit; they post via fetch and then leave.
  // Catching the click on the button covers those.
  window.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (target && passwordFields(document).length) reportSubmission();
    },
    true
  );

  function setValue(input, value) {
    // Assign through the native setter so frameworks that patch the property
    // (React and friends) still see the change.
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value'
    )?.set;
    setter ? setter.call(input, value) : (input.value = value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  ipcRenderer.on('passwords:fill', (_event, credential) => {
    if (!credential) return;
    const field = passwordFields(document)[0];
    if (!field || field.value) return;
    const username = findUsernameField(field);
    if (username && !username.value && credential.username) setValue(username, credential.username);
    setValue(field, credential.password);
  });
}
