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
const NARROW_WIDTH = 108;

const { buildLobes, RAIN_CLOUD } = window.CloudShape;

const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_AUDIO =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6.5 9H4v6h2.5L11 19z"/><path d="M15 9.5a3.5 3.5 0 0 1 0 5"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5L6.5 9H4v6h2.5L11 19z"/><path d="M16 10l4 4M20 10l-4 4"/></svg>';
// Nothing to show for this page: same raining cloud as everywhere else.
const ICON_PAGE = RAIN_CLOUD;

/**
 * The browser's own pages have no favicon to fetch, and a blank sheet of paper
 * makes a new tab look half-loaded. Give each one its own mark.
 */
const INTERNAL_ICONS = {
  'stratus://newtab':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M6.5 18h11a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.6 8.6 4.2 4.2 0 0 0 6.5 18Z"/></svg>',
  'stratus://settings':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l1.7-1.3-1.9-3.3-2 .8a7.8 7.8 0 0 0-2.6-1.5L14.3 3H10.5l-.3 2.2a7.8 7.8 0 0 0-2.6 1.5l-2-.8L3.7 9.2l1.7 1.3a7.7 7.7 0 0 0 0 3l-1.7 1.3 1.9 3.3 2-.8a7.8 7.8 0 0 0 2.6 1.5l.3 2.2h3.8l.3-2.2a7.8 7.8 0 0 0 2.6-1.5l2 .8 1.9-3.3z"/></svg>',
  'stratus://history':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 1.8"/></svg>',
  'stratus://bookmarks':
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5l2.2 4.6 5 .7-3.6 3.5.85 5-4.45-2.35L7.55 18.3l.85-5L4.8 9.8l5-.7z"/></svg>'
};

class CloudTabStrip {
  constructor(root, api) {
    this.root = root;
    this.api = api;
    this.nodes = new Map();
    this.drag = null;
    this.lastWidth = 0;
    /** Ctrl-clicked clouds, waiting to be merged. */
    this.selected = new Set();
    this.onSelectionChange = null;

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

    let dropped = false;
    for (const id of [...this.selected]) {
      if (!seen.has(id)) {
        this.selected.delete(id);
        dropped = true;
      }
    }
    if (dropped) this.onSelectionChange?.([...this.selected]);

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
    for (const [id, node] of this.nodes) buildLobes(node.el, id, this._lobeOptions(width));
  }

  _lobeOptions(width) {
    return { width, base: TAB_HEIGHT, spacing: LOBE_SPACING, maxLobes: 3 };
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
    buildLobes(el, tab.id, this._lobeOptions(this.lastWidth || this.root.clientWidth || 190));

    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close') || e.target.closest('.tab-audio')) return;
      // Ctrl-click gathers clouds instead of switching to one.
      if (e.ctrlKey || e.metaKey) {
        this.toggleSelected(tab.id);
        return;
      }
      if (this.selected.size) this.clearSelection();
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

  // --- selection -----------------------------------------------------------

  toggleSelected(id) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this._paintSelection();
  }

  clearSelection() {
    if (!this.selected.size) return;
    this.selected.clear();
    this._paintSelection();
  }

  _paintSelection() {
    for (const [id, node] of this.nodes) {
      node.el.classList.toggle('selected', this.selected.has(id));
    }
    this.onSelectionChange?.([...this.selected]);
  }

  _update(node, tab, isActive) {
    const { el, icon, title, audio } = node;

    el.classList.toggle('selected', this.selected.has(tab.id));
    el.classList.toggle('merged', (tab.panes || 1) > 1);
    el.classList.toggle('active', isActive);
    el.setAttribute('aria-selected', String(isActive));
    el.title = tab.title ? `${tab.title}\n${tab.url}` : tab.url;

    const panes = tab.panes || 1;
    const label = panes > 1
      ? `${tab.title || 'Page'} + ${panes - 1}`
      : tab.title || tab.url || 'New Tab';
    if (title.textContent !== label) title.textContent = label;
    if (panes > 1 && tab.paneTitles?.length) {
      el.title = [tab.title, ...tab.paneTitles].filter(Boolean).join(String.fromCharCode(10));
    }

    if (tab.loading) {
      if (icon.className !== 'tab-spinner') {
        icon.className = 'tab-spinner';
        icon.innerHTML = '';
        delete icon.dataset.src;
      }
    } else {
      icon.className = 'tab-favicon';
      const internal = INTERNAL_ICONS[tab.url];
      const key = internal ? tab.url : tab.favicon || 'page';
      if (icon.dataset.src !== key) {
        if (internal) {
          icon.innerHTML = internal;
        } else if (tab.favicon) {
          icon.innerHTML = `<img src="${encodeURI(tab.favicon)}" alt="" />`;
          // A favicon that 404s or is an unreadable format leaves an empty
          // box; fall back to the raining cloud when the load fails.
          const img = icon.querySelector('img');
          img.addEventListener('error', () => {
            icon.innerHTML = ICON_PAGE;
            icon.classList.add('is-rain');
          }, { once: true });
        } else {
          icon.innerHTML = ICON_PAGE;
        }
        icon.classList.toggle('is-rain', !internal && !tab.favicon);
        icon.dataset.src = key;
      }
      icon.classList.toggle('is-internal', Boolean(internal));
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
