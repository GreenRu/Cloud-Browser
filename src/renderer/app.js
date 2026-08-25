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
  droplet: $('droplet'),
  dropletBarToggle: $('droplet-bar-toggle'),
  findOpen: $('find-open'),
  menu: $('menu'),
  settings: $('settings'),
  sidebar: $('sidebar'),
  tabstrip: $('tabstrip'),
  newTab: $('new-tab'),
  mergeClouds: $('merge-clouds'),
  mergeLabel: $('merge-label'),
  splitClouds: $('split-clouds'),
  splitLabel: $('split-label'),
  tabCount: $('tab-count'),
  resizer: $('resizer'),
  findBar: $('find-bar'),
  findInput: $('find-input'),
  findCount: $('find-count'),
  findPrev: $('find-prev'),
  findNext: $('find-next'),
  findClose: $('find-close'),
  dropletBar: $('droplet-bar'),
  savePassword: $('save-password'),
  savePasswordText: $('save-password-text'),
  savePasswordSave: $('save-password-save'),
  savePasswordNever: $('save-password-never'),
  savePasswordDismiss: $('save-password-dismiss'),
  toast: $('toast'),
  toastText: $('toast-text'),
  toastAction: $('toast-action'),
  stage: $('stage'),
  flights: $('flights'),
  flightCount: $('flight-count'),
  thought: $('thought'),
  thoughtLabel: $('thought-label'),
  paneGrips: $('pane-grips'),
  thoughtBubble: document.querySelector('.thought-bubble'),
  thoughtScreen: $('thought-screen'),
  thoughtUrl: $('thought-url')
};

const BADGE_SECURE = window.Icons.svg('lock');
const BADGE_INSECURE = window.Icons.svg('danger');
const BADGE_INTERNAL = window.Icons.svg('cloud');

// Every element that named an icon gets one, before anything is drawn.
window.Icons.paint(document);

const SIDEBAR_MIN = 190;
const SIDEBAR_MAX = 400;
const SIDEBAR_COLLAPSED = 58;
const SIDEBAR_DEFAULT = 252;

const state = {
  tabs: [],
  activeId: null,
  theme: 'day',
  droplets: [],
  dropletKept: false,
  showDroplets: true,
  sidebarWidth: 252,
  showFullUrl: true
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

  window.SkyTheme.apply({ base: state.themeBase, variables: state.themeVars });
  applySidebarWidth(state.sidebarWidth, { persist: false });
  strip.render(state.tabs, state.activeId);

  const tab = activeTab();
  const loading = Boolean(tab?.loading);

  document.body.classList.toggle('loading', loading);
  // With a cloud on screen the stage is covered; its colour would only show in
  // the seams between merged panes.
  document.body.classList.toggle('has-tabs', state.tabs.length > 0);
  el.back.disabled = !tab?.canGoBack;
  el.forward.disabled = !tab?.canGoForward;
  el.reload.title = loading ? 'Stop loading (Esc)' : 'Reload (Ctrl+R)';

  const count = state.tabs.length;
  el.tabCount.textContent = `${count} cloud${count === 1 ? '' : 's'}`;

  if (!omniDirty && document.activeElement !== el.address) {
    el.address.value = displayUrl(tab);
  }

  renderGrips(state);
  renderPluginButtons(state);

  renderBadge(tab?.url || '');

  el.droplet.classList.toggle('on', Boolean(state.dropletKept));
  el.droplet.title = state.dropletKept
    ? 'Remove this droplet (Ctrl+D)'
    : 'Keep as a droplet (Ctrl+D)';

  const showing = state.showDroplets !== false;
  el.dropletBarToggle.classList.toggle('on', showing);
  el.dropletBarToggle.setAttribute('aria-pressed', String(showing));
  el.dropletBarToggle.title = showing ? 'Hide droplets (Ctrl+Shift+B)' : 'Show droplets (Ctrl+Shift+B)';

  const panes = tab?.panes || 1;
  el.splitClouds.hidden = panes < 2;
  if (panes > 1) {
    el.splitLabel.textContent = `Split ${panes} clouds`;
    el.splitClouds.title = `Give each of these ${panes} pages its own cloud again`;
  }

  renderDroplets();
  reportContentBounds();
}

