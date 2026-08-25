'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* ============================================================
   Bridge for the browser's own bundled pages (new tab, history,
   droplets, settings, error).
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
    droplets: {
      remove: (id) => ipcRenderer.send('droplet:remove', id)
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
    flights: {
      list: () => ipcRenderer.invoke('flights:list'),
      act: (action, id) => ipcRenderer.invoke('flights:act', action, id),
      chooseFolder: () => ipcRenderer.invoke('flights:choose-folder'),
      useDefaultFolder: () => ipcRenderer.invoke('flights:use-default-folder'),
      onChanged: (callback) => {
        const handler = (_event, state) => callback(state);
        ipcRenderer.on('flights:changed', handler);
        return () => ipcRenderer.removeListener('flights:changed', handler);
      }
    },
    cards: {
      list: () => ipcRenderer.invoke('cards:list'),
      save: (card) => ipcRenderer.invoke('cards:save', card),
      reveal: (id) => ipcRenderer.invoke('cards:reveal', id),
      remove: (id) => ipcRenderer.invoke('cards:remove', id),
      clear: () => ipcRenderer.invoke('cards:clear'),
      keepCvv: (on) => ipcRenderer.invoke('cards:keep-cvv', on),
      forgetCvv: () => ipcRenderer.invoke('cards:forget-cvv')
    },
    transfer: {
      sources: () => ipcRenderer.invoke('import:sources'),
      bookmarks: (id) => ipcRenderer.invoke('import:bookmarks', id),
      fromFile: (kind) => ipcRenderer.invoke('import:file', kind)
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
    // (React and friends) still see the change. The setter belongs to the
    // element's own kind: handing a <select> the one off HTMLInputElement
    // throws, and takes the rest of the form's filling down with it.
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
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

  /* --------------------------------------------------------------------------
     Saved cards at a checkout.

     Nothing happens until a card field is focused - a page cannot help itself
     to a card by existing, and the browser never volunteers one. Even then the
     page is only ever handed the values, never the store: it cannot list what
     is saved, cannot ask for a card by number, and cannot ask twice for the
     code on the back if the browser has decided it must be typed.
     -------------------------------------------------------------------------- */

  // The purpose of a field, from `autocomplete` where a checkout bothers with
  // it, and from its name otherwise. Order matters: the more specific tests
  // come first, since `cc-exp` is a prefix of two other things.
  const CARD_KINDS = [
    ['number', /\bcc-number\b/, /(card|cc)[-_ ]?(number|num)|cardnumber|creditcard/i],
    ['cvv', /\bcc-csc\b/, /\b(cvv|cvc|csc|cvn|security[-_ ]?code|card[-_ ]?code)\b/i],
    ['expMonth', /\bcc-exp-month\b/, /(exp|expiry|expiration)[-_ ]?(month|mm)\b|\bmonth\b/i],
    ['expYear', /\bcc-exp-year\b/, /(exp|expiry|expiration)[-_ ]?(year|yy)\b|\byear\b/i],
    ['exp', /\bcc-exp\b/, /\b(expiry|expiration|exp[-_ ]?date)\b/i],
    ['holder', /\bcc-name\b/, /(card|cc)[-_ ]?(holder|name)|nameoncard/i]
  ];

  function kindOf(input) {
    const auto = (input.autocomplete || input.getAttribute('autocomplete') || '').toLowerCase();
    for (const [kind, byAutocomplete] of CARD_KINDS) {
      if (byAutocomplete.test(auto)) return kind;
    }
    // A checkout that says nothing about itself. The label counts as a name
    // here, because plenty of them put the only clue there.
    const words = [
      input.name, input.id, input.placeholder,
      input.getAttribute('aria-label') || '',
      input.labels && input.labels[0] ? input.labels[0].textContent : ''
    ].join(' ');
    for (const [kind, , byName] of CARD_KINDS) {
      if (byName.test(words)) return kind;
    }
    return null;
  }

  /** Every card field in the same form, or on the page if there is no form. */
  function cardFields(from) {
    const scope = (from && from.form) || document;
    const found = {};
    for (const input of scope.querySelectorAll('input, select')) {
      if (!isVisible(input)) continue;
      const kind = kindOf(input);
      if (kind && !found[kind]) found[kind] = input;
    }
    return found;
  }

  /**
   * Set an expiry field that may be a dropdown, and may want its month either
   * padded or not - `09` and `9` are both common, and so are `2030` and `30`.
   * A text box takes the first form; a dropdown takes whichever it actually
   * offers, by value or by the words in the option.
   */
  function chooseValue(field, candidates) {
    if (field.tagName !== 'SELECT') {
      setValue(field, candidates[0]);
      return;
    }
    const options = [...field.options];
    for (const candidate of candidates) {
      const match = options.find((o) => o.value === candidate) ||
        options.find((o) => o.textContent.trim() === candidate);
      if (match) {
        setValue(field, match.value);
        return;
      }
    }
    // A month dropdown that lists names rather than numbers.
    const byPosition = options.filter((o) => o.value !== '');
    const index = Number(candidates[candidates.length - 1]);
    if (byPosition.length === 12 && index >= 1 && index <= 12) {
      setValue(field, byPosition[index - 1].value);
    }
  }

  // Which card was filled here, so a code typed afterwards can be attached to
  // it. Kept in this world only; the page cannot read it.
  let filledCard = null;

  function fillCard(card) {
    if (!card) return;
    const fields = cardFields(document.activeElement);
    if (!fields.number) return;

    setValue(fields.number, card.number);
    if (fields.holder && card.holder) setValue(fields.holder, card.holder);

    const mm = String(card.expMonth).padStart(2, '0');
    const yyyy = String(card.expYear);
    if (fields.expMonth) chooseValue(fields.expMonth, [mm, String(card.expMonth)]);
    if (fields.expYear) chooseValue(fields.expYear, [yyyy, yyyy.slice(-2)]);
    if (fields.exp) setValue(fields.exp, `${mm} / ${yyyy}`);

    filledCard = { id: card.id, field: fields.cvv || null };

    if (fields.cvv) {
      if (card.cvv) {
        setValue(fields.cvv, card.cvv);
      } else {
        // The browser is not going to fill this one. Put the person in it
        // rather than leaving them to discover the empty box themselves.
        setValue(fields.cvv, '');
        try {
          fields.cvv.focus();
        } catch {
          /* a checkout may well refuse to be focused */
        }
      }
    }
  }

  ipcRenderer.on('cards:fill', (_event, card) => fillCard(card));

  // Focusing a card field is the ask. Nothing before that.
  window.addEventListener(
    'focusin',
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.value) return;
      const kind = kindOf(input);
      if (kind !== 'number' && kind !== 'holder') return;
      ipcRenderer.send('cards:wanted');
    },
    true
  );

  /*
   * A code typed by hand is worth keeping, since typing it is exactly what the
   * browser asked for. Only ever the code, only for the card just filled, and
   * the main process still refuses it unless keeping codes is switched on.
   */
  function reportTypedCvv() {
    if (!filledCard || !filledCard.field) return;
    const code = String(filledCard.field.value || '').trim();
    if (!/^[0-9]{3,4}$/.test(code)) return;
    ipcRenderer.send('cards:cvv-typed', { id: filledCard.id, cvv: code });
    filledCard = null;
  }

  window.addEventListener('submit', reportTypedCvv, true);
  window.addEventListener(
    'click',
    (event) => {
      const target = event.target instanceof Element
        ? event.target.closest('button, input[type="submit"], [role="button"]')
        : null;
      if (target) reportTypedCvv();
    },
    true
  );
}
