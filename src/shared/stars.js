'use strict';

/**
 * Night sky.
 *
 * Speckles a field of small dots over whatever page asks for one, each drifting
 * slowly between dim and bright on its own clock so the sky never pulses in
 * time with itself. Present only at night: by day the field is transparent and
 * every star is paused, which costs nothing and means the theme can be switched
 * back and forth without rebuilding anything.
 *
 * The field is placed behind the page's own content and cannot be clicked, so
 * it is safe to hang off the body of any page that shows sky.
 *
 * Only the browser's own pages have one - the sky the chrome shows around them
 * is left plain, so the stars read as part of what you are looking at rather
 * than as a texture over the whole window. Shared by those pages, so it carries
 * its own stylesheet rather than asking each of them to keep a copy in step.
 */

(function () {
  const STYLE_ID = 'sky-stars-style';

  const CSS = `
    .star-field {
      position: fixed;
      inset: 0;
      pointer-events: none;
      /* Above the sky gradient the body paints, behind everything drawn on it -
         a page card or the stage panel should cover the stars, not float in
         front of them. */
      z-index: -1;
      opacity: 0;
      transition: opacity 600ms ease;
    }

    [data-theme="night"] .star-field { opacity: 1; }

    .star {
      position: absolute;
      border-radius: 50%;
      background: #fdfeff;
      opacity: 0.2;
      animation-name: star-twinkle;
      animation-timing-function: ease-in-out;
      animation-iteration-count: infinite;
      animation-direction: alternate;
      animation-play-state: paused;
    }

    [data-theme="night"] .star { animation-play-state: running; }

    @keyframes star-twinkle {
      from { opacity: 0.12; }
      to { opacity: 0.85; }
    }

    /* Still a sky full of stars, just a still one. */
    @media (prefers-reduced-motion: reduce) {
      .star { animation: none; opacity: 0.45; }
    }
  `;

  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  /**
   * Hang a star field on `host`, replacing any it already has.
   *
   * Positions are percentages, so the scatter stretches with the window instead
   * of clumping into one corner when it is resized.
   */
  function speckle(host, options = {}) {
    const doc = host.ownerDocument;
    ensureStyle(doc);

    host.querySelector(':scope > .star-field')?.remove();

    const area = (host.clientWidth || 1200) * (host.clientHeight || 800);
    const count = options.count ?? Math.round(Math.min(170, Math.max(30, area / 7600)));

    const field = doc.createElement('div');
    field.className = 'star-field';
    field.setAttribute('aria-hidden', 'true');

    for (let i = 0; i < count; i++) {
      const star = doc.createElement('span');
      star.className = 'star';

      // A few brighter, larger ones among many faint ones reads as depth; all
      // one size reads as a texture.
      const size = Math.random() < 0.16 ? 1.8 + Math.random() * 1.1 : 0.9 + Math.random();

      star.style.left = `${Math.random() * 100}%`;
      star.style.top = `${Math.random() * 100}%`;
      star.style.width = `${size.toFixed(2)}px`;
      star.style.height = `${size.toFixed(2)}px`;
      // Slow, and no two alike: nothing should blink.
      star.style.animationDuration = `${(3.4 + Math.random() * 5).toFixed(2)}s`;
      star.style.animationDelay = `-${(Math.random() * 8).toFixed(2)}s`;

      field.appendChild(star);
    }

    host.appendChild(field);
    return field;
  }

  window.Sky = { speckle };

  // Including the script is the whole of the setup: any window that shows sky
  // wants the same field, in the same place.
  const start = () => speckle(document.body);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
