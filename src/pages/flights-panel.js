'use strict';

/*
 * The flights panel's own page.
 *
 * It is handed the whole state whenever anything moves and draws it. What a
 * flight is, and what any of these buttons mean, is the browser's business -
 * this sends back a name and an id and nothing else.
 */

const bridge = window.flightsPanel;
const list = document.getElementById('list');
const panel = document.getElementById('panel');

const I = window.Icons;

const ICON = {
  flying: I.svg('airplane'),
  held: I.svg('play-pause'),
  landed: I.svg('check'),
  stalled: I.svg('danger'),
  lost: I.svg('close'),
  'called off': I.svg('close')
};

const DO = {
  hold: I.svg('play-pause'),
  'carry-on': I.svg('play-button'),
  'call-off': I.svg('close'),
  again: I.svg('sync'),
  reveal: I.svg('folder'),
  forget: I.svg('trash')
};

/** Sizes people read, not sizes computers store. */
function size(bytes) {
  if (!bytes || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function howLong(seconds) {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} hours left`;
}

/** The line under the name: what is happening, in as few words as it takes. */
function under(flight) {
  if (flight.state === 'flying') {
    const parts = [];
    if (flight.total > 0) parts.push(`${size(flight.received)} of ${size(flight.total)}`);
    else parts.push(size(flight.received));
    if (flight.speed > 0) parts.push(`${size(flight.speed)}/s`);
    const left = howLong(flight.remaining);
    if (left) parts.push(left);
    return parts.join(' · ');
  }
  if (flight.state === 'held') return `Held at ${size(flight.received)}`;
  if (flight.state === 'landed') return `${size(flight.total || flight.received)} · ${flight.origin}`;
  if (flight.state === 'stalled') return `Stopped at ${size(flight.received)} · try again`;
  if (flight.state === 'called off') return 'Called off';
  return `Did not arrive · ${flight.origin}`;
}

/** Which buttons a flight in this state has any use for. */
function doings(flight) {
  if (flight.state === 'flying') return ['hold', 'call-off'];
  if (flight.state === 'held') return ['carry-on', 'call-off'];
  if (flight.state === 'landed') return ['reveal', 'forget'];
  return ['again', 'forget'];
}

const TITLES = {
  hold: 'Hold it there',
  'carry-on': 'Carry on',
  'call-off': 'Call it off',
  again: 'Send it again',
  reveal: 'Show where it landed',
  forget: 'Take it off the list'
};

function draw(state) {
  const flights = (state && state.flights) || [];
  list.replaceChildren();

  if (!flights.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing has come down yet.';
    list.appendChild(empty);
    measure();
    return;
  }

  for (const flight of flights.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = `flight ${flight.state.replace(' ', '-')}`;
    row.dataset.id = flight.id;

    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.innerHTML = ICON[flight.state] || ICON.flying;

    const body = document.createElement('div');
    body.className = 'body';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = flight.name;
    name.title = flight.path || flight.name;

    const line = document.createElement('div');
    line.className = 'under';
    line.textContent = under(flight);

    body.append(name, line);

    if (flight.state === 'flying' || flight.state === 'held') {
      const track = document.createElement('div');
      track.className = 'track' + (flight.total > 0 ? '' : ' unknown');
      const fill = document.createElement('i');
      fill.style.width = flight.total > 0
        ? `${Math.min(100, (flight.received / flight.total) * 100)}%` : '40%';
      track.appendChild(fill);
      body.appendChild(track);
    }

    const buttons = document.createElement('div');
    buttons.className = 'doings';
    for (const action of doings(flight)) {
      const button = document.createElement('button');
      button.innerHTML = DO[action];
      button.title = TITLES[action];
      if (action === 'call-off' || action === 'forget') button.classList.add('danger');
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        draw(await bridge.act(action, flight.id));
      });
      buttons.appendChild(button);
    }

    // Opening a landed file is what clicking the row means; the buttons are for
    // everything else.
    if (flight.state === 'landed') {
      row.addEventListener('click', () => bridge.act('open', flight.id));
      row.style.cursor = 'pointer';
    }

    row.append(mark, body, buttons);
    list.appendChild(row);
  }

  measure();
}

/**
 * The browser cannot know how big this turned out until it is drawn, so it is
 * told - and where the card sits inside the view, so the panel lands under the
 * button rather than under the margin around it.
 */
function measure() {
  const style = getComputedStyle(document.body);
  const left = parseFloat(style.paddingLeft) || 0;
  const top = parseFloat(style.paddingTop) || 0;
  const box = panel.getBoundingClientRect();
  bridge.measured({
    width: Math.ceil(box.width + left * 2),
    height: Math.ceil(box.height + top + (parseFloat(style.paddingBottom) || 0)),
    offsetX: left,
    offsetY: top
  });
}

document.getElementById('clear').addEventListener('click', async () => {
  draw(await bridge.act('clear', ''));
});

document.getElementById('all').addEventListener('click', () => {
  bridge.openPage();
  bridge.close();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') bridge.close();
});

// A press on the padding around the card is a press outside the panel.
document.addEventListener('pointerdown', (event) => {
  if (!panel.contains(event.target)) bridge.close();
});

bridge.onShow(async ({ base }) => {
  document.documentElement.dataset.theme = base === 'night' ? 'night' : 'day';
  draw(await bridge.list());
});

bridge.onState((state) => draw(state));
