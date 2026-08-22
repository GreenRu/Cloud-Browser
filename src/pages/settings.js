'use strict';

const bridge = window.cloudPage;
const $ = (id) => document.getElementById(id);

let settings = null;

/* ---------------------------------------------------------------- helpers */

function hostOf(origin) {
  return origin.replace(/^https?:\/\//, '');
}

function makeIconButton(glyph, title, onClick, className = 'icon-btn') {
  const button = document.createElement('button');
  button.className = className;
  button.textContent = glyph;
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

async function patch(update) {
  await bridge.settings.update(update);
  settings = await bridge.settings.read();
}

/* ---------------------------------------------------------------- search */

function renderSearch() {
  const engine = $('engine');
  engine.replaceChildren(
    ...Object.entries(settings.engines).map(([key, value]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = value.name;
      option.selected = key === settings.searchEngine;
      return option;
    })
  );

  $('homepage').value = settings.homepage;
  $('theme').value = settings.theme;
  $('show-full-url').checked = settings.showFullUrl !== false;
}

$('engine').addEventListener('change', (e) => patch({ searchEngine: e.target.value }));
$('theme').addEventListener('change', (e) => patch({ theme: e.target.value }).then(applyTheme));
$('homepage').addEventListener('change', (e) => patch({ homepage: e.target.value }));
$('show-full-url').addEventListener('change', (e) => patch({ showFullUrl: e.target.checked }));

/* ---------------------------------------------------------------- shortcuts */

function renderShortcuts() {
  const list = $('shortcut-list');
  const entries = Object.entries(settings.shortcuts).sort(([a], [b]) => a.localeCompare(b));

  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No shortcuts yet. Add one below.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...entries.map(([keyword, template]) => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const key = document.createElement('span');
      key.className = 'keyword';
      key.textContent = keyword;

      const url = document.createElement('span');
      url.className = 'template';
      url.textContent = template;
      url.title = template;

      row.append(key, url, makeIconButton('×', `Remove "${keyword}"`, async () => {
        const next = { ...settings.shortcuts };
        delete next[keyword];
        await patch({ shortcuts: next });
        renderShortcuts();
      }));
      return row;
    })
  );
}

async function addShortcut() {
  const keyword = $('new-key').value.trim().toLowerCase();
  const template = $('new-url').value.trim();

  if (!keyword || /\s/.test(keyword)) return flash($('new-key'));
  if (!/^https?:\/\//i.test(template) || !template.includes('%s')) return flash($('new-url'));

  await patch({ shortcuts: { ...settings.shortcuts, [keyword]: template } });
  $('new-key').value = '';
  $('new-url').value = '';
  renderShortcuts();
}

function flash(input) {
  input.style.borderColor = '#d94a4a';
  input.focus();
  setTimeout(() => {
    input.style.borderColor = '';
  }, 1200);
}

$('add-shortcut').addEventListener('click', addShortcut);
$('new-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addShortcut();
});

$('reset-shortcuts').addEventListener('click', async () => {
  await patch({ shortcuts: settings.defaultShortcuts });
  renderShortcuts();
});

/* ---------------------------------------------------------------- passwords */

function renderVaultState() {
  $('save-passwords').checked = Boolean(settings.savePasswords);

  const warning = $('vault-warning');
  warning.hidden = settings.encryptionAvailable;
  if (!settings.encryptionAvailable) {
    warning.textContent =
      'This system has no keystore Stratus can use, so passwords will not be saved. ' +
      'Nothing is ever written to disk unencrypted.';
  }

  const blocked = settings.blockedOrigins || [];
  $('blocked').hidden = blocked.length === 0;
  $('blocked-list').replaceChildren(
    ...blocked.map((origin) => {
      const row = document.createElement('div');
      row.className = 'row';

      const label = document.createElement('span');
      label.className = 'row-title';
      label.textContent = hostOf(origin);

      row.append(label, makeIconButton('×', 'Ask again on this site', async () => {
        await bridge.passwords.unblock(origin);
        settings = await bridge.settings.read();
        renderVaultState();
      }));
      return row;
    })
  );
}

async function renderPasswords(entries) {
  const list = $('password-list');
  const saved = entries || (await bridge.passwords.list());

  if (!saved.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No saved passwords yet.';
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(
    ...saved.map((entry) => {
      const row = document.createElement('div');
      row.className = 'row';

      const site = document.createElement('span');
      site.className = 'row-title';
      site.textContent = hostOf(entry.origin);

      const user = document.createElement('span');
      user.className = 'row-url';
      user.textContent = entry.username || '(no username)';

      const secret = document.createElement('span');
      secret.className = 'row-meta secret';
      secret.textContent = '••••••••';

      let shown = false;
      let hideTimer = null;

      const reveal = makeIconButton('👁', 'Show password', async () => {
        clearTimeout(hideTimer);
        if (shown) {
          secret.textContent = '••••••••';
          shown = false;
          return;
        }
        const value = await bridge.passwords.reveal(entry.id);
        secret.textContent = value === null ? 'unreadable' : value;
        shown = true;
        // Auto-hide, so a revealed password does not linger on screen.
        hideTimer = setTimeout(() => {
          secret.textContent = '••••••••';
          shown = false;
        }, 15000);
      });

      const remove = makeIconButton('×', 'Remove this password', async () => {
        renderPasswords(await bridge.passwords.remove(entry.id));
      });

      row.append(site, user, secret, reveal, remove);
      return row;
    })
  );
}

$('save-passwords').addEventListener('change', (e) => patch({ savePasswords: e.target.checked }));

$('clear-passwords').addEventListener('click', async () => {
  renderPasswords(await bridge.passwords.clear());
});

/* ---------------------------------------------------------------- history */

function renderHistory() {
  $('history-note').textContent = settings.historyCount
    ? `${settings.historyCount} page${settings.historyCount === 1 ? '' : 's'} in history.`
    : 'No browsing history recorded.';
}

$('clear-history').addEventListener('click', async () => {
  bridge.history.clear();
  settings = await bridge.settings.read();
  renderHistory();
});

/* ---------------------------------------------------------------- boot */

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme || 'day';
}

async function load() {
  if (!bridge) return;
  settings = await bridge.settings.read();
  applyTheme();
  renderSearch();
  renderShortcuts();
  renderVaultState();
  renderHistory();
  renderPasswords();
}

load();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  document.documentElement.dataset.theme = theme;
});
