'use strict';

const bridge = window.cloudPage;

const QUICK_LINKS = [
  { label: 'Google', url: 'https://www.google.com', color: '#4285f4' },
  { label: 'GitHub', url: 'https://github.com', color: '#24292f' },
  { label: 'YouTube', url: 'https://www.youtube.com', color: '#ff0033' },
  { label: 'Wikipedia', url: 'https://www.wikipedia.org', color: '#5a6570' },
  { label: 'MDN', url: 'https://developer.mozilla.org', color: '#1d6fe0' },
  { label: 'Hacker News', url: 'https://news.ycombinator.com', color: '#ff6600' }
];

function go(url) {
  if (bridge) bridge.navigate(url);
  else window.location.href = url;
}

document.getElementById('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = document.getElementById('q').value.trim();
  if (value) go(value);
});

const linksRoot = document.getElementById('links');
const cards = [];

for (const link of QUICK_LINKS) {
  const node = document.createElement('button');
  node.className = 'link';
  node.type = 'button';

  const badge = document.createElement('span');
  badge.className = 'link-badge';
  badge.style.background = link.color;
  badge.textContent = link.label[0];

  const label = document.createElement('span');
  label.textContent = link.label;

  node.append(badge, label);
  node.addEventListener('click', () => go(link.url));
  linksRoot.appendChild(node);
  cards.push({ node, seed: link.label });
}

/**
 * Give every card its cloud, using the same generator as the tab strip. The
 * lobes are allowed to overhang the sides a little, which is what stops a grid
 * of them looking like a row of identical boxes.
 */
function shapeCards() {
  for (const { node, seed } of cards) {
    window.CloudShape.buildLobes(node, seed, {
      width: node.offsetWidth,
      base: 26,
      spacing: 64,
      maxLobes: 3,
      overhang: 0.1,
      className: 'link-lobe'
    });
  }
}

shapeCards();
// The grid reflows with the window, and the lobe count follows the card width.
window.addEventListener('resize', shapeCards);

async function hydrate() {
  if (!bridge) return;

  try {
    const state = await bridge.getState();
    document.documentElement.dataset.theme = state.theme || 'day';
  } catch {
    /* theme is cosmetic - fall back to day */
  }

  try {
    const history = await bridge.history.list(40);
    const seen = new Set();
    const recent = [];
    for (const entry of history) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      recent.push(entry);
      if (recent.length === 8) break;
    }
    if (!recent.length) return;

    const chips = document.getElementById('chips');
    for (const entry of recent) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.textContent = entry.title || entry.url;
      chip.title = entry.url;
      chip.addEventListener('click', () => go(entry.url));
      chips.appendChild(chip);
    }
    document.getElementById('recent').hidden = false;
  } catch {
    /* an empty history simply means no chips */
  }
}

hydrate();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  document.documentElement.dataset.theme = theme;
});
