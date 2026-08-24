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

/* How long a closing cloud takes to drift clear and then fade out, and how much
   rain falls from it on the way. Both times are also written into styles.css -
   keep them in step. */
const JOIN = 420;    // a cloud sliding up into the one it has joined
const DRIFT = 620;
const DRIFT_GAP = 14;   // clear air between the new-cloud button and the ghost
const STACK_GAP = 10;   // and between one raining cloud and the next
const FADE = 3000;
const DROPS = 40;
const PUDDLE_H = 22;   // matches .puddle's height in styles.css
const PUDDLE_LIFE = 6800;

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

    this.rain = document.getElementById('rain-layer');
    this.puddleTimer = null;
    /** Clouds about to leave the strip because they are joining another one. */
    this.joining = new Map();
    /** Clouds that have been closed and are raining themselves out. */
    this.ghosts = new Set();

    this.observer = new ResizeObserver(() => {
      this.reflow();
      this._settleGhosts();
    });
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
      // Keep DOM order in step with model order without rebuilding the strip -
      // except while a cloud is being held, when the order on screen is the
      // user's and the browser's copy of it is one step behind.
      if (this.drag && this.drag.active) return;
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

    const leaving = [];
    for (const [id, node] of this.nodes) {
      if (seen.has(id)) continue;
      this.nodes.delete(id);
      leaving.push({ el: node.el, host: this.joining.get(id) });
      this.joining.delete(id);
    }

    // Measure every one of them before any of them is taken out of the flow:
    // pinning the first shifts the rest up, and a cloud measured after that
    // starts its animation from somewhere it was never drawn.
    for (const item of leaving) item.from = item.el.getBoundingClientRect();

    for (const item of leaving) {
      // A cloud that has joined another one goes to it. Only a closed one rains.
      if (item.host !== undefined) this._joinTo(item.el, item.host, item.from);
      else this._dissolve(item.el, item.from);
    }

    this.reflow();
    // The strip has just moved; the rain has to move with it.
    this._settleGhosts();
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
    // A cloud's own menu. The strip is chrome, so the browser can put a real
    // one here; the selection goes with it, because merging is only on offer
    // when more than one cloud is picked.
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onCloudMenu?.(tab.id, event.clientX, event.clientY, [...this.selected]);
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

  // --- merging -----------------------------------------------------------------

  /**
   * Told, just before the strip loses them, that these clouds are joining that
   * one. Without this a merge is indistinguishable from a close, and they would
   * rain themselves out on the way.
   */
  expectMerge(host, ids) {
    for (const id of ids) this.joining.set(id, host);
    // If the state never arrives, do not hold the expectation for ever.
    setTimeout(() => {
      for (const id of ids) this.joining.delete(id);
    }, 2000);
  }

  /**
   * A cloud that has joined another slides up to it and tucks in behind it.
   * Nothing is lost here - it is going somewhere - so it should read as arrival
   * rather than as a disappearance.
   */
  _joinTo(el, hostId, from) {
    const host = this.nodes.get(hostId);
    const to = host ? host.el.getBoundingClientRect() : null;

    if (!from.width || !to) {
      el.remove();
      return;
    }

    el.style.left = `${from.left}px`;
    el.style.top = `${from.top}px`;
    el.style.width = `${from.width}px`;
    el.style.height = `${from.height}px`;
    el.classList.add('joining');

    requestAnimationFrame(() => {
      // Up to where the host sits, and a touch smaller, so it reads as sliding
      // under rather than landing on.
      el.style.transform = `translateY(${Math.round(to.top - from.top)}px) scale(0.94)`;
      el.style.opacity = '0';
    });

    setTimeout(() => el.remove(), JOIN + 120);
  }

  // --- closing ---------------------------------------------------------------

  /**
   * A closing cloud leaves the strip, floats down into the clear sky below the
   * new-cloud button, and rains itself out there: it fades - body, label and
   * close button together - while drops fall straight out of its underside,
   * and if there is room at the foot of the sky they gather into a puddle that
   * dries up again.
   *
   * Deliberately quiet. It should read as the cloud going away, not as an
   * effect demanding to be watched.
   */
  _dissolve(el, cloud) {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (cloud.width === 0 || !this.rain || still) {
      el.remove();
      return;
    }

    // Pin it where it stood before it leaves the flow, so the clouds below
    // close the gap at once rather than waiting out the whole animation.
    el.style.left = `${cloud.left}px`;
    el.style.top = `${cloud.top}px`;
    el.style.width = `${cloud.width}px`;
    el.style.height = `${cloud.height}px`;
    el.classList.add('adrift');
    this.ghosts.add(el);

    // Measured on the next frame, once the strip has closed up: the button will
    // have moved by then, and the ghost should come to rest under where it
    // ends up, not where it was.
    requestAnimationFrame(() => {
      this._settleGhosts();
      setTimeout(() => this._rainOut(el), el.style.transform ? DRIFT : 0);
    });

    setTimeout(() => {
      this.ghosts.delete(el);
      el.remove();
      // The ones queued behind it can close up.
      this._settleGhosts();
    }, DRIFT + FADE + 400);
  }

  /**
   * Put the raining clouds where they belong: in a queue below the new-cloud
   * button, oldest first, each clear of the one before it. Run again whenever
   * anything moves - opening a tab pushes the button down, and closing several
   * in a row would otherwise pile every ghost on the same spot.
   */
  _settleGhosts() {
    const marker = document.querySelector('.new-cloud');
    if (!marker) return;

    const floor = this._skyFloor();
    let y = marker.getBoundingClientRect().bottom + DRIFT_GAP;

    for (const el of this.ghosts) {
      if (!el.isConnected) {
        this.ghosts.delete(el);
        continue;
      }

      const from = parseFloat(el.style.top);
      const height = parseFloat(el.style.height);
      // Below the one before it, but never past the foot of the sky, and never
      // back up above where the cloud actually was.
      const rest = Math.min(y, floor - height);
      const drop = Math.max(0, Math.round(rest - from));

      el.style.transform = drop ? `translateY(${drop}px)` : '';
      y = Math.max(rest, from) + height + STACK_GAP;
    }
  }

  /** Fade out, and rain, from wherever the drift left it. */
  _rainOut(el) {
    if (!el.isConnected) return;
    el.classList.add('leaving');

    const cloud = el.getBoundingClientRect();
    const layer = this.rain.getBoundingClientRect();
    const spot = this._puddleSpot(layer, cloud.bottom);
    this._rain(cloud, layer, spot);
    if (spot) this._puddle(spot);
  }

  /** The line the sky stops at: its own foot, or the footer when one is showing. */
  _skyFloor() {
    const layer = this.rain.getBoundingClientRect();
    const foot = document.querySelector('.sidebar-foot');
    const rect = foot ? foot.getBoundingClientRect() : null;
    return rect && rect.height > 0
      ? Math.min(layer.bottom - 6, rect.top - 4)
      : layer.bottom - 6;
  }

  /**
   * Where a puddle could sit without covering anything, or null when the strip
   * reaches too far down to spare the room.
   */
  _puddleSpot(layer, cloudBottom) {
    const marker = document.querySelector('.new-cloud');
    if (!marker) return null;

    // Water lies along the foot of the sky. It has room when nothing - neither
    // the raining ghost nor the strip below it - reaches that far down.
    const floor = this._skyFloor();
    const lowest = Math.max(cloudBottom, marker.getBoundingClientRect().bottom);
    if (floor - PUDDLE_H - 10 < lowest) return null;

    return { y: floor - PUDDLE_H / 2 - layer.top };
  }

  _rain(cloud, layer, spot) {
    const from = cloud.bottom - layer.top - 4;
    const to = spot ? spot.y : from + 90;
    const left = cloud.left - layer.left + 14;
    const span = Math.max(10, cloud.width - 28);

    for (let i = 0; i < DROPS; i++) {
      const rd = document.createElement('span');
      rd.className = 'raindrop';

      // Straight down, wherever it left the cloud. Rain does not aim.
      rd.style.left = `${left + Math.random() * span}px`;
      rd.style.top = `${from}px`;
      rd.style.setProperty('--dy', `${to - from}px`);

      // Spread over most of the fade, so the cloud is still raining as it goes.
      const delay = Math.random() * (FADE - 1200);
      const fall = 620 + Math.random() * 420;
      rd.style.animationDelay = `${delay}ms`;
      rd.style.animationDuration = `${fall}ms`;

      this.rain.appendChild(rd);
      setTimeout(() => rd.remove(), delay + fall + 60);
    }
  }

  _puddle(spot) {
    let puddle = this.rain.querySelector('.puddle');
    if (!puddle) {
      puddle = document.createElement('span');
      puddle.className = 'puddle';
      this.rain.appendChild(puddle);
    }

    puddle.style.top = `${spot.y}px`;

    // Restart the run so closing several clouds keeps the water gathering
    // rather than leaving a puddle part-way through drying.
    puddle.classList.remove('gather');
    void puddle.offsetWidth;
    puddle.classList.add('gather');

    clearTimeout(this.puddleTimer);
    this.puddleTimer = setTimeout(() => puddle.remove(), PUDDLE_LIFE);
  }

  // --- drag to reorder -----------------------------------------------------

  _onPointerDown(event) {
    if (event.button !== 0) return;
    const el = event.target.closest('.tab');
    if (!el || event.target.closest('.tab-close') || event.target.closest('.tab-audio')) return;

    this.drag = {
      id: el.dataset.id,
      el,
      startY: event.clientY,
      // Where in the cloud it was taken hold of, so it does not jump on lift.
      grabbedAt: event.clientY - el.getBoundingClientRect().top,
      active: false
    };
  }

  /**
   * Pick the cloud up.
   *
   * It comes out of the flow and follows the pointer, and a gap of its own size
   * takes its place in the strip. The gap is a real element, so the clouds
   * around it move by the strip's own layout rather than by anything here
   * having to work out where they should go.
   */
  _liftCloud(event) {
    const drag = this.drag;
    const box = drag.el.getBoundingClientRect();

    const gap = document.createElement('div');
    gap.className = 'tab-gap';
    gap.style.height = `${box.height}px`;
    this.root.insertBefore(gap, drag.el);

    drag.gap = gap;
    drag.width = box.width;
    drag.left = box.left;
    drag.active = true;

    drag.el.classList.add('dragging');
    drag.el.style.width = `${box.width}px`;
    drag.el.style.left = `${box.left}px`;
    drag.el.style.top = `${event.clientY - drag.grabbedAt}px`;
    document.body.classList.add('dragging-cloud');
  }

  _onPointerMove(event) {
    if (!this.drag) return;
    if (!this.drag.active) {
      if (Math.abs(event.clientY - this.drag.startY) < 6) return;
      this._liftCloud(event);
    }

    const drag = this.drag;
    drag.el.style.top = `${event.clientY - drag.grabbedAt}px`;

    // Where it would land: the first cloud whose middle is below the pointer.
    const others = [...this.root.children].filter((el) => el !== drag.el && el !== drag.gap);
    const before = others.find((el) => {
      const box = el.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    });

    if (before) this.root.insertBefore(drag.gap, before);
    else this.root.appendChild(drag.gap);
  }

  _onPointerUp() {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;

    if (!drag.active) return;

    const index = [...this.root.children]
      .filter((el) => el !== drag.el)
      .indexOf(drag.gap);

    // Settle into the gap before letting go of it, so the cloud arrives rather
    // than teleports.
    const landing = drag.gap.getBoundingClientRect();
    drag.el.classList.add('landing');
    drag.el.style.top = `${landing.top}px`;
    drag.el.style.left = `${landing.left}px`;

    const release = () => {
      drag.el.classList.remove('dragging', 'landing');
      drag.el.style.width = '';
      drag.el.style.left = '';
      drag.el.style.top = '';
      drag.gap.remove();
      document.body.classList.remove('dragging-cloud');
      if (index >= 0) this.api.tabs.move(drag.id, index);
    };

    drag.el.addEventListener('transitionend', release, { once: true });
    setTimeout(release, 260);
  }
}

window.CloudTabStrip = CloudTabStrip;