/**
 * What the address bar shows when it is not being edited.
 *
 * With "show full address" off it is trimmed to the host - subdomains and all -
 * because the scheme, path and query are rarely what you are checking. The
 * whole address comes back the moment the field is focused, so editing and
 * copying still work on the real thing.
 */
function displayUrl(tab) {
  if (!tab?.url || tab.url === 'stratus://newtab') return '';
  if (state.showFullUrl) return tab.url;
  return hostOnly(tab.url);
}

function hostOnly(url) {
  try {
    const { hostname, port } = new URL(url);
    if (!hostname) return url;
    return port ? `${hostname}:${port}` : hostname;
  } catch {
    return url;
  }
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
    el.badge.title = 'Stratus page';
  }
}

/**
 * The row of kept pages.
 *
 * Whether it is on show is the button's business, not the list's: a bar that
 * vanishes when the last droplet goes leaves the button looking broken. With it
 * on and nothing kept, it says so instead.
 */
function renderDroplets() {
  const list = state.droplets || [];
  el.dropletBar.hidden = state.showDroplets === false;
  if (el.dropletBar.hidden) {
    el.dropletBar.replaceChildren();
    return;
  }

  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'droplet-empty';
    empty.textContent = 'No droplets yet - Ctrl+D keeps a page here.';
    el.dropletBar.replaceChildren(empty);
    return;
  }

  const nodes = list.slice(0, 24).map((droplet) => {
    const button = document.createElement('button');
    button.className = 'droplet-pill';
    button.title = `${droplet.title}\n${droplet.url}`;

    const label = document.createElement('span');
    label.textContent = droplet.title || droplet.url;
    button.appendChild(label);

    button.addEventListener('click', () => api.nav.go(droplet.url));

    // The menu is drawn by the browser, in a view of its own: this row sits
    // under the page, so anything drawn here would be cut off by it.
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      api.droplets.menu(droplet.id, Math.round(event.clientX), Math.round(event.clientY));
    });
    return button;
  });

  el.dropletBar.replaceChildren(...nodes);
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
window.addEventListener('resize', () => {
  reportContentBounds();
  if (!el.thought.hidden) sendPreview(lastPreviewKey);
});

// ---------------------------------------------------------------- selection

/**
 * Ctrl-click gathers clouds; the merge button only exists while at least two
 * are gathered, so it never sits there greyed out.
 */
strip.onSelectionChange = (ids) => {
  const enough = ids.length >= 2;
  el.mergeClouds.hidden = !enough;
  if (enough) {
    el.mergeLabel.textContent = `Merge ${ids.length} clouds`;
    el.mergeClouds.title = `Show these ${ids.length} pages side by side`;
  }
  reportContentBounds();
};

el.splitClouds.addEventListener('click', () => {
  const tab = activeTab();
  if (tab && (tab.panes || 1) > 1) api.tabs.split(tab.id);
});

el.mergeClouds.addEventListener('click', () => {
  const ids = [...strip.selected];
  if (ids.length < 2) return;
  api.tabs.merge(ids);
  strip.clearSelection();
});

// Escape drops a selection, the same way it closes everything else here.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && strip.selected.size) strip.clearSelection();
});

// ---------------------------------------------------------------- sidebar

