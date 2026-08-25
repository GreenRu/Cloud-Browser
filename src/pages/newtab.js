
// Every element that named an icon gets one.
window.Icons.paint(document);
'use strict';

const bridge = window.cloudPage;

/**
 * The places a cloud can hang, and how far away it is at each.
 *
 * Hand-placed rather than generated: a grid is exactly what this page is trying
 * not to be, and random scatter collides and clumps. Percentages, so the
 * arrangement survives the window changing shape. `s` is the distance - smaller
 * and fainter reads as further off.
 *
 * Which cloud takes which place is kept in the browser's store, so adding and
 * removing them survives a restart.
 */
const SKY_SLOTS = [
  { x: '1%', y: '2%', s: 0.9, o: 0.9 },
  { x: '64%', y: '0%', s: 0.8, o: 0.8 },
  { x: '8%', y: '27%', s: 0.78, o: 0.8 },
  { x: '38%', y: '31%', s: 1.12, o: 1 },
  { x: '3%', y: '62%', s: 1, o: 0.96 },
  { x: '57%', y: '54%', s: 0.92, o: 0.9 },
  { x: '30%', y: '4%', s: 0.72, o: 0.72 },
  { x: '68%', y: '25%', s: 0.86, o: 0.86 },
  { x: '26%', y: '68%', s: 0.82, o: 0.84 },
  { x: '46%', y: '15%', s: 0.68, o: 0.7 },
  { x: '13%', y: '45%', s: 0.7, o: 0.72 },
  { x: '72%', y: '68%', s: 0.76, o: 0.8 }
];

/** Reserved for the add cloud, so nothing is ever placed on top of it. */
const ADD_SLOT = { x: '44%', y: '76%', s: 0.82, o: 0.7 };

const ICON_ADD = window.Icons.svg('add');

/**
 * Somewhere for the nth cloud to go once the hand-placed slots are used up.
 * Stepped rather than random, so two extra clouds never land on each other.
 */
function slotAt(index) {
  if (index < SKY_SLOTS.length) return SKY_SLOTS[index];
  const n = index - SKY_SLOTS.length;
  return {
    x: `${8 + ((n * 29) % 66)}%`,
    y: `${6 + ((n * 37) % 74)}%`,
    s: 0.7 + ((n * 7) % 3) * 0.1,
    o: 0.74
  };
}

// Nothing hangs below this, so the search bubble always has clear sky to
// appear in. The bubble is drawn above the field, not inside it.

// A site with no reachable icon gets the same raining cloud the rest of the
// browser uses for anything that did not load.
const CLOUD_GLYPH = window.CloudShape.RAIN_CLOUD;

/** Puffy rather than streaky: rounder lobes, and more of them. */
const PUFFY = { widthRatio: [1.2, 2.05], spacing: 44, maxLobes: 4, overhang: 0.14 };

function go(url) {
  if (bridge) bridge.navigate(url);
  else window.location.href = url;
}

/** The site's own icon, falling back to a cloud if it has none to give. */
function siteIcon(url) {
  const holder = document.createElement('span');
  holder.className = 'drift-icon';

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    holder.innerHTML = CLOUD_GLYPH;
    return holder;
  }

  const img = document.createElement('img');
  img.alt = '';
  img.src = origin + '/favicon.ico';
  img.addEventListener('error', () => {
    holder.innerHTML = CLOUD_GLYPH;
    holder.classList.add('is-rain');
  });
  holder.appendChild(img);
  return holder;
}

/* ---------------------------------------------------------------- clouds */

const field = document.getElementById('sky-field');
const askForm = document.getElementById('ask-form');
let clouds = [];
let links = [];

/** One cloud, hung at `place`, drifting on its own clock. */
function hang(place, index, build) {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.style.setProperty('--x', place.x);
  slot.style.setProperty('--y', place.y);
  // Each cloud drifts on its own clock, so the sky never pulses in unison.
  slot.style.setProperty('--dur', 8 + index * 1.9 + 's');
  slot.style.setProperty('--delay', -(index * 2.7) + 's');

  const cloud = document.createElement('button');
  cloud.className = 'drift';
  cloud.type = 'button';
  cloud.style.setProperty('--s', String(place.s));
  cloud.style.setProperty('--o', String(place.o));

  build(cloud);
  slot.appendChild(cloud);
  field.appendChild(slot);
  return cloud;
}

