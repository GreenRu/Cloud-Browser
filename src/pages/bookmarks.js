'use strict';

const bridge = window.cloudPage;
const listRoot = document.getElementById('list');
const countLabel = document.getElementById('count');
const filterInput = document.getElementById('filter');

let bookmarks = [];

function render() {
  const query = filterInput.value.trim().toLowerCase();
  const visible = query
    ? bookmarks.filter(
        (b) =>
          (b.title || '').toLowerCase().includes(query) || (b.url || '').toLowerCase().includes(query)
      )
    : bookmarks;

  countLabel.textContent = visible.length
    ? `${visible.length} saved page${visible.length === 1 ? '' : 's'}`
    : 'Nothing saved yet';

  listRoot.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query
      ? 'No bookmarks match that search.'
      : 'Press Ctrl+D on any page to keep it here.';
    listRoot.appendChild(empty);
    return;
  }

  for (const bookmark of visible) {
    const row = document.createElement('div');
    row.className = 'row';
    row.title = bookmark.url;

    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = bookmark.title || bookmark.url;

    const url = document.createElement('span');
    url.className = 'row-url';
    url.textContent = bookmark.url;

    const remove = document.createElement('button');
    remove.className = 'row-remove';
    remove.textContent = '×';
    remove.title = 'Remove bookmark';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      bridge?.bookmarks.remove(bookmark.id);
      bookmarks = bookmarks.filter((b) => b.id !== bookmark.id);
      render();
    });

    row.append(title, url, remove);
    row.addEventListener('click', () => bridge?.navigate(bookmark.url));
    listRoot.appendChild(row);
  }
}

filterInput.addEventListener('input', render);

async function load() {
  if (!bridge) return;
  const state = await bridge.getState();
  document.documentElement.dataset.theme = state.theme || 'day';
  bookmarks = state.bookmarks || [];
  render();
}

load();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  document.documentElement.dataset.theme = theme;
});
