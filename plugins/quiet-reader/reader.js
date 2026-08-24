'use strict';

/*
 * Runs in an isolated world: the DOM is visible, and nothing else is. There is
 * no Node here, no browser bridge, and no access to the page's own JavaScript -
 * so this can only do what it can do through the document.
 *
 * The one channel back from the browser is the `stratus:command` event, which
 * carries the commands this plugin declared in its manifest.
 */

function toggleReading() {
  const root = document.documentElement;
  if (root.hasAttribute('data-stratus-reader')) root.removeAttribute('data-stratus-reader');
  else root.setAttribute('data-stratus-reader', '');
}

window.addEventListener('stratus:command', (event) => {
  const { plugin, command } = event.detail || {};
  if (plugin !== 'quiet-reader') return;
  if (command === 'toggle') toggleReading();
});