function applySidebarWidth(width, { persist = true } = {}) {
  const clamped = Math.round(Math.max(SIDEBAR_COLLAPSED, Math.min(SIDEBAR_MAX, width)));
  const collapsed = clamped < SIDEBAR_MIN;
  const applied = collapsed ? SIDEBAR_COLLAPSED : clamped;
  el.sidebar.style.width = `${applied}px`;
  document.documentElement.style.setProperty('--sidebar-w', `${applied}px`);
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

// ---------------------------------------------------------------- thought bubble

/**
 * While the address bar has content, a thought bubble hangs off it showing the
 * page that pressing Enter would open - rendered live, not described.
 *
 * The bubble itself is only a frame: its screen area is reported to the main
 * process, which parks a real view over that rect. Same trick as the page
 * stage, so both stay in step when the window or sidebar moves.
 */
let lastPreviewKey = '';
let previewTimer = null;

/**
 * How long typing must settle before the page itself is fetched.
 *
 * The destination updates on every character, but attaching and loading the
 * preview view moves native focus away from the address bar, and doing that
 * mid-word costs keystrokes. Coalescing the loads keeps the field stable while
 * still showing the real page.
 */
const PREVIEW_SETTLE_MS = 650;

function normalizedInput(value) {
  // Spaces alone never trigger a reload, per the "excluding spaces" rule.
  return value.replace(/\s+/g, ' ').trim();
}

function updateThought() {
  const key = normalizedInput(el.address.value);

  // Only an empty field closes the bubble. Focus can bounce to the preview for
  // a frame as it attaches; that is not the user leaving.
  if (!key) return hideThought();

  el.thought.hidden = false;
  lastPreviewKey = key;

  // Instant, costs nothing: say where Enter would go.
  api.preview
    .resolve(key)
    .then((url) => {
      if (el.thought.hidden || normalizedInput(el.address.value) !== key) return;
      el.thoughtLabel.textContent = url || key;
      el.thoughtUrl.textContent = url || key;
    })
    .catch(() => {});

  // Deferred: fetch the page once the typing settles.
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!el.thought.hidden) sendPreview(lastPreviewKey);
  }, PREVIEW_SETTLE_MS);
}

/**
 * Report both rects: where the live view goes, and where the card around it
 * goes. The card has to be drawn as a view of its own - this renderer sits
 * below the page, so the frame it draws here is hidden the moment a tab is
 * open. What is measured here is what gets painted up there.
 */
function sendPreview(key) {
  const rect = el.thoughtScreen.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const card = el.thoughtBubble.getBoundingClientRect();
  api.preview.show(
    key,
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight },
    { x: card.x, y: card.y, width: card.width, height: card.height }
  );
}

// getBoundingClientRect reports the *transformed* box, so a rect measured
// during the entrance animation is scaled down. Re-send once it settles.
el.thought.addEventListener('animationend', () => {
  if (!el.thought.hidden && lastPreviewKey) sendPreview(lastPreviewKey);
});

function hideThought({ notifyMain = true } = {}) {
  clearTimeout(previewTimer);
  if (el.thought.hidden) return;
  el.thought.hidden = true;
  lastPreviewKey = '';
  if (notifyMain) api.preview.hide();
}

// ---------------------------------------------------------------- omnibox

el.omnibox.addEventListener('click', (event) => {
  if (!el.sidebar.classList.contains('collapsed')) return;
  event.preventDefault();
  applySidebarWidth(SIDEBAR_DEFAULT);
  el.address.focus();
});

// Attaching the preview view moves native focus, which fires a blur here even
// though the user never left the field. Give the blur a grace period: if focus
// comes straight back, it was the preview, not the user.
let blurTimer = null;

el.address.addEventListener('focus', () => {
  clearTimeout(blurTimer);
  el.omnibox.classList.add('focused');
  // Edit the real address, not the trimmed one on display.
  if (!state.showFullUrl && !omniDirty) {
    const tab = activeTab();
    if (tab?.url && tab.url !== 'stratus://newtab') el.address.value = tab.url;
  }
  // Select-all belongs to the user's first focus only. The preview bounces
  // focus back here as it attaches, and re-selecting then means the next
  // keystroke replaces everything already typed.
  if (!omniDirty) requestAnimationFrame(() => el.address.select());
});

el.address.addEventListener('blur', () => {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => {
    // Focus can leave and come straight back when the preview appears, and the
    // return does not always fire a focus event. Ask where focus actually is
    // rather than trusting that it left.
    if (document.activeElement === el.address) return;
    el.omnibox.classList.remove('focused');
    hideThought();
    // Only restore the tab's URL if nothing was typed. Wiping a half-typed
    // address because focus moved is how this used to eat input.
    if (!omniDirty) el.address.value = displayUrl(activeTab());
  }, 400);
});

el.address.addEventListener('input', () => {
  omniDirty = true;
  updateThought();
});

