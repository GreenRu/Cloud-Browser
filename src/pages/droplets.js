'use strict';

const bridge = window.cloudPage;
const listRoot = document.getElementById('list');
const countLabel = document.getElementById('count');
const filterInput = document.getElementById('filter');

let droplets = [];

function render() {
  const query = filterInput.value.trim().toLowerCase();
  const visible = query
    ? droplets.filter(
        (d) =>
          (d.title || '').toLowerCase().includes(query) || (d.url || '').toLowerCase().includes(query)
      )
    : droplets;

  countLabel.textContent = visible.length
    ? `${visible.length} droplet${visible.length === 1 ? '' : 's'}`
    : 'Nothing kept yet';

  listRoot.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query
      ? 'No droplets match that search.'
      : 'Press Ctrl+D on any page to keep it here.';
    listRoot.appendChild(empty);
    return;
  }

  for (const droplet of visible) {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = droplet.url;

    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = droplet.title || droplet.url;

    const url = document.createElement('span');
    url.className = 'row-url';
    url.textContent = droplet.url;

    const remove = document.createElement('button');
    remove.className = 'row-remove';
    remove.textContent = '×';
    remove.title = 'Delete droplet';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      bridge?.droplets.remove(droplet.id);
      droplets = droplets.filter((d) => d.id !== droplet.id);
      render();
    });

    row.append(title, url, remove);
    row.addEventListener('click', () => bridge?.navigate(droplet.url));
    listRoot.appendChild(row);
  }
}

filterInput.addEventListener('input', render);

async function load() {
  if (!bridge) return;
  const state = await bridge.getState();
  window.SkyTheme.apply({ base: state.themeBase, variables: state.pageThemeVars });
  droplets = state.droplets || [];
  render();
}

load();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  window.SkyTheme.apply(theme);
});
