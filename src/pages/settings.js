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

  // Day and night, then anything a plugin is offering.
  const themes = [
    { id: 'day', name: 'Day' },
    { id: 'night', name: 'Night' },
    ...(settings.customThemes || []).map((t) => ({ id: t.id, name: `${t.name} (${t.pluginName})` }))
  ];
  $('theme').replaceChildren(
    ...themes.map((t) => {
      const option = document.createElement('option');
      option.value = t.id;
      option.textContent = t.name;
      option.selected = t.id === settings.theme;
      return option;
    })
  );

  $('homepage').value = settings.homepage;
  $('restore-session').checked = settings.restoreSession !== false;
  $('save-history').checked = settings.saveHistory !== false;
  $('default-zoom').value = String(settings.defaultZoom || 1);
  $('show-full-url').checked = settings.showFullUrl !== false;
}

$('engine').addEventListener('change', (e) => patch({ searchEngine: e.target.value }));
$('theme').addEventListener('change', async (e) => {
  await patch({ theme: e.target.value });
  await applyTheme();
  renderPalette();
});

/* ------------------------------------------------------------- theme editor */

const palette = document.getElementById('palette');

/**
 * The editor for a theme a plugin offers: a control for every field that theme
 * declared, in the groups it declared them in. Nothing here knows what any
 * particular colour is for - the plugin said, and this draws what it said.
 */
function renderPalette() {
  const theme = (settings.customThemes || []).find((t) => t.id === settings.theme);
  palette.hidden = !theme;
  palette.replaceChildren();
  if (!theme) return;

  const note = document.createElement('p');
  note.className = 'palette-note';
  note.textContent = `${theme.name}, from ${theme.pluginName}. ` +
    'Changes apply as you make them.';
  palette.appendChild(note);

  // Group order follows the manifest, so a theme decides how it reads.
  const groups = [];
  for (const field of theme.fields) {
    const name = field.group || '';
    let group = groups.find((g) => g.name === name);
    if (!group) groups.push((group = { name, fields: [] }));
    group.fields.push(field);
  }

  for (const group of groups) {
    if (group.name) {
      const heading = document.createElement('p');
      heading.className = 'palette-group';
      heading.textContent = group.name;
      palette.appendChild(heading);
    }

    const grid = document.createElement('div');
    grid.className = 'palette-grid';

    for (const field of group.fields) {
      grid.appendChild(field.type === 'toggle'
        ? paletteToggle(theme, field)
        : paletteColor(theme, field));
    }

    palette.appendChild(grid);
  }
}

function paletteColor(theme, field) {
  const label = document.createElement('label');
  label.className = 'swatch';

  const input = document.createElement('input');
  input.type = 'color';
  input.value = String(theme.values[field.id] || '#ffffff');

  const text = document.createElement('span');
  text.textContent = field.label;

  // `input` while dragging the picker, so the browser repaints as you choose.
  input.addEventListener('input', async () => {
    theme.values[field.id] = input.value;
    await bridge.plugins.setThemeValue(theme.id, field.id, input.value);
  });

  label.append(input, text);
  return label;
}

function paletteToggle(theme, field) {
  const wrap = document.createElement('label');
  wrap.className = 'swatch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(theme.values[field.id]);

  const text = document.createElement('span');
  text.textContent = field.label;

  input.addEventListener('change', async () => {
    theme.values[field.id] = input.checked;
    await bridge.plugins.setThemeValue(theme.id, field.id, input.checked);
  });

  wrap.append(input, text);
  return wrap;
}
$('homepage').addEventListener('change', (e) => patch({ homepage: e.target.value }));
$('restore-session').addEventListener('change', (e) => patch({ restoreSession: e.target.checked }));
$('save-history').addEventListener('change', (e) => patch({ saveHistory: e.target.checked }));
$('default-zoom').addEventListener('change', (e) => patch({ defaultZoom: Number(e.target.value) }));

$('open-history').addEventListener('click', () => bridge?.navigate('stratus://history'));
$('open-bookmarks').addEventListener('click', () => bridge?.navigate('stratus://bookmarks'));

$('clear-site-data').addEventListener('click', async () => {
  const note = $('data-note');
  note.textContent = 'Clearing...';
  await bridge.settings.clearSiteData();
  note.textContent = 'Cookies and site data cleared. Sites you were signed in to will ask again.';
});
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
  window.SkyTheme.apply({ base: settings.themeBase, variables: settings.pageThemeVars });
}

/* ---------------------------------------------------------------- plugins */

const pluginList = document.getElementById('plugin-list');
const pluginNote = document.getElementById('plugin-note');

function renderPlugins(state) {
  pluginList.replaceChildren();

  const { plugins = [], problems = [], directory = '' } = state || {};
  const on = plugins.filter((p) => p.enabled).length;

  pluginNote.textContent = plugins.length
    ? `${on} of ${plugins.length} switched on. Installed in ${directory}.`
    : `Nothing installed yet. Plugins go in ${directory}.`;

  for (const plugin of plugins) {
    const row = document.createElement('div');
    row.className = 'row';

    const text = document.createElement('div');
    text.className = 'row-title';
    text.textContent = `${plugin.name} ${plugin.version}`;

    const detail = document.createElement('div');
    detail.className = 'row-url';
    const parts = [];
    if (plugin.description) parts.push(plugin.description);
    const c = plugin.counts;
    const does = [
      c.styles && `${c.styles} style${c.styles === 1 ? '' : 's'}`,
      c.scripts && `${c.scripts} script${c.scripts === 1 ? '' : 's'}`,
      c.shortcuts && `${c.shortcuts} keyword${c.shortcuts === 1 ? '' : 's'}`,
      c.commands && `${c.commands} command${c.commands === 1 ? '' : 's'}`,
      c.pages && `${c.pages} page${c.pages === 1 ? '' : 's'}`
    ].filter(Boolean);
    if (does.length) parts.push(does.join(', '));
    detail.textContent = parts.join(' - ');

    const cell = document.createElement('div');
    cell.style.flex = '1 1 auto';
    cell.style.minWidth = '0';
    cell.append(text, detail);

    const toggle = document.createElement('button');
    toggle.className = 'ghost-btn';
    toggle.textContent = plugin.enabled ? 'On' : 'Off';
    toggle.addEventListener('click', async () => {
      renderPlugins(await bridge.plugins.setEnabled(plugin.id, !plugin.enabled));
    });

    row.append(cell, toggle);
    pluginList.appendChild(row);
  }

  // A plugin that would not load is worth saying so about, with the reason.
  for (const problem of problems) {
    const row = document.createElement('div');
    row.className = 'row';
    const cell = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'row-title';
    title.textContent = problem.path.split(/[\\/]/).pop() + ' would not load';
    const why = document.createElement('div');
    why.className = 'row-url';
    why.textContent = problem.error;
    cell.append(title, why);
    row.appendChild(cell);
    pluginList.appendChild(row);
  }
}

document.getElementById('plugin-reload').addEventListener('click', async () => {
  renderPlugins(await bridge.plugins.reload());
});

document.getElementById('plugin-folder').addEventListener('click', () => {
  bridge.plugins.openFolder();
});

async function load() {
  if (!bridge) return;
  settings = await bridge.settings.read();
  applyTheme();
  renderSearch();
  renderPalette();
  renderShortcuts();
  renderVaultState();
  renderHistory();
  renderPasswords();

  try {
    renderPlugins(await bridge.plugins.list());
  } catch {
    /* an older build of the browser simply has no plugin host */
  }
}

load();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  window.SkyTheme.apply(theme);
});
