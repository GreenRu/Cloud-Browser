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

  // A cloud, like everything else in the strip. Seeded by what the menu is
  // for, so the same thing's menu keeps the same shape each time it opens.
  window.CloudShape.buildLobes(root, `menu-${menu.seed}`, {
    width: root.offsetWidth,
    base: 30,
    spacing: 84,
    minLobes: 2,
    maxLobes: 4,
    overhang: 0,
    widthRatio: [1.5, 2.6]
  });

  // The browser cannot know how big this turned out until it is drawn, so it
  // is told - and where the card sits inside the view, so the pointer lands on
  // the card rather than on the room left for the lobes.
  const style = getComputedStyle(document.body);
  const left = parseFloat(style.paddingLeft) || 0;
  const top = parseFloat(style.paddingTop) || 0;
  const box = root.getBoundingClientRect();

  bridge.measured({
    width: Math.ceil(box.width + left * 2),
    height: Math.ceil(box.height + top + (parseFloat(style.paddingBottom) || 0)),
    offsetX: left,
    offsetY: top
  });

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
