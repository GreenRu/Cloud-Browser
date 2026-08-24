'use strict';

/*
 * Page Timeline.
 *
 * Every cloud keeps the page each of its pages was opened from, so where it has
 * been is a tree rather than a line. Going back three pages and following a
 * different link is a fork: the browser's own history throws away what was
 * ahead, and this keeps it, drawn as a branch nobody is standing on.
 *
 * Laid out depth-first, so a run of pages reads straight down and a fork steps
 * one column to the right. That keeps the common case - no branches at all -
 * looking like the plain list it is.
 */

const bridge = window.cloudPlugin;

const cloudsRoot = document.getElementById('clouds');
const sub = document.getElementById('sub');

const ROW = 34;            // matches .node's height
const COLUMN = 22;         // how far a branch steps to the right
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.startsWith('stratus://') ? 'Stratus' : url;
  }
}

/**
 * Walk the tree into rows.
 *
 * The child a cloud actually went on to keeps the parent's column; anything
 * else is a turning it did not take, and steps right. Which is which is decided
 * by where the cloud is now: the branch holding it is the one that reads as the
 * main line.
 */
function layout(cloud) {
  const nodes = cloud.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const children = new Map();
  for (const node of nodes) {
    const key = node.parent || '';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(node);
  }

  // The path from the root down to where the cloud is now.
  const spine = new Set();
  let walk = byId.get(cloud.at);
  while (walk) {
    spine.add(walk.id);
    walk = walk.parent ? byId.get(walk.parent) : null;
  }

  const rows = [];
  const place = (node, depth) => {
    rows.push({ node, depth, row: rows.length });

    const kids = (children.get(node.id) || []).slice();
    // The one the cloud carried on down goes first and keeps the column.
    kids.sort((a, b) => (spine.has(b.id) ? 1 : 0) - (spine.has(a.id) ? 1 : 0) || a.at - b.at);

    kids.forEach((kid, i) => place(kid, i === 0 ? depth : depth + 1));
  };

  for (const root of children.get('') || []) place(root, 0);
  return { rows, spine };
}

function drawCloud(cloud) {
  const card = document.createElement('div');
  card.className = 'cloud';

  const head = document.createElement('div');
  head.className = 'cloud-head';

  const title = document.createElement('div');
  title.className = 'cloud-title';
  title.textContent = cloud.title || hostOf(cloud.url);

  const count = document.createElement('div');
  count.className = 'cloud-count';
  const branches = cloud.nodes.length - new Set(cloud.nodes.map((n) => n.parent)).size;
  count.textContent = `${cloud.nodes.length} page${cloud.nodes.length === 1 ? '' : 's'}`;

  head.append(title, count);
  card.appendChild(head);

  const { rows, spine } = layout(cloud);
  const graph = document.createElement('div');
  graph.className = 'graph';
  graph.style.height = `${rows.length * ROW}px`;

  const rowOf = new Map(rows.map((r) => [r.node.id, r]));

  // The lines first, so the pages sit on top of them.
  for (const entry of rows) {
    const parent = entry.node.parent && rowOf.get(entry.node.parent);
    if (!parent) continue;

    const edge = document.createElement('div');
    const straight = parent.depth === entry.depth;
    edge.className = straight ? 'edge straight' : 'edge';

    // From the middle of the page it came from to the middle of this one, then
    // across if this one is on a branch of its own.
    edge.style.left = `${parent.depth * COLUMN + 15}px`;
    edge.style.top = `${parent.row * ROW + ROW / 2}px`;
    edge.style.height = `${(entry.row - parent.row) * ROW}px`;
    edge.style.width = straight ? '0' : `${(entry.depth - parent.depth) * COLUMN}px`;
    graph.appendChild(edge);
  }

  for (const entry of rows) {
    const node = document.createElement('div');
    node.className = 'node';
    if (entry.node.id === cloud.at) node.classList.add('here');
    else if (!spine.has(entry.node.id)) node.classList.add('aside');

    node.style.marginLeft = `${entry.depth * COLUMN}px`;
    node.title = entry.node.url;

    const dot = document.createElement('i');
    dot.className = 'dot';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = entry.node.title || hostOf(entry.node.url);

    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = hostOf(entry.node.url);

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = timeFormat.format(new Date(entry.node.at));

    node.append(dot, label, where, when);
    node.addEventListener('click', () => bridge?.navigate(entry.node.url));
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) bridge?.openTab?.(entry.node.url, true);
    });

    graph.appendChild(node);
  }

  card.appendChild(graph);
  return { card, branches };
}

async function draw() {
  if (!bridge) {
    sub.textContent = 'This page only works inside Stratus.';
    return;
  }

  const trails = await bridge.timeline();
  const clouds = (trails && trails.clouds) || [];

  cloudsRoot.replaceChildren();

  if (!clouds.length) {
    sub.textContent = 'Nothing to show yet.';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Visit a few pages, then come back. Turn back and go somewhere else and the trail will fork.';
    cloudsRoot.appendChild(empty);
    return;
  }

  let forks = 0;
  for (const cloud of clouds) {
    const { card, branches } = drawCloud(cloud);
    forks += branches > 0 ? 1 : 0;
    cloudsRoot.appendChild(card);
  }

  sub.textContent = `${clouds.length} cloud${clouds.length === 1 ? '' : 's'}` +
    (forks ? `, ${forks} of them forked` : '');
}

draw();

// The map is only worth anything if it keeps up with where you go. The browser
// only says that something changed; what changed is asked for above.
bridge?.onChange?.(() => draw());

bridge?.getState?.().then((state) => {
  document.documentElement.dataset.theme = state.themeBase === 'night' ? 'night' : 'day';
}).catch(() => {});

bridge?.onTheme?.((theme) => {
  const base = typeof theme === 'string' ? theme : theme && theme.base;
  document.documentElement.dataset.theme = base === 'night' ? 'night' : 'day';
});
