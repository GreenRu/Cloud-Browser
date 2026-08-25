'use strict';

/*
 * The page of flights.
 *
 * Everything a flight can be asked to do is named by its id and done in the
 * main process. This page holds no download and no path; the folder is chosen
 * with a picker, so nothing here can invent a place to write to.
 */

const bridge = window.cloudPage;
const listRoot = document.getElementById('list');
const countLabel = document.getElementById('count');
const filterInput = document.getElementById('filter');
const folderLabel = document.getElementById('folder');

let state = { flights: [], folder: '' };

/** Sizes people read, not sizes computers store. */
function size(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function when(at) {
  if (!at) return '';
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** What is happening to this one, in as few words as it takes. */
function under(flight) {
  if (flight.state === 'flying') {
    const parts = [flight.total > 0 ? `${size(flight.received)} of ${size(flight.total)}` : size(flight.received)];
    if (flight.speed > 0) parts.push(`${size(flight.speed)}/s`);
    parts.push(flight.origin);
    return parts.filter(Boolean).join(' · ');
  }
  if (flight.state === 'held') return `Held at ${size(flight.received)} · ${flight.origin}`;
  if (flight.state === 'landed') {
    return [size(flight.total || flight.received), flight.origin, when(flight.finishedAt)]
      .filter(Boolean).join(' · ');
  }
  if (flight.state === 'stalled') return `Stopped at ${size(flight.received)} · ${flight.origin}`;
  if (flight.state === 'called off') return `Called off · ${flight.origin}`;
  return `Did not arrive · ${flight.origin}`;
}

const DOINGS = {
  flying: [['hold', 'Hold'], ['call-off', 'Call it off', true]],
  held: [['carry-on', 'Carry on'], ['call-off', 'Call it off', true]],
  landed: [['open', 'Open'], ['reveal', 'Show me'], ['forget', 'Remove', true]],
  stalled: [['again', 'Send it again'], ['forget', 'Remove', true]],
  'called off': [['again', 'Send it again'], ['forget', 'Remove', true]],
  lost: [['again', 'Send it again'], ['forget', 'Remove', true]]
};

function render() {
  const query = filterInput.value.trim().toLowerCase();
  const all = state.flights || [];
  const visible = query
    ? all.filter((f) => (f.name || '').toLowerCase().includes(query) ||
      (f.origin || '').toLowerCase().includes(query))
    : all;

  const air = all.filter((f) => f.state === 'flying' || f.state === 'held').length;
  countLabel.textContent = !all.length ? 'Nothing has come down yet'
    : air ? `${air} in the air, ${all.length} altogether`
      : `${all.length} flight${all.length === 1 ? '' : 's'}`;

  folderLabel.textContent = state.folder || '';
  listRoot.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query
      ? 'No flights match that search.'
      : 'Files you download from a site will be listed here.';
    listRoot.appendChild(empty);
    return;
  }

  for (const flight of visible) {
    const row = document.createElement('div');
    row.className = 'row';

    const cell = document.createElement('div');
    cell.style.flex = '1 1 auto';
    cell.style.minWidth = '0';

    const line = document.createElement('div');
    line.className = 'flight-line row-title';

    const name = document.createElement('span');
    name.textContent = flight.name;

    const where = document.createElement('span');
    where.className = 'flight-where';
    where.textContent = flight.state === 'landed' ? 'landed' : flight.state;

    line.append(name, where);

    const detail = document.createElement('div');
    detail.className = 'row-url';
    detail.textContent = under(flight);
    detail.title = flight.path || '';

    cell.append(line, detail);

    if (flight.state === 'flying' || flight.state === 'held') {
      const track = document.createElement('div');
      track.className = 'flight-track' + (flight.total > 0 ? '' : ' unknown');
      const fill = document.createElement('i');
      fill.style.width = flight.total > 0
        ? `${Math.min(100, (flight.received / flight.total) * 100)}%` : '40%';
      track.appendChild(fill);
      cell.appendChild(track);
    }

    row.appendChild(cell);

    for (const [action, label, danger] of DOINGS[flight.state] || []) {
      const button = document.createElement('button');
      button.className = 'ghost-btn' + (danger ? ' danger' : '');
      button.textContent = label;
      button.addEventListener('click', async () => {
        state = await bridge.flights.act(action, flight.id);
        render();
      });
      row.appendChild(button);
    }

    listRoot.appendChild(row);
  }
}

filterInput.addEventListener('input', render);

document.getElementById('clear').addEventListener('click', async () => {
  state = await bridge.flights.act('clear', '');
  render();
});

document.getElementById('choose').addEventListener('click', async () => {
  const result = await bridge.flights.chooseFolder();
  if (result && result.folder) state.folder = result.folder;
  render();
});

document.getElementById('default').addEventListener('click', async () => {
  const result = await bridge.flights.useDefaultFolder();
  if (result && result.folder) state.folder = result.folder;
  render();
});

/* Live: the list moves while things are coming down, without being asked. */
bridge?.flights.onChanged((next) => {
  state = next;
  render();
});

(async () => {
  if (!bridge) return;
  const shell = await bridge.getState();
  window.SkyTheme.apply({ base: shell.themeBase, variables: shell.pageThemeVars });
  state = await bridge.flights.list();
  render();
})();

bridge?.onTheme?.((theme) => window.SkyTheme.apply(theme));
