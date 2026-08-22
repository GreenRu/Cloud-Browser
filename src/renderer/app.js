'use strict';

/**
 * Chrome UI controller.
 *
 * The main process owns all browsing state; this file is a projection of the
 * `shell:state` snapshots it broadcasts, plus the input handling that turns
 * clicks and keystrokes back into IPC messages.
 */

const api = window.cloud;
const $ = (id) => document.getElementById(id);

const el = {
  back: $('back'),
  forward: $('forward'),
  reload: $('reload'),
  home: $('home'),
  omnibox: $('omnibox'),
  badge: $('omni-badge'),
  address: $('address'),
  bookmark: $('bookmark'),
  findOpen: $('find-open'),
  theme: $('theme'),
  menu: $('menu'),
  settings: $('settings'),
  sidebar: $('sidebar'),
  tabstrip: $('tabstrip'),
  newTab: $('new-tab'),
  tabCount: $('tab-count'),
  resizer: $('resizer'),
  findBar: $('find-bar'),
  findInput: $('find-input'),
  findCount: $('find-count'),
  findPrev: $('find-prev'),
  findNext: $('find-next'),
  findClose: $('find-close'),
  bookmarksBar: $('bookmarks-bar'),
  savePassword: $('save-password'),
  savePasswordText: $('save-password-text'),
  savePasswordSave: $('save-password-save'),
  savePasswordNever: $('save-password-never'),
  savePasswordDismiss: $('save-password-dismiss'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
  stage: $('stage')
};

const BADGE_SECURE =
  '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>';
const BADGE_INSECURE =
  '<svg viewBox="0 0 24 24"><path d="M12 8v5"/><circle cx="12" cy="16.5" r="0.9" fill="currentColor"/><path d="M10.6 4.4 3.5 17a1.6 1.6 0 0 0 1.4 2.4h14.2A1.6 1.6 0 0 0 20.5 17L13.4 4.4a1.6 1.6 0 0 0-2.8 0Z"/></svg>';
const BADGE_INTERNAL =
  '<svg viewBox="0 0 24 24"><path d="M6.5 17h11a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7.6 8.4 3.8 3.8 0 0 0 6.5 17Z"/></svg>';

const SIDEBAR_MIN = 190;
const SIDEBAR_MAX = 400;
const SIDEBAR_COLLAPSED = 58;
const SIDEBAR_DEFAULT = 252;

const state = {
  tabs: [],
  activeId: null,
  theme: 'day',
  bookmarks: [],
  bookmarked: false,
  sidebarWidth: 252
};

let omniDirty = false;
let toastTimer = null;
const strip = new window.CloudTabStrip(el.tabstrip, api);

// ---------------------------------------------------------------- rendering

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeId) || null;
}

function render(next) {
  Object.assign(state, next);

  document.documentElement.dataset.theme = state.theme;
  applySidebarWidth(state.sidebarWidth, { persist: false });
  strip.render(state.tabs, state.activeId);

  const tab = activeTab();
  const loading = Boolean(tab?.loading);

  document.body.classList.toggle('loading', loading);
  el.back.disabled = !tab?.canGoBack;
  el.forward.disabled = !tab?.canGoForward;
  el.reload.title = loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)';

  const count = state.tabs.length;
  el.tabCount.textContent = `${count} tab${count === 1 ? '' : 's'}`;

  if (!omniDirty && document.activeElement !== el.address) {
    el.address.value = displayUrl(tab);
  }

  renderBadge(tab?.url || '');

  el.bookmark.classList.toggle('on', Boolean(state.bookmarked));
  el.bookmark.title = state.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';

  renderBookmarks();
  reportContentBounds();
}

function displayUrl(tab) {
  if (!tab?.url || tab.url === 'cloud://newtab') return '';
  return tab.url;
}

function renderBadge(url) {
  el.badge.classList.remove('secure', 'insecure');
  if (url.startsWith('https://')) {
    el.badge.classList.add('secure');
    el.badge.innerHTML = BADGE_SECURE;
    el.badge.title = 'Connection is secure';
  } else if (url.startsWith('http://')) {
    el.badge.classList.add('insecure');
    el.badge.innerHTML = BADGE_INSECURE;
    el.badge.title = 'Connection is not secure';
  } else {
    el.badge.innerHTML = BADGE_INTERNAL;
    el.badge.title = 'Cloud Browser page';
  }
}

