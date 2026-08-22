'use strict';

const { ipcRenderer } = require('electron');

/**
 * Preload for the thought bubble's preview only.
 *
 * The preview is a picture of where you are about to go, not somewhere you have
 * gone: it must not respond to the pointer, scroll, select text, or run a link.
 * Every interaction is swallowed in the capture phase, before the page sees it,
 * and a press anywhere opens the page for real instead.
 *
 * Nothing is exposed to the page - there is no contextBridge call here.
 */

const SWALLOWED = [
  'mouseup',
  'dblclick',
  'contextmenu',
  'wheel',
  'touchstart',
  'touchmove',
  'touchend',
  'pointerup',
  'dragstart',
  'keydown',
  'keypress',
  'keyup',
  'submit'
];

function swallow(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

for (const type of SWALLOWED) {
  window.addEventListener(type, swallow, { capture: true, passive: false });
}

/*
 * Pressing anywhere opens the previewed page.
 *
 * This listens on pointerdown, not mousedown, and that detail matters:
 * preventDefault() on a pointerdown suppresses the compatibility mouse events
 * that would otherwise follow, so a swallowed pointerdown means mousedown and
 * click never fire at all. Anything waiting on those would never hear a real
 * press - only synthetic MouseEvents, which skip the pointer path entirely.
 */
let lastPress = 0;

function press(event) {
  swallow(event);
  const now = Date.now();
  // One press, however many event types it produces.
  if (now - lastPress < 400) return;
  lastPress = now;
  ipcRenderer.send('preview:activate');
}

window.addEventListener('pointerdown', press, { capture: true, passive: false });
window.addEventListener('mousedown', press, { capture: true, passive: false });
window.addEventListener('click', swallow, { capture: true, passive: false });

/** Freeze scrolling and selection, and show the whole thing as clickable. */
function lockDown() {
  const style = document.createElement('style');
  style.textContent =
    'html,body{overflow:hidden!important;user-select:none!important;' +
    '-webkit-user-select:none!important;cursor:pointer!important}' +
    '*{cursor:pointer!important}';
  (document.head || document.documentElement).appendChild(style);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', lockDown, { once: true });
} else {
  lockDown();
}