el.address.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const value = el.address.value.trim();
    if (!value) return;
    omniDirty = false;
    clearTimeout(blurTimer);
    hideThought();
    api.nav.go(value);
    el.address.blur();
  } else if (e.key === 'Escape') {
    omniDirty = false;
    clearTimeout(blurTimer);
    hideThought();
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
el.droplet.addEventListener('click', () => api.droplets.toggle());
el.dropletBarToggle.addEventListener('click', () => {
  api.droplets.showBar(state.showDroplets === false);
});
el.findOpen.addEventListener('click', () => openFind());
el.settings.addEventListener('click', () => api.tabs.create('stratus://settings'));
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
  // Collapsed, the input is display:none - focusing it would swallow the
  // keystrokes. Open the sidebar first.
  if (el.sidebar.classList.contains('collapsed')) applySidebarWidth(SIDEBAR_DEFAULT);
  el.address.focus();
  el.address.select();
});
api.on.openFind(openFind);
api.on.savePassword(showSavePassword);
// The preview is growing into the page area; the frame would only be in its
// way. Main owns the view from here, so do not ask it to hide anything.
api.on.previewExpanding(() => {
  clearTimeout(blurTimer);
  omniDirty = false;
  hideThought({ notifyMain: false });
  el.address.blur();
});

api.on.fullScreen((on) => {
  // The page view already covers the window in full screen; hiding the chrome
  // stops it painting underneath and keeps the transition clean.
  document.body.classList.toggle('full-screen', Boolean(on));
});

// Said just before the state that drops them: these clouds are joining that
// one, so the strip moves them into it rather than closing them.
// ------------------------------------------------------- buttons from plugins

/**
 * Buttons a plugin has asked for, put in the toolbar beside the browser's own.
 *
 * A plugin describes its icon rather than drawing it - outlines and circles -
 * so nothing it says is ever treated as markup. It names a button to sit behind
 * rather than a position, so the toolbar can change without breaking it.
 */
let toolbarSignature = '';

function renderPluginButtons(state) {
  const buttons = state.pluginToolbar || [];
  // Rebuilt only when the set actually changes: this runs on every broadcast.
  const signature = JSON.stringify(buttons);
  if (signature === toolbarSignature) return;
  toolbarSignature = signature;

  for (const old of document.querySelectorAll('.tool-btn.from-plugin')) old.remove();

  for (const button of buttons) {
    const anchor = document.getElementById(button.after);
    if (!anchor || !anchor.parentNode) continue;

    const el = document.createElement('button');
    el.className = 'tool-btn from-plugin';
    el.type = 'button';
    el.dataset.plugin = button.id;
    el.title = button.label;
    el.setAttribute('aria-label', button.label);
    el.appendChild(pluginIcon(button.icon));
    el.addEventListener('click', () => api.tabs.create(button.opens));

    anchor.parentNode.insertBefore(el, anchor.nextSibling);
  }
}

function pluginIcon(icon = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');

  for (const d of icon.paths || []) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  for (const [cx, cy, r] of icon.circles || []) {
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    svg.appendChild(circle);
  }

  return svg;
}

// ---------------------------------------------------------------- pane seams

/**
 * A grip on each seam between merged panes, dragged to trade width between
 * them. The browser reports where the seams are, since it is the one that
 * placed the views; dragging one moves the views straight away and only tells
 * the strip about it when the pointer is let go.
 */
const PANE_GAP = 8;
let dragging = null;

function renderGrips(state) {
  const gutters = dragging ? [] : state.gutters || [];
  const active = state.tabs.find((t) => t.id === state.activeId);
  const sizes = active && active.paneSizes;

  if (dragging || !gutters.length || !sizes) {
    if (!dragging) el.paneGrips.replaceChildren();
    return;
  }

  el.paneGrips.replaceChildren();
  gutters.forEach((rect, index) => {
    const grip = document.createElement('div');
    grip.className = 'pane-grip';
    grip.style.left = `${rect.x}px`;
    grip.style.top = `${rect.y}px`;
    grip.style.width = `${rect.width}px`;
    grip.style.height = `${rect.height}px`;
    grip.addEventListener('pointerdown', (event) => startDrag(event, grip, index, state));
    el.paneGrips.appendChild(grip);
  });
}