function renderBookmarks() {
  const list = state.bookmarks || [];
  el.bookmarksBar.hidden = list.length === 0;
  if (!list.length) {
    el.bookmarksBar.replaceChildren();
    return;
  }

  const nodes = list.slice(0, 24).map((bm) => {
    const button = document.createElement('button');
    button.className = 'bookmark';
    button.title = `${bm.title}\n${bm.url}\nRight-click to remove`;

    const label = document.createElement('span');
    label.textContent = bm.title || bm.url;
    button.appendChild(label);

    button.addEventListener('click', () => api.nav.go(bm.url));
    button.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      api.bookmarks.remove(bm.id);
    });
    return button;
  });

  el.bookmarksBar.replaceChildren(...nodes);
}

/**
 * The page view is a native child of the window, not part of this document, so
 * the main process has to be told exactly where to put it. The `.stage`
 * element is a stand-in for the page: whatever rect it occupies is the rect
 * the page gets, which keeps the two in step as drawers open and close.
 */
let lastBounds = '';
function reportContentBounds() {
  const rect = el.stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
  if (key === lastBounds) return;
  lastBounds = key;
  api.view.setContentBounds(
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight }
  );
}

new ResizeObserver(reportContentBounds).observe(el.stage);
window.addEventListener('resize', reportContentBounds);

// ---------------------------------------------------------------- sidebar

function applySidebarWidth(width, { persist = true } = {}) {
  const clamped = Math.round(Math.max(SIDEBAR_COLLAPSED, Math.min(SIDEBAR_MAX, width)));
  const collapsed = clamped < SIDEBAR_MIN;
  el.sidebar.style.width = `${collapsed ? SIDEBAR_COLLAPSED : clamped}px`;
  el.sidebar.classList.toggle('collapsed', collapsed);
  state.sidebarWidth = collapsed ? SIDEBAR_COLLAPSED : clamped;
  strip.reflow(true);
  reportContentBounds();
  if (persist) api.view.setSidebarWidth(state.sidebarWidth);
}

let resizing = null;

el.resizer.addEventListener('pointerdown', (event) => {
  resizing = { startX: event.clientX, startWidth: el.sidebar.offsetWidth };
  el.resizer.setPointerCapture(event.pointerId);
  event.preventDefault();
});

el.resizer.addEventListener('pointermove', (event) => {
  if (!resizing) return;
  applySidebarWidth(resizing.startWidth + (event.clientX - resizing.startX), { persist: false });
});

el.resizer.addEventListener('pointerup', (event) => {
  if (!resizing) return;
  resizing = null;
  el.resizer.releasePointerCapture(event.pointerId);
  api.view.setSidebarWidth(state.sidebarWidth);
});

el.resizer.addEventListener('dblclick', () => {
  const collapsed = el.sidebar.classList.contains('collapsed');
  applySidebarWidth(collapsed ? SIDEBAR_DEFAULT : SIDEBAR_COLLAPSED);
});

// ---------------------------------------------------------------- omnibox

el.omnibox.addEventListener('click', (event) => {
  if (!el.sidebar.classList.contains('collapsed')) return;
  event.preventDefault();
  applySidebarWidth(SIDEBAR_DEFAULT);
  el.address.focus();
});

el.address.addEventListener('focus', () => {
  el.omnibox.classList.add('focused');
  requestAnimationFrame(() => el.address.select());
});

el.address.addEventListener('blur', () => {
  el.omnibox.classList.remove('focused');
  omniDirty = false;
  el.address.value = displayUrl(activeTab());
});

el.address.addEventListener('input', () => {
  omniDirty = true;
});

el.address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const value = el.address.value.trim();
    if (!value) return;
    omniDirty = false;
    api.nav.go(value);
    el.address.blur();
  } else if (e.key === 'Escape') {
    omniDirty = false;
    el.address.blur();
  }
});

// ---------------------------------------------------------------- toolbar

