'use strict';

/**
 * Day sky.
 *
 * The daytime counterpart to the stars: a few birds crossing slowly, high up
 * and far off, each on its own course and its own clock. Present only by day -
 * at night the field is transparent and every bird is paused, which costs
 * nothing and lets the theme be switched back and forth without rebuilding
 * anything.
 *
 * Deliberately sparse and deliberately slow. A bird takes the better part of a
 * minute to cross, so the sky reads as moving rather than as animated.
 *
 * Like the stars, this is for the browser's own pages - the sky the chrome
 * shows around them is left plain. It carries its own stylesheet rather than
 * asking each page to keep a copy in step.
 */

(function () {
  const STYLE_ID = 'sky-birds-style';

  const CSS = `
    .bird-field {
      position: fixed;
      inset: 0;
      pointer-events: none;
      /* Above the sky the body paints, behind everything drawn on it. */
      z-index: -1;
      opacity: 0;
      transition: opacity 600ms ease;
    }

    [data-theme="day"] .bird-field { opacity: 1; }

    /* Three parts, because each animates a different thing and they would
       otherwise be fighting over one transform: the crossing, the rise and
       fall on the way, and the wings. */
    .bird {
      position: absolute;
      top: var(--y);
      left: 0;
      width: var(--size);
      color: var(--bird-ink, rgba(58, 92, 133, 0.5));
      animation: bird-cross var(--dur) linear var(--delay) infinite;
      animation-play-state: paused;
    }

    .bird-bob {
      display: block;
      animation: bird-bob var(--bob) ease-in-out infinite alternate;
      animation-play-state: paused;
    }

    .bird svg {
      display: block;
      width: 100%;
      height: auto;
      animation: bird-flap var(--flap) ease-in-out infinite alternate;
      animation-play-state: paused;
    }

    [data-theme="day"] .bird,
    [data-theme="day"] .bird-bob,
    [data-theme="day"] .bird svg { animation-play-state: running; }

    @keyframes bird-cross {
      from { transform: translateX(-14vw); }
      to { transform: translateX(114vw); }
    }

    @keyframes bird-bob {
      from { transform: translateY(-7px); }
      to { transform: translateY(7px); }
    }

    /* Wings up, wings down. At this size the whole bird squashing and
       stretching reads as a wingbeat. */
    @keyframes bird-flap {
      from { transform: scaleY(0.72); }
      to { transform: scaleY(1.18); }
    }

    /* Still a sky with birds in it, just one that holds still. */
    @media (prefers-reduced-motion: reduce) {
      .bird, .bird-bob, .bird svg { animation: none; }
      .bird { transform: translateX(var(--rest)); }
    }
  `;

  // The far-off bird: two shallow arcs, and nothing else. Anything more
  // detailed stops reading as distance.
  const GLYPH =
    '<svg viewBox="0 0 28 9" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M1 6.5c3.4 0 5-5 6.5-5s3.1 5 6.5 5"/>' +
    '<path d="M14 6.5c3.4 0 5-5 6.5-5s3.1 5 6.5 5"/></svg>';

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  /**
   * Hang a few birds on `host`, replacing any it already has.
   *
   * Heights are percentages, so they keep their place in the sky when the
   * window changes shape, and they are kept to the upper part of it: birds
   * belong above the horizon, not among whatever the page has at its foot.
   */
  function flock(host, options = {}) {
    const doc = host.ownerDocument;
    ensureStyle(doc);

    host.querySelector(':scope > .bird-field')?.remove();

    const width = host.clientWidth || 1200;
    const count = options.count ?? Math.round(Math.min(6, Math.max(3, width / 380)));

    const field = doc.createElement('div');
    field.className = 'bird-field';
    field.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < count; i++) {
      const bird = doc.createElement('span');
      bird.className = 'bird';

      const bob = doc.createElement('span');
      bob.className = 'bird-bob';
      bob.innerHTML = GLYPH;
      bird.appendChild(bob);

      // Spread down the upper half, never two at the same height.
      const lane = (i + 0.35 + Math.random() * 0.3) / count;
      const size = 13 + Math.random() * 9;

      bird.style.setProperty('--y', `${(6 + lane * 46).toFixed(1)}%`);
      bird.style.setProperty('--size', `${size.toFixed(1)}px`);
      // Smaller birds are further off, so they cross more slowly.
      bird.style.setProperty('--dur', `${(96 - size * 1.8 + Math.random() * 20).toFixed(1)}s`);
      bird.style.setProperty('--delay', `-${(Math.random() * 90).toFixed(1)}s`);
      bird.style.setProperty('--bob', `${(5 + Math.random() * 4).toFixed(1)}s`);
      bird.style.setProperty('--flap', `${(0.55 + Math.random() * 0.5).toFixed(2)}s`);
      // Where it sits when nothing is allowed to move.
      bird.style.setProperty('--rest', `${(12 + Math.random() * 70).toFixed(0)}vw`);

      field.appendChild(bird);
    }

    host.appendChild(field);
    return field;
  }

  window.Sky = Object.assign(window.Sky || {}, { flock });

  // Including the script is the whole of the setup.
  const start = () => flock(document.body);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
