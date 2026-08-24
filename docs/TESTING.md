# Testing

There is no test framework here. Checks are **assertion scripts**: a script
boots the real modules, drives them, and prints one line per claim.

```
PASS  the day and night button is gone from the toolbar
PASS  the panes meet edge to edge  ["0+426","426+426","852+427"]
FAIL  the pool spans the sky rather than a spot in it  {"w":232,"lw":252,"offFloor":37}

32/32 passed
```

A failing line carries the numbers that made it fail, which is most of the
debugging. The suites live in the working scratch directory rather than the
repository — they are development instruments, not a deliverable, and several
depend on absolute paths on the machine they were written on.

## What a suite looks like

```js
const { app } = require('electron');
app.setName('Stratus');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'stratus-x-')));

app.whenReady().then(async () => {
  const { BrowserShell } = require('.../src/main/shell.js');
  const shell = new BrowserShell(new Store());
  // ...drive it, check things, report
});
```

Run one with `npx electron <suite>.js`.

Four habits are worth copying:

- **A throwaway profile.** A restored session changes the number of clouds and
  with it every measurement. `mkdtemp` and point `userData` at it.
- **Print as you go.** A suite that only prints at the end goes silent when it
  hangs, and says nothing about where.
- **Kill stray instances first.** See below.
- **Report numbers, not booleans.** `'ring ' + ring + 'px'` turns a red line
  into a diagnosis.

## Ranked by what a check costs

From [../PLAN.md](../PLAN.md), cheapest first:

1. `node --check` on every file touched — effectively free, catches most typos.
2. A headless assertion script — a few seconds, and answers most questions.
3. Launching the app and looking — slow, and only worth it for how something
   *looks*.
4. A screen capture — slower still, and needed for anything the chrome renderer
   cannot see, which is anything involving a page view.
5. `./build.sh` — the most expensive, and Smart App Control blocks the result
   anyway. Build once when a round is finished.

## Things that will waste your afternoon

Every one of these was found the hard way. The full list, with evidence, is in
[../PLAN.md](../PLAN.md).

**Kill stray Electron instances before launching.** The single-instance lock
silently hands the launch to an older process, so a stale instance reads stale
state and the new code appears not to work. Worse: a stray window *covers* the
new one, and an occluded page pauses its CSS animations and throttles its
timers — three assertions failed reproducibly that way with nothing wrong in the
code.

```bash
taskkill //F //IM electron.exe
```

**Synthetic events do not exercise the real input path.** A dispatched
`MouseEvent` skips the pointer path entirely, so a suite can pass green while
real clicks do nothing. Two bugs were found this way: `preventDefault()` on a
`pointerdown` cancels the compatibility `mousedown`/`click` that follow, and
`sendInputEvent` never reaches a non-focused child view. Anything about pointers
needs a real OS click — the scratch directory has PowerShell helpers that
declare DPI awareness first, without which Windows rescales the coordinates and
the click lands somewhere else.

**A filled animation outranks inline styles and transitions.** `.tab` carries
`animation: cloud-in ... both`, and `both` keeps the final keyframe applying for
the life of the element. A closing cloud sat at full opacity for its whole
three-second "fade" while the computed transition duration read back correctly
as `3s`. **Assert the value partway through, never just the declared duration.**

**The chrome renderer cannot draw over a page.** A tab is a native view stacked
above the window's own web contents. HTML positioned over the page area is
invisible behind it — and nothing in the DOM shows this: every measurement is
correct and a `capturePage` of the renderer looks perfect. Only a screen capture
tells you.

**A suite that builds the shell by hand never boots the app.** They construct
`BrowserShell` directly, which is what makes them fast, and means none of them
runs `src/main/index.js`. A missing `let` there passed 28 green assertions and
still broke the browser on launch. Finish with:

```bash
npx electron .
```

and *read* the output.

**Smart App Control can block `electron.exe` mid-session.** The verdict is
pinned to that file rather than its contents — copying the same bytes elsewhere
runs — so `npm rebuild electron` clears it. Do not turn Smart App Control off; it
cannot be turned back on without reinstalling Windows.

## Testing without a browser

`src/main/plugins.js` reaches Electron for exactly one thing — where the profile
lives — so stubbing that is enough to exercise manifest reading, validation and
theme resolution under plain Node:

```js
const Module = require('module');
const realLoad = Module._load;
Module._load = (request, parent, isMain) =>
  request === 'electron'
    ? { app: { getPath: () => PROFILE } }
    : realLoad(request, parent, isMain);
```

Worth reaching for when Electron itself will not start.

## Coverage as it stands

Roughly 400 assertions across fifteen suites: the browser end to end, merge and
split, pane seams, the closing animation, the preview bubble in the chrome and
in a page, multi-pane search, themes, the plugin host, the timeline, the sky,
settings and history, and the password vault. Each was written against a
specific piece of behaviour while it was being built, and most exist because
something was once wrong in a way a screenshot did not show.
