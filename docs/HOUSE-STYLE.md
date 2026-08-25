# The Cloud Suite house style

Stratus is the first of a family of small, cloud-themed, open-source desktop
programs. This page is the shared document the rest are built against — what
they have in common, what they may not do, and why.

| Program | Is | Cloud word |
| --- | --- | --- |
| **Stratus** | A web browser | A flat, layered sheet — the one you look *through* |
| **Nimbus** | A text editor | The rain cloud — the one that actually produces something |
| **Cumulus** | A file explorer | The heaped, many-lobed one — lots of small things, piled |
| **Sky Box** | The manager that installs and updates the others | The box they all come in |

Each is small on its own and has room to grow through plugins. None of them
depends on another; Sky Box knows how to fetch them, and that is the whole
relationship.

- [Naming things](#naming-things)
- [The look](#the-look)
- [Motion](#motion)
- [The shape of the code](#the-shape-of-the-code)
- [Rules that do not bend](#rules-that-do-not-bend)
- [Native views, and the law about them](#native-views-and-the-law-about-them)
- [Plugins](#plugins)
- [Testing](#testing)
- [Prose, comments and commits](#prose-comments-and-commits)
- [Open source](#open-source)

## Naming things

The theme is weather, and it earns its place or it does not go in.

**Rename a thing when the metaphor is genuinely better, not to be cute.** In
Stratus a tab is a **cloud** (they stack, they drift, they merge and split), the
page area is the **sky**, a closing cloud **rains** and leaves a **puddle**, and
a kept page is a **droplet** — a cloud leaves droplets behind. Those all say
something. A "cirrus preferences pane" would not, and there isn't one.

Two rules keep it from becoming a private language:

- **The interface gets the new word; the data keeps the old one.** Droplets are
  stored under the key `bookmarks`, because that is what is already on disk and
  what every other program calls them — which is the language an importer has to
  speak. Rename the layer people read, not the layer machines read.
- **Keep the plain word reachable.** `stratus://bookmarks` still lands on the
  droplets page. Someone who does not know your metaphor should not hit a wall.

Each program answers to `<name>://` for its own internal pages —
`stratus://settings`, `nimbus://settings`, and so on.

## The look

One continuous sky fills the window; the content floats on it as a rounded card.
Controls live in a left column, not in a band across the top. Nothing is square,
nothing is grey, and nothing is loud.

Colours are CSS variables, never literals, so a theme can replace all of them.
The full set (40 in Stratus, and it will differ per program — that is fine):

```css
:root {
  --sky-top: #74b1e5;      --sky-bottom: #b6dbf6;   /* the window itself */
  --cloud: #ffffff;        --cloud-idle: #dcecfb;   /* the floating things */
  --cloud-hover: #eef6fe;
  --text: #22364c;         --text-dim: #5f7a96;     --text-on-sky: #24425f;
  --field: #ffffff;        --field-line: rgba(15, 23, 42, 0.10);
  --panel: rgba(255, 255, 255, 0.74);               /* frosted, over the sky */
  --hover: rgba(255, 255, 255, 0.5);
  --accent: #2472cf;       --droplet: #2b9fd6;      --danger: #d94a4a;
  --stage: #eaf3fc;                                 /* where content sits */
  --shadow-card: 0 10px 30px rgba(16, 44, 76, 0.18);
  --page-radius: 16px;     --gutter: 10px;
  --ui-font: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
  --brand-font: "Comfortaa", var(--ui-font);
}
```

Two bases ship: **day** and **night**. Night is the same variables at different
values, never a filter. Every program reads `nativeTheme` for the window
controls, which are drawn by the system and need a real colour rather than a
variable.

Shapes:

| Thing | Radius |
| --- | --- |
| Anything pill-shaped — buttons, chips, fields | `999px` |
| Cards, menus, sheets | `22px` |
| The content card | `var(--page-radius)`, 16px |

**Clouds are drawn, not drawn *on*.** `src/shared/clouds.js` builds a cloud as a
rounded body with lobes rising off its top edge, each lobe carrying
`background: inherit` so the whole thing reads as one silhouette under one
shadow. Shapes come from a hash of a stable seed rather than `Math.random`, so
every cloud differs from its neighbours and keeps its own shape for life instead
of re-rolling on each render:

```js
CloudShape.buildLobes(element, `menu-${id}`, {
  width: element.offsetWidth, base: 30, spacing: 84,
  minLobes: 2, maxLobes: 4, overhang: 0, widthRatio: [1.5, 2.6]
});
```

Copy the file. It has no dependencies and knows nothing about browsers.

Fills that overlap must be **opaque**. Lobes cross each other, and any alpha
compounds where they do and exposes the seams.

## Motion

Everything that appears, grows or is pressed overshoots slightly and settles.
Nothing eases linearly, and nothing is instant.

```css
--ease:       cubic-bezier(0.22, 1, 0.36, 1);      /* moving between places */
--spring:     cubic-bezier(0.34, 1.56, 0.64, 1);   /* the jelly */
--spring-big: cubic-bezier(0.22, 1.7, 0.36, 1);    /* arrivals */
--t-fast: 160ms;  --t-mid: 260ms;  --t-slow: 380ms;
```

Motion should say what happened. A droplet arrives by falling and squashing, not
by spinning. A closing cloud drifts down, rains, and leaves a puddle. If an
animation would look the same for two different events, it is decoration and can
go.

One trap, paid for once already: **a filled animation outranks inline styles.**
`animation: x 1s both` keeps its last keyframe applying forever and silently
beats every later attempt to set `transform` or `opacity` from script. Set
`animation: none` on the state that takes over.

## The shape of the code

Electron, one renderer per window, and three kinds of code that never blur:

```
src/
  main/         Node. Owns all state, the disk, and every privileged call.
  preload/      The only bridge. Enumerates channels explicitly.
  renderer/     The interface. Draws state; owns none of it.
  pages/        The program's own pages, loaded from file://
  shared/       Loaded by both the interface and the pages (plain scripts,
                attaching to window — they cross a module boundary)
plugins/        Bundled plugins, all switched off until asked for
docs/           ARCHITECTURE, PRIVACY, PLUGINS, TESTING, this file
```

Windows are `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
without exception. A preload exposes a hand-written object, never `ipcRenderer`:

```js
contextBridge.exposeInMainWorld('cloud', {
  droplets: {
    toggle: () => ipcRenderer.send('droplet:toggle'),
    menu:   (id, x, y) => ipcRenderer.send('droplet:menu', id, x, y)
  }
});
```

State flows one way. The interface gets a full snapshot because it draws all of
it; a content page gets **a knock at the door with nothing in it** and asks for
exactly what it is allowed to have. Nothing about one document leaks into
another that never asked.

Preferences live in one JSON file in the user-data directory, read through a
defaults-merged `Store`. **On-disk keys are permanent.** Renaming one costs a
migration, and a migration that goes wrong costs somebody their data.

## Rules that do not bend

- **Refuse rather than degrade.** Secrets are encrypted with Electron's
  `safeStorage`, which delegates to the OS keystore. If the platform cannot
  encrypt, saving is *refused* — never written in the clear. A password store
  that quietly isn't one is worse than none.
- **Keep only what a list has to show.** A username, a card's last four digits.
  Everything else is ciphertext at rest.
- **The page never says who it is.** When something fills a form, the origin
  comes from the sending view's own URL, read in the main process. A page that
  can name an origin can ask for someone else's secrets.
- **Guess nothing.** With two saved entries matching, fill neither: there is no
  way to know which is meant, and asking is better than guessing wrong.
- **A setting that destroys data says so, and means it.** Stratus's "keep the
  code on the back of the card" switch destroys every stored code when turned
  off *and writes down when*, so a code that outlives the wipe in a backup is
  still never offered. Where a rule must survive a restored file, enforce it with
  a timestamp, not only a deletion.
- **No dependency unless there is genuinely no choice.** Firefox's compressed
  bookmark backups are decoded in about forty lines rather than by pulling in a
  package. Read the format; it is usually smaller than the wrapper.
- **Guard anything that can be destroyed.** `isDestroyed()` before touching a
  view, every time. Teardown will find the one place you skipped.

## Native views, and the law about them

This is the most expensive thing to get wrong, and it generalises to any of these
programs that embeds content — a browser, an editor with a preview pane, an
explorer with a file preview.

**A native view is a child of the window, not part of your document. Your
interface cannot draw over it.** Anything the renderer draws inside the area a
view covers is simply not on screen — every measurement correct, nothing
visible. And `capturePage` on the renderer will *not* show you: it captures the
renderer alone, so the missing part looks perfectly present. Only a real screen
capture tells you.

It has been got wrong three times in Stratus: the preview card, the cloud menu,
and then the droplet menu, which hangs down off a bar that is itself fine.

So: **anything that overlays content is its own view.** One menu view serves
every menu. It is handed a list of labels and hands back the name of whichever
was chosen; what that name *means* is decided in the main process, which is where
the state is. Adding a new kind of menu is a `thingMenu()` that returns a
description and a `runThingMenu()` that acts on a name — and nothing else.

The layout goes the other way round: the renderer measures its placeholder
element and reports the rectangle; the main process converts it to view bounds. A
`ResizeObserver` on the placeholder means anything that changes the layout —
showing a bar, collapsing a sidebar — re-reports for free.

## Plugins

Every program in the family takes plugins, and they all use the same shape:
**a folder with a `plugin.json` beside whatever files it names.**

Manifests are **declarative**. A plugin says what it wants applied and where; the
program applies it. There is **no plugin code in the main process**, and there is
not going to be — that is the entire security model, not a detail of it. Scripts
a plugin injects run in an isolated world.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One line about what it does.",

  "commands": [{ "id": "toggle", "label": "Toggle it", "accelerator": "CommandOrControl+Alt+M" }],
  "styles":   [{ "matches": ["*://*.example.com/*"], "css": "skin.css" }],
  "scripts":  [{ "matches": ["<all_urls>"], "js": "content.js" }],
  "pages":    { "stratus://my-plugin": "page.html" },
  "themes":   [{ "id": "custom", "name": "Custom", "fields": [], "variables": {} }],
  "toolbar":  [{ "id": "open", "label": "Open it", "after": "back" }]
}
```

Two folders are read: the one in the repository, and the one in the profile.
A plugin in the profile replaces a bundled one with the same id.

**Everything is off until switched on.** The store keeps the list of what is
*on*, so dropping a folder in makes a plugin available, not active. Ship a couple
of real ones as worked examples — a theme, something that injects, something with
a page of its own — and they double as the test suite for the host.

## Testing

There is no framework. A suite is a script the program's own runtime executes,
which is the only way to test something whose behaviour lives in a window
manager, a compositor and a keystore.

```bash
npx electron suite.js
```

The rules, each of which was learned by losing an afternoon:

- **A throwaway profile per suite.** `fs.mkdtempSync`, and `app.setName` before
  anything reads a path.
- **Kill strays first.** `taskkill //F //IM electron.exe`. The single-instance
  lock hands your launch to an older process, and an occluded window pauses its
  CSS animations and throttles its timers — three assertions once failed
  reproducibly with nothing wrong in the code.
- **Print each assertion as it runs**, and set a watchdog. A suite that only
  prints at the end goes silent exactly when it hangs.
- **Assert the value, not the declaration.** Checking that an animation lasts
  three seconds proves nothing about what it does. Sample the opacity halfway
  through.
- **Name assertions as sentences.** `check('a code that predates the last
  switch-off is not offered', ...)`. The output should read as a description of
  the program.
- **Synthetic events do not exercise the real input path.** A dispatched
  `MouseEvent` skips the pointer path entirely, so a suite can pass green while
  real clicks do nothing. Pointer behaviour needs a real OS click.
- **A window with `show: false` never gives its document focus**, so anything
  depending on `focusin` or `activeElement` quietly never happens.
- **Finish with a real boot.** Every suite that constructs your app object by
  hand skips your entry point entirely. `npx electron .` catches the missing
  `let` that 28 green assertions did not.

When something is wrong, **measure it — do not reason about it**. Pixel
sampling, geometry probes, event logs. Most of the expensive bugs here looked
like one thing and were another: "the last fields were not recognised" was
really an exception thrown on the third of them, which abandoned the rest.

## Prose, comments and commits

The programs are small and the writing is part of them.

- **Comments explain why, never what.** If a line needs saying what it does,
  rename something instead. Prefer a short paragraph above a tricky block to a
  string of end-of-line notes.
- **Plain sentences.** No shouting, no "NOTE:", no decoration. Write as though
  explaining to somebody who will maintain it next year.
- **Record the trap where it was set.** When something took an afternoon to
  find, the comment that stops the next person losing the same afternoon is worth
  more than the fix.
- **User-facing text is a sentence, not a label.** "No droplets yet — Ctrl+D
  keeps a page here", not "Empty". Say what will happen, not what is missing.
- **Commit messages say what changed and why it is that way**, in prose, in the
  present tense. The subject line is a statement, not a category prefix.

## Open source

GPL-3.0-or-later, with the notice at the head of each entry point. Every program
in the family ships:

- a `README.md` that shows what it does before it explains how to build it;
- `docs/ARCHITECTURE.md` — the parts, the stacking order, and the traps;
- `docs/PRIVACY.md` — where the profile is, what is in each file, what is
  encrypted, and what leaves the machine (for most of these: nothing);
- `docs/PLUGINS.md` — the tour, with the field reference beside the plugins;
- `docs/TESTING.md` — how to run the suites and what has already gone wrong;
- this file, so the next one in the family starts where the last one finished.

Nothing phones home. If a program ever needs the network for its own sake rather
than the user's, that is a decision documented in `PRIVACY.md` with a switch
beside it.