el.newTab.addEventListener('click', () => api.tabs.create());
el.back.addEventListener('click', () => api.nav.back());
el.forward.addEventListener('click', () => api.nav.forward());
el.home.addEventListener('click', () => api.nav.home());
el.reload.addEventListener('click', () => {
  if (activeTab()?.loading) api.nav.stop();
  else api.nav.reload();
});
el.bookmark.addEventListener('click', () => api.bookmarks.toggle());
el.findOpen.addEventListener('click', () => openFind());
el.settings.addEventListener('click', () => api.tabs.create('cloud://settings'));
el.theme.addEventListener('click', () => {
  api.view.setTheme(state.theme === 'night' ? 'day' : 'night');
});
el.menu.addEventListener('click', () => {
  const box = el.menu.getBoundingClientRect();
  api.app.openMenu(Math.round(box.left), Math.round(box.bottom + 4));
});

// ---------------------------------------------------------------- find bar

function openFind() {
  el.findBar.hidden = false;
  reportContentBounds();
  el.findInput.focus();
  el.findInput.select();
  if (el.findInput.value) api.find.query(el.findInput.value, { findNext: false });
}

function closeFind() {
  el.findBar.hidden = true;
  el.findCount.textContent = '0/0';
  api.find.stop();
  reportContentBounds();
}

el.findInput.addEventListener('input', () => {
  const value = el.findInput.value;
  if (!value) {
    el.findCount.textContent = '0/0';
    api.find.stop();
    return;
  }
  api.find.query(value, { findNext: false });
});

el.findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    api.find.query(el.findInput.value, { findNext: true, forward: !e.shiftKey });
  } else if (e.key === 'Escape') {
    closeFind();
  }
});

el.findPrev.addEventListener('click', () =>
  api.find.query(el.findInput.value, { findNext: true, forward: false })
);
el.findNext.addEventListener('click', () =>
  api.find.query(el.findInput.value, { findNext: true, forward: true })
);
el.findClose.addEventListener('click', closeFind);

// ---------------------------------------------------------------- passwords

function showSavePassword({ origin, username, update, available }) {
  const host = origin.replace(/^https?:\/\//, '');
  if (!available) {
    showToast({
      kind: 'error',
      message: 'This system has no secure keystore, so passwords cannot be saved.'
    });
    return;
  }
  el.savePasswordText.textContent = username
    ? `${update ? 'Update' : 'Save'} password for ${username} on ${host}?`
    : `${update ? 'Update' : 'Save'} password for ${host}?`;
  el.savePassword.hidden = false;
  reportContentBounds();
}

function resolveSavePassword(action) {
  el.savePassword.hidden = true;
  api.passwords.resolve(action);
  reportContentBounds();
}

el.savePasswordSave.addEventListener('click', () => resolveSavePassword('save'));
el.savePasswordNever.addEventListener('click', () => resolveSavePassword('never'));
el.savePasswordDismiss.addEventListener('click', () => resolveSavePassword('dismiss'));

// ---------------------------------------------------------------- toast

function showToast({ message, kind, path }) {
  clearTimeout(toastTimer);
  el.toastText.textContent = message;
  el.toast.hidden = false;
  el.toastAction.hidden = !path;
  el.toastAction.onclick = path ? () => api.app.showItem(path) : null;
  reportContentBounds();

  toastTimer = setTimeout(() => {
    el.toast.hidden = true;
    reportContentBounds();
  }, kind === 'download' ? 2500 : 6000);
}

// ---------------------------------------------------------------- keyboard

// Most shortcuts live in the application menu so they fire while a page has
// focus. These are the few that only make sense with the chrome focused.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.findBar.hidden && document.activeElement !== el.findInput) closeFind();
  else if (activeTab()?.loading) api.nav.stop();
});

// ---------------------------------------------------------------- wiring

api.on.state(render);
api.on.toast(showToast);
api.on.focusOmnibox(() => {
  el.address.focus();
  el.address.select();
});
api.on.openFind(openFind);
api.on.savePassword(showSavePassword);
api.on.findResult(({ matches, current }) => {
  el.findCount.textContent = `${matches ? current : 0}/${matches || 0}`;
});

api.getState().then(render).catch(() => {
  /* the first broadcast will fill us in */
});
