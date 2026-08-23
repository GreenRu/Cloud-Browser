'use strict';

/**
 * Cloud shapes, shared by the tab strip and the built-in pages.
 *
 * A cloud is a rounded body with a few lobes poking off its top edge. The
 * lobes carry `background: inherit`, so they take the body's fill and the
 * whole thing reads as one silhouette under a single shadow.
 *
 * Shapes are randomised per element, but from a hash of a stable seed rather
 * than Math.random - so every cloud differs from its neighbours while keeping
 * its own shape for life instead of re-rolling on each render.
 *
 * Loaded as a plain script in both the chrome renderer and the file:// pages,
 * so it attaches to `window` rather than using modules.
 */
(function attach(global) {
  function hashString(text) {
    let h = 2166136261;
    for (let i = 0; i < String(text).length; i++) {
      h ^= String(text).charCodeAt(i);
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

  /**
   * Draw lobes onto `element`, replacing any it already has.
   *
   * @param {HTMLElement} element  the cloud body; needs position: relative
   * @param {string}      seed     stable identity, e.g. a tab id or a label
   * @param {object}      options
   *   width     - the body's width in px, which sets how many lobes fit
   *   base      - the tallest a lobe may be, in px
   *   spacing   - px of width expected per lobe
   *   minLobes  - floor on the count, for shapes that must not come out bald
   *   maxLobes  - ceiling on the count
   *   overhang  - fraction of the width lobes may spread past each edge
   *   widthRatio- [min, max] of how much wider than tall a lobe runs. Long and
   *               low reads as a streak of cloud; closer to 1 reads as puffy.
   *   className - class applied to each lobe
   */
  function buildLobes(element, seed, options) {
    const {
      width,
      base = 34,
      spacing = 90,
      minLobes = 1,
      maxLobes = 3,
      overhang = 0,
      widthRatio = [1.9, 3.4],
      className = 'lobe'
    } = options || {};

    for (const old of element.querySelectorAll('.' + className)) old.remove();
    if (!width || width <= 0) return;

    const random = seededRandom(hashString(seed));

    // Width sets the ceiling; each cloud then draws somewhere between one lobe
    // and that many. Sparse is the point - every cloud keeps at least one.
    const ceiling = Math.max(minLobes, Math.min(maxLobes, Math.round(width / spacing)));
    const count = minLobes + Math.floor(random() * (ceiling - minLobes + 1));

    // Where the tallest lobe sits, as a fraction of the width.
    const peak = 0.34 + random() * 0.3;
    const span = 1 + overhang * 2;
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < count; i++) {
      const position = (-overhang + ((i + 0.5) / count) * span) + (random() - 0.5) * (0.5 / count);

      // A steep falloff keeps the silhouette stepped: one lobe towers, the rest
      // stay low. Without it, equal-height lobes merge into a slab.
      const falloff = Math.cos(Math.min(1, Math.abs(position - peak) * 1.35) * (Math.PI / 2)) ** 2.2;
      const height = Math.round(base * (0.3 + 0.62 * falloff) * (0.92 + random() * 0.16));
      const [ratioMin, ratioMax] = widthRatio;
      const lobeWidth = Math.round(height * (ratioMin + random() * (ratioMax - ratioMin)));

      const lobe = document.createElement('span');
      lobe.className = className;
      lobe.style.width = lobeWidth + 'px';
      lobe.style.height = height + 'px';
      lobe.style.left = (position * 100).toFixed(2) + '%';
      // Measured up from the body's top edge, so it works whatever the body's
      // own height happens to be.
      lobe.style.top = '-' + Math.round(height * (0.45 - random() * 0.1)) + 'px';
      fragment.appendChild(lobe);
    }

    element.appendChild(fragment);
  }

  /**
   * The mark for anything that did not load - a favicon that failed, a page
   * that would not open. One grey cloud, raining, used everywhere so the
   * meaning is learned once.
   */
  const RAIN_CLOUD =
    '<svg viewBox="0 0 24 24" aria-hidden="true" class="rain-cloud">' +
    '<path fill="currentColor" d="M7 15h10a3.6 3.6 0 0 0 .5-7.16A5 5 0 0 0 8.1 6.4 3.8 3.8 0 0 0 7 15Z"/>' +
    '<path stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none" ' +
    'd="M8.6 17.6 7.7 20.4M12 17.6l-.9 2.8M15.4 17.6l-.9 2.8"/>' +
    '</svg>';

  global.CloudShape = { hashString, seededRandom, buildLobes, RAIN_CLOUD };
})(typeof window !== 'undefined' ? window : globalThis);
