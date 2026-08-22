'use strict';

/**
 * Vertical cloud tab strip.
 *
 * Each tab is drawn as one cloud built the same way as the app mark: a fully
 * rounded body with a couple of rounded-rectangle lobes stacked over it, one
 * dominant and the rest smaller. The lobes share the body's fill and sit
 * behind it, so the whole tab reads as a single silhouette under one shadow.
 *
 * The shape is randomised per tab, but from a hash of the tab id rather than
 * Math.random - so every cloud differs from its neighbours yet keeps its own
 * shape for life instead of re-rolling on each re-render.
 */

const TAB_HEIGHT = 34;
const LOBE_SPACING = 90; // px of tab width one lobe is expected to cover

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 - a tiny deterministic PRNG, so one seed always yields one cloud. */
function seededRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLobes(tabEl, id, width) {
  for (const old of tabEl.querySelectorAll('.lobe')) old.remove();

  const random = seededRandom(hashString(id));
  // Width sets the ceiling; each cloud then draws somewhere between one lobe
  // and that many. Sparse is the point - every cloud keeps at least one.
  const ceiling = Math.max(1, Math.min(3, Math.round(width / LOBE_SPACING)));
  const count = 1 + Math.floor(random() * ceiling);

  // Where the tallest lobe sits, as a fraction of the tab's width. The app
  // mark puts it right of centre; each cloud wanders a little either side.
  const peak = 0.34 + random() * 0.30;
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const position = (i + 0.5) / count + (random() - 0.5) * (0.5 / count);
    // Falls off with distance from the peak: one dominant lobe, smaller rest.
    // A steep falloff is what keeps the silhouette stepped: one lobe towers,
    // the rest stay low. Without it, equal-height lobes merge into a slab.
    const falloff = Math.cos(Math.min(1, Math.abs(position - peak) * 1.35) * (Math.PI / 2)) ** 2.2;
    const height = Math.round(TAB_HEIGHT * (0.30 + 0.62 * falloff) * (0.92 + random() * 0.16));
    // Long, low lobes are what make this read as a drifting cloud rather than
    // a row of bubbles - so they run well wider than they are tall.
    const lobeWidth = Math.round(height * (1.9 + random() * 1.5));

    const lobe = document.createElement('span');
    lobe.className = 'lobe';
    lobe.style.width = `${lobeWidth}px`;
    lobe.style.height = `${height}px`;
    lobe.style.left = `${(position * 100).toFixed(2)}%`;
    lobe.style.bottom = `${Math.round(TAB_HEIGHT - height * (0.55 + random() * 0.1))}px`;
    fragment.appendChild(lobe);
  }

  tabEl.appendChild(fragment);
}

const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_AUDIO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6.5 9H4v6h2.5L11 19z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6.5 9H4v6h2.5L11 19z"/><path d="M16 10l4 4M20 10l-4 4"/></svg>';
const ICON_PAGE =
  '<svg viewBox="0 0 24 24" aria-hidden="true" style="opacity:.45"><path d="M7 4h7l4 4v12H7z"/><path d="M14 4v4h4"/></svg>';