/** Draw the sky from scratch. Cheap - there are only ever a handful. */
function drawSky() {
  field.replaceChildren();
  clouds = [];

  links.forEach((link, index) => {
    const cloud = hang(slotAt(link.slot ?? index), index, (el) => {
      el.title = link.url;
      el.dataset.id = link.id;

      const label = document.createElement('span');
      label.textContent = link.label;
      el.append(siteIcon(link.url), label);

      el.addEventListener('click', () => go(link.url));
      el.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openMenu(event, link);
      });
    });
    clouds.push({ cloud, seed: link.id });
  });

  // Always last, always there: the way to put something new in the sky.
  const add = hang(ADD_SLOT, links.length, (el) => {
    el.classList.add('is-add');
    el.title = 'Add a cloud';

    const icon = document.createElement('span');
    icon.className = 'drift-icon';
    icon.innerHTML = ICON_ADD;

    const label = document.createElement('span');
    label.textContent = 'Add cloud';

    el.append(icon, label);
    el.addEventListener('click', openSheet);
  });
  clouds.push({ cloud: add, seed: 'add-cloud' });

  shapeClouds();
}

/** Give every cloud its lobes, using the same generator as the tab strip. */
function shapeClouds() {
  for (const { cloud, seed } of clouds) {
    window.CloudShape.buildLobes(cloud, seed, {
      ...PUFFY,
      width: cloud.offsetWidth,
      base: 38,
      className: 'drift-lobe'
    });
  }
  window.CloudShape.buildLobes(askForm, 'stratus-search', {
    ...PUFFY,
    width: askForm.offsetWidth,
    base: 34,
    spacing: 130,
    minLobes: 3,
    maxLobes: 5,
    className: 'ask-lobe'
  });
}

window.addEventListener('resize', shapeClouds);

/* ------------------------------------------------------- right-click a cloud */

const menu = document.getElementById('sky-menu');
let menuLink = null;

function openMenu(event, link) {
  menuLink = link;
  menu.hidden = false;

  // Placed at the pointer, then pulled back inside the window if it would hang
  // off an edge.
  const box = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - box.width - 8);
  const y = Math.min(event.clientY, window.innerHeight - box.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}

function closeMenu() {
  menu.hidden = true;
  menuLink = null;
}

document.getElementById('menu-open').addEventListener('click', () => {
  const link = menuLink;
  closeMenu();
  if (link) bridge?.openTab?.(link.url, true);
});

document.getElementById('menu-remove').addEventListener('click', async () => {
  const link = menuLink;
  closeMenu();
  if (!link || !bridge) return;
  links = await bridge.sky.remove(link.id);
  drawSky();
});

// Any click outside it, and any change of window, puts it away again.
window.addEventListener('pointerdown', (event) => {
  if (!menu.hidden && !menu.contains(event.target)) closeMenu();
});
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
// The page itself never shows a menu; only its clouds do.
window.addEventListener('contextmenu', (event) => {
  if (!event.defaultPrevented) closeMenu();
});

/* ------------------------------------------------------------ adding a cloud */

const sheet = document.getElementById('sky-sheet');
const addForm = document.getElementById('sky-add-form');
const addUrl = document.getElementById('add-url');
const addLabel = document.getElementById('add-label');

function openSheet() {
  closeMenu();
  addUrl.value = '';
  addLabel.value = '';
  sheet.hidden = false;
  addUrl.focus();
}

function closeSheet() {
  sheet.hidden = true;
}

document.getElementById('add-cancel').addEventListener('click', closeSheet);
sheet.addEventListener('pointerdown', (event) => {
  if (event.target === sheet) closeSheet();
});

addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = addUrl.value.trim();
  if (!url || !bridge) return closeSheet();

  links = await bridge.sky.add({ url, label: addLabel.value.trim() });
  closeSheet();
  drawSky();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!sheet.hidden) closeSheet();
  else closeMenu();
});

/* ---------------------------------------------------------------- search */

const askInput = document.getElementById('ask');
const askBubble = document.getElementById('ask-bubble');
const askTarget = document.getElementById('ask-target');
const askScreen = document.getElementById('ask-screen');
const askPuffs = [document.getElementById('ask-puff-1'), document.getElementById('ask-puff-2')];

/**
 * How long typing must settle before the page itself is fetched.
 *
 * The destination updates on every character, but attaching and loading the
 * preview moves native focus away from the search bar, and doing that mid-word
 * costs keystrokes. Coalescing the loads keeps the field steady while still
 * showing the real page.
 */
const PREVIEW_SETTLE_MS = 650;

let previewKey = '';
let previewTimer = null;

function setBubble(visible) {
  askBubble.hidden = !visible;
  for (const puff of askPuffs) puff.hidden = !visible;
  if (!visible) {
    clearTimeout(previewTimer);
    previewKey = '';
    bridge?.preview?.hide?.();
  }
}

/**
 * Report the bubble's interior; the browser parks the real view over it.
 *
 * Only ever called from the settle timer, which is longer than the bubble's
 * entrance animation - so the rect is never measured mid-animation, when
 * getBoundingClientRect would report the scaled-down box.
 */
function sendPreview(key) {
  if (!key || askBubble.hidden || !bridge?.preview) return;
  const rect = askScreen.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  bridge.preview.show(
    key,
    { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    { width: window.innerWidth, height: window.innerHeight }
  );
}

/**
 * The bubble above the field shows the page that pressing Enter would open -
 * rendered live, not described. The destination is resolved by the main
 * process so the rules stay in one place; the page itself is fetched only once
 * the typing settles.
 */
async function updateBubble() {
  const text = askInput.value.replace(/\s+/g, ' ').trim();
  if (!text || !bridge) return setBubble(false);

  let url;
  try {
    url = await bridge.resolve(text);
  } catch {
    return setBubble(false);
  }
  if (askInput.value.replace(/\s+/g, ' ').trim() !== text) return;
  if (!url) return setBubble(false);

  askTarget.textContent = url;
  setBubble(true);
  previewKey = text;

  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => sendPreview(previewKey), PREVIEW_SETTLE_MS);
}

askInput.addEventListener('input', updateBubble);
askInput.addEventListener('focus', updateBubble);

// Focus leaves for a moment when the preview attaches, and comes straight
// back. Only a field the user has actually left closes the bubble.
askInput.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement !== askInput) setBubble(false);
  }, 400);
});

askForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = askInput.value.trim();
  setBubble(false);
  if (value) go(value);
});

// Leaving the page must not leave a view of somewhere else behind.
window.addEventListener('pagehide', () => bridge?.preview?.hide?.());

/* ---------------------------------------------------------------- recent */

async function hydrate() {
  // Without the browser behind it the page still draws, just with nothing in
  // the sky but the add cloud.
  if (!bridge) return drawSky();

  try {
    const state = await bridge.getState();
    window.SkyTheme.apply({ base: state.themeBase, variables: state.pageThemeVars });
  } catch {
    /* theme is cosmetic - fall back to day */
  }

  try {
    links = await bridge.sky.list();
  } catch {
    links = [];
  }
  drawSky();

  try {
    const history = await bridge.history.list(40);
    const seen = new Set();
    const recent = [];
    for (const entry of history) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      recent.push(entry);
      if (recent.length === 5) break;
    }
    if (!recent.length) return;

    const list = document.getElementById('recent-list');
    for (const entry of recent) {
      const link = document.createElement('button');
      link.className = 'recent-link';
      link.type = 'button';
      link.textContent = entry.title || entry.url;
      link.title = entry.url;
      link.addEventListener('click', () => go(entry.url));
      list.appendChild(link);
    }
  } catch {
    /* an empty history simply means no list */
  }
}

hydrate();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  window.SkyTheme.apply(theme);
});
