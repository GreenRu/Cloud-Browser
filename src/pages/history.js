'use strict';

const bridge = window.cloudPage;
const groupsRoot = document.getElementById('groups');
const countLabel = document.getElementById('count');
const filterInput = document.getElementById('filter');

let entries = [];

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric'
});
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function dayLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return dayFormatter.format(date);
}

function render() {
  const query = filterInput.value.trim().toLowerCase();
  const visible = query
    ? entries.filter(
        (e) =>
          (e.title || '').toLowerCase().includes(query) || (e.url || '').toLowerCase().includes(query)
      )
    : entries;

  countLabel.textContent = visible.length
    ? `${visible.length} page${visible.length === 1 ? '' : 's'}`
    : 'Nothing here yet';

  groupsRoot.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'card empty';
    empty.textContent = query ? 'No pages match that search.' : 'Pages you visit will show up here.';
    groupsRoot.appendChild(empty);
    return;
  }

  let currentLabel = null;
  let card = null;

  for (const entry of visible) {
    const label = dayLabel(entry.visitedAt);
    if (label !== currentLabel) {
      currentLabel = label;
      const heading = document.createElement('h2');
      heading.className = 'group-label';
      heading.textContent = label;
      groupsRoot.appendChild(heading);
      card = document.createElement('div');
      card.className = 'card';
      groupsRoot.appendChild(card);
    }

    const row = document.createElement('div');
    row.className = 'row';
    row.title = entry.url;

    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = entry.title || entry.url;

    const url = document.createElement('span');
    url.className = 'row-url';
    url.textContent = entry.url;

    const time = document.createElement('span');
    time.className = 'row-meta';
    time.textContent = timeFormatter.format(new Date(entry.visitedAt));

    row.append(title, url, time);
    row.addEventListener('click', () => bridge?.navigate(entry.url));
    card.appendChild(row);
  }
}

filterInput.addEventListener('input', render);

document.getElementById('clear').addEventListener('click', () => {
  bridge?.history.clear();
  entries = [];
  render();
});

async function load() {
  if (!bridge) return;
  try {
    const state = await bridge.getState();
    document.documentElement.dataset.theme = state.theme || 'day';
  } catch {
    /* cosmetic only */
  }
  entries = (await bridge.history.list(1000)) || [];
  render();
}

load();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  document.documentElement.dataset.theme = theme;
});