class CloudTabStrip {
  constructor(root, api) {
    this.root = root;
    this.api = api;
    this.nodes = new Map();
    this.drag = null;
    this.lastWidth = 0;

    window.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', () => this._onPointerUp());

    this.root.addEventListener('pointerdown', (e) => this._onPointerDown(e));

    // Middle-click closes, matching every other browser.
    this.root.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const el = e.target.closest('.tab');
      if (el) this.api.tabs.close(el.dataset.id);
    });

    this.observer = new ResizeObserver(() => this.reflow());
    this.observer.observe(this.root);
  }

  render(tabs, activeId) {
    const seen = new Set();

    tabs.forEach((tab, index) => {
      seen.add(tab.id);
      let node = this.nodes.get(tab.id);
      if (!node) {
        node = this._create(tab);
        this.nodes.set(tab.id, node);
      }
      this._update(node, tab, tab.id === activeId);
      // Keep DOM order in step with model order without rebuilding the strip.
      if (this.root.children[index] !== node.el) {
        this.root.insertBefore(node.el, this.root.children[index] || null);
      }
    });

    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      // Let the cloud deflate before it leaves the DOM.
      this.nodes.delete(id);
      node.el.classList.add('leaving');
      node.el.addEventListener('transitionend', () => node.el.remove(), { once: true });
      setTimeout(() => node.el.remove(), 400);
    }

    this.reflow();
  }

  /** Rebuild lobes when the tab width changed enough to want a different count. */
  reflow(force = false) {
    const width = this.root.clientWidth;
    if (width <= 0) return;
    if (!force && Math.abs(width - this.lastWidth) < LOBE_SPACING / 2) return;
    this.lastWidth = width;
    for (const [id, node] of this.nodes) buildLobes(node.el, id, width);
  }

  _create(tab) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.dataset.id = tab.id;
    el.setAttribute('role', 'tab');

    const icon = document.createElement('span');
    icon.className = 'tab-favicon';

    const title = document.createElement('span');
    title.className = 'tab-title';

    const audio = document.createElement('button');
    audio.className = 'tab-audio';
    audio.hidden = true;

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.innerHTML = ICON_CLOSE;
    close.title = 'Close tab';

    el.append(icon, title, audio, close);
    buildLobes(el, tab.id, this.lastWidth || this.root.clientWidth || 190);

    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close') || e.target.closest('.tab-audio')) return;
      this.api.tabs.activate(tab.id);
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.api.tabs.close(tab.id);
    });
    audio.addEventListener('click', (e) => {
      e.stopPropagation();
      this.api.tabs.setMuted(tab.id, el.dataset.muted !== 'true');
    });

    return { el, icon, title, audio, close };
  }

  _update(node, tab, isActive) {
    const { el, icon, title, audio } = node;

    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', String(isActive));
    el.title = tab.title ? `${tab.title}\n${tab.url}` : tab.url;

    const label = tab.title || tab.url || 'New Tab';
    if (title.textContent !== label) title.textContent = label;

    if (tab.loading) {
      if (icon.className !== 'tab-spinner') {
        icon.className = 'tab-spinner';
        icon.innerHTML = '';
        delete icon.dataset.src;
      }
    } else {
      icon.className = 'tab-favicon';
      const key = tab.favicon || 'page';
      if (icon.dataset.src !== key) {
        icon.innerHTML = tab.favicon
          ? `<img src="${encodeURI(tab.favicon)}" alt="" />`
          : ICON_PAGE;
        icon.dataset.src = key;
      }
    }

    const showAudio = Boolean(tab.audible || tab.muted);
    audio.hidden = !showAudio;
    if (showAudio) {
      audio.innerHTML = tab.muted ? ICON_MUTED : ICON_AUDIO;
      audio.title = tab.muted ? 'Unmute tab' : 'Mute tab';
    }
    el.dataset.muted = String(Boolean(tab.muted));
  }

  // --- drag to reorder -----------------------------------------------------

  _onPointerDown(event) {
    if (event.button !== 0) return;
    const el = event.target.closest('.tab');
    if (!el || event.target.closest('.tab-close') || event.target.closest('.tab-audio')) return;
    this.drag = { id: el.dataset.id, el, startY: event.clientY, active: false };
  }

  _onPointerMove(event) {
    if (!this.drag) return;
    if (!this.drag.active && Math.abs(event.clientY - this.drag.startY) < 6) return;
    this.drag.active = true;
    this.drag.el.style.opacity = '0.7';

    const siblings = [...this.root.children];
    const index = siblings.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });
    this.drag.targetIndex = index === -1 ? siblings.length - 1 : index;
  }

  _onPointerUp() {
    if (!this.drag) return;
    const { id, el, active, targetIndex } = this.drag;
    this.drag = null;
    el.style.opacity = '';
    if (active && Number.isInteger(targetIndex)) this.api.tabs.move(id, targetIndex);
  }
}

window.CloudTabStrip = CloudTabStrip;
