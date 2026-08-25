'use strict';

const bridge = window.cloudPage;
const groupsRoot = document.getElementById('groups');
const countLabel = document.getElementById('count');
const filterInput = document.getElementById('filter');
const rangeSelect = document.getElementById('range');

let entries = [];

const dayFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric'
});
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function startOfDay(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayLabel(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return dayFormatter.format(date);
}

/** The site's own icon, falling back to the browser's raining cloud. */
function siteIcon(url) {
  const holder = document.createElement('span');
  holder.className = 'row-icon';

  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    holder.innerHTML = window.CloudShape.RAIN_CLOUD;
    holder.classList.add('is-rain');
    return holder;
  }

  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = `${origin}/favicon.ico`;
  img.addEventListener('error', () => {
    holder.innerHTML = window.CloudShape.RAIN_CLOUD;
    holder.classList.add('is-rain');
  });
  holder.appendChild(img);
  return holder;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** What the filter and the date range leave. */
function visibleEntries() {
  const query = filterInput.value.trim().toLowerCase();
  const cutoff = Number(rangeSelect.value);
  const since = cutoff ? Date.now() - cutoff : 0;

  return entries.filter((e) => {
    if (since && e.visitedAt < since) return false;
    if (!query) return true;
    return (e.title || '').toLowerCase().includes(query) ||
      (e.url || '').toLowerCase().includes(query);
  });
}

function render() {
  const visible = visibleEntries();
  const query = filterInput.value.trim();

  countLabel.textContent = visible.length
    ? `${visible.length} page${visible.length === 1 ? '' : 's'}` +
      (visible.length < entries.length ? ` of ${entries.length}` : '')
    : 'Nothing here yet';

  groupsRoot.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'card empty';
    empty.textContent = entries.length
      ? 'No pages match that.'
      : 'Pages you visit will show up here.';
    groupsRoot.appendChild(empty);
    return;
  }

  // One card per day, newest first, with the day's own count and a way to
  // forget the whole of it.
  const days = [];
  for (const entry of visible) {
    const key = startOfDay(entry.visitedAt);
    let day = days.find((d) => d.key === key);
    if (!day) days.push((day = { key, label: dayLabel(entry.visitedAt), rows: [] }));
    day.rows.push(entry);
  }

  for (const day of days) {
    const heading = document.createElement('div');
    heading.className = 'group-head';

    const label = document.createElement('h2');
    label.className = 'group-label';
    label.textContent = `${day.label} · ${day.rows.length} page${day.rows.length === 1 ? '' : 's'}`;

    const forget = document.createElement('button');
    forget.className = 'group-clear';
    forget.type = 'button';
    forget.textContent = 'Clear this day';
    forget.addEventListener('click', async () => {
      await bridge.history.clearBetween(day.key, day.key + 86400000 - 1);
      entries = entries.filter((e) => startOfDay(e.visitedAt) !== day.key);
      render();
    });

    heading.append(label, forget);
    groupsRoot.appendChild(heading);

    const card = document.createElement('div');
    card.className = 'card';

    for (const entry of day.rows) card.appendChild(historyRow(entry));
    groupsRoot.appendChild(card);
  }
}

function historyRow(entry) {
  const row = document.createElement('div');
  row.className = 'row';
  row.title = entry.url;

  const text = document.createElement('span');
  text.className = 'row-title';
  text.textContent = entry.title || hostOf(entry.url);

  const where = document.createElement('span');
  where.className = 'row-url';
  where.textContent = hostOf(entry.url);

  const time = document.createElement('span');
  time.className = 'row-meta';
  time.textContent = timeFormatter.format(new Date(entry.visitedAt));

  const forget = document.createElement('button');
  forget.className = 'row-remove';
  forget.type = 'button';
  forget.title = 'Forget this page';
  forget.setAttribute('aria-label', 'Forget this page');
  forget.innerHTML = window.Icons.svg('close');
  forget.addEventListener('click', async (event) => {
    // The row itself opens the page; the button must not.
    event.stopPropagation();
    await bridge.history.remove(entry.url, entry.visitedAt);
    entries = entries.filter((e) => !(e.url === entry.url && e.visitedAt === entry.visitedAt));
    render();
  });

  row.append(siteIcon(entry.url), text, where, time, forget);
  row.addEventListener('click', () => bridge?.navigate(entry.url));
  // The middle button opens things in a new cloud, the way it does everywhere.
  row.addEventListener('auxclick', (event) => {
    if (event.button === 1) bridge?.openTab?.(entry.url, true);
  });

  return row;
}

filterInput.addEventListener('input', render);
rangeSelect.addEventListener('change', render);

// Enter opens the first thing the search found - the usual way to use a filter.
filterInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const first = visibleEntries()[0];
  if (first) bridge?.navigate(first.url);
});

document.getElementById('clear').addEventListener('click', () => {
  bridge?.history.clear();
  entries = [];
  render();
});

async function load() {
  if (!bridge) return;
  try {
    const state = await bridge.getState();
    window.SkyTheme.apply({ base: state.themeBase, variables: state.pageThemeVars });
  } catch {
    /* cosmetic only */
  }
  entries = (await bridge.history.list(5000)) || [];
  render();
  filterInput.focus();
}

load();

// Follow the browser theme while the page is open, not just at load.
bridge?.onTheme?.((theme) => {
  window.SkyTheme.apply(theme);
});
