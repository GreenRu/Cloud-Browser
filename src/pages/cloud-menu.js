'use strict';

/*
 * The cloud menu's own page.
 *
 * It is handed a list and draws it. What is on the list, and what any of it
 * means, is the browser's business - this sends back a name and nothing else.
 */

const bridge = window.cloudMenu;
const root = document.getElementById('menu');

bridge?.onMenu?.((menu) => {
  document.documentElement.dataset.theme = menu.base === 'night' ? 'night' : 'day';
  root.replaceChildren();

  for (const item of menu.items || []) {
    if (item.type === 'separator') {
      root.appendChild(document.createElement('hr'));
      continue;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.dataset.action = item.id;
    button.disabled = item.enabled === false;
    if (item.danger) button.classList.add('danger');

    const label = document.createElement('span');
    label.textContent = item.label;
    button.appendChild(label);

    if (item.accelerator) {
      const key = document.createElement('kbd');
      key.textContent = item.accelerator;
      button.appendChild(key);
    }

    button.addEventListener('click', () => bridge.run(item.id));
    root.appendChild(button);
  }

  // The browser cannot know how big this turned out until it is drawn, so it
  // is told - including the room the shadow needs on every side.
  const box = root.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(document.body).paddingLeft) || 0;
  bridge.measured(Math.ceil(box.width + pad * 2), Math.ceil(box.height + pad * 2));

  root.querySelector('button:not(:disabled)')?.focus();
});

// Up and down walk it, the way a menu is expected to.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    bridge?.close?.();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

  event.preventDefault();
  const items = [...root.querySelectorAll('button:not(:disabled)')];
  const at = items.indexOf(document.activeElement);
  const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
  items[(next + items.length) % items.length]?.focus();
});

// A press on the padding around the card is a press outside the menu.
document.addEventListener('pointerdown', (event) => {
  if (!root.contains(event.target)) bridge?.close?.();
});
