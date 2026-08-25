
// Every element that named an icon gets one.
window.Icons.paint(document);
'use strict';

/**
 * The preview frame's only job: show the address the bubble is pointing at, in
 * the browser's current theme, and pass a press on to the browser so that
 * clicking the frame opens the page just as clicking the view does.
 */

const bridge = window.cloudBubble;
const url = document.getElementById('url');

bridge?.onFrame?.((frame) => {
  document.documentElement.dataset.theme = frame.theme === 'night' ? 'night' : 'day';
  url.textContent = frame.url || '';
});

// A press anywhere on the frame opens it, the same as pressing the view inside.
window.addEventListener('pointerdown', () => bridge?.activate?.(), { capture: true });