function startDrag(event, grip, index, state) {
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (!active || !active.paneSizes) return;

  event.preventDefault();
  try {
    grip.setPointerCapture(event.pointerId);
  } catch {
    // No capture available - the drag still works, it just stops at the edges
    // of the window rather than following the pointer outside it.
  }
  grip.classList.add('dragging');
  document.body.classList.add('resizing-panes');

  const stage = el.stage.getBoundingClientRect();
  dragging = {
    id: active.id,
    index,
    grip,
    startX: event.clientX,
    from: active.paneSizes.slice(),
    // Fractions are of the width the panes actually share, not of the stage.
    usable: Math.max(1, stage.width - PANE_GAP * (active.paneSizes.length - 1))
  };
}

function moveDrag(event) {
  if (!dragging) return;
  const { from, index, usable } = dragging;

  // The two panes either side of this seam trade; the rest are untouched.
  const min = Math.min(0.12, 1 / (from.length * 2));
  const room = from[index] + from[index + 1];
  let shift = (event.clientX - dragging.startX) / usable;
  shift = Math.max(min - from[index], Math.min(from[index + 1] - min, shift));

  const next = from.slice();
  next[index] = from[index] + shift;
  next[index + 1] = room - next[index];

  dragging.last = next;
  dragging.grip.style.left = `${el.stage.getBoundingClientRect().left +
    next.slice(0, index + 1).reduce((a, b) => a + b, 0) * usable + index * PANE_GAP}px`;

  // A pointer can report more often than the screen draws, and each of these
  // resizes three live pages. One per frame is as much as is worth sending.
  if (dragging.queued) return;
  dragging.queued = requestAnimationFrame(() => {
    if (!dragging) return;
    dragging.queued = 0;
    api.tabs.paneSizes(dragging.id, dragging.last);
  });
}

function endDrag() {
  if (!dragging) return;
  if (dragging.queued) cancelAnimationFrame(dragging.queued);
  if (dragging.last) api.tabs.paneSizes(dragging.id, dragging.last);
  dragging.grip.classList.remove('dragging');
  document.body.classList.remove('resizing-panes');
  dragging = null;
  // Take the browser's word for where the seams ended up.
  api.getState().then(render).catch(() => {});
}

window.addEventListener('pointermove', moveDrag);
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

api.on.merged(({ host, ids }) => {
  strip.expectMerge(host, ids || []);
});

api.on.previewTarget(({ url, live }) => {
  el.thoughtLabel.textContent = url;
  el.thoughtUrl.textContent = url;
  // Without a rendered page the bubble has nothing to fill 300px with.
  el.thought.classList.toggle('compact', !live);
});
api.on.findResult(({ matches, current }) => {
  el.findCount.textContent = `${matches ? current : 0}/${matches || 0}`;
});

api.getState().then(render).catch(() => {
  /* the first broadcast will fill us in */
});

/* ============================================================
   Flights
   ============================================================ */

/**
 * What the plane on the toolbar says.
 *
 * A number, and nothing that moves. There was a meteor for each file crossing
 * the sky here; it was taken out again because a thing flying about the window
 * while you are trying to read a page is a distraction, however pretty. The
 * count and the panel say everything the meteor did, and only when looked at.
 */
function renderFlights(state) {
  const flights = (state && state.flights) || [];
  const inTheAir = flights.filter((f) => f.state === 'flying' || f.state === 'held');

  el.flightCount.hidden = inTheAir.length === 0;
  el.flightCount.textContent = String(inTheAir.length);
  el.flights.title = inTheAir.length
    ? `${inTheAir.length} in the air (Ctrl+J)`
    : 'Flights (Ctrl+J)';
}

/**
 * The panel, hanging from the plane. A view of its own; see the shell.
 *
 * Pressing the button while the panel is up means put it away. Left to timing
 * it does not read that way: the press takes the keyboard off the panel, which
 * closes it, and then opens it again - a flicker rather than a toggle. So the
 * browser says whether the panel is up and the button acts on that.
 */
let panelUp = false;
api.on.flightsPanelOpen(() => { panelUp = true; });
api.on.flightsPanelClosed(() => { panelUp = false; });

function openFlights() {
  if (panelUp) {
    api.flights.panelClose();
    return;
  }
  const box = el.flights.getBoundingClientRect();
  api.flights.panel(Math.round(box.left), Math.round(box.bottom + 6));
}

el.flights.addEventListener('click', openFlights);
api.on.flights((state) => renderFlights(state));
