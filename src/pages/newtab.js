'use strict';

const bridge = window.cloudPage;

/**
 * Where each cloud hangs, and how far away it is.
 *
 * Positions are hand-placed rather than generated: a grid is exactly what this
 * page is trying not to be, and random scatter collides and clumps. `s` is the
 * distance - smaller and fainter reads as further off.
 */
const QUICK_LINKS = [
  { label: 'Google', url: 'https://www.google.com', x: '4%', y: 18, s: 0.82, o: 0.85 },
  { label: 'GitHub', url: 'https://github.com', x: '38%', y: 96, s: 1, o: 1 },
  { label: 'Wikipedia', url: 'https://www.wikipedia.org', x: '63%', y: 14, s: 0.74, o: 0.78 },
  { label: 'YouTube', url: 'https://www.youtube.com', x: '10%', y: 182, s: 0.93, o: 0.95 },
  { label: 'Hacker News', url: 'https://news.ycombinator.com', x: '56%', y: 152, s: 0.86, o: 0.9 },
  { label: 'MDN', url: 'https://developer.mozilla.org', x: '30%', y: 258, s: 0.7, o: 0.72 }
];

const CLOUD_GLYPH =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" d="M6.5 18h11a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.6 8.6 4.2 4.2 0 0 0 6.5 18Z"/></svg>';

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
  });
  holder.appendChild(img);
  return holder;
}

const field = document.getElementById('sky-field');
const clouds = [];

QUICK_LINKS.forEach((link, index) => {
  const slot = document.createElement('div');
  slot.className = 'slot';
  slot.style.setProperty('--x', link.x);
  slot.style.setProperty('--y', link.y + 'px');
  // Each cloud drifts on its own clock, so the sky never pulses in unison.
  slot.style.setProperty('--dur', 7 + index * 1.7 + 's');
  slot.style.setProperty('--delay', -(index * 2.3) + 's');

  const cloud = document.createElement('button');
  cloud.className = 'drift';
  cloud.type = 'button';
  cloud.style.setProperty('--s', String(link.s));
  cloud.style.setProperty('--o', String(link.o));
  cloud.title = link.url;

  const label = document.createElement('span');
  label.textContent = link.label;

  cloud.append(siteIcon(link.url), label);
  cloud.addEventListener('click', () => go(link.url));

  slot.appendChild(cloud);
  field.appendChild(slot);
  clouds.push({ cloud, seed: link.label });
});

/** Give every cloud its lobes, using the same generator as the tab strip. */
function shapeClouds() {
  for (const { cloud, seed } of clouds) {
    window.CloudShape.buildLobes(cloud, seed, {
      width: cloud.offsetWidth,
      base: 24,
      spacing: 62,
      maxLobes: 3,
      overhang: 0.12,
      className: 'drift-lobe'
    });
  }
}

shapeClouds();
window.addEventListener('resize', shapeClouds);

/* ---------------------------------------------------------------- recent */

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
      if (recent.length === 6) break;
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
    document.getElementById('recent').hidden = false;
  } catch {
    /* an empty history simply means no list */
  }
}

hydrate();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  document.documentElement.dataset.theme = theme;
});
